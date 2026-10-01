import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from './errors';
import type { ReleaseChannel, ReleaseRecord, Repositories } from '../domain/repositories';

// ---------------------------------------------------------------------------
// 语义化版本（主.次.修订[-预发布][+构建]）。构建元数据不参与比较。
// ---------------------------------------------------------------------------
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion { major: number; minor: number; patch: number; pre: string[] }

export function parseVersion(v: string): ParsedVersion | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

export const isVersion = (v: string) => parseVersion(v) !== null;

/** a<b 返回负数，相等 0，a>b 返回正数。非法版本号抛错（调用方先校验）。 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`invalid version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1; // 有预发布的更小
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1; // 数字标识符小于字母标识符
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 灰度分档：同一设备对同一发布永远落在同一档，结果与请求次数、时间、服务器实例无关。
// 档位 = sha256("talekiln-rollout|<通道>|<版本>|<设备号>") 前 4 字节 mod 100。
// 加入通道与版本作盐：同一设备在不同发布里的档位互相独立（不会总是“第一批”）；
// 提高灰度百分比只会纳入更多设备，已命中的设备不会丢失。
// ---------------------------------------------------------------------------
export function rolloutBucket(deviceId: string, channel: ReleaseChannel, version: string): number {
  const h = createHash('sha256').update(`talekiln-rollout|${channel}|${version}|${deviceId}`).digest();
  return h.readUInt32BE(0) % 100;
}

export type RolloutPick = Pick<ReleaseRecord, 'version' | 'channel' | 'rolloutPercent' | 'minVersion' | 'forced' | 'notes'>;

export type UpdateDecision =
  | { update: false }
  | { update: true; version: string; channel: ReleaseChannel; notes: string; forced: boolean; minVersion: string | null; rolloutPercent: number };

/** 某通道的客户端可见的发布通道：beta 同时看 beta 与 stable，stable 只看 stable。 */
export const visibleChannels = (channel: ReleaseChannel): ReleaseChannel[] => (channel === 'beta' ? ['beta', 'stable'] : ['stable']);

/**
 * 纯函数：给定当前版本、通道、设备号与全部已启用发布，决定是否提示更新。
 * 在版本号高于当前版本的发布里，取最新的、且该设备命中灰度的一个；没有 deviceId 时只命中 100% 的发布。
 * forced = 发布自带强制标记，或当前版本低于该发布的 minVersion。
 */
export function decideUpdate(current: string, channel: ReleaseChannel, deviceId: string | undefined, releases: RolloutPick[]): UpdateDecision {
  const chans = visibleChannels(channel);
  const candidates = releases
    .filter((r) => chans.includes(r.channel) && compareVersions(r.version, current) > 0)
    // 版本高者优先；同版本时 stable 优先于 beta
    .sort((a, b) => compareVersions(b.version, a.version) || (a.channel === b.channel ? 0 : a.channel === 'stable' ? -1 : 1));
  for (const r of candidates) {
    const hit = r.rolloutPercent >= 100 || (r.rolloutPercent > 0 && deviceId !== undefined && rolloutBucket(deviceId, r.channel, r.version) < r.rolloutPercent);
    if (!hit) continue;
    return {
      update: true, version: r.version, channel: r.channel, notes: r.notes,
      forced: r.forced || (r.minVersion !== null && compareVersions(current, r.minVersion) < 0),
      minVersion: r.minVersion, rolloutPercent: r.rolloutPercent,
    };
  }
  return { update: false };
}

const version = z.string().max(64).refine(isVersion, '版本号需为语义化版本，如 1.2.3 或 1.3.0-beta.1');
const percent = z.number().int().min(0).max(100);

export const releaseCreateSchema = z.object({
  version,
  channel: z.enum(['beta', 'stable']),
  rolloutPercent: percent.default(0),
  minVersion: version.nullable().default(null),
  forced: z.boolean().default(false),
  notes: z.string().max(2000).default(''),
  enabled: z.boolean().default(true),
});
/** 发布创建后版本号与通道不可改（要改就新建一条）；其余字段可调。 */
export const releasePatchSchema = z.object({
  rolloutPercent: percent,
  minVersion: version.nullable(),
  forced: z.boolean(),
  notes: z.string().max(2000),
  enabled: z.boolean(),
}).partial();

export const updateCheckQuery = z.object({
  version,
  channel: z.enum(['beta', 'stable']).default('stable'),
  deviceId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional(),
});

const isUnique = (e: unknown) => (e as { code?: string }).code === 'P2002' || (e as Error).message?.startsWith('unique:');

export class ReleaseService {
  constructor(private readonly repos: Repositories, private readonly now: () => Date = () => new Date()) {}

  list() { return this.repos.releases.list(); }

  async create(input: unknown) {
    const b = releaseCreateSchema.parse(input);
    if (b.minVersion && compareVersions(b.minVersion, b.version) > 0) throw new ServiceError('bad_request', '最低版本不能高于发布版本');
    try {
      return await this.repos.releases.create(b, this.now());
    } catch (e) {
      if (isUnique(e)) throw new ServiceError('conflict', '该通道已有同一版本号的发布');
      throw e;
    }
  }

  async update(id: string, input: unknown) {
    const patch = releasePatchSchema.parse(input);
    const cur = await this.repos.releases.findById(id);
    if (!cur) throw new ServiceError('not_found');
    const min = patch.minVersion === undefined ? cur.minVersion : patch.minVersion;
    if (min && compareVersions(min, cur.version) > 0) throw new ServiceError('bad_request', '最低版本不能高于发布版本');
    return (await this.repos.releases.update(id, patch, this.now()))!;
  }

  /** 客户端检查更新。 */
  async check(query: unknown): Promise<UpdateDecision> {
    const q = updateCheckQuery.parse(query);
    const releases = await this.repos.releases.listEnabled(visibleChannels(q.channel));
    return decideUpdate(q.version, q.channel, q.deviceId, releases);
  }
}
