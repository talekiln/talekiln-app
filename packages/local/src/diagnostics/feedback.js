'use strict';

// 与云端 /feedback 的限制保持一致（云端以 MAX_DIAGNOSTIC_BYTES 为准，这里提前拦截省流量）
const MAX_BUNDLE_BYTES = 1_500_000;
const MAX_MESSAGE = 4000;

/**
 * 把反馈（可带诊断包）发给云端。只在用户明确点“发送”后调用；不会自动上传。
 * 返回 { id }；失败抛出带 code 的 Error。
 */
async function submitFeedback({ baseUrl, message, bundle, taskId, contact, installId, appVersion, fetchImpl = fetch, maxBundleBytes = MAX_BUNDLE_BYTES, timeoutMs = 20000 }) {
  const err = (code, msg) => Object.assign(new Error(msg), { code });
  if (!baseUrl) throw err('NO_CLOUD_URL', '未配置云端地址');
  const text = String(message || '').trim();
  if (!text) throw err('EMPTY_MESSAGE', '请填写问题描述');
  if (text.length > MAX_MESSAGE) throw err('MESSAGE_TOO_LONG', `描述不能超过 ${MAX_MESSAGE} 字`);
  if (bundle && bundle.length > maxBundleBytes) throw err('BUNDLE_TOO_LARGE', '诊断包过大，请缩短日志范围后重试');
  const body = { message: text };
  if (bundle) body.diagnostic = bundle.toString('base64');
  if (taskId) body.taskId = taskId;
  if (contact) body.contact = contact;
  if (installId) body.installId = installId;
  if (appVersion) body.appVersion = appVersion;
  const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) throw err(res.status === 429 ? 'RATE_LIMITED' : (json && json.error) || 'HTTP_' + res.status, (json && json.message) || `云端返回 ${res.status}`);
  return { id: json && json.id };
}

module.exports = { submitFeedback, MAX_BUNDLE_BYTES, MAX_MESSAGE };
