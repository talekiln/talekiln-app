'use strict';
// 为一组场景注册 node:test 用例（分成几个 *.test.js 文件，让 node --test 并行跑）。
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./stories');
const { SCENARIOS } = require('./scenarios');
const { runScenarioOnStory } = require('./harness');

function defineScenarioTests(pick) {
  const stories = S.loadStories();
  for (const sc of SCENARIOS.filter((s) => pick(s.id))) {
    test(`场景 ${sc.id}：${sc.title}`, () => {
      let pass = 0;
      const failures = [];
      for (const st of stories) {
        for (const r of runScenarioOnStory(sc, st)) {
          if (r.status === 'pass') pass++;
          else if (r.status === 'fail') failures.push(`[${r.view}/${r.variant} @ ${r.story}] ${r.error.message.split('\n')[0]}`);
        }
      }
      assert.deepEqual(failures, [], `${failures.length} failing executions:\n${failures.slice(0, 12).join('\n')}`);
      assert.ok(pass >= 8, `scenario ran on too few stories (${pass} passes) — too many n/a skips`);
    });
  }
}

/** 所有场景必须被某个分片文件覆盖（防止新增场景漏跑）。 */
const SHARDS = {
  script: ['rewrite_line', 'change_line_kind', 'split_line', 'merge_lines', 'reorder_lines', 'delete_line', 'insert_line'],
  shots: ['split_shot', 'merge_shots', 'reorder_shots_swap', 'move_shot_across_scenes_neutral', 'move_shot_across_scenes', 'delete_shot', 'add_shot', 'set_shot_title', 'set_shot_duration', 'regenerate_shot', 'regenerate_video_only', 'change_voice', 'change_references', 'change_tail_frame', 'change_image_model', 'change_video_model', 'adopt_old_version', 'reorder_after_split'],
  timeline_canvas: ['timeline_trim', 'timeline_split_segment', 'timeline_reorder_within_shot', 'timeline_gap', 'timeline_transition', 'timeline_add_music', 'canvas_move_node', 'canvas_connect_disconnect', 'canvas_delete_node', 'canvas_rewire', 'compose_created_late'],
  sessions: ['mixed_session_undo_redo', 'crash_reload_mid_session'],
};

module.exports = { defineScenarioTests, SHARDS };
