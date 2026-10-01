'use strict';
// 录制测试数据前统一脱敏：Key、Authorization、工作空间域名、带签名的下载链接。
// 所有写入 test/fixtures 的真实响应都必须先过这里。

const RULES = [
  [/sk-[A-Za-z0-9._-]{8,}/g, 'sk-REDACTED'],
  [/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1REDACTED'],
  [/("?authorization"?\s*[:=]\s*"?)[^",}\s]+/gi, '$1REDACTED'],
  [/\bo1_[A-Za-z0-9._-]{20,}/g, 'o1_REDACTED'],
  [/\bLTAI[A-Za-z0-9]{12,}/g, 'LTAI_REDACTED'],
  [/\bws-[a-z0-9]{12,}(\.[a-z0-9-]+\.maas\.aliyuncs\.com)/gi, 'ws-example$1'],
  [/https?:\/\/[^\s"']+[?&](Signature|X-Amz-Signature|OSSAccessKeyId|Expires)=[^\s"']*/g, 'https://example.invalid/redacted'],
];

/** Redact a string, plus any extra exact secrets (e.g. the key from the environment). */
function redact(text, extraSecrets = []) {
  let out = String(text);
  for (const s of extraSecrets.filter((x) => x && x.length >= 6)) out = out.split(s).join('REDACTED');
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

module.exports = { redact };
