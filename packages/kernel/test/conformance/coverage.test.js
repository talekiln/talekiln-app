'use strict';
// 套件自检：样例故事齐全；每个场景恰好属于一个分片；分片里没有不存在的场景。
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./stories');
const { SCENARIOS } = require('./scenarios');
const { SHARDS } = require('./define');

test('样例故事：10 个真实 scriptgen 输出 + 3 个手写边界故事', () => {
  const stories = S.loadStories();
  assert.equal(stories.filter((s) => s.origin === 'recorded-real').length, 10);
  assert.equal(stories.filter((s) => s.origin === 'hand-written').length, 3);
  for (const s of stories) assert.ok(s.scenes.length >= 1 && s.scenes.some((x) => x.shots.length), s.id);
});

test('每个场景恰好属于一个分片', () => {
  const listed = Object.values(SHARDS).flat();
  assert.deepEqual([...listed].sort(), SCENARIOS.map((s) => s.id).sort());
  assert.equal(new Set(listed).size, listed.length);
});

test('场景覆盖任务要求的全部操作与四种入口视图', () => {
  const ids = new Set(SCENARIOS.map((s) => s.id));
  for (const need of ['rewrite_line', 'split_shot', 'merge_shots', 'reorder_shots_swap', 'move_shot_across_scenes', 'timeline_trim', 'timeline_split_segment',
    'timeline_reorder_within_shot', 'timeline_transition', 'timeline_add_music', 'canvas_move_node', 'canvas_connect_disconnect', 'canvas_delete_node',
    'regenerate_shot', 'change_voice', 'mixed_session_undo_redo', 'crash_reload_mid_session']) assert.ok(ids.has(need), need);
  const views = new Set(SCENARIOS.flatMap((s) => Object.keys(s.entries)));
  assert.deepEqual([...views].sort(), ['canvas', 'script', 'shot', 'timeline']);
  // 等价场景必须至少有两个入口
  for (const s of SCENARIOS.filter((x) => x.equivalence)) assert.ok(Object.values(s.entries).flat().length >= 2, s.id);
});
