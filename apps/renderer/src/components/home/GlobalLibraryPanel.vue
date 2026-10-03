<template>
  <section class="lib" :data-test="`library-${kind}`">
    <div class="toolbar">
      <el-input v-model="keyword" clearable class="search" :placeholder="t('home.library.search')" :aria-label="t('home.library.search')" @input="debouncedLoad">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
    </div>

    <div v-loading="loading" class="grid">
      <article v-for="item in items" :key="item.id" class="item" data-test="library-item">
        <el-image v-if="itemImage(item)" class="cover" :src="itemImage(item)" fit="cover" :preview-src-list="[itemImage(item)]" preview-teleported lazy />
        <div v-else class="cover none">{{ t('home.library.noImage') }}</div>
        <div class="info">
          <div class="name">{{ itemName(kind, item) || t('home.library.unnamed') }}</div>
          <div class="desc">{{ itemDescription(item) }}</div>
          <div class="acts">
            <el-button size="small" @click="openEdit(item)">{{ t('home.action.edit') }}</el-button>
            <el-button size="small" type="danger" plain @click="onDelete(item)">{{ t('common.delete') }}</el-button>
          </div>
        </div>
      </article>
      <p v-if="!loading && !items.length" class="empty">{{ t(`home.library.empty.${kind}`) }}</p>
    </div>

    <div v-if="total > pageSize" class="pager">
      <el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="prev, pager, next" @current-change="load" />
    </div>

    <el-dialog v-model="editing" :title="t(`home.library.edit.${kind}`)" width="480px" append-to-body @closed="form = null">
      <el-form v-if="form" label-position="top" @submit.prevent>
        <el-form-item :label="t('home.library.image')">
          <div class="img-edit">
            <el-image v-if="itemImage(form)" class="thumb" :src="itemImage(form)" fit="cover" />
            <div v-else class="thumb none"><el-icon><PictureFilled /></el-icon></div>
            <div class="img-btns">
              <el-button size="small" :loading="uploading" @click="fileInput?.click()">{{ t('home.library.upload') }}</el-button>
              <el-button size="small" type="primary" :loading="generating" @click="generateImage">{{ t('home.library.aiGenerate') }}</el-button>
            </div>
            <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="onUpload" />
          </div>
        </el-form-item>
        <el-form-item v-for="f in fields" :key="f" :label="t(`home.library.field.${f}`)">
          <el-input v-model="form[f]" :type="f === 'description' ? 'textarea' : 'text'" :rows="3" :placeholder="f === 'tags' ? t('home.library.tagsPh') : ''" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editing = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { PictureFilled, Search } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { characterLibraryAPI } from '@/api/characterLibrary'
import { sceneLibraryAPI } from '@/api/sceneLibrary'
import { propLibraryAPI } from '@/api/propLibrary'
import { uploadAPI } from '@/api/upload'
import { imagesAPI } from '@/api/images'
import { taskAPI } from '@/api/task'
import { LIBRARY_KINDS, editForm, imagePrompt, itemDescription, itemImage, itemName, updateBody } from './libraryKinds.js'

const props = defineProps({ kind: { type: String, required: true } })
const { t } = useI18n()

const API = { character: characterLibraryAPI, scene: sceneLibraryAPI, prop: propLibraryAPI }
const api = computed(() => API[props.kind])
const fields = computed(() => LIBRARY_KINDS[props.kind].fields)

const items = ref([])
const loading = ref(false)
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)
const total = ref(0)
const editing = ref(false)
const form = ref(null)
const saving = ref(false)
const uploading = ref(false)
const generating = ref(false)
const fileInput = ref(null)
let timer = null
let alive = true

async function load() {
  loading.value = true
  try {
    const res = await api.value.list({ page: page.value, page_size: pageSize.value, keyword: keyword.value || undefined, global: 1 })
    items.value = res?.items ?? []
    total.value = res?.pagination?.total ?? items.value.length
  } catch (_) {
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function debouncedLoad() {
  clearTimeout(timer)
  timer = setTimeout(() => { page.value = 1; load() }, 300)
}

function openEdit(item) {
  form.value = editForm(props.kind, item)
  editing.value = true
}

async function save() {
  if (!form.value?.id) return
  saving.value = true
  try {
    await api.value.update(form.value.id, updateBody(props.kind, form.value))
    ElMessage.success(t('home.library.saved'))
    editing.value = false
    load()
  } catch (e) {
    ElMessage.error(e?.message || t('home.library.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function onDelete(item) {
  const name = (itemName(props.kind, item) || t('home.library.unnamed')).slice(0, 20)
  try {
    await ElMessageBox.confirm(t(`home.library.confirmDelete.${props.kind}`, { name }), t('home.library.deleteTitle'), {
      type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel'),
    })
  } catch (_) { return }
  try {
    await api.value.delete(item.id)
    ElMessage.success(t('home.library.deleted'))
    load()
  } catch (e) {
    ElMessage.error(e?.message || t('home.library.deleteFailed'))
  }
}

async function persistImage(imageUrl, localPath) {
  form.value.image_url = imageUrl || ''
  form.value.local_path = localPath ?? null
  await api.value.update(form.value.id, { image_url: imageUrl || null, local_path: localPath ?? null })
  load()
}

async function onUpload(ev) {
  const file = ev.target?.files?.[0]
  if (ev.target) ev.target.value = ''
  if (!file || !form.value?.id) return
  uploading.value = true
  try {
    const res = await uploadAPI.uploadImage(file)
    const data = res?.data ?? res
    const url = data?.url || data?.path || data?.local_path
    if (!url) { ElMessage.error(t('home.library.uploadNoUrl')); return }
    await persistImage(url, null)
    ElMessage.success(t('home.library.imageUpdated'))
  } catch (e) {
    ElMessage.error(e?.message || t('home.library.uploadFailed'))
  } finally {
    uploading.value = false
  }
}

async function generateImage() {
  const prompt = imagePrompt(props.kind, form.value || {})
  if (!prompt) { ElMessage.warning(t('home.library.needPrompt')); return }
  generating.value = true
  try {
    const created = await imagesAPI.create({ prompt, drama_id: null })
    const taskId = (created?.data ?? created)?.task_id
    if (!taskId) throw new Error(t('home.library.noTask'))
    let task = null
    for (let i = 0; i < 300 && alive; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      const tr = await taskAPI.get(taskId)
      task = tr?.data ?? tr
      if (task.status === 'completed') break
      if (task.status === 'failed') throw new Error(task.error || t('home.library.genFailed'))
    }
    if (!alive) return
    if (!task || task.status !== 'completed') throw new Error(t('home.library.genTimeout'))
    const r = task.result
    if (!r?.image_url && !r?.local_path) throw new Error(t('home.library.noImageResult'))
    await persistImage(r.image_url, r.local_path)
    ElMessage.success(t('home.library.genDone'))
  } catch (e) {
    ElMessage.error(e?.message || t('home.library.genFailed'))
  } finally {
    generating.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => { alive = false; clearTimeout(timer) })
</script>

<style scoped>
.toolbar { margin-bottom: 12px; }
.search { max-width: 280px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; min-height: 120px; }
.item { display: flex; gap: 10px; padding: 10px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 10px; }
.cover { flex: 0 0 84px; width: 84px; height: 84px; border-radius: 8px; overflow: hidden; background: var(--bg-inner); }
.none { display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--text-subtle); }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.name { font-weight: 600; font-size: 14px; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desc { font-size: 12px; color: var(--text-muted); line-height: 1.5; flex: 1; overflow: hidden; }
.acts { display: flex; gap: 6px; }
.empty { grid-column: 1 / -1; margin: 24px 0; text-align: center; font-size: 13px; color: var(--text-subtle); }
.pager { display: flex; justify-content: center; margin-top: 16px; }
.img-edit { display: flex; align-items: center; gap: 12px; }
.thumb { width: 96px; height: 96px; border-radius: 8px; overflow: hidden; background: var(--bg-inner); display: flex; align-items: center; justify-content: center; color: var(--text-subtle); }
.img-btns { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.hidden { display: none; }
</style>
