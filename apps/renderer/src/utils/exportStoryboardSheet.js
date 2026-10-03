// 分镜表导出：每镜头一行，每个元素类型一列。列名、标签、文件名全部走 i18n（语言随当前界面语言）。
import { t } from '../i18n/index.js'

const COLUMN_KEYS = [
  'index', 'number', 'title', 'segment', 'duration', 'shotType', 'movement', 'scene', 'characters', 'props',
  'location', 'time', 'description', 'dialogue', 'narration', 'action', 'result', 'atmosphere', 'layout',
  'firstFramePrompt', 'lastFramePrompt', 'imagePrompt', 'videoPrompt', 'universalSegment',
]

/** 当前语言的 24 个列名 */
export function sheetColumns() {
  return COLUMN_KEYS.map((k) => t(`export.sheet.col.${k}`))
}

const MOVEMENTS = [
  'static', 'push', 'pull', 'pan', 'tilt', 'tracking', 'crane_up', 'crane_dn', 'orbit', 'handheld', 'zoom', 'roll',
  'whip_pan', 'spiral', 'hitchcock_zoom', 'bullet_time', 'dutch_angle_move', 'dolly_track', 'slowmo_orbit',
]

/** 运镜代码 -> 当前语言的名称；不认识的代码原样返回 */
export function movementLabel(code) {
  if (!code) return ''
  return MOVEMENTS.includes(code) ? t(`export.sheet.move.${code}`) : String(code)
}

function cellText(v) {
  if (v == null) return ''
  return String(v).replace(/\r\n/g, '\n').trim()
}

function escapeHtml(s) {
  return cellText(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeCsvCell(s) {
  const text = cellText(s)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

const labelled = (key, v) => (v ? t(`export.sheet.label.${key}`, { v }) : '')

function charBlock(char) {
  const name = cellText(char.name) || t('export.sheet.unnamed')
  const parts = [
    labelled('appearance', char.appearance),
    labelled('personality', char.personality),
    labelled('description', char.description),
    labelled('prompt', char.polished_prompt),
  ].filter(Boolean)
  return parts.length ? `${name}\n${parts.join('\n')}` : name
}

function sceneBlock(scene) {
  const head = cellText(scene.location) || t('export.sheet.unnamedScene')
  const parts = [
    labelled('time', scene.time),
    labelled('prompt', scene.prompt),
    labelled('polished', scene.polished_prompt),
  ].filter(Boolean)
  return parts.length ? `${head}\n${parts.join('\n')}` : head
}

function propBlock(prop) {
  const name = cellText(prop.name) || t('export.sheet.unnamed')
  const parts = [
    labelled('type', prop.type),
    labelled('description', prop.description),
    labelled('prompt', prop.prompt),
  ].filter(Boolean)
  return parts.length ? `${name}\n${parts.join('\n')}` : name
}

function joinBlocks(blocks) {
  return blocks.filter((b) => cellText(b)).join('\n\n')
}

function field(getField, sb, key) {
  const v = getField?.(sb, key)
  if (v != null && v !== '') return cellText(v)
  return cellText(sb[key])
}

function segmentLabel(sb) {
  const title = cellText(sb.segment_title)
  const n = sb.segment_index != null ? Number(sb.segment_index) + 1 : 0
  if (title) return n ? t('export.sheet.segmentFull', { n, title }) : title
  return n ? t('export.sheet.segment', { n }) : ''
}

/**
 * 构建分镜表数据：严格一行对应一个分镜。
 * @param {object} ctx
 * @param {Array} ctx.storyboards
 * @param {Function} [ctx.getScene] (sbId) => scene | null
 * @param {Function} [ctx.getCharacters] (sbId) => character[]
 * @param {Function} [ctx.getProps] (sbId) => prop[]
 * @param {Function} [ctx.getMovementLabel] (code) => string
 * @param {Function} [ctx.getField] (sb, key) => 编辑中的值
 * @param {Function} [ctx.getFirstFramePrompt] (sbId) => string
 * @param {Function} [ctx.getLastFramePrompt] (sbId) => string
 */
export function buildStoryboardSheetRows(ctx) {
  const {
    storyboards = [], getScene, getCharacters, getProps, getMovementLabel, getField, getFirstFramePrompt, getLastFramePrompt,
  } = ctx
  const moveLabel = getMovementLabel || movementLabel

  return storyboards.map((sb, i) => {
    const sbId = sb.id
    const scene = getScene?.(sbId)
    const chars = getCharacters?.(sbId) || []
    const propList = getProps?.(sbId) || []
    return [
      i + 1,
      sb.storyboard_number ?? i + 1,
      cellText(field(getField, sb, 'title')) || t('export.sheet.shotN', { n: i + 1 }),
      segmentLabel(sb),
      field(getField, sb, 'duration') || sb.duration || '',
      field(getField, sb, 'shot_type'),
      moveLabel(field(getField, sb, 'movement')) || field(getField, sb, 'movement'),
      scene ? sceneBlock(scene) : '',
      joinBlocks(chars.map(charBlock)),
      joinBlocks(propList.map(propBlock)),
      field(getField, sb, 'location'),
      field(getField, sb, 'time'),
      cellText(sb.description),
      field(getField, sb, 'dialogue'),
      field(getField, sb, 'narration'),
      field(getField, sb, 'action'),
      field(getField, sb, 'result'),
      field(getField, sb, 'atmosphere'),
      field(getField, sb, 'layout_description'),
      cellText(getFirstFramePrompt?.(sbId) ?? field(getField, sb, 'first_frame_prompt')),
      cellText(getLastFramePrompt?.(sbId) ?? field(getField, sb, 'last_frame_prompt')),
      field(getField, sb, 'polished_prompt') || cellText(sb.polished_prompt || sb.image_prompt),
      field(getField, sb, 'video_prompt') || cellText(sb.video_prompt),
      field(getField, sb, 'universal_segment_text'),
    ]
  })
}

const idOf = (c) => (c !== null && typeof c === 'object' ? Number(c.id) : Number(c))

/**
 * 由接口数据组装 buildStoryboardSheetRows 的 ctx。
 * storyboards 来自 GET /episodes/:id/storyboards；characters / scenes / props 来自项目；
 * framePrompts: { [sbId]: { first, last } }（可选，来自 frame-prompts 接口）。
 */
export function sheetContextFrom({ storyboards = [], characters = [], scenes = [], props = [], framePrompts = {} } = {}) {
  const byId = new Map(storyboards.map((sb) => [Number(sb.id), sb]))
  const find = (list, id) => list.find((x) => Number(x.id) === Number(id)) || null
  return {
    storyboards,
    getScene(sbId) {
      const sb = byId.get(Number(sbId))
      if (!sb) return null
      return (sb.scene_id != null && find(scenes, sb.scene_id)) || sb.background || null
    },
    getCharacters(sbId) {
      const sb = byId.get(Number(sbId))
      const list = Array.isArray(sb?.characters) ? sb.characters : []
      return list
        .map((c) => find(characters, idOf(c)) || (c !== null && typeof c === 'object' ? c : null))
        .filter(Boolean)
    },
    getProps(sbId) {
      const sb = byId.get(Number(sbId))
      const ids = Array.isArray(sb?.prop_ids) ? sb.prop_ids : []
      return ids.map((id) => find(props, id)).filter(Boolean)
    },
    getFirstFramePrompt: (sbId) => framePrompts[sbId]?.first || '',
    getLastFramePrompt: (sbId) => framePrompts[sbId]?.last || '',
  }
}

/** 文件名（不含扩展名）：<项目名>-<第N集>-分镜表 */
export function sheetFilename({ title, episodeNumber, episodeId } = {}) {
  const name = (title || 'project').replace(/[\\/:*?"<>|]/g, '_')
  const ep = episodeNumber != null ? t('export.sheet.fileEp', { n: episodeNumber }) : `ep${episodeId || '1'}`
  return `${name}-${ep}-${t('export.sheet.fileSuffix')}`
}

function formatExcelCellContent(s) {
  // Excel 识别 &#10; 为单元格内换行，避免 <br/> 在部分软件里被拆成多行
  return escapeHtml(s).replace(/\n/g, '&#10;')
}

/** Excel 可打开的 HTML 表格（.xls，无需额外依赖） */
export function buildExcelHtml(rows) {
  const tdStyle = 'style="white-space:normal;vertical-align:top;mso-data-placement:same-cell;"'
  const header = sheetColumns().map((c) => `<th>${escapeHtml(c)}</th>`).join('')
  const body = rows.map((row) => `<tr>${row.map((c) => `<td ${tdStyle}>${formatExcelCellContent(c)}</td>`).join('')}</tr>`).join('')
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>${escapeHtml(t('export.sheet.sheetName'))}</x:Name></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
<body><table border="1"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></body></html>`
}

/** CSV 文本（不含 BOM；行间用 CRLF，单元格内换行放在引号里） */
export function buildCsvText(rows) {
  return [sheetColumns().map(escapeCsvCell).join(','), ...rows.map((row) => row.map(escapeCsvCell).join(','))].join('\r\n')
}

function saveBlob(blob, filename) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export function downloadStoryboardExcel(rows, filename) {
  const blob = new Blob(['﻿' + buildExcelHtml(rows)], { type: 'application/vnd.ms-excel;charset=utf-8' })
  saveBlob(blob, filename.endsWith('.xls') ? filename : `${filename}.xls`)
}

/** CSV 备选（部分环境 .xls 受限时使用） */
export function downloadStoryboardCsv(rows, filename) {
  const blob = new Blob(['﻿' + buildCsvText(rows)], { type: 'text/csv;charset=utf-8' })
  saveBlob(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`)
}

export function exportStoryboardSheet(ctx, filenameBase) {
  const rows = buildStoryboardSheetRows(ctx)
  if (!rows.length) return { ok: false, reason: 'empty' }
  const name = filenameBase || 'storyboard-sheet'
  try {
    downloadStoryboardExcel(rows, name)
    return { ok: true, count: rows.length }
  } catch (_) {
    downloadStoryboardCsv(rows, name)
    return { ok: true, count: rows.length, fallback: 'csv' }
  }
}
