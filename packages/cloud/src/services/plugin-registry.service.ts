import { z } from 'zod';
import { ServiceError } from './errors';
import type { AppConfig } from './config';
import { pluginHash, pluginSigningPayload, signPluginPayload } from './plugin-signing';
import type { PluginReviewRecord, PluginReviewStatus, PluginVersionRecord, Repositories } from '../domain/repositories';

// ---------------------------------------------------------------------------
// manifest 规则：与 @talekiln/plugin-sdk validateManifest 一致（云端镜像不含 SDK，这里复刻）。
// sdkVersion 与宿主 SDK 的兼容性由客户端安装时检查，云端只校验形状。
// ---------------------------------------------------------------------------
const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const ENTRY_RE = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|cjs)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
export const PLUGIN_CAPABILITIES = ['llm.chat', 'image.generate', 'video.submit', 'video.poll', 'tts.synthesize'] as const;
const OTHER_PERMISSIONS = ['secret:apiKey'];

/** 相对路径且不出插件目录：正斜杠、无空段 / . / ..、无盘符、无控制字符或反斜杠。 */
export function safeRelativePath(p: string): boolean {
  if (typeof p !== 'string' || !p || p.length > 512 || /[\0-\x1f\\]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export const pluginManifestSchema = z.object({
  name: z.string().regex(NAME_RE, 'name 需为 ^[a-z][a-z0-9-]{1,39}$'),
  version: z.string().regex(SEMVER_RE, 'version 需为语义化版本'),
  sdkVersion: z.string().regex(SEMVER_RE, 'sdkVersion 需为语义化版本'),
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).min(1),
  permissions: z.array(z.string().max(300)),
  entry: z.string().max(512).regex(ENTRY_RE, 'entry 需为插件目录内的相对 .js/.cjs 路径'),
  label: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  homepage: z.string().max(500).optional(),
  files: z.array(z.string().max(512)).min(1),
}).strict().superRefine((m, ctx) => {
  const caps = new Set(m.capabilities);
  if (caps.size !== m.capabilities.length) ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'capabilities 重复' });
  if (caps.has('video.submit') !== caps.has('video.poll')) ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'video.submit 与 video.poll 必须同时声明' });
  let hasNet = false;
  for (const p of m.permissions) {
    if (p.startsWith('network:')) {
      hasNet = true;
      if (!HOST_RE.test(p.slice(8))) ctx.addIssue({ code: 'custom', path: ['permissions'], message: `非法的网络权限：${p}` });
    } else if (!OTHER_PERMISSIONS.includes(p)) ctx.addIssue({ code: 'custom', path: ['permissions'], message: `未知权限：${p}` });
  }
  if (!hasNet) ctx.addIssue({ code: 'custom', path: ['permissions'], message: '至少声明一个 network:<host>' });
  if (m.entry.split('/').includes('..')) ctx.addIssue({ code: 'custom', path: ['entry'], message: 'entry 不能含 ..' });
  const seen = new Set<string>();
  for (const f of m.files) {
    if (!safeRelativePath(f)) ctx.addIssue({ code: 'custom', path: ['files'], message: `非法的文件路径：${f}` });
    if (seen.has(f)) ctx.addIssue({ code: 'custom', path: ['files'], message: `文件重复：${f}` });
    seen.add(f);
  }
  if (!seen.has(m.entry)) ctx.addIssue({ code: 'custom', path: ['files'], message: 'files 必须包含 entry' });
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const pluginSubmitSchema = z.object({
  manifest: pluginManifestSchema,
  /** 每个 files 条目的 sha256（由 SDK 的 hashFiles 计算）。 */
  fileHashes: z.record(z.string().max(512), z.string().regex(SHA256_RE, '需为 64 位十六进制 sha256')),
  packageUrl: z.string().url().max(1000).refine((u) => u.startsWith('https://'), '下载地址必须是 https'),
  sha256: z.string().regex(SHA256_RE, '需为 64 位十六进制 sha256'),
  notes: z.string().max(2000).default(''),
}).superRefine((b, ctx) => {
  const keys = Object.keys(b.fileHashes).sort();
  const files = [...b.manifest.files].sort();
  if (keys.length !== files.length || keys.some((k, i) => k !== files[i])) {
    ctx.addIssue({ code: 'custom', path: ['fileHashes'], message: 'fileHashes 的键必须与 manifest.files 一一对应' });
  }
});

export const pluginListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(200).catch(100),
});
const notesBody = z.object({ notes: z.string().max(2000).default('') });

export interface PluginActor { accountId: string; email: string }

const isUnique = (e: unknown) => (e as { code?: string }).code === 'P2002' || (e as Error).message?.startsWith('unique:');

/** 发布者要随包发布的 manifest.json：提交的 manifest + 官方签名。 */
export function signedManifest(v: PluginVersionRecord): Record<string, unknown> | null {
  return v.signature ? { ...v.manifest, signature: v.signature } : null;
}

export function pluginVersionView(v: PluginVersionRecord, reviews?: PluginReviewRecord[]) {
  const m = v.manifest as Partial<PluginManifest>;
  return {
    id: v.id, pluginId: v.pluginId, name: v.pluginName, version: v.version, label: m.label ?? v.pluginName,
    manifest: v.manifest, fileHashes: v.fileHashes, hash: v.hash, packageUrl: v.packageUrl, sha256: v.sha256,
    signature: v.signature, signedAt: v.signedAt, signedBy: v.signedBy, signedManifest: signedManifest(v),
    reviewStatus: v.reviewStatus, reviewedAt: v.reviewedAt, reviewedBy: v.reviewedBy, submittedBy: v.submittedBy,
    createdAt: v.createdAt, updatedAt: v.updatedAt,
    ...(reviews ? { reviews } : {}),
  };
}

/**
 * 插件注册表：登记版本 -> 审核（通过/驳回）-> 用官方密钥签名 -> 进入公开目录。
 * 云端不下载也不执行插件包：审核员须按 packageUrl 取包、核对 sha256，并用 SDK 的 sign-plugin.mjs --inspect
 * 核对指纹（hash）与这里登记的一致后再通过。签名一旦发出不可撤回（只能换密钥），驳回已签名版本只是把它撤出目录。
 */
export class PluginRegistryService {
  constructor(
    private readonly repos: Repositories,
    private readonly cfg: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async submit(actor: PluginActor, input: unknown) {
    const b = pluginSubmitSchema.parse(input);
    const now = this.now();
    const manifest = b.manifest as Record<string, unknown>;
    const hash = pluginHash(pluginSigningPayload(manifest, b.fileHashes));
    const plugin = await this.repos.plugins.upsertPlugin({ name: b.manifest.name, label: b.manifest.label ?? b.manifest.name, homepage: b.manifest.homepage ?? null }, now);
    let version: PluginVersionRecord;
    try {
      version = await this.repos.plugins.createVersion({
        pluginId: plugin.id, version: b.manifest.version, manifest, fileHashes: b.fileHashes, hash,
        packageUrl: b.packageUrl, sha256: b.sha256, submittedBy: actor.accountId,
      }, now);
    } catch (e) {
      if (isUnique(e)) throw new ServiceError('conflict', `插件 ${b.manifest.name} 已登记过版本 ${b.manifest.version}，请提升版本号`);
      throw e;
    }
    await this.review(version.id, 'submit', b.notes, actor, now);
    return pluginVersionView(version);
  }

  async list(query: unknown) {
    const q = pluginListQuery.parse(query);
    return (await this.repos.plugins.listVersions({ reviewStatus: q.status, limit: q.limit })).map((v) => pluginVersionView(v));
  }

  async get(id: string) {
    const v = await this.repos.plugins.findVersion(id);
    if (!v) throw new ServiceError('not_found');
    return pluginVersionView(v, await this.repos.plugins.listReviews(id));
  }

  async approve(actor: PluginActor, id: string, input: unknown) {
    const { notes } = notesBody.parse(input ?? {});
    const v = await this.load(id);
    if (v.reviewStatus === 'approved') throw new ServiceError('conflict', '该版本已通过审核');
    const now = this.now();
    const next = (await this.repos.plugins.setReview(id, { reviewStatus: 'approved', reviewedAt: now, reviewedBy: actor.accountId }, now))!;
    await this.review(id, 'approve', notes, actor, now);
    return pluginVersionView(next);
  }

  async reject(actor: PluginActor, id: string, input: unknown) {
    const { notes } = notesBody.parse(input ?? {});
    const v = await this.load(id);
    if (v.reviewStatus === 'rejected') throw new ServiceError('conflict', '该版本已被驳回');
    const now = this.now();
    const next = (await this.repos.plugins.setReview(id, { reviewStatus: 'rejected', reviewedAt: now, reviewedBy: actor.accountId }, now))!;
    await this.review(id, 'reject', notes, actor, now);
    return pluginVersionView(next);
  }

  /** 用许可证/目录同一把 ES256 私钥签名；只签已通过审核的版本；同一密钥不重复签，换密钥后可再签。 */
  async sign(actor: PluginActor, id: string, input: unknown) {
    const { notes } = notesBody.parse(input ?? {});
    const v = await this.load(id);
    if (v.reviewStatus !== 'approved') throw new ServiceError('conflict', '只能给已通过审核的版本签名');
    if (v.signature && v.signature.kid === this.cfg.licenceKeyId) throw new ServiceError('conflict', '该版本已用当前密钥签名');
    const payload = pluginSigningPayload(v.manifest, v.fileHashes);
    if (pluginHash(payload) !== v.hash) throw new ServiceError('conflict', '登记的指纹与 manifest 不一致，请重新提交');
    const now = this.now();
    const signature = signPluginPayload(payload, this.cfg.licencePrivateKey, this.cfg.licenceKeyId);
    const next = (await this.repos.plugins.setSignature(id, { signature, signedAt: now, signedBy: actor.accountId }, now))!;
    await this.review(id, 'sign', notes, actor, now);
    return pluginVersionView(next);
  }

  /** 公开目录：只含已通过审核的版本，按插件分组；未签名的版本也列出（signed=false），客户端只把带签名的当官方。 */
  async catalog() {
    const versions = await this.repos.plugins.listVersions({ reviewStatus: 'approved', limit: 1000 });
    const plugins = new Map<string, { name: string; label: string; homepage: string | null; versions: ReturnType<typeof catalogVersion>[] }>();
    for (const v of versions) {
      const m = v.manifest as Partial<PluginManifest>;
      const g = plugins.get(v.pluginName) ?? { name: v.pluginName, label: m.label ?? v.pluginName, homepage: m.homepage ?? null, versions: [] };
      g.versions.push(catalogVersion(v));
      plugins.set(v.pluginName, g);
    }
    return {
      generated_at: this.now().toISOString(),
      kid: this.cfg.licenceKeyId,
      plugins: [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  private async load(id: string) {
    const v = await this.repos.plugins.findVersion(id);
    if (!v) throw new ServiceError('not_found');
    return v;
  }

  private review(versionId: string, action: PluginReviewRecord['action'], notes: string, actor: PluginActor, now: Date) {
    return this.repos.plugins.addReview({ versionId, action, notes, actorId: actor.accountId, actorEmail: actor.email, createdAt: now });
  }
}

function catalogVersion(v: PluginVersionRecord) {
  const m = v.manifest as Partial<PluginManifest>;
  return {
    version: v.version, sdkVersion: m.sdkVersion ?? null, capabilities: m.capabilities ?? [], permissions: m.permissions ?? [],
    manifest: signedManifest(v) ?? v.manifest, signed: !!v.signature, kid: v.signature?.kid ?? null,
    hash: v.hash, packageUrl: v.packageUrl, sha256: v.sha256, reviewedAt: v.reviewedAt, signedAt: v.signedAt,
  };
}

export type { PluginReviewStatus };
