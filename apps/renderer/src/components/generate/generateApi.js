import request from '@/utils/request'

/** 草稿档产物重跑（packages/local/src/routes/qualityRerun.js） */
export const qualityAPI = {
  /** { count, nodes: [{ node, kind, shot }], estimate: { amount, max, currency }, allowed, refusal } */
  draftNodes(episodeId) {
    return request.get(`/episodes/${episodeId}/quality/draft-nodes`)
  },
  /** 以成片档入队；额度不够整批 402。-> { count, nodes, estimate, tasks } */
  rerun(episodeId) {
    return request.post(`/episodes/${episodeId}/quality/rerun`, {})
  },
}
