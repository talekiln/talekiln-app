import { z } from 'zod';
import type { AppConfig } from './config';
import { ServiceError } from './errors';
import type { Repositories } from '../domain/repositories';

export const MAX_MESSAGE = 4000;

export const feedbackBody = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE),
  contact: z.string().trim().max(200).optional(),
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  installId: z.string().regex(/^[A-Za-z0-9-]{16,64}$/).optional(),
  appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
  /** 诊断包（zip）的 base64。 */
  diagnostic: z.string().max(4_000_000).optional(),
}).strict();

/** 服务端兜底脱敏：用户可能把 Key 粘进反馈文字。客户端诊断包已先行脱敏，这里不解析 zip 内容。 */
export function scrubText(s: string): string {
  return s
    .replace(/(Bearer|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b(LTAI|AKIA)[A-Za-z0-9]{12,}/g, '[REDACTED]');
}

export class FeedbackService {
  constructor(
    private readonly repos: Repositories,
    private readonly cfg: AppConfig,
  ) {}

  async submit(input: unknown, accountId: string | null = null) {
    const b = feedbackBody.parse(input);
    let diagnostic: Buffer | null = null;
    if (b.diagnostic) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b.diagnostic)) throw new ServiceError('bad_request', '诊断包不是有效的 base64');
      // 先按 base64 长度估算再解码，避免为超大输入分配内存
      if (Math.floor((b.diagnostic.length * 3) / 4) > this.cfg.maxDiagnosticBytes + 3) throw new ServiceError('payload_too_large');
      diagnostic = Buffer.from(b.diagnostic, 'base64');
      if (diagnostic.length > this.cfg.maxDiagnosticBytes) throw new ServiceError('payload_too_large');
      if (diagnostic.length < 4 || diagnostic.readUInt32LE(0) !== 0x04034b50) throw new ServiceError('bad_request', '诊断包必须是 zip');
    }
    const rec = await this.repos.feedback.create({
      accountId, installId: b.installId ?? null, contact: b.contact || null,
      message: scrubText(b.message), taskId: b.taskId ?? null, appVersion: b.appVersion ?? null,
      diagnostic, diagnosticSize: diagnostic?.length ?? 0,
    });
    return { id: rec.id };
  }

  list(limit = 100) { return this.repos.feedback.list(Math.min(Math.max(limit, 1), 200)); }

  async diagnostic(id: string) {
    const f = await this.repos.feedback.findById(id);
    if (!f || !f.diagnostic) throw new ServiceError('not_found');
    return { id: f.id, data: f.diagnostic };
  }
}
