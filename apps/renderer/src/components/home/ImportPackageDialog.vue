<template>
  <el-dialog
    v-model="visible"
    :title="t('home.importPackage.title')"
    width="560px"
    :close-on-click-modal="false"
    append-to-body
    @closed="emit('close', result)"
  >
    <p class="lead">{{ t('home.importPackage.lead') }}</p>
    <div
      class="drop"
      :class="{ over, busy }"
      role="button"
      tabindex="0"
      :aria-label="t('home.importPackage.drop')"
      data-test="package-drop"
      @click="fileInput?.click()"
      @keydown.enter.prevent="fileInput?.click()"
      @keydown.space.prevent="fileInput?.click()"
      @dragover.prevent="over = true"
      @dragleave.prevent="over = false"
      @drop.prevent="onDrop"
    >
      <el-icon :size="26"><UploadFilled /></el-icon>
      <span class="drop-t">{{ busy ? t('home.importPackage.working') : t('home.importPackage.drop') }}</span>
      <span class="drop-s">{{ t('home.importPackage.dropHint') }}</span>
      <input ref="fileInput" type="file" accept=".zip,application/zip" class="hidden" data-test="package-file" @change="onPick" />
    </div>
    <el-alert v-if="errorText" :title="errorText" type="error" show-icon :closable="false" class="err" data-test="package-error" />

    <section class="recent" data-test="recent-deleted">
      <h3>{{ t('home.recent.title') }}</h3>
      <p v-if="!deleted.length" class="empty">{{ t('home.recent.empty') }}</p>
      <ul v-else class="rows">
        <li v-for="r in deleted" :key="`${r.dramaId}-${r.snapshotId}`">
          <span class="rn">{{ r.title || t('home.card.untitled') }}</span>
          <span class="rt">{{ formatUpdated(r.at, locale) }}</span>
          <el-button size="small" :loading="restoringId === r.dramaId" :disabled="busy" data-test="recent-restore" @click="restoreDeleted(r)">{{ t('home.recent.restore') }}</el-button>
          <el-button size="small" text :disabled="busy" :aria-label="t('home.recent.forget')" @click="forget(r)"><el-icon><Close /></el-icon></el-button>
        </li>
      </ul>
    </section>

    <template #footer>
      <el-button @click="visible = false">{{ t('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue'
import { Close, UploadFilled } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { formatUpdated } from '@/utils/homeModel'
import { classifyFailure } from './projectFlows.js'
import { forgetDeletedProject, importProjectPackage, loadDeletedLog, restoreFullBackup, restoreSnapshot } from './homeApi'

const emit = defineEmits(['close'])
const { t, locale } = useI18n()

const visible = ref(true)
const busy = ref(false)
const over = ref(false)
const errorText = ref('')
const restoringId = ref(null)
const fileInput = ref(null)
const deleted = ref(loadDeletedLog())
let result

function failText(e) {
  const code = e?.code || e?.response?.data?.error?.code
  if (code === 'BACKUP_CORRUPT') return t('home.importPackage.err.corrupt')
  if (code === 'BACKUP_VERSION_UNSUPPORTED') return t('home.importPackage.err.version')
  return e?.message || t('home.importPackage.err.failed')
}

function finish(res) {
  const dramaId = res?.drama_id ?? res?.id
  if (dramaId == null) {
    errorText.value = t('home.importPackage.err.failed')
    return
  }
  result = { dramaId, title: res?.title || '' }
  visible.value = false
}

async function importFile(file) {
  if (!file || busy.value) return
  errorText.value = ''
  if (!/\.zip$/i.test(file.name)) {
    errorText.value = t('home.importPackage.err.notZip')
    return
  }
  busy.value = true
  try {
    let res
    try {
      res = await restoreFullBackup(file)
    } catch (e) {
      // 旧后端没有 /dramas/restore：退回普通项目包导入（同一份 ZIP，少了 2GB 上限）
      if (classifyFailure(e) !== 'unavailable') throw e
      res = await importProjectPackage(file)
    }
    finish(res)
  } catch (e) {
    errorText.value = failText(e)
  } finally {
    busy.value = false
  }
}

function onPick(ev) {
  const file = ev.target?.files?.[0]
  if (ev.target) ev.target.value = ''
  importFile(file)
}

function onDrop(ev) {
  over.value = false
  importFile(ev.dataTransfer?.files?.[0])
}

async function restoreDeleted(rec) {
  if (busy.value) return
  errorText.value = ''
  busy.value = true
  restoringId.value = rec.dramaId
  try {
    const res = await restoreSnapshot(rec.dramaId, rec.snapshotId)
    deleted.value = forgetDeletedProject(rec.dramaId)
    finish(res)
  } catch (e) {
    errorText.value = classifyFailure(e) === 'unavailable' ? t('home.recent.gone') : failText(e)
  } finally {
    busy.value = false
    restoringId.value = null
  }
}

function forget(rec) {
  deleted.value = forgetDeletedProject(rec.dramaId)
}
</script>

<style scoped>
.lead { margin: 0 0 12px; font-size: 13px; color: var(--text-muted); line-height: 1.6; }
.hidden { display: none; }
.drop {
  display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 22px 16px; border: 2px dashed var(--border-muted);
  border-radius: 12px; color: var(--text-muted); cursor: pointer; text-align: center;
}
.drop:hover, .drop.over, .drop:focus-visible { border-color: var(--el-color-primary); color: var(--el-color-primary); outline: none; }
.drop.busy { opacity: 0.7; pointer-events: none; }
.drop-t { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.drop-s { font-size: 12px; }
.err { margin-top: 10px; }
.recent { margin-top: 18px; }
.recent h3 { margin: 0 0 6px; font-size: 14px; }
.empty { margin: 0; font-size: 12px; color: var(--text-subtle); }
.rows { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.rows li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.rn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt { font-size: 12px; color: var(--text-subtle); }
</style>
