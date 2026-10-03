<template>
  <section class="media" data-test="media-panel">
    <div class="bar">
      <el-radio-group v-model="mediaType" @change="reload">
        <el-radio-button value="all">{{ t('home.media.all') }}</el-radio-button>
        <el-radio-button value="image">{{ t('home.media.image') }}</el-radio-button>
        <el-radio-button value="video">{{ t('home.media.video') }}</el-radio-button>
      </el-radio-group>
      <el-input v-model="keyword" clearable class="search" :placeholder="t('home.media.search')" :aria-label="t('home.media.search')" @input="debouncedLoad">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <span class="grow" />
      <el-button type="primary" plain data-test="media-upload" @click="uploadInput?.click()">
        <el-icon><Upload /></el-icon>{{ t('home.media.upload') }}
      </el-button>
      <input ref="uploadInput" type="file" accept="image/*,video/*" multiple class="hidden" @change="onUpload" />
    </div>

    <div v-if="uploading" class="progress" role="status">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>{{ t('home.media.uploading', { current: progress.current, total: progress.total }) }}</span>
    </div>

    <div v-loading="loading" class="grid">
      <div
        v-for="item in items"
        :key="item.id"
        class="card"
        :class="{ selected: selected.has(item.id) }"
        role="button"
        tabindex="0"
        :aria-pressed="selected.has(item.id)"
        @click="toggleSelect(item)"
        @keydown.enter.prevent="toggleSelect(item)"
        @keydown.space.prevent="toggleSelect(item)"
      >
        <div class="thumb">
          <video v-if="item.type === 'video'" :src="itemUrl(item)" class="thumb-media" muted />
          <img v-else :src="itemUrl(item)" class="thumb-media" alt="" />
          <div class="overlay">
            <el-icon v-if="selected.has(item.id)" class="check"><CircleCheck /></el-icon>
            <div class="acts" @click.stop>
              <el-button size="small" plain :aria-label="t('home.media.preview')" @click.stop="openPreview(item)"><el-icon><ZoomIn /></el-icon></el-button>
              <el-button size="small" type="danger" plain :aria-label="t('common.delete')" @click.stop="deleteItem(item)"><el-icon><Delete /></el-icon></el-button>
            </div>
          </div>
        </div>
        <div class="info">
          <span class="name" :title="item.name">{{ item.name || t('home.media.unnamed') }}</span>
          <span class="size">{{ formatSize(item.size) }}</span>
        </div>
      </div>
      <div v-if="!loading && !items.length" class="empty">
        <el-icon :size="44"><Files /></el-icon>
        <p>{{ t('home.media.empty') }}</p>
      </div>
    </div>

    <div v-if="total > pageSize" class="pager">
      <el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="prev, pager, next" @current-change="load" />
    </div>

    <div v-if="selected.size" class="batch" role="region" :aria-label="t('home.media.batchAria')">
      <span>{{ t('home.media.selected', { n: selected.size }) }}</span>
      <el-button size="small" @click="selected.clear()">{{ t('home.media.clearSelection') }}</el-button>
      <el-button size="small" type="danger" plain @click="batchDelete">{{ t('home.media.batchDelete') }}</el-button>
    </div>

    <el-dialog v-model="showPreview" :title="t('home.media.previewTitle')" width="800px" destroy-on-close append-to-body>
      <div class="preview">
        <video v-if="previewItem?.type === 'video'" :src="itemUrl(previewItem)" controls autoplay class="preview-media" />
        <img v-else-if="previewItem" :src="itemUrl(previewItem)" class="preview-media" alt="" />
      </div>
      <div class="meta">
        <div><b>{{ t('home.media.metaName') }}</b>{{ previewItem?.name || t('home.media.unnamed') }}</div>
        <div><b>{{ t('home.media.metaSize') }}</b>{{ formatSize(previewItem?.size) }}</div>
        <div><b>{{ t('home.media.metaCreated') }}</b>{{ previewItem?.created_at }}</div>
      </div>
    </el-dialog>
  </section>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, Delete, Files, Loading, Search, Upload, ZoomIn } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { uploadAPI } from '@/api/upload'
import request from '@/utils/request'

const { t } = useI18n()

const loading = ref(false)
const uploading = ref(false)
const progress = ref({ current: 0, total: 0 })
const items = ref([])
const mediaType = ref('all')
const keyword = ref('')
const page = ref(1)
const pageSize = ref(30)
const total = ref(0)
const selected = reactive(new Set())
const showPreview = ref(false)
const previewItem = ref(null)
const uploadInput = ref(null)
let timer = null

function normalizeItem(item) {
  const url = item.url || item.image_url || item.video_url || ''
  const isVideo = /\.(mp4|webm|mov)$/i.test(url) || item.type === 'video'
  return { ...item, type: isVideo ? 'video' : 'image', name: item.name || item.filename || url.split('/').pop() }
}

function itemUrl(item) {
  if (!item) return ''
  const lp = item.local_path || item.image_local_path || item.video_local_path
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return item.url || item.image_url || item.video_url || ''
}

function formatSize(size) {
  if (!size) return ''
  if (size > 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB'
  if (size > 1024) return (size / 1024).toFixed(0) + ' KB'
  return size + ' B'
}

async function load() {
  loading.value = true
  try {
    const params = { page: page.value, page_size: pageSize.value }
    if (mediaType.value !== 'all') params.type = mediaType.value
    if (keyword.value) params.keyword = keyword.value
    const res = await request.get('/assets', { params })
    items.value = (res?.items || []).map(normalizeItem)
    total.value = res?.total || 0
  } catch (_) {
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function reload() {
  page.value = 1
  load()
}

function debouncedLoad() {
  clearTimeout(timer)
  timer = setTimeout(reload, 400)
}

async function onUpload(e) {
  const files = Array.from(e.target.files || [])
  if (e.target) e.target.value = ''
  if (!files.length) return
  uploading.value = true
  progress.value = { current: 0, total: files.length }
  let failed = 0
  for (const file of files) {
    try {
      await uploadAPI.uploadImage(file)
      progress.value.current++
    } catch (err) {
      failed++
      ElMessage.warning(t('home.media.uploadFailed', { name: file.name, reason: err?.message || '' }))
    }
  }
  uploading.value = false
  if (failed < files.length) ElMessage.success(t('home.media.uploadDone', { n: files.length - failed }))
  reload()
}

function toggleSelect(item) {
  if (selected.has(item.id)) selected.delete(item.id)
  else selected.add(item.id)
}

function openPreview(item) {
  previewItem.value = item
  showPreview.value = true
}

async function confirm(message, title) {
  try {
    await ElMessageBox.confirm(message, title, { type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel') })
    return true
  } catch (_) {
    return false
  }
}

async function deleteItem(item) {
  if (!(await confirm(t('home.media.confirmDelete'), t('home.library.deleteTitle')))) return
  try {
    await request.delete(`/assets/${item.id}`)
    selected.delete(item.id)
    ElMessage.success(t('home.library.deleted'))
    load()
  } catch (err) {
    ElMessage.error(err?.message || t('home.library.deleteFailed'))
  }
}

async function batchDelete() {
  const count = selected.size
  if (!(await confirm(t('home.media.confirmBatch', { n: count }), t('home.media.batchDelete')))) return
  let failed = 0
  for (const id of [...selected]) {
    try {
      await request.delete(`/assets/${id}`)
    } catch (_) {
      failed++
    }
  }
  selected.clear()
  if (failed) ElMessage.warning(t('home.media.batchPartial', { ok: count - failed, failed }))
  else ElMessage.success(t('home.media.batchDone', { n: count }))
  load()
}

onMounted(load)
onBeforeUnmount(() => clearTimeout(timer))
</script>

<style scoped>
.hidden { display: none; }
.bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.search { width: 240px; }
.grow { flex: 1 1 8px; }
.progress { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 13px; color: var(--el-color-primary); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; min-height: 200px; }
.card { background: var(--bg-card); border: 2px solid var(--border-color); border-radius: 8px; overflow: hidden; cursor: pointer; }
.card:hover, .card:focus-visible { border-color: var(--border-muted); outline: none; }
.card:focus-visible { box-shadow: 0 0 0 2px var(--el-color-primary); }
.card.selected { border-color: var(--el-color-primary); }
.thumb { position: relative; aspect-ratio: 1; background: var(--bg-inner); overflow: hidden; }
.thumb-media { width: 100%; height: 100%; object-fit: cover; }
.overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.35); opacity: 0; transition: opacity 0.15s; }
.card:hover .overlay, .card:focus-within .overlay, .card.selected .overlay { opacity: 1; }
.check { position: absolute; top: 8px; right: 8px; font-size: 20px; color: var(--el-color-primary); background: #fff; border-radius: 50%; }
.acts { display: flex; gap: 6px; }
.info { display: flex; flex-direction: column; padding: 8px; }
.name { font-size: 12px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.size { font-size: 11px; color: var(--text-subtle); }
.empty { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; height: 260px; color: var(--text-subtle); }
.pager { display: flex; justify-content: center; margin-top: 20px; }
.batch {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 10; display: flex; align-items: center; gap: 12px;
  padding: 10px 20px; border-radius: 24px; background: #1a1a2e; color: #fff; font-size: 14px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}
.preview { display: flex; align-items: center; justify-content: center; min-height: 300px; background: #000; border-radius: 8px; overflow: hidden; }
.preview-media { max-width: 100%; max-height: 60vh; object-fit: contain; }
.meta { margin-top: 16px; font-size: 13px; color: var(--text-muted); line-height: 1.7; }
.meta b { font-weight: 500; color: var(--text-primary); }
</style>
