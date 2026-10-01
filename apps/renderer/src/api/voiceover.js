import request from '@/utils/request'

export const voiceoverAPI = {
  /** { voices: [{id,label,verified}], default } */
  voices() {
    return request.get('/voiceover/voices')
  },
  /**
   * 旁白配音：先不带 confirm 调用得到估价（confirm_required、estimate、max、currency、chars、allowed），
   * 用户确认后带 confirm: true 再调用；body: { all?: true, shots?: [镜头 id], voice?, confirm? }
   * 确认后返回 { done, failed, skipped, ... }。
   */
  run(episodeId, body) {
    return request.post(`/episodes/${episodeId}/voiceover`, body, { timeout: 600000 })
  },
}
