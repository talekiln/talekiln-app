// 提交前/CI 密钥扫描：命中即失败。敏感信息只放本机或环境变量，不进 git。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['百炼工作空间 Key', /sk-ws-[A-Za-z0-9._-]{8,}/],
  ['sk- 风格 Key', /\bsk-[A-Za-z0-9]{20,}/],
  ['阿里云 AccessKey', /\bLTAI[A-Za-z0-9]{12,}/],
  ['AWS AccessKey', /\bAKIA[0-9A-Z]{16}\b/],
  ['私钥', /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['长 Bearer 令牌', /Bearer\s+[A-Za-z0-9._-]{24,}/],
  ['百炼 CLI 安装令牌', /\bo1_[A-Za-z0-9_-]{30,}/],
  ['带签名的下载链接', /[?&](Signature|X-Amz-Signature|OSSAccessKeyId)=/],
  ['百炼工作空间域名', /\bws-[a-z0-9]{12,}\.[a-z0-9-]+\.maas\.aliyuncs\.com/i],
];
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const bad = [];
for (const f of files) {
  if (f === 'scripts/secret-scan.mjs' || /\.(png|jpg|jpeg|gif|ico|woff2?|zip|mp3|mp4)$/i.test(f)) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line)) bad.push(`${f}:${i + 1}  ${name}`);
  });
}
if (bad.length) { console.error('发现疑似密钥（内容未打印）：\n' + bad.join('\n')); process.exit(1); }
console.log(`密钥扫描通过（${files.length} 个文件）`);
