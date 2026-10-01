'use strict';
/**
 * 时间线装配走内核：旧时间线表是项目图 timelineView 的物化投影，不再由这里直接拼表。
 * 与 assembleFromStoryboard 同语义（已有时间线且未 replace -> 409），但：
 *   - 片段时长取真实片长（采用的 video 版本 metadata.duration_ms），没有就退回镜头目标时长；
 *   - 字幕按旁白版本的词级字幕块（旁白过期则退回整镜文字字幕）；
 *   - 旁白片段来自 narration 采用版本。
 * replace: true 把全部片段重置为“每镜一个整段、无间隙、无转场”，并清空字幕样式覆盖（音乐保留）。
 */
const kernel = require('@talekiln/kernel');
const { TimelineError, loadTimelineByEpisode } = require('./service');
const store = require('../kernel/store');
const legacy = require('../kernel/legacy');

function assembleFromKernel(db, episodeId, opts = {}) {
  const ep = Number(episodeId);
  return db.transaction(() => {
    const had = loadTimelineByEpisode(db, ep);
    if (had && !opts.replace) throw new TimelineError('timeline already exists for episode', 409, 'CONFLICT');
    const hasShots = db.prepare('SELECT 1 FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').get(ep);
    if (!hasShots) throw new TimelineError('episode has no storyboards', 400, 'NO_STORYBOARDS');
    legacy.importLegacy(db, ep);
    if (opts.replace) {
      store.commit(db, ep, (g) => {
        const cid = kernel.composeId(g);
        if (!cid) throw new TimelineError('episode has no compose node', 400, 'NO_STORYBOARDS');
        const segments = kernel.shotOrder(g).map((shotId, i) => ({
          id: `seg_r${i + 1}`, shot_id: shotId, in_ms: 0, out_ms: g.nodes[shotId].params.duration_ms ?? kernel.DEFAULT_SHOT_MS, gap_before_ms: 0, transition: null,
        }));
        return {
          tx_id: `assemble:replace:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, label: 'reassemble timeline',
          ops: [{ op: 'setComposeSegments', node: cid, segments }, { op: 'setParam', node: cid, path: ['subtitle_overrides'], value: {} }],
        };
      });
    } else {
      // 图已存在但旧时间线表缺失（或落后）：按图重新物化
      legacy.materialize(db, ep, store.openProject(db, ep).graph);
    }
    return loadTimelineByEpisode(db, ep);
  })();
}

module.exports = { assembleFromKernel };
