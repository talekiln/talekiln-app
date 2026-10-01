<template>
  <Teleport to="body">
    <div v-if="paletteOpen" class="cp-mask" data-test="palette" @mousedown.self="closePalette">
      <div class="cp-box" role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref="inputEl"
          v-model="query"
          class="cp-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="cp-list"
          :aria-activedescendant="rows[active] ? `cp-opt-${active}` : undefined"
          placeholder="输入命令，或搜索镜头、台词…（↑↓ 选择，Enter 执行，Esc 关闭）"
          data-test="palette-input"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKey"
        >
        <ul id="cp-list" ref="listEl" class="cp-list" role="listbox" data-test="palette-list">
          <li v-if="!rows.length" class="cp-empty" data-test="palette-empty">没有匹配的命令</li>
          <template v-for="(r, i) in rows" :key="r.cmd.id">
            <li v-if="showHeader(i)" class="cp-group" role="presentation">{{ headerOf(r) }}</li>
            <li
              :id="`cp-opt-${i}`"
              class="cp-item"
              :class="{ active: i === active, disabled: !r.enabled }"
              role="option"
              :aria-selected="i === active"
              :aria-disabled="!r.enabled"
              :data-cmd="r.cmd.id"
              data-test="palette-item"
              @mousemove="active = i"
              @click="run(r)"
            >
              <span class="cp-title">{{ r.cmd.title }}</span>
              <span v-if="r.cmd.hint" class="cp-hint">{{ r.cmd.hint }}</span>
              <span v-else-if="r.cmd.group" class="cp-tag">{{ r.cmd.group }}</span>
            </li>
          </template>
        </ul>
        <div v-if="errorText" class="cp-error" data-test="palette-error">{{ errorText }}</div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectViewsStore } from '@/stores/projectViews'
import { useKeymap } from '@/composables/useKeymap'
import { registry, paletteOpen, closePalette, togglePalette } from '@/composables/useCommandPalette'
import { openHistory } from '@/composables/useHistoryDrawer'
import { createBuiltinCommands, createContentProvider } from '@/utils/builtinCommands'
import { episodeOfRoute } from '@/utils/episodeContext'
import { resolveAction } from '@/utils/keymap'

const route = useRoute()
const router = useRouter()
const views = useProjectViewsStore()
const { createGlobalHandler, keymap } = useKeymap()

const query = ref('')
const active = ref(0)
const inputEl = ref(null)
const listEl = ref(null)
const errorText = ref('')
const tick = ref(0) // 面板打开时刷新一次上下文

// 搜索时现取：当前剧集、撤销状态
function getCtx() {
  const ep = episodeOfRoute(route, views.episodeId)
  const loaded = ep && views.episodeId === ep
  return {
    episodeId: ep,
    dramaId: loaded ? views.dramaId : (Number(route.query.drama) || null),
    canUndo: !!(loaded && views.canUndo),
    canRedo: !!(loaded && views.canRedo),
    busy: !!views.busy,
  }
}

const rows = computed(() => {
  void tick.value
  return registry.search(query.value, getCtx())
})

const showRecentHeader = computed(() => !query.value.trim() && rows.value.some((r) => r.recent))
function showHeader(i) {
  const r = rows.value[i]
  if (!query.value.trim() && showRecentHeader.value) return i === 0 || headerOf(rows.value[i - 1]) !== headerOf(r)
  return i === 0 || rows.value[i - 1].cmd.group !== r.cmd.group
}
function headerOf(r) {
  if (!query.value.trim() && r.recent) return '最近使用'
  return r.cmd.group || '其它'
}

watch(rows, (v) => { if (active.value >= v.length) active.value = Math.max(0, v.length - 1) })
watch(query, () => { active.value = 0; errorText.value = '' })
watch(active, async () => {
  await nextTick()
  listEl.value?.querySelector('.cp-item.active')?.scrollIntoView?.({ block: 'nearest' })
})
watch(paletteOpen, async (open) => {
  if (open) {
    query.value = ''
    active.value = 0
    errorText.value = ''
    tick.value += 1
    await nextTick()
    inputEl.value?.focus()
  }
})

async function run(r) {
  if (!r || !r.enabled) return
  try {
    errorText.value = ''
    await registry.execute(r.cmd, getCtx())
    closePalette()
  } catch (e) {
    // 命令失败：面板保持打开并显示原因（不静默吞掉）
    errorText.value = e?.message || '命令执行失败'
  }
}

function onKey(e) {
  if (e.isComposing) return // 输入法选词中的 Enter / 方向键不当命令处理
  if (resolveAction(keymap.value, e, ['global']) === 'palette.open') return // 开关面板的组合键交给全局处理器
  const n = rows.value.length
  const k = e.key
  const ctrl = e.ctrlKey || e.metaKey
  if (k === 'Escape') { e.preventDefault(); closePalette() }
  else if (k === 'ArrowDown' || (ctrl && k === 'n')) { e.preventDefault(); if (n) active.value = (active.value + 1) % n }
  else if (k === 'ArrowUp' || (ctrl && k === 'p')) { e.preventDefault(); if (n) active.value = (active.value - 1 + n) % n }
  else if (k === 'Tab') { e.preventDefault(); if (n) active.value = (active.value + (e.shiftKey ? -1 : 1) + n) % n }
  else if (k === 'Home' && ctrl) { e.preventDefault(); active.value = 0 }
  else if (k === 'End' && ctrl) { e.preventDefault(); active.value = Math.max(0, n - 1) }
  else if (k === 'PageDown') { e.preventDefault(); if (n) active.value = Math.min(n - 1, active.value + 8) }
  else if (k === 'PageUp') { e.preventDefault(); active.value = Math.max(0, active.value - 8) }
  else if (k === 'Enter') { e.preventDefault(); run(rows.value[active.value]) }
}

// 全局快捷键（默认 Ctrl+K，可在快捷键设置里改）。面板已开时按下同一组合键 = 关闭。
const onGlobalKey = createGlobalHandler({ 'palette.open': () => togglePalette() })

// 内置命令 + 内容搜索；hint 里的快捷键随键位设置显示
let offs = []
onMounted(() => {
  const deps = {
    go: (loc) => router.push(loc),
    undo: () => views.undo(),
    redo: () => views.redo(),
    openHistory,
    select: (sel) => views.select(sel),
    getViews: () => (views.episodeId === getCtx().episodeId ? views.views : null),
  }
  offs = [
    registry.registerAll(createBuiltinCommands(deps)),
    registry.registerProvider(createContentProvider(deps)),
  ]
  window.addEventListener('keydown', onGlobalKey)
})
onBeforeUnmount(() => {
  offs.forEach((f) => f())
  window.removeEventListener('keydown', onGlobalKey)
})
</script>

<style scoped>
.cp-mask {
  position: fixed; inset: 0; z-index: 3000; background: rgba(0, 0, 0, .45);
  display: flex; justify-content: center; align-items: flex-start; padding-top: 14vh;
}
.cp-box {
  width: min(640px, 92vw); background: var(--el-bg-color, #fff); border: 1px solid var(--el-border-color-light, #ddd);
  border-radius: 10px; box-shadow: 0 12px 40px rgba(0, 0, 0, .35); overflow: hidden; display: flex; flex-direction: column;
}
.cp-input {
  border: 0; outline: 0; padding: 14px 16px; font-size: 15px; background: transparent; color: var(--el-text-color-primary, #222);
  border-bottom: 1px solid var(--el-border-color-light, #ddd); width: 100%;
}
.cp-list { list-style: none; margin: 0; padding: 6px; max-height: 52vh; overflow-y: auto; }
.cp-group { padding: 8px 10px 4px; font-size: 12px; color: var(--el-text-color-secondary, #888); }
.cp-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 14px; color: var(--el-text-color-primary, #222); }
.cp-item.active { background: var(--el-color-primary-light-9, #ecf5ff); color: var(--el-color-primary, #409eff); }
.cp-item.disabled { opacity: .45; cursor: not-allowed; }
.cp-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-hint, .cp-tag { font-size: 12px; color: var(--el-text-color-secondary, #888); }
.cp-hint { font-family: ui-monospace, Consolas, monospace; padding: 1px 6px; border: 1px solid var(--el-border-color-light, #ddd); border-radius: 4px; }
.cp-empty { padding: 18px; text-align: center; color: var(--el-text-color-secondary, #888); font-size: 13px; }
.cp-error { padding: 8px 14px; font-size: 12px; color: var(--el-color-danger, #f56c6c); border-top: 1px solid var(--el-border-color-light, #ddd); }
</style>
