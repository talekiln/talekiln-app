<template>
  <div class="canvas-view" data-test="canvas-view">
    <ViewSwitcher />
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
          <Background />
          <MiniMap pannable zoomable />
          <Controls />
        </VueFlow>
        <div v-if="views.loading && !views.ready" class="overlay">加载中…</div>
        <div class="hint">拖动节点只改位置（不会让任何东西过期）· 从节点右侧圆点拖到另一节点左侧圆点连线 · 点选连线后可断开 · Delete 删除选中项</div>
      </div>

      <aside class="panel" data-test="canvas-panel">
        <template v-if="node">
          <h4>
            {{ NODE_TYPE_LABEL[node.type] }}
            <el-tag v-if="STATE_LABEL[node.state]" size="small" :type="node.state === 'fresh' ? 'success' : node.state === 'stale' ? 'warning' : 'info'" data-test="panel-state">{{ STATE_LABEL[node.state] }}</el-tag>
          </h4>
          <p class="id">{{ node.id }}<template v-if="node.key"> · key {{ node.key }}</template></p>
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
            <el-button type="primary" size="small" :disabled="!dirty || views.busy" data-test="apply-params" @click="apply">应用</el-button>
            <el-button size="small" :disabled="!dirty" @click="resetForm">还原</el-button>
            <el-button size="small" type="danger" plain :disabled="node.type === 'compose' || views.busy" data-test="delete-node" @click="removeNode">删除节点</el-button>
          </div>
          <p v-if="node.type === 'compose'" class="note">合成节点每集唯一，不能从画布删除。</p>
        </template>
        <template v-else-if="edge">
          <h4>连线</h4>
          <p class="id">{{ edge.from.node }} → {{ edge.to.node }}.{{ edge.to.port }}（{{ edge.type }}）</p>
          <el-button size="small" type="danger" plain :disabled="views.busy" data-test="delete-edge" @click="removeEdge">断开</el-button>
        </template>
        <p v-else class="note">点选一个节点查看和编辑它的关键参数；剧本行、镜头的修改会同步到剧本 / 分镜 / 时间线视图。</p>
        <p v-if="views.error" class="err" data-test="canvas-error">{{ views.error }}</p>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import ViewSwitcher from '@/components/ViewSwitcher.vue'
import CanvasNodeCard from '@/components/canvas/CanvasNodeCard.vue'
import SceneGroupBox from '@/components/canvas/SceneGroupBox.vue'
import { useProjectViewsStore } from '@/stores/projectViews'
import { NODE_TYPE_LABEL, STATE_LABEL, canvasToFlow, diffParams, displayPos, editableFields, fieldValue } from '@/utils/projectViews'

const route = useRoute()
const views = useProjectViewsStore()
const { fitView } = useVueFlow()

const flowNodes = ref([])
const flowEdges = ref([])
const edgeId = ref(null)

const canvas = computed(() => views.views.canvas)
const focus = computed(() => views.focusFor('canvas'))
const node = computed(() => (focus.value && canvas.value ? canvas.value.nodes.find((n) => n.id === focus.value.id) : null))
const edge = computed(() => (!node.value && edgeId.value && canvas.value ? canvas.value.edges.find((e) => e.id === edgeId.value) : null))
const fields = computed(() => (node.value ? editableFields(node.value.type) : []))

// 画布数据只来自 store；Vue Flow 里的数组是它的显示副本，每次 store 变化（含失败后的回读）都整体重建
function rebuild() {
  const f = canvasToFlow(canvas.value, focus.value?.id || null)
  flowNodes.value = f.nodes
  flowEdges.value = f.edges.map((e) => ({ ...e, selected: e.id === edgeId.value }))
}
watch(canvas, rebuild, { deep: false })
watch([focus, edgeId], rebuild)

// 侧栏表单
const form = reactive({})
function resetForm() {
  for (const k of Object.keys(form)) delete form[k]
  if (node.value) for (const f of fields.value) form[f.key] = fieldValue(f, node.value.params)
}
watch(() => [node.value?.id, node.value?.params, views.seq], resetForm, { immediate: true })
const diff = computed(() => (node.value ? diffParams(fields.value, node.value.params, form) : { patch: {}, changed: false }))
const dirty = computed(() => diff.value.changed)

async function apply() {
  const n = node.value
  const { patch } = diff.value
  if (!n || !Object.keys(patch).length) return
  if (n.type === 'script_line') await views.intent('script', 'rewriteLine', { line_id: n.id, patch })
  else if (n.type === 'shot') await views.intent('shot', 'setShotField', { shot_id: n.id, patch })
  else await views.setParam(n.id, patch) // 画布没有“改参数”意图：纯 setParam 事务
}

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

// 拖动：只写 layout（moveNode），内核保证不改 cacheKey / 过期集合
async function onDragStop({ node: n }) {
  if (!n || String(n.id).startsWith('group:')) return
  const orig = canvas.value?.nodes.find((x) => x.id === n.id)
  const { x, y } = n.position
  const shown = orig && displayPos(orig)
  if (shown && Math.round(shown.x) === Math.round(x) && Math.round(shown.y) === Math.round(y)) return
  await views.intent('canvas', 'moveNode', { node_id: n.id, pos: { x: Math.round(x), y: Math.round(y) } })
}

function onNodeClick({ node: n }) {
  if (String(n.id).startsWith('group:')) return
  edgeId.value = null
  views.select({ kind: 'node', id: n.id })
}
function onEdgeClick({ edge: e }) {
  edgeId.value = e.id
  views.select(null)
}
function onPaneClick() {
  edgeId.value = null
  views.select(null)
}

// 连线：端口类型 / 环 / 容量由内核校验，失败时 store 给出内核的错误文案并回读，画布上不会留下非法的边
async function onConnect(c) {
  await views.intent('canvas', 'connectNodes', { from_id: c.source, to_id: c.target, port: c.targetHandle || undefined })
  rebuild()
}

function onKey(e) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  if (node.value && node.value.type !== 'compose') { e.preventDefault(); removeNode() } else if (edge.value) { e.preventDefault(); removeEdge() }
}

async function fit() {
  await nextTick()
  const f = focus.value
  setTimeout(() => fitView(f ? { nodes: [f.id], maxZoom: 0.9, padding: 0.6, duration: 0 } : { padding: 0.15, maxZoom: 0.9, duration: 0 }), 50)
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  await views.load(route.params.id, { drama: route.query.drama })
  rebuild()
  fit()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
watch(() => route.params.id, async (id) => { if (id) { await views.load(id, { drama: route.query.drama }); rebuild(); fit() } })
</script>

<style scoped>
.canvas-view { height: 100vh; display: flex; flex-direction: column; background: var(--bg-page); }
.work { flex: 1; display: flex; min-height: 0; }
.flow-wrap { flex: 1; position: relative; min-width: 0; }
.overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--bg-page) 70%, transparent); color: var(--el-text-color-secondary); z-index: 5; }
.hint { position: absolute; left: 12px; bottom: 12px; font-size: 12px; color: var(--el-text-color-secondary); background: var(--el-bg-color); padding: 3px 10px; border-radius: 6px; border: 1px solid var(--el-border-color-lighter); z-index: 4; max-width: 70%; }
.panel { width: 320px; flex-shrink: 0; overflow: auto; padding: 14px 16px; border-left: 1px solid var(--el-border-color-light); background: var(--el-bg-color); }
.panel h4 { margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
.id { margin: 0 0 10px; font-size: 12px; color: var(--el-text-color-secondary); word-break: break-all; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.note { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; }
.err { color: var(--el-color-danger); font-size: 12px; margin-top: 12px; word-break: break-all; }
@media (max-width: 800px) { .work { flex-direction: column; } .panel { width: auto; max-height: 40vh; border-left: 0; border-top: 1px solid var(--el-border-color-light); } }
</style>
