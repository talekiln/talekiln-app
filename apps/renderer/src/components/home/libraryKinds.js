// 全局素材库三种素材（角色 / 场景 / 道具）的差异：字段、显示名、编辑表单、AI 出图提示词。纯函数，可在 node 下测试。

export const LIBRARY_KINDS = {
  character: { fields: ['name', 'category', 'description', 'tags'], nameFields: ['name'] },
  scene: { fields: ['location', 'time', 'category', 'description', 'tags'], nameFields: ['location', 'time'] },
  prop: { fields: ['name', 'category', 'description', 'tags'], nameFields: ['name'] },
}

const OPTIONAL = ['time', 'category', 'description', 'tags']

function kindOf(kind) {
  const k = LIBRARY_KINDS[kind]
  if (!k) throw new Error(`unknown library kind: ${kind}`)
  return k
}

/** 卡片标题：按字段顺序取第一个非空值，都没有返回空串（界面显示"未命名"）。 */
export function itemName(kind, item) {
  for (const f of kindOf(kind).nameFields) {
    const v = item?.[f]
    if (v != null && String(v).trim()) return String(v)
  }
  return ''
}

export function itemDescription(item, limit = 60) {
  const s = String(item?.description || item?.prompt || '')
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

/** 图片地址：local_path（走 /static）优先，其次 image_url。 */
export function itemImage(item) {
  if (!item) return ''
  const lp = item.local_path && String(item.local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return (item.image_url && String(item.image_url).trim()) || ''
}

export function editForm(kind, item) {
  const form = { id: item.id }
  for (const f of kindOf(kind).fields) form[f] = item[f] ?? ''
  form.image_url = item.image_url ?? ''
  form.local_path = item.local_path ?? null
  return form
}

/** PUT 请求体：可选字段为空时传 null（清空），必填的名称 / 地点原样传。 */
export function updateBody(kind, form) {
  const body = {}
  for (const f of kindOf(kind).fields) {
    body[f] = OPTIONAL.includes(f) ? form[f] || null : form[f]
  }
  body.image_url = form.image_url || null
  body.local_path = form.local_path ?? null
  return body
}

/** AI 出图提示词：名称（场景用地点 + 时间）加描述，逗号连接。 */
export function imagePrompt(kind, form) {
  const parts = kind === 'scene' ? [form.location, form.time, form.description] : [form.name, form.description]
  return parts.filter((p) => p && String(p).trim()).map((p) => String(p).trim()).join(', ')
}
