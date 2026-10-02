<template>
  <div class="ref-lib">
    <div class="page-header">
      <el-button text @click="$router.back()"><el-icon><ArrowLeft /></el-icon>返回</el-button>
      <h2 class="page-title">{{ title || '项目' }} · 角色与场景库</h2>
      <span class="spacer" />
      <el-select v-model="model" placeholder="图像模型" clearable style="width: 200px">
        <el-option v-for="m in models" :key="m" :label="m" :value="m" />
      </el-select>
    </div>

    <el-tabs v-model="kind" @tab-change="onKindChange">
      <el-tab-pane label="角色" name="character" />
      <el-tab-pane label="场景" name="scene" />
    </el-tabs>

    <div v-loading="loading" class="body">
      <aside class="list">
        <div
          v-for="e in entities"
          :key="e.id"
          class="item"
          :class="{ active: e.id === selectedId }"
          @click="select(e.id)"
        >
          <el-image v-if="lockSrc(e.id)" :src="lockSrc(e.id)" fit="cover" class="mini" />
          <div v-else class="mini mini-empty">无</div>
          <span class="name">{{ entityName(e) }}</span>
          <el-tag v-if="locks[`${kind}:${e.id}`]" size="small" type="success">已锁定</el-tag>
        </div>
        <el-empty v-if="!entities.length" :description="kind === 'scene' ? '暂无场景' : '暂无角色'" />
      </aside>

      <section v-if="current" class="detail">
        <h3>{{ entityName(current) }}</h3>
        <p class="desc">{{ entityDesc(current) }}</p>

        <div class="lock-box">
          <div class="lock-title">锁定的参考图</div>
          <template v-if="currentLock">
            <el-image :src="lockSrc(current.id)" fit="contain" class="lock-img" :preview-src-list="[lockSrc(current.id)]" />
            <div class="hint">生成该{{ kind === 'scene' ? '场景' : '角色' }}相关镜头的视频时，会自动作为参考图带上。</div>
            <el-button type="warning" plain @click="unlock">解除锁定</el-button>
          </template>
          <div v-else class="hint">尚未锁定。生成候选图后选择一张锁定。</div>
        </div>

        <div class="gen-bar">
          <el-button type="primary" :loading="generating" @click="generate">生成 {{ CANDIDATE_COUNT }} 张候选</el-button>
          <span class="hint">候选只保存在本页，锁定后才会写入库。</span>
        </div>

        <div class="cands">
          <div v-for="c in cands" :key="c.key" class="cand" :class="{ locked: isLockedCandidate(c.rec, currentLock) }">
            <el-image v-if="imgSrc(c.rec)" :src="imgSrc(c.rec)" fit="cover" class="cand-img" :preview-src-list="[imgSrc(c.rec)]" />
            <div v-else class="cand-img cand-wait">
              <span v-if="c.rec?.status === 'failed'">失败：{{ c.rec.error_msg || '未知错误' }}</span>
              <span v-else>生成中…</span>
            </div>
            <el-button
              size="small"
              :type="isLockedCandidate(c.rec, currentLock) ? 'success' : 'primary'"
              :disabled="!isLockable(c.rec) || isLockedCandidate(c.rec, currentLock)"
              @click="lock(c.rec)"
            >{{ isLockedCandidate(c.rec, currentLock) ? '已锁定' : '锁定为参考图' }}</el-button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { dramaAPI } from '@/api/drama'
import { aiAPI } from '@/api/ai'
import { imagesAPI } from '@/api/images'
import { referenceLocksAPI } from '@/api/referenceLocks'
import { getSelectableModels } from '@/utils/modelSelection'
import {
  CANDIDATE_COUNT, buildCandidateRequest, candidateImageSrc, indexLocks, isLockable, isLockedCandidate, lockBody,
} from '@/utils/referenceLibrary'

const route = useRoute()
const dramaId = route.params.dramaId
const title = ref('')
const kind = ref('character')
const drama = ref({ characters: [], scenes: [] })
const loading = ref(false)
const locks = ref({})
const selectedId = ref(null)
const models = ref([])
const model = ref('')
const generating = ref(false)
const cands = ref([])
let timer = null
let keySeq = 0

const entities = computed(() => (kind.value === 'scene' ? drama.value.scenes : drama.value.characters) || [])
const current = computed(() => entities.value.find((e) => e.id === selectedId.value) || null)
const currentLock = computed(() => (current.value ? locks.value[`${kind.value}:${current.value.id}`] : null))

const entityName = (e) => (kind.value === 'scene' ? [e.location, e.time].filter(Boolean).join(' · ') || `场景 ${e.id}` : e.name)
const entityDesc = (e) => (kind.value === 'scene' ? e.prompt : e.appearance || e.description) || ''
const imgSrc = candidateImageSrc
const lockSrc = (id) => candidateImageSrc(locks.value[`${kind.value}:${id}`])

async function loadLocks() {
  const ids = entities.value.map((e) => e.id)
  locks.value = { ...locks.value, ...indexLocks(kind.value, await referenceLocksAPI.list(kind.value, ids)) }
}

async function load() {
  loading.value = true
  try {
    const d = await dramaAPI.get(dramaId)
    title.value = d.title
    drama.value = { characters: d.characters || [], scenes: d.scenes || [] }
    selectedId.value = entities.value[0]?.id ?? null
    await loadLocks()
    try {
      models.value = getSelectableModels(await aiAPI.list('image'), 'image')
      model.value = models.value[0] || ''
    } catch (_) { /* 模型列表失败不阻塞页面 */ }
  } finally {
    loading.value = false
  }
}

function select(id) {
  selectedId.value = id
  cands.value = []
}

async function onKindChange() {
  selectedId.value = entities.value[0]?.id ?? null
  cands.value = []
  await loadLocks()
}

async function generate() {
  if (!current.value) return
  generating.value = true
  try {
    const body = buildCandidateRequest({ kind: kind.value, entity: current.value, dramaId, model: model.value })
    const recs = await Promise.all(Array.from({ length: CANDIDATE_COUNT }, () => imagesAPI.create(body)))
    cands.value = recs.map((rec) => ({ key: ++keySeq, rec }))
    startPolling()
  } catch (e) {
    ElMessage.error(e.message || '生成失败')
  } finally {
    generating.value = false
  }
}

function startPolling() {
  stopPolling()
  timer = setInterval(async () => {
    const pending = cands.value.filter((c) => c.rec && !['completed', 'failed'].includes(c.rec.status))
    if (!pending.length) return stopPolling()
    await Promise.all(pending.map(async (c) => {
      try { c.rec = await imagesAPI.get(c.rec.id) } catch (_) { /* 下次重试 */ }
    }))
  }, 3000)
}

function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
}

async function lock(rec) {
  try {
    const saved = await referenceLocksAPI.lock(kind.value, current.value.id, lockBody(rec))
    locks.value = { ...locks.value, [`${kind.value}:${current.value.id}`]: saved }
    ElMessage.success('已锁定为参考图')
  } catch (e) {
    ElMessage.error(e.message || '锁定失败')
  }
}

async function unlock() {
  await referenceLocksAPI.unlock(kind.value, current.value.id)
  const next = { ...locks.value }
  delete next[`${kind.value}:${current.value.id}`]
  locks.value = next
}

onMounted(load)
onBeforeUnmount(stopPolling)
</script>

<style scoped>
.ref-lib { max-width: 1200px; margin: 0 auto; padding: 24px; }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.page-title { margin: 0; font-size: 18px; }
.spacer { flex: 1; }
.body { display: flex; gap: 20px; align-items: flex-start; min-height: 300px; }
.list { width: 260px; flex-shrink: 0; border: 1px solid var(--el-border-color); border-radius: 6px; max-height: 70vh; overflow: auto; }
.item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; }
.item:hover { background: var(--el-fill-color-light); }
.item.active { background: var(--el-color-primary-light-9); }
.mini { width: 36px; height: 36px; border-radius: 4px; flex-shrink: 0; }
.mini-empty { background: var(--el-fill-color); color: var(--el-text-color-placeholder); font-size: 12px; display: flex; align-items: center; justify-content: center; }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail { flex: 1; min-width: 0; }
.desc, .hint { color: var(--el-text-color-secondary); font-size: 13px; }
.lock-box { border: 1px dashed var(--el-border-color); border-radius: 6px; padding: 12px; margin: 12px 0; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.lock-title { font-weight: 600; }
.lock-img { width: 200px; height: 200px; border-radius: 4px; }
.gen-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.cands { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.cand { display: flex; flex-direction: column; gap: 6px; padding: 6px; border: 2px solid transparent; border-radius: 6px; }
.cand.locked { border-color: var(--el-color-success); }
.cand-img { width: 100%; aspect-ratio: 1 / 1; border-radius: 4px; background: var(--el-fill-color); }
.cand-wait { display: flex; align-items: center; justify-content: center; color: var(--el-text-color-secondary); font-size: 12px; padding: 8px; text-align: center; }
@media (max-width: 720px) { .body { flex-direction: column; } .list { width: 100%; } }
</style>
