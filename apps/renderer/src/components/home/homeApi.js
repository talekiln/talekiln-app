// 首页用到的接口与浏览器副作用（下载、本机存储）。纯逻辑在 projectFlows.js / utils/homeModel.js。
import request from '@/utils/request'
import { dramaAPI } from '@/api/drama'
import { DELETED_LOG_KEY, parseDeletedLog, rememberDeleted, forgetDeleted, backupFileName } from '@/utils/homeModel'
import { classifyFailure, fetchFullBackup, createProjectWithEpisodes } from './projectFlows.js'

const quiet = { silentError: true }

export function listProjects() {
  return dramaAPI.list({ page: 1, page_size: 100 })
}

export function createWithEpisodes(meta, episodes) {
  return createProjectWithEpisodes(
    {
      create: (body) => dramaAPI.create(body),
      saveEpisodes: (id, eps) => dramaAPI.saveEpisodes(id, eps),
      get: (id) => dramaAPI.get(id),
      remove: (id) => dramaAPI.delete(id),
    },
    meta,
    episodes,
  )
}

export function renameProject(id, patch) {
  return dramaAPI.update(id, patch)
}

export function deleteProject(id) {
  return dramaAPI.delete(id)
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

/** 项目包 ZIP：浏览器原生下载（大文件不经 axios 缓冲）。 */
export function downloadProjectZip(drama) {
  const a = document.createElement('a')
  a.href = `/api/v1/dramas/${drama.id}/export`
  a.download = `${drama.title || 'drama'}.zip`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/** 完整备份（含撤销历史与版本）：失败抛带 reason('unavailable'|'failed') 的错误。 */
export async function downloadFullBackup(drama) {
  const blob = await fetchFullBackup(drama.id, (url, init) => fetch(url, init))
  saveBlob(blob, backupFileName(drama.title))
}

/** 导入普通项目包 -> { drama_id, title } */
export function importProjectPackage(file) {
  return dramaAPI.importDrama(file)
}

/** 从完整备份恢复（总是新建项目）-> { drama_id } */
export function restoreFullBackup(file) {
  const form = new FormData()
  form.append('file', file)
  return request.post('/dramas/restore', form, { headers: { 'Content-Type': 'multipart/form-data' }, silentError: true })
}

/** 删除前的本机快照 -> { ok:true, id } | { ok:false, reason }。接口不存在时 reason='unavailable'。 */
export async function snapshotProject(dramaId, reason = 'delete') {
  try {
    const snap = await request.post(`/dramas/${dramaId}/snapshots`, { reason }, quiet)
    const id = snap?.id ?? snap?.snapshot_id
    if (id == null) return { ok: false, reason: 'failed' }
    return { ok: true, id }
  } catch (e) {
    return { ok: false, reason: classifyFailure(e) }
  }
}

export async function listSnapshots(dramaId) {
  const res = await request.get(`/dramas/${dramaId}/snapshots`, quiet)
  return Array.isArray(res) ? res : res?.items || res?.snapshots || []
}

/** 从本机快照恢复为新项目 -> { drama_id } */
export function restoreSnapshot(dramaId, snapshotId) {
  return request.post(`/dramas/${dramaId}/snapshots/${snapshotId}/restore`, {}, quiet)
}

// ---- "最近删除"记录（只存在本机浏览器里） ----

export function loadDeletedLog() {
  try {
    return parseDeletedLog(globalThis.localStorage?.getItem(DELETED_LOG_KEY))
  } catch (_) {
    return []
  }
}

function saveDeletedLog(list) {
  try { globalThis.localStorage?.setItem(DELETED_LOG_KEY, JSON.stringify(list)) } catch (_) { /* 存储被禁用：忽略 */ }
}

export function rememberDeletedProject(rec) {
  const next = rememberDeleted(loadDeletedLog(), rec)
  saveDeletedLog(next)
  return next
}

export function forgetDeletedProject(dramaId) {
  const next = forgetDeleted(loadDeletedLog(), dramaId)
  saveDeletedLog(next)
  return next
}
