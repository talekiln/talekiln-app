'use strict';
// 把 场景 × 入口视图 × 故事 全部跑一遍，返回结果行；conformance.test.js 和 report.js 共用。
const S = require('./stories');
const { SCENARIOS } = require('./scenarios');
const { runScenarioOnStory } = require('./harness');

function runMatrix({ scenarios = SCENARIOS, stories = S.loadStories(), onRow } = {}) {
  const rows = [];
  for (const sc of scenarios) {
    for (const st of stories) {
      for (const r of runScenarioOnStory(sc, st)) { rows.push(r); if (onRow) onRow(r); }
    }
  }
  return rows;
}

module.exports = { runMatrix, SCENARIOS };
