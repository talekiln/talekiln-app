import { createHash } from 'node:crypto';
import { CompactSign } from 'jose';
import { z } from 'zod';
import { canonicalJson } from './catalog.service';
import type { AppConfig } from './config';
import { ServiceError } from './errors';
import type { Repositories, TemplateRecord, TemplateVersionRecord } from '../domain/repositories';

/**
 * P3-T 模板市场（云端）：模板 + 版本管理、官方签名、公开目录。
 *
 * 清单格式与本地 packages/local/src/templates/schema.js 保持一致（规则两边各实现一份，测试里用同一份内置模板互相校验）。
 * 签名：对 'tpl-' + sha256(canonicalJson(清单)) 做 ES256 紧凑 JWS，header 带 kid；密钥与许可证/模型目录共用，
 * 客户端用 /.well-known/licence-jwks.json 验签，验签通过的模板标为「官方」。
 */
const SLOT_RE = /^[a-z][a-z0-9_]{0,31}$/;
const RESERVED = new Set(['scene', 'style']);
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

const lineSchema = z.object({
  kind: z.enum(['narration', 'dialogue', 'action']),
  speaker: z.string().max(32).optional(),
  text: z.string().trim().min(1).max(2000),
});

const shotSchema = z.object({
  title: z.string().trim().min(1).max(100),
  duration_ms: z.number().int().min(1).max(600_000),
  prompt_template: z.string().trim().min(1).max(4000),
  character_slots: z.array(z.string().max(32)).default([]),
  scene_slot: z.string().max(500).nullable().optional(),
  camera: z.string().max(200).nullable().optional(),
  group: z.string().max(100).nullable().optional(),
  lines: z.array(lineSchema).max(50).optional(),
});

export const manifestSchema = z.object({
  id: z.string().regex(TEMPLATE_ID_RE, 'id 须为 2–64 位小写字母、数字、点、下划线或连字符'),
  name: z.string().trim().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version 须为 x.y.z'),
  genre: z.string().trim().min(1).max(40),
  tier: z.enum(['free', 'pro']),
  description: z.string().max(2000).optional(),
  cover: z.string().max(1000).nullable().optional(),
  music_hint: z.string().max(500).nullable().optional(),
  style: z.object({
    name: z.string().trim().min(1).max(50),
    prompt: z.string().trim().min(1).max(2000),
    preset: z.string().max(50).optional(),
    aspect_ratio: z.string().regex(/^\d+:\d+$/).optional(),
  }),
  character_slots: z.array(z.object({
    id: z.string().regex(SLOT_RE, '槽位 id 须为小写字母开头的字母数字下划线'),
    name: z.string().trim().min(1).max(50),
    description: z.string().max(1000).optional(),
    appearance: z.string().max(1000).optional(),
    role: z.string().max(50).optional(),
  })).max(12),
  shots: z.array(shotSchema).min(1).max(60),
}).superRefine((m, ctx) => {
  const slots = new Set<string>();
  m.character_slots.forEach((s, i) => {
    if (RESERVED.has(s.id)) ctx.addIssue({ code: 'custom', path: ['character_slots', i, 'id'], message: `槽位 id 不能用保留字 ${s.id}` });
    if (slots.has(s.id)) ctx.addIssue({ code: 'custom', path: ['character_slots', i, 'id'], message: `槽位 id 重复：${s.id}` });
    slots.add(s.id);
  });
  m.shots.forEach((s, i) => {
    for (const id of s.character_slots) if (!slots.has(id)) ctx.addIssue({ code: 'custom', path: ['shots', i, 'character_slots'], message: `引用了未声明的槽位：${id}` });
    for (const mt of s.prompt_template.matchAll(PLACEHOLDER_RE)) {
      const ph = mt[1];
      if (RESERVED.has(ph)) continue;
      if (!slots.has(ph)) ctx.addIssue({ code: 'custom', path: ['shots', i, 'prompt_template'], message: `占位符 {{${ph}}} 不是已声明的槽位` });
      else if (!s.character_slots.includes(ph)) ctx.addIssue({ code: 'custom', path: ['shots', i, 'character_slots'], message: `提示词用到 {{${ph}}}，但 character_slots 没有列出` });
    }
    (s.lines ?? []).forEach((l, j) => {
      if (l.speaker && !slots.has(l.speaker)) ctx.addIssue({ code: 'custom', path: ['shots', i, 'lines', j, 'speaker'], message: `speaker 须为已声明的槽位：${l.speaker}` });
    });
  });
});
export type TemplateManifest = z.infer<typeof manifestSchema>;

export const templateCreateSchema = z.object({
  id: z.string().regex(TEMPLATE_ID_RE),
  name: z.string().trim().min(1).max(100),
  genre: z.string().trim().min(1).max(40),
  tier: z.enum(['free', 'pro']).default('free'),
  description: z.string().max(2000).default(''),
});
export const templatePatchSchema = templateCreateSchema.omit({ id: true }).partial();
export const versionCreateSchema = z.object({
  manifest: z.unknown(),
  packageUrl: z.string().url().max(1000).nullable().optional(),
});

/** 清单摘要的十六进制（存库），签名载荷是 'tpl-' + 它。与本地 templates/schema.js 的 templateDigest 一致。 */
export function manifestSha256(manifest: unknown): string {
  const { signature: _sig, ...rest } = (manifest ?? {}) as Record<string, unknown>;
  void _sig;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}
export const templateDigest = (manifest: unknown) => 'tpl-' + manifestSha256(manifest);

/** 公开目录条目：清单里嵌入 signature，客户端安装时验签。 */
export function catalogItem(v: TemplateVersionRecord) {
  return {
    id: v.templateId, version: v.version, tier: v.tier, sha256: v.sha256, kid: v.kid, packageUrl: v.packageUrl,
    published_at: v.publishedAt ? v.publishedAt.toISOString() : null,
    manifest: { ...(v.manifest as Record<string, unknown>), signature: v.signature },
  };
}

const isUnique = (e: unknown) => {
  const msg = e instanceof Error ? e.message : '';
  return msg.startsWith('unique:') || (e as { code?: string }).code === 'P2002';
};

export class TemplateService {
  constructor(
    private readonly repos: Repositories,
    private readonly cfg: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private sign(digest: string) {
    return new CompactSign(new TextEncoder().encode(digest))
      .setProtectedHeader({ alg: 'ES256', kid: this.cfg.licenceKeyId })
      .sign(this.cfg.licencePrivateKey);
  }

  /** 全部模板及各自的版本（新建的在前）。 */
  async list() {
    const ts = await this.repos.templates.list();
    return Promise.all(ts.map(async (t) => ({ ...t, versions: await this.repos.templates.listVersions(t.id) })));
  }

  async get(id: string) {
    const t = await this.repos.templates.findById(id);
    if (!t) throw new ServiceError('not_found');
    return { ...t, versions: await this.repos.templates.listVersions(id) };
  }

  async create(input: unknown): Promise<TemplateRecord> {
    const b = templateCreateSchema.parse(input);
    try {
      return await this.repos.templates.create(b, this.now());
    } catch (e) {
      if (isUnique(e)) throw new ServiceError('conflict', `模板 ${b.id} 已存在`);
      throw e;
    }
  }

  async update(id: string, input: unknown): Promise<TemplateRecord> {
    const patch = templatePatchSchema.parse(input);
    const r = await this.repos.templates.update(id, patch, this.now());
    if (!r) throw new ServiceError('not_found');
    return r;
  }

  async remove(id: string) {
    if (!(await this.repos.templates.delete(id))) throw new ServiceError('not_found');
  }

  /**
   * 新增版本：校验清单（id 必须等于模板 id）、算摘要、签名、入库；并把模板的名字/类型/档位/简介同步成清单里的值。
   * 新版本默认未发布。
   */
  async addVersion(templateId: string, input: unknown): Promise<TemplateVersionRecord> {
    const b = versionCreateSchema.parse(input);
    const t = await this.repos.templates.findById(templateId);
    if (!t) throw new ServiceError('not_found');
    const parsed = manifestSchema.safeParse(b.manifest);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ServiceError('bad_request', `清单不合法：${first.path.join('.')}${first.path.length ? '：' : ''}${first.message}`);
    }
    const manifest = parsed.data;
    if (manifest.id !== templateId) throw new ServiceError('bad_request', `清单的 id（${manifest.id}）与模板 id（${templateId}）不一致`);
    const sha256 = manifestSha256(manifest);
    const signature = await this.sign('tpl-' + sha256);
    const now = this.now();
    let v: TemplateVersionRecord;
    try {
      v = await this.repos.templates.addVersion({
        templateId, version: manifest.version, manifest, packageUrl: b.packageUrl ?? null, sha256, signature, kid: this.cfg.licenceKeyId, tier: manifest.tier,
      }, now);
    } catch (e) {
      if (isUnique(e)) throw new ServiceError('conflict', `版本 ${manifest.version} 已存在`);
      throw e;
    }
    await this.repos.templates.update(templateId, { name: manifest.name, genre: manifest.genre, tier: manifest.tier, description: manifest.description ?? '' }, now);
    return v;
  }

  private async version(templateId: string, versionId: string) {
    const v = await this.repos.templates.findVersion(versionId);
    if (!v || v.templateId !== templateId) throw new ServiceError('not_found');
    return v;
  }

  async publish(templateId: string, versionId: string) {
    await this.version(templateId, versionId);
    return (await this.repos.templates.setPublished(versionId, true, this.now()))!;
  }

  async unpublish(templateId: string, versionId: string) {
    await this.version(templateId, versionId);
    return (await this.repos.templates.setPublished(versionId, false, this.now()))!;
  }

  /** 公开目录：每个模板最近发布的那个版本。 */
  async catalog() {
    const seen = new Set<string>();
    const items = [];
    for (const v of await this.repos.templates.listPublished()) {
      if (seen.has(v.templateId)) continue;
      seen.add(v.templateId);
      items.push(catalogItem(v));
    }
    return { items, kid: this.cfg.licenceKeyId, issued_at: this.now().toISOString() };
  }
}
