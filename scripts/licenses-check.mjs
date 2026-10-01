// 依赖许可证检查：遇到 GPL / AGPL 退出码 1；LGPL 与未知许可证仅告警。
import { execSync } from 'node:child_process';

const out = execSync('pnpm licenses list --json', { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const byLicense = JSON.parse(out);
const fail = [];
const warn = [];
for (const [lic, pkgs] of Object.entries(byLicense)) {
  const names = pkgs.map((p) => `${p.name}@${p.versions.join(',')}`);
  // 复合表达式（A OR B）只要有一个非 GPL 选项即视为可用
  const options = lic.replace(/[()]/g, '').split(/\s+OR\s+/i);
  const isStrong = (o) => /^(A?GPL)/i.test(o.trim());
  if (options.every(isStrong)) fail.push([lic, names]);
  else if (/LGPL|unknown|unlicensed|see license/i.test(lic)) warn.push([lic, names]);
}
for (const [l, n] of warn) console.warn(`WARN  ${l}: ${n.join(', ')}`);
for (const [l, n] of fail) console.error(`FAIL  ${l}: ${n.join(', ')}`);
if (fail.length) process.exit(1);
console.log(`licenses:check OK（${Object.keys(byLicense).length} 种许可证，${warn.length} 项告警）`);
