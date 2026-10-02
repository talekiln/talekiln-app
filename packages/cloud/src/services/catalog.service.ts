import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CompactSign } from 'jose';
import { z } from 'zod';
import type { AppConfig } from './config';

const SERVICE_TYPES = ['text', 'image', 'video', 'tts'] as const;

const catalogSchema = z.object({
  providers: z.array(z.object({
    id: z.string().min(1).max(40),
    name: z.string().min(1).max(100),
    key_url_code: z.string().max(40).optional(),
  })),
  models: z.array(z.object({
    provider: z.string().min(1).max(40),
    service_type: z.enum(SERVICE_TYPES),
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(100),
  })),
  // 价格表与本地 prices.json 同形：{ version, currency, max_factor, defaults, providers }
  prices: z.object({
    version: z.string().min(1).max(60),
    currency: z.string().min(1).max(10),
    providers: z.record(z.record(z.record(z.unknown()))),
  }).passthrough(),
  announcements: z.array(z.object({
    id: z.string().min(1).max(60),
    level: z.enum(['info', 'warn']),
    title: z.string().min(1).max(100),
    body: z.string().max(1000),
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
  })),
});
export type CatalogData = z.infer<typeof catalogSchema>;

/** 内置默认目录：价格为示例价，上线前由 CATALOG_FILE 覆盖。 */
export const DEFAULT_CATALOG: CatalogData = {
  providers: [
    { id: 'bailian', name: '阿里云百炼', key_url_code: 'bailian' },
    { id: 'ark', name: '火山方舟', key_url_code: 'ark' },
  ],
  models: [
    { provider: 'bailian', service_type: 'image', id: 'wan2.6-t2i', label: '万相 2.6 文生图' },
    { provider: 'bailian', service_type: 'video', id: 'wan2.6-t2v', label: '万相 2.6 文生视频' },
    { provider: 'bailian', service_type: 'video', id: 'wan2.6-i2v-flash', label: '万相 2.6 图生视频 Flash' },
    { provider: 'bailian', service_type: 'tts', id: 'cosyvoice-v2', label: 'CosyVoice v2' },
  ],
  prices: {
    sample: true,
    version: 'sample-cloud-2026-10-01',
    currency: 'CNY',
    max_factor: 1.2,
    defaults: { duration_seconds: 5 },
    providers: {
      bailian: {
        image: { 'wan2.6-t2i': { per: 'image', price: 0.2 }, _default: { per: 'image', price: 0.2 } },
        video: { 'wan2.6-t2v': { per: 'second', price: 0.6 }, _default: { per: 'second', price: 0.6 } },
        tts: { _default: { per: 'char', price: 0.0002 } },
      },
    },
  },
  announcements: [],
};

/** 键排序的稳定序列化；本地端用同一算法校验版本哈希。 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function catalogVersion(data: unknown): string {
  return 'c-' + createHash('sha256').update(canonicalJson(data)).digest('hex').slice(0, 16);
}

export function loadCatalogFromEnv(env: NodeJS.ProcessEnv = process.env): CatalogData {
  if (!env.CATALOG_FILE) return DEFAULT_CATALOG;
  return catalogSchema.parse(JSON.parse(readFileSync(env.CATALOG_FILE, 'utf8')));
}

export interface CatalogResponse {
  version: string;
  unchanged?: true;
  kid?: string;
  /** ES256 compact JWS，载荷为 version 字符串；version 是目录内容的 sha256，二者合起来可验真。 */
  signature?: string;
  issued_at?: string;
  catalog?: CatalogData;
}

export class CatalogService {
  private readonly data: CatalogData;
  readonly version: string;
  private sig?: Promise<string>;

  constructor(
    private readonly cfg: AppConfig,
    data: CatalogData = DEFAULT_CATALOG,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.data = catalogSchema.parse(data);
    this.version = catalogVersion(this.data);
  }

  private sign() {
    return (this.sig ??= new CompactSign(new TextEncoder().encode(this.version))
      .setProtectedHeader({ alg: 'ES256', kid: this.cfg.licenceKeyId })
      .sign(this.cfg.licencePrivateKey));
  }

  /** since 与当前版本一致时只回 { version, unchanged }，省流量。 */
  async get(since?: string): Promise<CatalogResponse> {
    if (since && since === this.version) return { version: this.version, unchanged: true };
    return {
      version: this.version,
      kid: this.cfg.licenceKeyId,
      signature: await this.sign(),
      issued_at: this.now().toISOString(),
      catalog: this.data,
    };
  }
}
