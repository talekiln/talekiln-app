'use strict';
/**
 * 字体的平台差异（纯函数，platform 可注入，测试不依赖真实系统）。
 *
 * - libass（字幕烧录）按“字体族名”查找：Windows 用 DirectWrite、macOS 用 CoreText，各自只认本系统装的字体。
 *   “Microsoft YaHei”在 macOS 上不存在，所以 macOS 默认改用随系统自带的“PingFang SC”。
 *   Windows 与其他平台的默认值保持不变。
 * - drawtext（水印）需要字体文件路径：按平台列出候选，取第一个存在的。
 *
 * macOS 的路径与字体族名依据对 macOS 12–14 的了解，未在真机上逐一核实（见 docs/phase2-macos.md 必验清单）。
 */
const path = require('path');

function defaultSubtitleFont(platform = process.platform) {
  return platform === 'darwin' ? 'PingFang SC' : 'Microsoft YaHei';
}

/** 水印 / drawtext 字体文件候选，按优先级排列（含 CJK 覆盖）。 */
function drawtextFontCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const root = env.SystemRoot || 'C:\\Windows';
    return [
      path.win32.join(root, 'Fonts', 'msyh.ttc'),
      path.win32.join(root, 'Fonts', 'msyhbd.ttc'),
      path.win32.join(root, 'Fonts', 'simhei.ttf'),
    ];
  }
  if (platform === 'darwin') {
    // PingFang.ttc 在较新的 macOS 上不在 /System/Library/Fonts 下（改为按需下载的系统资产），不能当作必然存在；
    // 后面几个是长期随系统提供、带中文字形的字体。
    return [
      '/System/Library/Fonts/PingFang.ttc',
      '/System/Library/Fonts/STHeiti Medium.ttc',
      '/System/Library/Fonts/Hiragino Sans GB.ttc',
      '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
      '/Library/Fonts/Arial Unicode.ttf',
    ];
  }
  return [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
}

function pickDrawtextFont({ platform = process.platform, env = process.env, exists = (p) => require('fs').existsSync(p) } = {}) {
  return drawtextFontCandidates(platform, env).find((p) => exists(p)) || null;
}

module.exports = { defaultSubtitleFont, drawtextFontCandidates, pickDrawtextFont };
