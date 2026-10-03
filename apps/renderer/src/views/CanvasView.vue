<template>
  <div class="canvas-view" data-test="canvas-view">
    <div class="work">
      <div class="flow-wrap">
        <VueFlow
          v-model:nodes="flowNodes"
          v-model:edges="flowEdges"
          :delete-key-code="null"
          :min-zoom="0.15"
          :max-zoom="1.5"
          :nodes-connectable="true"
          :elevate-edges-on-select="true"
          @node-drag-stop="onDragStop"
          @node-click="onNodeClick"
          @edge-click="onEdgeClick"
          @pane-click="onPaneClick"
          @connect="onConnect"
        >
          <template #node-card="p"><CanvasNodeCard v-bind="p" /></template>
          <template #node-sceneGroup="p"><SceneGroupBox v-bind="p" /></template>
          <template #node-assetRef="p"><AssetRefNode v-bind="p" /></template>
          <Background />
          <MiniMap pannable zoomable />
          <Controls />
        </VueFlow>
        <div v-if="views.loading && !views.ready" class="overlay">{{ t('canvas.loading') }}</div>
        <div v-else-if="emptyKey" class="empty" data-test="canvas-empty">{{ t(emptyKey) }}</div>
        <div class="toolbar" data-test="canvas-toolbar">
          <el-select v-model="addType" size="small" style="width: 110px" data-test="add-type">
            <el-option v-for="ty in ADD_TYPES" :key="ty" :label="nodeTypeLabel(ty)" :value="ty" />
          </el-select>
          <el-select v-if="addType === 'shot' || addType === 'script_line'" v-model="addGroup" size="small" style="width: 140px" :placeholder="t('canvas.toolbar.scenePlaceholder')" data-test="add-group">
            <el-option v-for="g in scenes" :key="g.id" :label="g.title || t('canvas.group.untitled')" :value="g.id" />
          </el-select>
          <el-button size="small" type="primary" :disabled="views.busy || !canvas" data-test="add-node" @click="addNode">{{ t('canvas.toolbar.addNode') }}</el-button>
          <span class="sep" />
          <el-tooltip :content="t('canvas.toolbar.staleOnlyTip')" placement="bottom" :show-after="400">
            <el-switch :model-value="shell.staleOnly" size="small" :active-text="t('canvas.toolbar.staleOnly')" data-test="stale-only" @change="shell.setStaleOnly" />
          </el-tooltip>
          <el-tooltip :content="t('canvas.toolbar.assetRefsTip')" placement="bottom" :show-after="400">
            <el-switch v-model="showRefs" size="small" :active-text="t('canvas.toolbar.assetRefs')" data-test="asset-refs" />
          </el-tooltip>
          <span v-if="showRefs && refLayout.stats.assets" class="refs-sum" data-test="asset-refs-summary">
            {{ t('canvas.toolbar.assetRefsSummary', { assets: refLayout.stats.assets, edges: refLayout.stats.edges }) }}<template v-if="refLayout.stats.missing"> · {{ t('canvas.toolbar.assetRefsMissing', { n: refLayout.stats.missing }) }}</template>
          </span>
          <span v-else-if="showRefs && canvas && canvas.nodes.length" class="refs-sum" data-test="asset-refs-empty">{{ t('canvas.empty.noRefs') }}</span>
        </div>
        <div class="hint">{{ t('canvas.hint') }}</div>
      </div>

      <aside class="panel" data-test="canvas-panel">
        <template v-if="node">
          <h4>
            {{ nodeTypeLabel(node.type) }}
            <el-tag v-if="stateLabel(node.state)" size="small" :type="node.state === 'fresh' ? 'success' : node.state === 'stale' ? 'warning' : 'info'" data-test="panel-state">{{ stateLabel(node.state) }}</el-tag>
          </h4>
          <p class="id">{{ node.key ? t('canvas.panel.idKey', { id: node.id, key: node.key }) : node.id }}</p>
          <el-form label-position="top" size="small" @submit.prevent>
            <el-form-item v-for="f in fields" :key="f.key" :label="f.label">
              <el-select v-if="f.type === 'select'" v-model="form[f.key]" style="width: 100%">
                <el-option v-for="o in f.options" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
              <el-switch v-else-if="f.type === 'bool'" v-model="form[f.key]" />
              <el-input v-else-if="f.type === 'number'" v-model="form[f.key]" :data-test="'field-' + f.key" />
              <el-input v-else-if="f.type === 'textarea'" v-model="form[f.key]" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" :data-test="'field-' + f.key" />
              <el-input v-else v-model="form[f.key]" :data-test="'field-' + f.key" />
            </el-form-item>
          </el-form>
          <div class="actions">
            <el-button type="primary" size="small" :disabled="!dirty || views.busy" data-test="apply-params" @click="apply">{{ t('canvas.panel.apply') }}</el-button>
            <el-tooltip v-if="canRegenerate" :content="regen ? t('canvas.panel.applyRegenTip') : t('canvas.panel.regenNoShot')" placement="top" :show-after="300">
              <span>
                <el-button size="small" type="success" :disabled="!regen || views.busy" data-test="apply-regen" @click="applyAndRegenerate">{{ t('canvas.panel.applyRegen') }}</el-button>
              </span>
            </el-tooltip>
            <el-tooltip :content="t('canvas.panel.historyNone')" :disabled="!!historyId" placement="top" :show-after="300">
              <span>
                <el-button size="small" :disabled="!historyId" data-test="open-history" @click="openHistory(historyId)">{{ t('canvas.panel.history') }}</el-button>
              </span>
            </el-tooltip>
            <el-button size="small" :disabled="!dirty" @click="resetForm">{{ t('canvas.panel.reset') }}</el-button>
            <el-button size="small" type="danger" plain :disabled="node.type === 'compose' || views.busy" data-test="delete-node" @click="removeNode">{{ t('canvas.panel.delete') }}</el-button>
          </div>
          <p v-if="node.type === 'compose'" class="note">{{ t('canvas.panel.composeNote') }}</p>
          <el-collapse v-if="ShotInspector && node.type === 'shot'" class="inspector" data-test="shot-inspector">
            <el-collapse-item :title="t('canvas.panel.shotInspector')" name="inspector">
              <component :is="ShotInspector" :shot-id="node.id" compact />
            </el-collapse-item>
          </el-collapse>
        </template>
        <template v-else-if="assetNode">
          <h4>
            {{ t('canvas.asset.title') }}
            <el-tag size="small" :type="assetNode.missing ? 'danger' : 'info'" data-test="asset-kind">{{ t('canvas.assetKind.' + assetNode.kind) }}</el-tag>
          </h4>
          <p class="asset-name" data-test="asset-name">{{ assetName(assetNode) }}</p>
          <p v-if="assetNode.missing" class="note warn" data-test="asset-missing">{{ t('canvas.asset.deletedTip') }}</p>
          <p class="note">{{ t('canvas.asset.readonly') }}</p>
          <p class="note">{{ t('canvas.asset.usedBy', { n: assetNode.shots.length }) }}</p>
          <p class="note">{{ t('canvas.asset.impact') }}</p>
          <ul class="ref-shots">
            <li v-for="s in assetShots" :key="s.id"><a href="#" @click.prevent="gotoShot(s.id)">{{ s.label }}</a></li>
          </ul>
          <el-button v-if="!assetNode.missing" size="small" data-test="asset-open-library" @click="shell.openAssetsPanel()">{{ t('canvas.asset.openLibrary') }}</el-button>
        </template>
        <template v-else-if="edge">
          <h4>{{ t('canvas.panel.edge') }}</h4>
          <p class="id">{{ t('canvas.panel.edgeLine', { from: edge.from.node, to: edge.to.node, port: edge.to.port, type: edge.type }) }}</p>
          <el-button size="small" type="danger" plain :disabled="views.busy" data-test="delete-edge" @click="removeEdge">{{ t('canvas.panel.disconnect') }}</el-button>
        </template>
        <template v-else>
          <p class="note">{{ t('canvas.panel.hint') }}</p>
          <h4>{{ t('canvas.panel.scenes') }}</h4>
          <div v-for="g in scenes" :key="g.id" class="scene" :data-test="'scene-' + g.id">
            <el-input v-model="sceneTitles[g.id]" size="small" :placeholder="g.title || t('canvas.group.untitled')" data-test="scene-title" @keyup.enter="renameScene(g)">
              <template #append>
                <el-button size="small" :disabled="views.busy || (sceneTitles[g.id] ?? g.title) === g.title" data-test="scene-rename" @click="renameScene(g)">{{ t('canvas.panel.rename') }}</el-button>
              </template>
            </el-input>
            <span class="scene-sub">{{ g.stale ? t('canvas.panel.sceneSubStale', g) : t('canvas.panel.sceneSub', g) }}</span>
          </div>
          <p v-if="!scenes.length" class="note">{{ t('canvas.panel.noScenes') }}</p>
        </template>
        <p v-if="views.error" class="err" data-test="canvas-error">{{ views.error }}</p>
      </aside>
    </div>
    <GenerateDialog :state="gen.dialog.value" @confirm="gen.confirm" @cancel="gen.cancel" />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import { ElMessage } from 'element-plus'
import { t } from '@/i18n'
import CanvasNodeCard from '@/components/canvas/CanvasNodeCard.vue'
import SceneGroupBox from '@/components/canvas/SceneGroupBox.vue'
import AssetRefNode from '@/components/canvas/AssetRefNode.vue'
import GenerateDialog from '@/components/GenerateDialog.vue'
import {
  assetOverlayToFlow, editableFieldsT, historyTarget, newNodeParams, nodeTypeLabel, paramOps, regeneratePlan, sceneTitleCheck, staleOnlyCanvas, stateLabel,
} from '@/components/canvas/canvasModel'
import { useProjectViewsStore } from '@/stores/projectViews'
import { useShellStore } from '@/stores/shell'
import { useGeneration } from '@/composables/useGeneration'
import { openHistory } from '@/composables/useHistoryDrawer'
import { buildAssetRefLayout, isAssetRefId } from '@/utils/canvasAssetRefs'
import { busyCount } from '@/utils/consistencyView'
import {
  addNodeArgs, canvasToFlow, diffParams, displayPos, fieldValue, sceneRows, shotNumbers,
} from '@/utils/projectViews'

// 资产库（lane 7）与分镜检查器（lane 8）是可选依赖：文件还不存在时 glob 为空，对应的块直接不显示
const assetStoreMods = import.meta.glob('@/stores/assets.js', { eager: true })
const inspectorMods = import.meta.glob('@/components/shot/ShotInspector.vue', { eager: true })
const useAssetsStore = Object.values(assetStoreMods).map((m) => m.useAssetsStore).find((f) => typeof f === 'function') || null
const ShotInspector = Object.values(inspectorMods).map((m) => m.default).find(Boolean) || null

const ADD_TYPES = ['shot', 'script_line', 'image', 'video', 'narration']
const REFS_KEY = 'talekiln.canvas.assetRefs'

const route = useRoute()
const views = useProjectViewsStore()
const shell = useShellStore()
const assetsStore = useAssetsStore ? useAssetsStore() : null
const { fitView } = useVueFlow()

const flowNodes = ref([])
const flowEdges = ref([])
const edgeId = ref(null)
const assetSel = ref(null)

const canvas = computed(() => views.views.canvas)
// 只看过期：画布显示的是过滤后的副本；侧栏、拖动保存仍然按完整画布查找
const shownCanvas = computed(() => (shell.staleOnly ? staleOnlyCanvas(canvas.value, views.staleSet) : canvas.value))
const focus = computed(() => views.focusFor('canvas'))
const node = computed(() => (focus.value && canvas.value ? canvas.value.nodes.find((n) => n.id === focus.value.id) : null))
const edge = computed(() => (!node.value && edgeId.value && canvas.value ? canvas.value.edges.find((e) => e.id === edgeId.value) : null))
const fields = computed(() => (node.value ? editableFieldsT(node.value.type) : []))
const scenes = computed(() => sceneRows(canvas.value))

const emptyKey = computed(() => {
  if (!views.ready) return ''
  if (!canvas.value || !canvas.value.nodes.length) return 'canvas.empty.noNodes'
  if (shell.staleOnly && !shownCanvas.value.nodes.length) return 'canvas.empty.noStale'
  return ''
})

// ---------- 资产引用覆盖层（只读，永远不写进内核） ----------
function loadRefsFlag() {
  try { return globalThis.localStorage?.getItem(REFS_KEY) === '1' } catch (_) { return false }
}
const showRefs = ref(loadRefsFlag())
watch(showRefs, (v) => {
  try { globalThis.localStorage?.setItem(REFS_KEY, v ? '1' : '0') } catch (_) { /* 无存储时只是不记住 */ }
  if (!v) assetSel.value = null
})
// 资产来源：资产库 store（若已有）优先，其次是项目详情里带的 characters / scenes / props
const assetsData = computed(() => {
  const pick = (key) => {
    const fromStore = assetsStore && assetsStore[key]
    if (Array.isArray(fromStore) && fromStore.length) return fromStore
    const fromDrama = shell.drama && shell.drama[key]
    return Array.isArray(fromDrama) ? fromDrama : []
  }
  return { characters: pick('characters'), scenes: pick('scenes'), props: pick('props') }
})
const refLayout = computed(() => (showRefs.value ? buildAssetRefLayout(shownCanvas.value, assetsData.value) : buildAssetRefLayout(null, null)))
const assetNode = computed(() => (assetSel.value && showRefs.value ? refLayout.value.nodes.find((n) => n.id === assetSel.value) || null : null))
const shotNums = computed(() => shotNumbers(views.views.shots))
const assetName = (a) => (a.name || (a.assetId != null ? t('canvas.asset.deletedId', { id: a.assetId }) : t('canvas.asset.deleted')))
const assetShots = computed(() => {
  if (!assetNode.value || !canvas.value) return []
  const byId = Object.fromEntries(canvas.value.nodes.map((n) => [n.id, n]))
  return assetNode.value.shots.map((id) => {
    const n = byId[id]
    const num = shotNums.value[id]
    const title = n && n.params && n.params.title
    const label = num ? (title ? t('canvas.asset.shotLabel', { n: num, title }) : t('canvas.asset.shotUntitled', { n: num })) : (title || id)
    return { id, label }
  })
})
function gotoShot(id) {
  assetSel.value = null
  edgeId.value = null
  views.select({ kind: 'node', id })
}

// ---------- 新增节点 ----------
// 位置由 addNodeArgs 算，落点在图的最右侧；新节点自动选中；镜头 / 剧本行的默认内容跟随当前语言
const addType = ref('shot')
const addGroup = ref(null)
watch(scenes, (list) => { if (!list.some((g) => g.id === addGroup.value)) addGroup.value = list[0]?.id ?? null }, { immediate: true })
async function addNode() {
  if (!canvas.value) return
  const args = addNodeArgs(canvas.value, addType.value, { group: addGroup.value })
  const params = newNodeParams(addType.value)
  if (params) args.params = params
  const r = await views.intent('canvas', 'addNodeAt', args)
  const id = r && r.meta && r.meta.node_id
  if (id) { edgeId.value = null; assetSel.value = null; views.select({ kind: 'node', id }) }
}

// 场景改名：canvas.renameGroup（进内核历史，可撤销）；输入框只保留用户正在改的标题，提交后随视图刷新
const sceneTitles = reactive({})
watch(scenes, () => { for (const k of Object.keys(sceneTitles)) delete sceneTitles[k] })
async function renameScene(g) {
  const raw = sceneTitles[g.id] ?? g.title
  const check = sceneTitleCheck(raw)
  if (check.error) return ElMessage.warning(check.error)
  if (check.value === g.title) return
  await views.intent('canvas', 'renameGroup', { group_id: g.id, title: check.value })
}

// 画布数据只来自 store；Vue Flow 里的数组是它的显示副本，每次 store 变化（含失败后的回读）都整体重建
function rebuild() {
  const f = canvasToFlow(shownCanvas.value, focus.value?.id || null)
  const overlay = showRefs.value ? assetOverlayToFlow(refLayout.value) : { nodes: [], edges: [] }
  flowNodes.value = [...f.nodes, ...overlay.nodes.map((n) => ({ ...n, selected: n.id === assetSel.value }))]
  flowEdges.value = [...f.edges.map((e) => ({ ...e, selected: e.id === edgeId.value })), ...overlay.edges]
}
watch(canvas, rebuild, { deep: false })
watch([focus, edgeId, assetSel, () => shell.staleOnly, showRefs, assetsData], rebuild)

// ---------- 侧栏表单 ----------
const form = reactive({})
function resetForm() {
  for (const k of Object.keys(form)) delete form[k]
  if (node.value) for (const f of fields.value) form[f.key] = fieldValue(f, node.value.params)
}
watch(() => [node.value?.id, node.value?.params, views.seq], resetForm, { immediate: true })
const diff = computed(() => (node.value ? diffParams(fields.value, node.value.params, form) : { patch: {}, changed: false }))
const dirty = computed(() => diff.value.changed)

// 返回 true = 修改已进入内核（没有修改也算 true）；剧本行 / 镜头走各自的意图，其它节点走 setNodeParam 事务
async function applyPatch() {
  const n = node.value
  const { patch } = diff.value
  if (!n) return false
  if (!Object.keys(patch).length) return true
  let r
  if (n.type === 'script_line') r = await views.intent('script', 'rewriteLine', { line_id: n.id, patch })
  else if (n.type === 'shot') r = await views.intent('shot', 'setShotField', { shot_id: n.id, patch })
  else r = await views.tx('setNodeParam', paramOps(n.id, patch))
  return !!r
}
const apply = () => applyPatch()

// ---------- 应用并重新生成 / 版本历史 ----------
const episodeId = computed(() => Number(route.params.episodeId) || 0)
const gen = useGeneration(episodeId)
const canRegenerate = computed(() => !!node.value && ['shot', 'image', 'video'].includes(node.value.type))
const regen = computed(() => (node.value ? regeneratePlan(node.value, views.index) : null))
const historyId = computed(() => historyTarget(node.value, canvas.value))

async function applyAndRegenerate() {
  const plan = regen.value
  if (!plan) return
  const ok = await applyPatch()
  if (!ok) { ElMessage.warning(t('canvas.msg.applyFailed')); return }
  await gen.ask({ shots: [plan.storyboardId], kind: plan.kind, regenerate: true })
}
// 排队的任务跑完（排队 + 生成中的镜头数由 >0 变 0）后重新读取项目图，节点状态从已过期变回最新
watch(() => busyCount(gen.status.value), (now, before) => { if (before > 0 && now === 0) views.refresh() })

async function removeNode() {
  const n = node.value
  if (!n) return
  const r = await views.intent('canvas', 'deleteNode', { node_id: n.id })
  if (r) views.select(null)
}
async function removeEdge() {
  const e = edge.value
  if (!e) return
  const r = await views.intent('canvas', 'disconnectNodes', { edge_id: e.id })
  if (r) edgeId.value = null
}

// 拖动：只写 layout（moveNode），内核保证不改 cacheKey / 过期集合；分组框和覆盖层节点不保存
async function onDragStop({ node: n }) {
  if (!n || String(n.id).startsWith('group:') || isAssetRefId(n.id)) return
  const orig = canvas.value?.nodes.find((x) => x.id === n.id)
  const { x, y } = n.position
  const shown = orig && displayPos(orig)
  if (shown && Math.round(shown.x) === Math.round(x) && Math.round(shown.y) === Math.round(y)) return
  await views.intent('canvas', 'moveNode', { node_id: n.id, pos: { x: Math.round(x), y: Math.round(y) } })
}

function onNodeClick({ node: n }) {
  if (String(n.id).startsWith('group:')) return
  edgeId.value = null
  if (isAssetRefId(n.id)) { assetSel.value = n.id; views.select(null); return }
  assetSel.value = null
  views.select({ kind: 'node', id: n.id })
}
function onEdgeClick({ edge: e }) {
  if (String(e.id).startsWith('assetref:')) return
  edgeId.value = e.id
  assetSel.value = null
  views.select(null)
}
function onPaneClick() {
  edgeId.value = null
  assetSel.value = null
  views.select(null)
}

// 连线：端口类型 / 环 / 容量由内核校验，失败时 store 给出内核的错误文案并回读，画布上不会留下非法的边
async function onConnect(c) {
  if (isAssetRefId(c.source) || isAssetRefId(c.target)) { rebuild(); return }
  await views.intent('canvas', 'connectNodes', { from_id: c.source, to_id: c.target, port: c.targetHandle || undefined })
  rebuild()
}

function onKey(e) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  const el = e.target
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
  if (node.value && node.value.type !== 'compose') { e.preventDefault(); removeNode() } else if (edge.value) { e.preventDefault(); removeEdge() }
}

async function fit() {
  await nextTick()
  const f = focus.value
  setTimeout(() => fitView(f ? { nodes: [f.id], maxZoom: 0.9, padding: 0.6, duration: 0 } : { padding: 0.15, maxZoom: 0.9, duration: 0 }), 50)
}

// 外壳用 router-view :key 在切集时重建本视图，所以只需在挂载时加载
onMounted(async () => {
  window.addEventListener('keydown', onKey)
  await views.load(route.params.episodeId, { drama: route.params.dramaId })
  rebuild()
  fit()
  gen.refresh()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.canvas-view { height: 100%; min-height: 520px; display: flex; flex-direction: column; background: var(--bg-page); }
.work { flex: 1; display: flex; min-height: 0; }
.flow-wrap { flex: 1; position: relative; min-width: 0; }
.overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--bg-page) 70%, transparent); color: var(--el-text-color-secondary); z-index: 5; }
.empty { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); z-index: 3; max-width: 420px; text-align: center; line-height: 1.7; font-size: 13px; color: var(--el-text-color-secondary); pointer-events: none; }
.toolbar { position: absolute; left: 12px; top: 12px; z-index: 4; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; max-width: calc(100% - 24px); background: var(--el-bg-color); padding: 6px 10px; border-radius: 6px; border: 1px solid var(--el-border-color-lighter); }
.sep { width: 1px; align-self: stretch; background: var(--el-border-color-lighter); }
.refs-sum { font-size: 12px; color: var(--el-text-color-secondary); }
.scene { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
.scene-sub { font-size: 12px; color: var(--el-text-color-secondary); }
.hint { position: absolute; left: 12px; bottom: 12px; font-size: 12px; color: var(--el-text-color-secondary); background: var(--el-bg-color); padding: 3px 10px; border-radius: 6px; border: 1px solid var(--el-border-color-lighter); z-index: 4; max-width: 70%; }
.panel { width: 320px; flex-shrink: 0; overflow: auto; padding: 14px 16px; border-left: 1px solid var(--el-border-color-light); background: var(--el-bg-color); }
.panel h4 { margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
.id { margin: 0 0 10px; font-size: 12px; color: var(--el-text-color-secondary); word-break: break-all; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.note { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; }
.note.warn { color: var(--el-color-danger); }
.asset-name { margin: 0 0 8px; font-weight: 600; word-break: break-all; }
.ref-shots { margin: 0 0 12px; padding-left: 18px; font-size: 12px; line-height: 1.8; max-height: 260px; overflow: auto; }
.inspector { margin-top: 14px; }
.err { color: var(--el-color-danger); font-size: 12px; margin-top: 12px; word-break: break-all; }
@media (max-width: 800px) { .work { flex-direction: column; } .panel { width: auto; max-height: 40vh; border-left: 0; border-top: 1px solid var(--el-border-color-light); } }
</style>
