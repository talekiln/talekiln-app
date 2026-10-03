<template>
  <div ref="root" class="sb-view" tabindex="-1" data-test="storyboard-page" @keydown="onKey">
    <div class="toolbar">
      <el-radio-group v-model="viewMode" size="small" data-test="view-mode">
        <el-radio-button value="cards">{{ t('storyboard.bar.cards') }}</el-radio-button>
        <el-radio-button value="table">{{ t('storyboard.bar.table') }}</el-radio-button>
      </el-radio-group>
      <el-checkbox :model-value="allSelected" :indeterminate="someSelected && !allSelected" :disabled="!order.length" data-test="select-all" @change="toggleAll">{{ t('storyboard.bar.selectAll') }}</el-checkbox>
      <span class="spacer" />
      <el-tag
        :type="saveState === 'error' ? 'danger' : saveState === 'saved' ? 'success' : 'warning'"
        :class="{ clickable: saveState === 'error' }"
        data-test="save-indicator"
        @click="saveState === 'error' && retry()"
      >{{ t(saveStateKey(saveState)) }}</el-tag>

      <el-popover placement="bottom-end" :width="320" trigger="click">
        <template #reference>
          <el-button size="small" data-test="project-settings">{{ t('storyboard.bar.settings') }}</el-button>
        </template>
        <div class="settings">
          <div class="setting">
            <el-switch :model-value="toggles.useFirstLast" :loading="savingToggle === 'useFirstLast'" data-test="toggle-first-last" @change="(v) => setToggle('useFirstLast', v)" />
            <div><strong>{{ t('storyboard.set.firstLast') }}</strong><p>{{ t('storyboard.set.firstLastHint') }}</p></div>
          </div>
          <div v-if="multiRef" class="setting">
            <el-switch :model-value="toggles.universal" :loading="savingToggle === 'universal'" data-test="toggle-universal" @change="(v) => setToggle('universal', v)" />
            <div><strong>{{ t('storyboard.set.universal') }}</strong><p>{{ t('storyboard.set.universalHint') }}</p></div>
          </div>
          <div class="setting">
            <el-switch :model-value="toggles.narration" :loading="savingToggle === 'narration'" data-test="toggle-narration" @change="(v) => setToggle('narration', v)" />
            <div><strong>{{ t('storyboard.set.narration') }}</strong><p>{{ t('storyboard.set.narrationHint') }}</p></div>
          </div>
        </div>
      </el-popover>

      <el-button size="small" :disabled="!episodeId || regenBusy" :loading="regenBusy" data-test="regenerate" @click="regenerate">
        {{ t(hasShots ? 'storyboard.bar.regenerate' : 'storyboard.bar.generate') }}
      </el-button>
      <el-button size="small" :disabled="!hasShots || regenBusy" data-test="infer-params" @click="act('storyboard.inferParams')">{{ t('storyboard.bar.inferParams') }}</el-button>
      <el-button size="small" :disabled="!episodeId || !views.ready || regenBusy" data-test="add-shot" @click="act('storyboard.addShot')"><el-icon><Plus /></el-icon>{{ t('storyboard.bar.addShot') }}</el-button>
      <el-button size="small" :disabled="!episodeId" data-test="open-director" :title="t('storyboard.bar.directorHint')" @click="openDirector(episodeId)">{{ t('storyboard.bar.director') }}</el-button>
      <el-button size="small" type="success" plain :disabled="!hasShots || !episodeId" data-test="generate-all" @click="gen.ask({ shots: 'all', kind: 'both' })">{{ t('storyboard.bar.generateAll') }}</el-button>
    </div>

    <div v-if="sel.ids.length" class="batchbar" data-test="batch-bar">
      <strong>{{ t('storyboard.batch.selected', { n: sel.ids.length }) }}</strong>
      <el-tooltip :disabled="batch.generate.enabled" :content="reasonText(batch.generate.reason)" placement="top">
        <span><el-button size="small" type="success" :disabled="!batch.generate.enabled" data-test="batch-generate" @click="batchGenerate(false)">{{ t('storyboard.batch.generate') }}</el-button></span>
      </el-tooltip>
      <el-tooltip :disabled="batch.regenerate.enabled" :content="reasonText(batch.regenerate.reason)" placement="top">
        <span><el-button size="small" :disabled="!batch.regenerate.enabled" data-test="batch-regenerate" @click="batchGenerate(true)">{{ t('storyboard.batch.regenerate') }}</el-button></span>
      </el-tooltip>
      <el-tooltip :disabled="batch.delete.enabled" :content="reasonText(batch.delete.reason)" placement="top">
        <span><el-button size="small" type="danger" plain :disabled="!batch.delete.enabled" data-test="batch-delete" @click="batchDelete">{{ t('storyboard.batch.delete') }}</el-button></span>
      </el-tooltip>
      <el-button size="small" text data-test="batch-clear" @click="sel = emptySelection()">{{ t('storyboard.batch.clear') }}</el-button>
      <span class="hint">{{ t('storyboard.batch.hint') }}</span>
    </div>

    <div class="content">
      <div class="main" v-loading="views.loading && !views.ready">
        <div v-if="!views.ready" class="empty">{{ t('storyboard.loading') }}</div>
        <div v-else-if="!hasShots" class="empty" data-test="empty">
          <p>{{ t('storyboard.empty.none') }}</p>
          <el-button type="primary" :loading="regenBusy" data-test="empty-generate" @click="regenerate">{{ t('storyboard.bar.generate') }}</el-button>
          <el-button @click="act('storyboard.addShot')">{{ t('storyboard.bar.addShot') }}</el-button>
        </div>
        <div v-else-if="!order.length" class="empty" data-test="empty-stale">
          <p>{{ t('storyboard.empty.stale') }}</p>
          <el-button @click="shell.setStaleOnly(false)">{{ t('storyboard.empty.showAll') }}</el-button>
        </div>

        <template v-else-if="viewMode === 'cards'">
          <section v-for="(g, gi) in decorated" :key="g.id" class="group">
            <header class="ghead">
              <strong>{{ g.title || t('storyboard.group.untitled', { n: gi + 1 }) }}</strong>
              <span class="hint">{{ t('storyboard.group.meta', { n: g.items.length, s: g.seconds.toFixed(1) }) }}</span>
            </header>
            <div class="grid">
              <ShotCard
                v-for="item in g.items" :key="item.id" :item="item"
                :selected="isSelected(sel, item.id)" :focused="item.id === focusId"
                :can-up="flags(item.id).canUp" :can-down="flags(item.id).canDown"
                @select="(e) => onSelect(item, e)" @toggle="toggleOne(item)" @open="openWorkbench(item)"
                @generate="gen.ask({ shots: [item.legacyId], kind: 'both' })" @move="(d) => move(item, d)" @remove="removeOne(item)"
              />
            </div>
          </section>
        </template>

        <el-table
          v-else :data="flatItems" row-key="id" border height="100%" class="sb-table" :row-class-name="rowClass"
          data-test="table-view" @row-click="(row, col, e) => onSelect(row, e)"
        >
          <el-table-column width="46" align="center">
            <template #default="{ row }"><el-checkbox :model-value="isSelected(sel, row.id)" @click.stop @change="toggleOne(row)" /></template>
          </el-table-column>
          <el-table-column :label="t('storyboard.col.no')" width="60" align="center">
            <template #default="{ row }">{{ row.no }}</template>
          </el-table-column>
          <el-table-column :label="t('storyboard.col.group')" width="110">
            <template #default="{ row }"><span class="gname">{{ row.groupTitle }}</span></template>
          </el-table-column>
          <el-table-column :label="t('storyboard.col.frame')" width="110" align="center">
            <template #default="{ row }">
              <el-image v-if="row.thumb" :src="row.thumb" fit="cover" class="thumb" lazy />
              <div v-else class="thumb thumb-empty">{{ t('storyboard.card.noImage') }}</div>
            </template>
          </el-table-column>
          <el-table-column :label="t('storyboard.col.description')" min-width="260">
            <template #default="{ row }">
              <el-input :model-value="row.description" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" :placeholder="t('storyboard.form.descriptionPlaceholder')" @click.stop @update:model-value="(v) => edit(row, 'description', v)" />
              <div v-for="w in warningsOf(row)" :key="w.key" class="warn">{{ t(w.key, w.params) }}</div>
            </template>
          </el-table-column>
          <el-table-column :label="t('storyboard.col.dialogue')" min-width="190">
            <template #default="{ row }">
              <el-input :model-value="row.dialogue" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" :placeholder="t('storyboard.form.dialoguePlaceholder')" @click.stop @update:model-value="(v) => edit(row, 'dialogue', v)" />
            </template>
          </el-table-column>
          <el-table-column :label="t('storyboard.col.duration')" width="130" align="center">
            <template #default="{ row }">
              <el-input-number :model-value="row.duration" :min="DURATION_RANGE.min" :max="DURATION_RANGE.max" :step="0.5" :precision="1" size="small" controls-position="right" @click.stop @change="(v) => v != null && edit(row, 'duration', v)" />
            </template>
          </el-table-column>
          <el-table-column :label="t('storyboard.col.status')" width="130" align="center">
            <template #default="{ row }">
              <div class="chips">
                <el-tooltip :disabled="!row.failure" :content="row.failure" placement="top">
                  <el-tag size="small" :type="chipType(row.chips.image)" data-test="row-chip-image">{{ t('storyboard.insp.image') }} {{ t(chipKey(row.chips.image)) }}</el-tag>
                </el-tooltip>
                <el-tag size="small" :type="chipType(row.chips.video)">{{ t('storyboard.insp.video') }} {{ t(chipKey(row.chips.video)) }}</el-tag>
                <el-tooltip v-if="row.cons" :content="row.cons.hint" placement="top">
                  <el-tag size="small" :type="row.cons.type" data-test="consistency-chip">{{ row.cons.label }}</el-tag>
                </el-tooltip>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('storyboard.col.actions')" width="230" align="center">
            <template #default="{ row }">
              <el-button link type="success" :disabled="row.busy" data-test="generate-row" @click.stop="gen.ask({ shots: [row.legacyId], kind: 'both' })">{{ t('storyboard.card.generate') }}</el-button>
              <el-button link type="primary" @click.stop="openWorkbench(row)">{{ t('storyboard.card.workbench') }}</el-button>
              <el-button link :disabled="!flags(row.id).canUp" :title="t('storyboard.card.up')" @click.stop="move(row, -1)"><el-icon><ArrowUp /></el-icon></el-button>
              <el-button link :disabled="!flags(row.id).canDown" :title="t('storyboard.card.down')" @click.stop="move(row, 1)"><el-icon><ArrowDown /></el-icon></el-button>
              <el-button link type="danger" :title="t('storyboard.card.delete')" @click.stop="removeOne(row)"><el-icon><Delete /></el-icon></el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <aside v-if="focusId && inspectorOpen && views.ready" class="inspector" data-test="inspector-pane">
        <div class="ihead">
          <strong>{{ t('storyboard.insp.title') }}</strong>
          <el-button link size="small" :title="t('storyboard.insp.close')" @click="inspectorOpen = false"><el-icon><Close /></el-icon></el-button>
        </div>
        <ShotInspector :key="focusId" :shot-id="focusId" compact />
      </aside>
      <el-button v-else-if="focusId && views.ready" class="reopen" size="small" data-test="reopen-inspector" @click="inspectorOpen = true">{{ t('storyboard.insp.open') }}</el-button>
    </div>

    <ShotGenerateDialog :gen="gen" />
  </div>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, ArrowUp, Close, Delete, Plus } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { dramaAPI } from '@/api/drama'
import { storyboardsAPI } from '@/api/storyboards'
import { consistencyAPI } from '@/api/consistency'
import { useProjectViewsStore } from '@/stores/projectViews'
import { useShellStore } from '@/stores/shell'
import { useActionContext } from '@/shell/context'
import { runAction } from '@/shell/actions'
import { openDirector } from '@/composables/useDirectorPanel'
import { badgeForShot, busyCount, consistencyShotMap } from '@/utils/consistencyView'
import { shotNumbers } from '@/utils/projectViews'
import { DURATION_RANGE } from '@/components/shot/shotParams'
import { createAutosaver, rowWarnings, saveStateKey } from '@/utils/storyboardTable'
import ShotCard from '@/components/shot/ShotCard.vue'
import ShotInspector from '@/components/shot/ShotInspector.vue'
import ShotGenerateDialog from '@/components/shot/ShotGenerateDialog.vue'
import { useShotGeneration } from '@/components/shot/useShotGeneration'
import { useMultiRef } from '@/components/shot/useMultiRef'
import { storyboardBusy } from '@/components/shot/storyboardGenerate'
import { buildPageGroups, legacyIdsOf, moveFlags, pageSummary, visibleIds } from '@/components/shot/storyboardPageModel'
import { batchAvailability, clickSelect, emptySelection, generateTargets, isSelected, pruneSelection, selectAll } from '@/components/shot/multiSelectModel'
import { chipKey, isShotBusy, shotChips } from '@/components/shot/shotInspectorModel'
import { deleteShots, flatShots, planMove, saveShotPatch } from '@/components/shot/shotWrite'
import { storyboardToggles, togglePatch } from '@/components/shot/storyboardOptions'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const shell = useShellStore()
const views = useProjectViewsStore()
const summary = inject('shellSummary', ref(''))
const actionCtx = useActionContext()
const { multiRef } = useMultiRef()

const episodeId = computed(() => Number(route.params.episodeId || route.query.episode) || null)
const dramaId = computed(() => Number(route.params.dramaId) || views.dramaId || shell.dramaId || null)
const root = ref(null)

// ---------- generation (queue only) ----------
const rows = ref({})
const gen = useShotGeneration(episodeId, { onChanged: () => loadRows() })
provide('storyboardGen', gen)
const regenBusy = storyboardBusy

// ---------- view state ----------
function readMode() {
  try { return localStorage.getItem('storyboard.viewMode') === 'table' ? 'table' : 'cards' } catch (_) { return 'cards' }
}
const viewMode = ref(readMode())
watch(viewMode, (v) => { try { localStorage.setItem('storyboard.viewMode', v) } catch (_) { /* storage unavailable */ } })
const inspectorOpen = ref(true)
const sel = ref(emptySelection())
const drafts = ref({})

const groups = computed(() => views.views.shots?.groups || [])
const numbers = computed(() => shotNumbers(views.views.shots))
const allIds = computed(() => flatShots(groups.value))
const hasShots = computed(() => allIds.value.length > 0)
const focusId = computed(() => views.focusFor('shots')?.id || null)

// consistency (read only), keyed by legacy storyboard id
const consistency = ref(null)
const consMap = computed(() => consistencyShotMap(consistency.value))
const CONS_HINT = {
  ok: 'storyboard.cons.hint.ok',
  check: 'storyboard.cons.hint.check',
  retry: 'storyboard.cons.hint.retry',
}
function consOf(legacyId) {
  const b = badgeForShot(consMap.value, legacyId)
  if (!b) return null
  const score = Number.isFinite(Number(b.score)) ? Math.round(Number(b.score)) : '-'
  return { type: b.type, label: t('storyboard.cons.chip', { score }), hint: t(CONS_HINT[b.suggestion] || CONS_HINT.check, { score }) }
}

function failureOf(g) {
  if (!g || g.state !== 'failed') return ''
  const n = [g.image, g.video].find((x) => x && x.state === 'failed')
  return (n && (n.error_message || n.error_code)) || t('storyboard.state.failedHint')
}

const pageGroups = computed(() => buildPageGroups(groups.value, {
  numbers: numbers.value, rows: rows.value, drafts: drafts.value, staleIds: views.staleSet, staleOnly: shell.staleOnly,
}))
const decorated = computed(() => pageGroups.value.map((g) => ({
  ...g,
  items: g.items.map((i) => {
    const gs = i.legacyId != null ? gen.shotStatus(i.legacyId) : null
    return {
      ...i,
      groupTitle: g.title,
      chips: shotChips({ imageState: i.imageState, videoState: i.videoState }, gs),
      busy: isShotBusy(gs),
      failure: failureOf(gs),
      cons: i.legacyId != null ? consOf(i.legacyId) : null,
    }
  }),
})))
const flatItems = computed(() => decorated.value.flatMap((g) => g.items.map((i) => ({ ...i, groupTitle: g.title || t('storyboard.group.untitled', { n: decorated.value.indexOf(g) + 1 }) }))))
const order = computed(() => visibleIds(decorated.value))
const flags = (id) => moveFlags(allIds.value, id)
const chipType = (s) => ({ none: 'info', queued: 'warning', running: 'primary', stale: 'warning', fresh: 'success', failed: 'danger' }[s] || 'info')
const warningsOf = (row) => rowWarnings({ description: row.description, dialogue: row.dialogue, duration: row.duration })
const rowClass = ({ row }) => (row.id === focusId.value ? 'is-focus' : '')

watchEffect(() => {
  const s = pageSummary(pageGroups.value)
  summary.value = views.ready ? t('storyboard.summary', { n: s.shots, s: s.seconds }) : ''
})

// ---------- selection ----------
watch(order, (o) => { sel.value = pruneSelection(sel.value, o) })
const allSelected = computed(() => order.value.length > 0 && sel.value.ids.length === order.value.length)
const someSelected = computed(() => sel.value.ids.length > 0)
function toggleAll() { sel.value = allSelected.value ? emptySelection() : selectAll(order.value) }
function toggleOne(item) { sel.value = clickSelect(sel.value, order.value, item.id, { ctrl: true }) }
function onSelect(item, e) {
  const ev = e || {}
  sel.value = clickSelect(sel.value, order.value, item.id, { shift: !!ev.shiftKey, ctrl: !!ev.ctrlKey, meta: !!ev.metaKey })
  if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) views.select({ kind: 'shot', id: item.id })
}
function onKey(e) {
  const tag = (e.target && e.target.tagName) || ''
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return
  if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault()
    sel.value = selectAll(order.value)
  } else if (e.key === 'Escape' && sel.value.ids.length) {
    sel.value = emptySelection()
  }
}

const itemsById = computed(() => Object.fromEntries(decorated.value.flatMap((g) => g.items).map((i) => [i.id, i])))
const busyMap = computed(() => Object.fromEntries(Object.values(itemsById.value).map((i) => [i.id, i.busy])))
const batch = computed(() => batchAvailability(
  sel.value,
  Object.fromEntries(Object.values(itemsById.value).map((i) => [i.id, { id: i.id, image: i.imageState, video: i.videoState }])),
  busyMap.value,
  { locked: regenBusy.value || deleting.value },
))
const REASONS = {
  empty: 'storyboard.batch.reason.empty',
  locked: 'storyboard.batch.reason.locked',
  allBusy: 'storyboard.batch.reason.allBusy',
  nothingToRedo: 'storyboard.batch.reason.nothingToRedo',
}
const reasonText = (r) => (REASONS[r] ? t(REASONS[r]) : '')

function batchGenerate(regenerate) {
  const targets = generateTargets(sel.value, busyMap.value)
  const ids = legacyIdsOf(targets, Object.values(itemsById.value))
  if (!ids.length) { ElMessage.warning(t('storyboard.batch.noLegacy')); return }
  return gen.ask({ shots: ids, kind: 'both', regenerate })
}

const deleting = ref(false)
async function confirmDelete(n) {
  try {
    await ElMessageBox.confirm(t('storyboard.delete.confirm', { n }), t('storyboard.delete.title'), {
      type: 'warning', confirmButtonText: t('storyboard.delete.ok'), cancelButtonText: t('storyboard.common.cancel'),
    })
    return true
  } catch (_) { return false }
}
async function deleteIds(ids) {
  deleting.value = true
  try {
    await flushEdits()
    for (const id of ids) { saver.cancel(`u:${id}`); delete drafts.value[id] }
    const r = await deleteShots({ intent: (v, n, a) => views.intent(v, n, a) }, ids)
    if (r.ok) ElMessage.success(t('storyboard.delete.done', { n: ids.length }))
    sel.value = pruneSelection(sel.value, visibleIds(buildPageGroups(groups.value, { numbers: numbers.value })))
    await loadRows()
    return r.ok
  } finally {
    deleting.value = false
  }
}
async function batchDelete() {
  const ids = [...sel.value.ids]
  if (ids.length && (await confirmDelete(ids.length))) await deleteIds(ids)
}
async function removeOne(item) {
  if (await confirmDelete(1)) await deleteIds([item.id])
}

async function move(item, dir) {
  const plan = planMove(groups.value, item.id, dir)
  if (!plan) return
  await flushEdits()
  await views.intent('shot', plan.name, plan.args)
}

function openWorkbench(item) {
  if (item.legacyId == null) return
  router.push({ name: 'shot-workbench', params: { dramaId: route.params.dramaId, episodeId: route.params.episodeId, shotId: item.legacyId } })
}

// ---------- toolbar actions (shared with the action registry) ----------
const act = (id) => runAction(id, actionCtx())
async function regenerate() {
  await flushEdits()
  await act(hasShots.value ? 'storyboard.regenerate' : 'storyboard.generate')
}

const toggles = computed(() => storyboardToggles(shell.drama))
const savingToggle = ref('')
async function setToggle(name, value) {
  if (!dramaId.value) return
  savingToggle.value = name
  try {
    await dramaAPI.saveOutline(dramaId.value, togglePatch(name, value))
    await shell.loadProject(dramaId.value)
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.set.saveFailed'))
  } finally {
    savingToggle.value = ''
  }
}

// ---------- legacy rows (thumbnails) ----------
let rowsToken = 0
async function loadRows() {
  if (!episodeId.value) return
  const mine = ++rowsToken
  try {
    const data = await dramaAPI.getStoryboards(episodeId.value)
    if (mine !== rowsToken) return
    rows.value = Object.fromEntries(((data && data.storyboards) || []).map((r) => [r.id, r]))
  } catch (_) { /* request.js already reports */ }
}
let consTimer = null
async function loadConsistency() {
  if (!episodeId.value) return
  try { consistency.value = await consistencyAPI.episodeReport(episodeId.value) } catch (_) { /* request.js already reports */ }
}
watch(() => busyCount(gen.status.value), (now, before) => {
  if (before > 0 && now === 0) {
    views.refresh() // chips read the kernel views; loadRows only re-reads the legacy thumbnails
    loadRows()
    loadConsistency()
    clearTimeout(consTimer)
    consTimer = setTimeout(loadConsistency, 4000)
  }
})
watch(() => [views.seq, views.revision], loadRows)

// ---------- table editing with debounced autosave ----------
const saveState = ref('saved')
const saver = createAutosaver({ delay: 800, onState: (s) => { saveState.value = s } })
const writeDeps = {
  intent: (v, n, a) => views.intent(v, n, a),
  updateLegacy: (id, data) => storyboardsAPI.update(id, data),
}
function edit(item, field, value) {
  drafts.value = { ...drafts.value, [item.id]: { ...(drafts.value[item.id] || {}), [field]: value } }
  saver.schedule(`u:${item.id}`, () => saveDraft(item.id, item.legacyId))
}
async function saveDraft(id, legacyId) {
  const d = drafts.value[id]
  if (!d) return
  const snapshot = { ...d }
  const r = await saveShotPatch(writeDeps, { id, legacyId }, snapshot)
  if (!r.ok) throw new Error(r.error || 'save')
  const cur = { ...(drafts.value[id] || {}) }
  for (const k of Object.keys(snapshot)) if (cur[k] === snapshot[k]) delete cur[k]
  const next = { ...drafts.value }
  if (Object.keys(cur).length) next[id] = cur
  else delete next[id]
  drafts.value = next
}
async function flushEdits() { return saver.flush() }
async function retry() { await saver.flush() }

function beforeUnload(e) {
  if (saver.state !== 'saved') { e.preventDefault(); e.returnValue = '' }
}
onBeforeRouteLeave(async () => {
  if (saver.state === 'saved') return true
  const ok = await saver.flush()
  if (ok) return true
  try {
    await ElMessageBox.confirm(t('storyboard.leave.confirm'), t('storyboard.leave.title'), { type: 'warning' })
    return true
  } catch (_) { return false }
})
// A saved edit may have touched plain columns the kernel does not announce: refresh the shared views.
watch(saveState, (s, old) => { if (s === 'saved' && old !== 'saved' && episodeId.value) views.refresh() })

onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  await views.load(episodeId.value, { drama: route.params.dramaId })
  loadRows()
  gen.refresh()
  loadConsistency()
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  clearTimeout(consTimer)
})
</script>

<style scoped>
.sb-view { height: 100%; min-height: 0; display: flex; flex-direction: column; outline: none; background: var(--bg-page, var(--el-bg-color-page)); }
.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; flex-wrap: wrap; border-bottom: 1px solid var(--el-border-color-lighter); }
.spacer { flex: 1; }
.clickable { cursor: pointer; }
.batchbar { display: flex; align-items: center; gap: 8px; padding: 6px 16px; background: var(--el-color-primary-light-9); flex-wrap: wrap; }
.hint { font-size: 12px; color: var(--el-text-color-secondary); }
.content { flex: 1; min-height: 0; display: flex; position: relative; }
.main { flex: 1; min-width: 0; overflow: auto; padding: 16px; display: flex; flex-direction: column; }
.empty { color: var(--el-text-color-secondary); padding: 40px; text-align: center; }
.group { margin-bottom: 20px; }
.ghead { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.sb-table { flex: 1; min-height: 0; }
.inspector { width: 440px; flex: none; border-left: 1px solid var(--el-border-color-lighter); overflow: auto; padding: 8px 12px 24px; background: var(--el-bg-color); }
.ihead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.reopen { position: absolute; right: 12px; top: 12px; }
.settings { display: flex; flex-direction: column; gap: 12px; }
.setting { display: flex; gap: 10px; align-items: flex-start; }
.setting p { margin: 2px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.chips { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; }
.gname { font-size: 12px; color: var(--el-text-color-secondary); }
.thumb { width: 90px; height: 90px; border-radius: 4px; display: block; margin: 0 auto; }
.thumb-empty { display: flex; align-items: center; justify-content: center; background: var(--el-fill-color-light); color: var(--el-text-color-placeholder); font-size: 12px; }
.warn { margin-top: 4px; font-size: 12px; color: var(--el-color-warning); }
:deep(.el-table .is-focus > td.el-table__cell) { background: var(--el-color-primary-light-9) !important; }
:deep(.el-table td.el-table__cell) { vertical-align: top; }
</style>
