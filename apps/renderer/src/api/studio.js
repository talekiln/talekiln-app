import request from '@/utils/request'

/** P3-S 工作室页：身份与成员管理（本地服务转发云端）、共享角色库 / 共享模板（本地服务读写对象存储）。都走 /studio/*。 */
export const studioAPI = {
  /** -> { studios: [{ id, name, status, my_role, seats }], current_studio_id, online, fetched_at, error } */
  identity(sync = false) {
    return request.get('/studio/identity', { params: sync ? { sync: 1 } : {}, silentError: true })
  },
  setCurrent(studioId) {
    return request.put('/studio/current', { studio_id: studioId })
  },
  createStudio(name) {
    return request.post('/studio/studios', { name }, { silentError: true })
  },
  /** -> { id, name, status, my_role, seats, members: [{ account_id, email, role, status, joined_at }], invites: [...] } */
  detail(studioId) {
    return request.get(`/studio/studios/${encodeURIComponent(studioId)}`, { silentError: true })
  },
  /** body: { email?, role?, expiresInDays? } -> { id, code, email, role, expires_at } */
  invite(studioId, body) {
    return request.post(`/studio/studios/${encodeURIComponent(studioId)}/invites`, body, { silentError: true })
  },
  revokeInvite(studioId, inviteId) {
    return request.delete(`/studio/studios/${encodeURIComponent(studioId)}/invites/${encodeURIComponent(inviteId)}`)
  },
  accept(code) {
    return request.post('/studio/accept', { code }, { silentError: true })
  },
  removeMember(studioId, accountId) {
    return request.delete(`/studio/studios/${encodeURIComponent(studioId)}/members/${encodeURIComponent(accountId)}`, { silentError: true })
  },
  setRole(studioId, accountId, role) {
    return request.put(`/studio/studios/${encodeURIComponent(studioId)}/members/${encodeURIComponent(accountId)}/role`, { role }, { silentError: true })
  },
  /** kind: 'characters' | 'templates' -> { items, invalid, my_role, can_publish, truncated } */
  listShared(studioId, kind) {
    return request.get(`/studio/shared/${kind}`, { params: { studio_id: studioId }, silentError: true })
  },
  publishCharacter(studioId, characterId) {
    return request.post('/studio/shared/characters/publish', { studio_id: studioId, character_id: characterId }, { silentError: true })
  },
  pullCharacter(studioId, sharedId, dramaId) {
    return request.post('/studio/shared/characters/pull', { studio_id: studioId, shared_id: sharedId, drama_id: dramaId }, { silentError: true })
  },
  publishTemplate(studioId, templateId) {
    return request.post('/studio/shared/templates/publish', { studio_id: studioId, template_id: templateId }, { silentError: true })
  },
  pullTemplate(studioId, sharedId) {
    return request.post('/studio/shared/templates/pull', { studio_id: studioId, shared_id: sharedId }, { silentError: true })
  },
  /** 某项目的角色（给「发布角色」选择器用）。 */
  dramaCharacters(dramaId) {
    return request.get(`/dramas/${encodeURIComponent(dramaId)}/characters`)
  },
}
