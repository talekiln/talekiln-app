import request from '@/utils/request'

export const musicAPI = {
  /** { items: [{ id, name, file_path, duration_ms, source: 'user'|'builtin', size_bytes }] } */
  list() {
    return request.get('/music-library')
  },
  /** 导入用户音乐文件（multipart），可附带 duration_ms 作为后端无法探测时长时的兜底 */
  upload(file, durationMs) {
    const fd = new FormData()
    fd.append('file', file)
    if (durationMs) fd.append('duration_ms', String(durationMs))
    return request.post('/music-library', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
  remove(id) {
    return request.delete(`/music-library/${id}`)
  },
  /** body: { music_id, start_ms?, loop?, volume? } → { timeline, clip_ids } */
  attach(timelineId, body) {
    return request.post(`/timelines/${timelineId}/music`, body)
  },
}
