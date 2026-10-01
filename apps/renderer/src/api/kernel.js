import request from '@/utils/request'

// 数据内核 REST（packages/local/src/routes/kernel.js）。silentError：错误由 store 统一提示。
const quiet = { silentError: true }

export const kernelAPI = {
  graph(ep) { return request.get(`/episodes/${ep}/graph`, quiet) },
  view(ep, name) { return request.get(`/episodes/${ep}/views/${name}`, quiet) },
  importLegacy(ep) { return request.post(`/episodes/${ep}/import-legacy`, {}, quiet) },
  intent(ep, view, name, args, txId) {
    return request.post(`/episodes/${ep}/intent`, { view, name, args: args || {}, ...(txId ? { tx_id: txId } : {}) }, quiet)
  },
  tx(ep, txId, label, ops) { return request.post(`/episodes/${ep}/tx`, { tx_id: txId, label, ops }, quiet) },
  undo(ep) { return request.post(`/episodes/${ep}/undo`, {}, quiet) },
  redo(ep) { return request.post(`/episodes/${ep}/redo`, {}, quiet) },
}
