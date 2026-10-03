<template>
  <el-drawer
    v-model="historyOpen"
    :title="t('history.title')"
    direction="rtl"
    size="520px"
    :append-to-body="true"
    data-test="history-drawer"
    @opened="reload"
  >
    <div v-if="!episodeId" class="vh-empty" data-test="history-noepisode">{{ t('history.noEpisode') }}</div>
    <template v-else>
      <el-tabs v-model="tab" data-test="history-tabs">
        <el-tab-pane :label="t('history.tab.versions')" name="versions">
          <div v-if="loadError" class="vh-error">{{ loadError }}</div>
          <div v-else-if="!nodes.length" class="vh-empty">{{ t('history.noNodes') }}</div>
          <template v-else>
            <el-select v-model="nodeId" size="small" class="vh-node" filterable :placeholder="t('history.pickNode')" data-test="history-node">
              <el-option v-for="n in nodes" :key="n.node" :value="n.node" :label="t('history.nodeOption', { label: n.label, n: n.versions.length })" />
            </el-select>
            <div v-if="selected" class="vh-nodehead">
              <el-tag size="small" :type="stateType(selected.state)" effect="light" data-test="history-node-state">{{ stateText(selected.state) }}</el-tag>
              <span class="vh-muted">{{ t('history.adoptedNow', { id: selected.adopted || t('history.adoptedNone') }) }}</span>
            </div>
            <div v-if="selected && !selected.versions.length" class="vh-empty">{{ t('history.noVersions') }}</div>
            <article
              v-for="v in cards"
              :key="v.id"
              class="vh-card"
              :class="{ adopted: v.adopted }"
              :data-version="v.id"
              data-test="version-card"
            >
              <div class="vh-thumb">
                <img v-if="v.thumb" :src="v.thumb" alt="" loading="lazy" @error="(e) => (e.target.style.display = 'none')">
                <span v-else class="vh-kind">{{ kindText(v) }}</span>
              </div>
              <div class="vh-main">
                <div class="vh-line1">
                  <b>{{ v.id }}</b>
                  <el-tag v-if="v.adopted" size="small" type="success" effect="dark" data-test="version-adopted">{{ t('history.adopted') }}</el-tag>
                  <el-tag v-if="!v.current" size="small" type="warning" effect="light" :title="t('history.inputChangedTip')">{{ t('history.inputChanged') }}</el-tag>
                </div>
                <div class="vh-muted">{{ v.source }}<template v-if="v.time"> · {{ v.time }}</template></div>
                <div v-if="v.meta" class="vh-muted">{{ v.meta }}</div>
                <div v-if="v.ref" class="vh-muted vh-ref" :title="v.ref">{{ v.ref }}<template v-if="v.hash"> · {{ v.hash }}</template></div>
              </div>
              <el-button size="small" :type="v.adopted ? 'default' : 'primary'" :disabled="!v.canAdopt || views.busy" data-test="adopt-version" @click="adopt(v)">
                {{ v.adopted ? t('history.currentVersion') : t('history.adoptThis') }}
              </el-button>
            </article>
          </template>
        </el-tab-pane>

        <el-tab-pane :label="t('history.tab.ops')" name="ops">
          <div v-if="loadError" class="vh-error">{{ loadError }}</div>
          <div v-else-if="!entries.length" class="vh-empty" data-test="history-ops-empty">{{ t('history.noOps') }}</div>
          <ul v-else class="vh-ops" data-test="history-ops">
            <li v-for="e in entries" :key="e.seq" class="vh-op" :class="[`s-${e.state}`, { head: e.head }]" data-test="history-op" :data-tx="e.tx_id" :data-state="e.state">
              <div class="vh-op-main">
                <span class="vh-op-title">{{ e.title }}</span>
                <span v-if="e.detail" class="vh-muted"> · {{ e.detail }}</span>
                <div class="vh-muted">#{{ e.seq }} · {{ e.time }}</div>
              </div>
              <el-tag v-if="e.head" size="small" type="success" effect="dark">{{ t('history.current') }}</el-tag>
              <el-tag v-else-if="e.stateText" size="small" :type="e.state === 'applied' ? 'info' : 'warning'" effect="light">{{ e.stateText }}</el-tag>
              <el-button v-if="e.jump" size="small" :disabled="views.busy || jumping" data-test="history-jump" @click="jump(e)">{{ e.jump.label }}</el-button>
            </li>
          </ul>
          <p v-if="truncated" class="vh-muted">{{ t('history.truncated') }}</p>
        </el-tab-pane>
      </el-tabs>
    </template>
  </el-drawer>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { kernelAPI } from '@/api/kernel'
import { useProjectViewsStore } from '@/stores/projectViews'
import { historyFocusNode, historyOpen } from '@/composables/useHistoryDrawer'
import { episodeOfRoute } from '@/utils/episodeContext'
import { adoptOps, describeEntry, describeVersion, nodeLabel, shotNumberMap, thumbUrl } from '@/utils/versionHistory'
import { stateLabel } from '@/components/canvas/canvasModel'

const { t } = useI18n()
const route = useRoute()
const views = useProjectViewsStore()

const tab = ref('versions')
const nodeId = ref('')
const rawNodes = ref([])
const rawEntries = ref([])
const truncated = ref(false)
const loadError = ref('')
const jumping = ref(false)

const episodeId = computed(() => episodeOfRoute(route))
const nums = computed(() => shotNumberMap(views.views.shots))
const nodes = computed(() => rawNodes.value.map((n) => ({ ...n, label: nodeLabel(n, nums.value) })))
const selected = computed(() => nodes.value.find((n) => n.node === nodeId.value) || null)
const cards = computed(() => {
  const n = selected.value
  if (!n) return []
  // 新版本在前
  return [...n.versions].reverse().map((v) => ({ ...describeVersion(n, v), thumb: thumbUrl(v.asset?.ref, v.asset?.kind) }))
})
const entries = computed(() => {
  const list = rawEntries.value.map(describeEntry)
  const head = list.find((e) => e.state === 'applied')
  return list.map((e) => ({ ...e, head: e === head }))
})

const stateText = (s) => stateLabel(s) || s
const stateType = (s) => ({ fresh: 'success', stale: 'warning', none: 'info' }[s] || 'info')
const kindText = (v) => t(['video', 'audio', 'image'].includes(v.kind) ? `history.kind.${v.kind}` : 'history.kind.other')

async function reload() {
  const ep = episodeId.value
  if (!ep || !historyOpen.value) return
  try {
    const [v, h] = await Promise.all([kernelAPI.versions(ep), kernelAPI.history(ep, 200)])
    if (ep !== episodeId.value) return
    loadError.value = ''
    rawNodes.value = v.nodes || []
    rawEntries.value = h.entries || []
    truncated.value = !!h.truncated
    if (historyFocusNode.value) {
      // 从画布节点面板打开：直接定位到那个节点的版本（节点没有版本记录时按默认选择）
      const want = historyFocusNode.value
      historyFocusNode.value = ''
      if (rawNodes.value.some((n) => n.node === want)) { nodeId.value = want; tab.value = 'versions' }
    }
    if (!rawNodes.value.some((n) => n.node === nodeId.value)) {
      // 默认选第一个有版本的节点（优先当前选择对应的镜头）
      const sel = views.selection
      const pick = rawNodes.value.find((n) => sel && sel.kind === 'shot' && n.shot_id === sel.id && n.versions.length)
        || rawNodes.value.find((n) => n.versions.length) || rawNodes.value[0]
      nodeId.value = pick ? pick.node : ''
    }
  } catch (e) {
    loadError.value = e?.message || t('history.loadFailed')
  }
}

// 打开时、剧集变化时、内核历史前进时（任何视图的编辑 / 撤销）重新读取
watch([historyOpen, episodeId, () => views.seq, historyFocusNode], () => { if (historyOpen.value) reload() })

const sameEpisode = () => !!episodeId.value && views.episodeId === episodeId.value

async function adopt(v) {
  if (!selected.value || !sameEpisode()) return ElMessage.warning(t('history.openProjectFirst'))
  const r = await views.tx('adoptVersion', adoptOps(selected.value.node, v.id))
  if (r) {
    await reload()
    ElMessage.success(t(v.freshIfAdopted ? 'history.adoptedMsg' : 'history.adoptedStale', { id: v.id }))
  }
}

async function jump(e) {
  if (!e.jump || !sameEpisode()) return
  jumping.value = true
  try {
    for (let i = 0; i < e.jump.steps; i++) {
      const r = e.jump.type === 'undo' ? await views.undo() : await views.redo()
      if (!r) break
    }
  } finally {
    jumping.value = false
    await reload()
  }
}
</script>

<style scoped>
.vh-empty { padding: 24px 8px; text-align: center; color: var(--el-text-color-secondary); font-size: 13px; }
.vh-error { color: var(--el-color-danger); font-size: 13px; padding: 8px 0; }
.vh-muted { font-size: 12px; color: var(--el-text-color-secondary); }
.vh-node { width: 100%; margin-bottom: 8px; }
.vh-nodehead { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.vh-card { display: flex; gap: 10px; align-items: center; padding: 10px; border: 1px solid var(--el-border-color-light); border-radius: 8px; margin-bottom: 8px; }
.vh-card.adopted { border-color: var(--el-color-success); background: var(--el-color-success-light-9); }
.vh-thumb { width: 72px; height: 48px; flex: none; border-radius: 4px; background: var(--el-fill-color); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.vh-thumb img { width: 100%; height: 100%; object-fit: cover; }
.vh-kind { font-size: 12px; color: var(--el-text-color-secondary); }
.vh-main { flex: 1; min-width: 0; }
.vh-line1 { display: flex; align-items: center; gap: 6px; }
.vh-ref { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vh-ops { list-style: none; margin: 0; padding: 0; }
.vh-op { display: flex; align-items: center; gap: 8px; padding: 8px 4px; border-bottom: 1px solid var(--el-border-color-lighter); }
.vh-op.s-undone .vh-op-title, .vh-op.s-discarded .vh-op-title { text-decoration: line-through; opacity: .6; }
.vh-op.s-event { opacity: .7; }
.vh-op.head { background: var(--el-color-success-light-9); }
.vh-op-main { flex: 1; min-width: 0; font-size: 13px; }
.vh-op-title { font-weight: 600; }
</style>
