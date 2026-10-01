import type { ReferralClickRepository } from '../domain/repositories';
import { ServiceError } from './errors';

export interface ReferralConfig {
  links: Map<string, string>;
  allowedHosts: Set<string>;
}

const CODE_RE = /^[a-z0-9_-]{1,40}$/;

/** 默认指向各平台密钥页（无推广参数）；推广链接通过 REFERRAL_LINKS 配置，且主机必须在白名单内。 */
const DEFAULT_LINKS: Record<string, string> = {
  bailian: 'https://bailian.console.aliyun.com/',
  ark: 'https://console.volcengine.com/ark',
  agnes: 'https://platform.agnes-ai.com/settings/apiKeys',
};

/** 校验目标：仅 https、无内嵌凭据、主机精确命中白名单。 */
export function assertAllowedTarget(raw: string, allowedHosts: Set<string>): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`推广链接不是合法 URL: ${raw}`); }
  if (u.protocol !== 'https:') throw new Error(`推广链接必须是 https: ${u.host}`);
  if (u.username || u.password) throw new Error('推广链接不得包含用户名或密码');
  if (!allowedHosts.has(u.hostname.toLowerCase())) throw new Error(`推广链接主机不在白名单内: ${u.hostname}`);
  return u.toString();
}

export function loadReferralConfig(env: NodeJS.ProcessEnv = process.env): ReferralConfig {
  const hosts = new Set<string>(Object.values(DEFAULT_LINKS).map((l) => new URL(l).hostname));
  for (const h of (env.REFERRAL_ALLOWED_HOSTS ?? '').split(',')) if (h.trim()) hosts.add(h.trim().toLowerCase());
  const raw: Record<string, string> = { ...DEFAULT_LINKS };
  if (env.REFERRAL_LINKS) {
    const extra = JSON.parse(env.REFERRAL_LINKS) as Record<string, unknown>;
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v !== 'string') throw new Error(`REFERRAL_LINKS.${k} 必须是字符串`);
      raw[k] = v;
    }
  }
  const links = new Map<string, string>();
  for (const [code, url] of Object.entries(raw)) {
    if (!CODE_RE.test(code)) throw new Error(`非法推广码: ${code}`);
    links.set(code, assertAllowedTarget(url, hosts)); // 启动时即校验，配置错误直接失败
  }
  return { links, allowedHosts: hosts };
}

export class ReferralService {
  constructor(
    private readonly cfg: ReferralConfig,
    private readonly clicks: ReferralClickRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 记录点击并返回跳转目标。目标只来自配置，绝不取自请求参数。 */
  async resolve(code: string, src?: string): Promise<string> {
    const key = String(code).toLowerCase();
    const target = CODE_RE.test(key) ? this.cfg.links.get(key) : undefined;
    if (!target) throw new ServiceError('not_found');
    const cleanSrc = src && /^[a-z0-9_.-]{1,40}$/i.test(src) ? src : null;
    try {
      await this.clicks.create({ code: key, src: cleanSrc, createdAt: this.now() });
    } catch (e) {
      console.error('[cloud] 记录推广点击失败', (e as Error).message); // 记录失败不应阻断跳转
    }
    return target;
  }
}
