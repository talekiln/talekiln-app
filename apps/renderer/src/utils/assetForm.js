// 资产（角色 / 场景 / 道具）编辑表单的纯函数：初始值、校验、创建参数、只提交改动的字段。
// 不依赖 Vue / 网络，可在 node --test 下运行。

// 表单里可编辑的文本字段（identity_anchors 后端不允许通过 PUT 修改，只能由“提炼视觉锚点”写入，所以不在表单字段里）
export const FORM_FIELDS = {
  characters: ['name', 'role', 'appearance', 'personality', 'description', 'polished_prompt', 'stages'],
  scenes: ['location', 'time', 'prompt', 'polished_prompt', 'polished_prompt_single'],
  props: ['name', 'type', 'description', 'prompt'],
}

// 创建接口直接支持的字段；其余字段在创建成功后用一次更新补上
const CREATE_FIELDS = {
  characters: ['name', 'role', 'appearance', 'personality', 'description'],
  scenes: ['location', 'time', 'prompt'],
  props: ['name', 'type', 'description', 'prompt'],
}

export const ROLE_VALUES = ['main', 'supporting', 'minor']

function str(v) {
  return v == null ? '' : String(v)
}

export function emptyForm(kind) {
  const f = {}
  for (const k of FORM_FIELDS[kind] || []) f[k] = ''
  f.ref_image = ''
  return f
}

export function formFromAsset(kind, item) {
  const f = emptyForm(kind)
  if (!item) return f
  for (const k of FORM_FIELDS[kind] || []) f[k] = str(item[k])
  f.ref_image = str(item.ref_image)
  return f
}

/** 返回 null 表示通过；否则返回 i18n key。 */
export function validateForm(kind, form) {
  if (kind === 'scenes') {
    if (!str(form.location).trim()) return 'assets.form.locationRequired'
  } else if (!str(form.name).trim()) {
    return 'assets.form.nameRequired'
  }
  if (kind === 'characters' && str(form.stages).trim()) {
    try {
      JSON.parse(form.stages)
    } catch (_) {
      return 'assets.form.stagesInvalid'
    }
  }
  return null
}

function clean(kind, form, field) {
  return str(form[field]).trim()
}

/** 创建：body 给创建接口；after 是创建后要补写的字段（为空则不需要再请求一次）。空值不提交。 */
export function createParts(kind, form) {
  const body = {}
  for (const k of CREATE_FIELDS[kind] || []) {
    const v = clean(kind, form, k)
    if (v) body[k] = v
  }
  const after = {}
  for (const k of FORM_FIELDS[kind] || []) {
    if (CREATE_FIELDS[kind].includes(k)) continue
    const v = clean(kind, form, k)
    if (v) after[k] = v
  }
  if (str(form.ref_image).trim()) after.ref_image = str(form.ref_image).trim()
  return { body, after }
}

/**
 * 编辑：只返回相对 item 改动过的字段。文本可以被清空（提交空串），但 role / stages 为空时不提交（后端没有“清空”语义）。
 */
export function updatePatch(kind, form, item) {
  const patch = {}
  for (const k of FORM_FIELDS[kind] || []) {
    const now = clean(kind, form, k)
    const was = str(item?.[k]).trim()
    if (now === was) continue
    if ((k === 'role' || k === 'stages') && !now) continue
    patch[k] = now
  }
  const ref = str(form.ref_image).trim()
  if (ref !== str(item?.ref_image).trim()) patch.ref_image = ref || null
  return patch
}
