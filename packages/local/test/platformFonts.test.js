'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultSubtitleFont, drawtextFontCandidates, pickDrawtextFont } = require('../src/utils/platformFonts');

test('subtitle font: PingFang SC on macOS, Microsoft YaHei elsewhere (Windows unchanged)', () => {
  assert.equal(defaultSubtitleFont('darwin'), 'PingFang SC');
  assert.equal(defaultSubtitleFont('win32'), 'Microsoft YaHei');
  assert.equal(defaultSubtitleFont('linux'), 'Microsoft YaHei');
});

test('drawtext candidates are platform specific and never cross over', () => {
  const win = drawtextFontCandidates('win32', { SystemRoot: 'D:\\Win' });
  assert.deepEqual(win.slice(0, 1), ['D:\\Win\\Fonts\\msyh.ttc']);
  const mac = drawtextFontCandidates('darwin', {});
  assert.ok(mac.every((p) => p.startsWith('/')));
  assert.ok(mac.some((p) => p.includes('Hiragino') || p.includes('STHeiti') || p.includes('Arial Unicode')), 'has a fallback that still ships on newer macOS');
  assert.ok(!mac.some((p) => /msyh/i.test(p)));
  assert.ok(!win.some((p) => p.includes('/System/Library')));
});

test('pickDrawtextFont: first existing candidate, null when none', () => {
  const mac = drawtextFontCandidates('darwin', {});
  assert.equal(pickDrawtextFont({ platform: 'darwin', exists: (p) => p === mac[2] }), mac[2]);
  assert.equal(pickDrawtextFont({ platform: 'darwin', exists: () => false }), null);
  // PingFang.ttc missing (newer macOS) must not stop the lookup
  assert.equal(pickDrawtextFont({ platform: 'darwin', exists: (p) => !p.includes('PingFang') && p.includes('STHeiti') }), '/System/Library/Fonts/STHeiti Medium.ttc');
});

test('default subtitle style uses the platform default font', () => {
  const { DEFAULT_STYLE } = require('../src/subtitles');
  assert.equal(DEFAULT_STYLE.fontName, defaultSubtitleFont(process.platform));
});
