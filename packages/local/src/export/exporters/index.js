'use strict';
// 纯函数导出器：输入内核 timelineView 投影（asset_ref 已解析成本机绝对路径），输出 { files, stats, warnings }。零网络、零文件系统。
const { buildJianyingDraft } = require('./jianying');
const { buildXmeml } = require('./xmeml');
const { buildFcpxml } = require('./fcpxml');
const { buildSrt } = require('./common');
const { PLATFORM_PRESETS, findPreset } = require('./presets');
const paths = require('./paths');

module.exports = { buildJianyingDraft, buildXmeml, buildFcpxml, buildSrt, PLATFORM_PRESETS, findPreset, paths };
