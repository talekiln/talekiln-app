'use strict';
const os = require('os');
const { redactText } = require('../secrets');

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 诊断包专用脱敏：在日志脱敏（已知密钥、Bearer）之上再加一层“宁可多删”的规则。
 * 规则按顺序应用；opts.extraSecrets 为额外的精确字符串（如刚填写、尚未入库的 Key）。
 */
function redactDiagnosticText(input, opts = {}) {
  let s = redactText(String(input));
  for (const secret of opts.extraSecrets || []) {
    if (secret && String(secret).length >= 6) s = s.split(String(secret)).join('[REDACTED]');
  }
  // 私钥块（含被截断的）
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]');
  // 常见厂商 Key / JWT
  s = s.replace(/\bsk-[A-Za-z0-9_.-]{8,}/g, '[REDACTED]');
  s = s.replace(/\b(LTAI|AKIA|ASIA)[A-Za-z0-9]{12,}/g, '[REDACTED]');
  s = s.replace(/\bo1_[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED]');
  // URL 查询串里的签名/令牌
  s = s.replace(/([?&](?:Signature|X-Amz-Signature|X-Amz-Credential|OSSAccessKeyId|AccessKeyId|access_token|token|key|api_key|apikey|sig)=)[^&\s"'<>]+/gi, '$1[REDACTED]');
  // URL 内嵌凭据 https://user:pass@host
  s = s.replace(/(\bhttps?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  // key=value / "key": "value" 形式的敏感字段
  s = s.replace(/(["']?(?:api[_-]?key|secret|token|authorization|password|passwd|access[_-]?key)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}&]+)/gi, '$1"[REDACTED]"');
  // 内容类字段（提示词、脚本、对话正文）整体省略：诊断包不需要创作内容
  s = s.replace(/(["'](?:prompt|negative_prompt|system_prompt|script|content|text|messages|narration|dialogue|lyrics)["']\s*:\s*)("(?:[^"\\]|\\.)*"|\[[^\]]*\])/gi, '$1"[OMITTED]"');
  // 邮箱
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
  // 用户目录与用户名
  const homes = new Set([opts.homeDir, safeHome()].filter(Boolean));
  for (const h of homes) {
    if (h.length < 4) continue;
    // 路径分隔符 / 与 \ 视为等价（日志里可能是任一种，或被 JSON 转义成 \\）
    const pattern = h.split(/[\\/]+/).map(ESC).join('[\\\\/]+');
    s = s.replace(new RegExp(pattern, 'gi'), '~');
  }
  s = s.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, '$1<user>');
  s = s.replace(/(\/(?:home|Users)\/)[^/\s"']+/g, '$1<user>');
  return s;
}

function safeHome() {
  try { return os.homedir(); } catch (_) { return ''; }
}

module.exports = { redactDiagnosticText };
