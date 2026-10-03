// 顶栏“花费”：从 GET /spend/summary 取本项目的累计花费（纯函数，可 node --test）。

/** by_project 里 project_id 与当前项目匹配的一行的 cost；没有或不是有限数字 -> null */
export function pickProjectCost(summary, dramaId) {
  const row = (summary?.by_project || []).find((r) => String(r.project_id) === String(dramaId))
  const n = Number(row?.cost)
  return row && Number.isFinite(n) ? n : null
}

const SYMBOL = { CNY: '¥', USD: '$' }

export function formatSpend(cost, currency) {
  if (cost === null || cost === undefined || !Number.isFinite(Number(cost))) return ''
  const sym = SYMBOL[currency || 'CNY'] ?? `${currency} `
  return `${sym}${Number(cost).toFixed(2)}`
}
