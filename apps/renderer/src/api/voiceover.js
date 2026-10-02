import request from '@/utils/request'

export const voiceoverAPI = {
  /** { voices: [{id,label,verified}], default } */
  voices() {
    return request.get('/voiceover/voices')
  },
  /**
   * 旁白配音：先不带 confirm 调用得到估价（confirm_required、estimate、max、currency、chars、allowed），
   * 用户确认后带 confirm: true 再调用；body: { all?: true, shots?: [镜头 id], voice?, confirm? }
   * 确认后只建任务不等结果：返回 { confirmed: true, tasks: [{ shot_id, outcome, task_id, state }], skipped }，进度看任务中心或 status()。
   */
  run(episodeId, body) {
    return request.post(`/episodes/${episodeId}/voiceover`, body)
  },
  /** 每个镜头的旁白状态：{ shots: [{ shot_id, legacy_id, number, state: none|queued|running|failed|stale|fresh, task_id, error_message }], counts } */
  status(episodeId) {
    return request.get(`/episodes/${episodeId}/voiceover/status`)
  },
}
