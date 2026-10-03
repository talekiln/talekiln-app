<template>
  <div class="film-list">
    <AnnouncementBar />
    <HomeTopBar @ai-config="showAiConfig = true" />

    <main class="main">
      <section class="start" aria-labelledby="home-start-title">
        <h2 id="home-start-title" class="section-title">{{ t('home.start.title') }}</h2>
        <div class="starts">
          <button
            v-for="s in STARTS"
            :key="s.id"
            type="button"
            class="start-card"
            :class="{ primary: s.primary }"
            :data-test="`start-${s.id}`"
            @click="onStart(s)"
          >
            <el-icon :size="22" class="start-icon" aria-hidden="true"><component :is="s.icon" /></el-icon>
            <span class="start-title">{{ t(`home.start.${s.id}.title`) }}</span>
            <span class="start-sub">{{ t(`home.start.${s.id}.sub`) }}</span>
            <span class="start-then">{{ t(`home.start.${s.id}.then`) }}</span>
          </button>
        </div>

        <div class="tryout" data-test="sample-block">
          <span class="tryout-hint"><el-icon aria-hidden="true"><QuestionFilled /></el-icon>{{ t('home.sample.hint') }}</span>
          <el-button size="small" :loading="sampleLoading" data-test="try-sample" @click="onTrySample">
            <el-icon><FolderOpened /></el-icon>{{ t('home.sample.try') }}
          </el-button>
          <template v-if="exampleList.length">
            <span class="tryout-hint"><el-icon aria-hidden="true"><QuestionFilled /></el-icon>{{ t('home.sample.exampleHint') }}</span>
            <el-button
              v-for="ex in exampleList"
              :key="ex.filename"
              size="small"
              :loading="importingExample === ex.filename"
              @click="onImportExample(ex)"
            >
              <el-icon><FolderOpened /></el-icon>{{ ex.name }}
            </el-button>
          </template>
        </div>
      </section>

      <section class="projects" aria-labelledby="home-projects-title">
        <div class="projects-head">
          <h2 id="home-projects-title" class="section-title">{{ t('home.projects.title') }}</h2>
          <el-input
            v-model="keyword"
            clearable
            class="search"
            :placeholder="t('home.projects.search')"
            :aria-label="t('home.projects.search')"
            data-test="project-search"
          >
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
        </div>

        <div v-loading="loading" class="grid" data-test="project-grid">
          <ProjectCard
            v-for="d in shown"
            :key="d.id"
            :project="d"
            :last-visited="shell.lastView(d.id)"
            @open="openProject"
            @zip="onZip"
            @backup="onBackup"
            @rename="onRename"
            @delete="onDelete"
          />
        </div>
        <p v-if="!loading && !projects.length" class="empty" data-test="projects-empty">{{ t('home.projects.empty') }}</p>
        <p v-else-if="!loading && !shown.length" class="empty" data-test="projects-no-match">{{ t('home.projects.noMatch', { q: keyword.trim() }) }}</p>
      </section>
    </main>

    <el-dialog v-model="showAiConfig" :title="t('home.aiConfig.title')" width="90%" destroy-on-close>
      <AIConfigContent v-if="showAiConfig" />
    </el-dialog>

    <DialogHost />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Document, FolderOpened, MagicStick, Plus, QuestionFilled, Search, Upload } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { useShellStore } from '@/stores/shell'
import { installActions, runAction } from '@/shell/actions/index.js'
import { openDialog } from '@/shell/dialogs/index.js'
import DialogHost from '@/shell/DialogHost.vue'
import AnnouncementBar from '@/components/AnnouncementBar.vue'
import AIConfigContent from '@/components/AIConfigContent.vue'
import HomeTopBar from '@/components/home/HomeTopBar.vue'
import ProjectCard from '@/components/home/ProjectCard.vue'
import { cardNextStop, filterProjects } from '@/utils/homeModel'
import { runDeleteFlow } from '@/components/home/projectFlows.js'
import { sampleLocation } from '@/components/home/homeNav.js'
import {
  deleteProject, downloadFullBackup, downloadProjectZip, listProjects, rememberDeletedProject, snapshotProject,
} from '@/components/home/homeApi.js'
import { dramaAPI } from '@/api/drama'
import { onboardingAPI } from '@/api/onboarding'
import { SAMPLE_ID } from '@/utils/sampleRoute'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const shell = useShellStore()
installActions()

// 四个创建入口：id 对应 home.start.<id>.* 文案；action 是 shell 的 action id。
const STARTS = [
  { id: 'oneLine', icon: MagicStick, action: 'home.oneLine', primary: true },
  { id: 'importScript', icon: Document, action: 'home.importScript' },
  { id: 'blank', icon: Plus, action: 'home.newBlank' },
  { id: 'importPackage', icon: Upload, action: 'home.importPackage' },
]

const projects = ref([])
const loading = ref(false)
const keyword = ref('')
const showAiConfig = ref(false)
const sampleLoading = ref(false)
const exampleList = ref([])
const importingExample = ref(null)

const shown = computed(() => filterProjects(projects.value, keyword.value))

async function load() {
  loading.value = true
  try {
    const res = await listProjects()
    projects.value = res?.items ?? []
  } catch (_) {
    projects.value = []
  } finally {
    loading.value = false
  }
}

function ctx() {
  return { router, route, dramaId: null, episodeId: null, openDialog, store: shell }
}

function onStart(s) {
  runAction(s.action, ctx())
}

// 点卡片：上次停留的集和视图 -> 第 1 集剧本 -> 没有剧集时 project-home
function openProject(d) {
  const stop = cardNextStop(d, shell.lastView(d.id))
  if (stop.kind === 'none') return
  if (stop.episodeId != null) shell.rememberView(d.id, stop.episodeId, stop.view)
  router.push(stop.location)
}

function onZip(d) {
  downloadProjectZip(d)
}

const backingUp = new Set()
async function onBackup(d) {
  if (backingUp.has(d.id)) return
  backingUp.add(d.id)
  try {
    ElMessage.info(t('home.backup.start', { title: d.title || t('home.card.untitled') }))
    await downloadFullBackup(d)
    ElMessage.success(t('home.backup.done'))
  } catch (e) {
    ElMessage.error(e?.reason === 'unavailable' ? t('home.backup.unavailable') : t('home.backup.failed'))
  } finally {
    backingUp.delete(d.id)
  }
}

async function onRename(d) {
  const res = await openDialog('home.rename', { dramaId: d.id, title: d.title || '', description: d.description || '' })
  if (res) load()
}

async function ask(message, title, confirmText) {
  try {
    await ElMessageBox.confirm(message, title, {
      type: 'warning', confirmButtonText: confirmText, cancelButtonText: t('common.cancel'), dangerouslyUseHTMLString: false,
    })
    return true
  } catch (_) {
    return false
  }
}

async function onDelete(d) {
  const name = d.title || t('home.card.untitled')
  const res = await runDeleteFlow(d, {
    confirmDelete: () => ask(t('home.delete.confirm', { title: name }), t('home.delete.title'), t('common.delete')),
    confirmWithoutSnapshot: (reason) => ask(
      t(reason === 'unavailable' ? 'home.delete.noSnapshotUnavailable' : 'home.delete.noSnapshotFailed', { title: name }),
      t('home.delete.noSnapshotTitle'),
      t('home.delete.anyway'),
    ),
    snapshot: (id) => snapshotProject(id, 'delete'),
    remove: (id) => deleteProject(id),
    remember: (rec) => rememberDeletedProject(rec),
    now: () => Date.now(),
  })
  if (res.status === 'deleted') {
    ElMessage.success(res.snapshot ? t('home.delete.doneSnapshot') : t('home.delete.done'))
    load()
  } else if (res.status === 'failed') {
    ElMessage.error(res.error?.message || t('home.delete.failed'))
  }
}

async function onTrySample() {
  sampleLoading.value = true
  try {
    const loc = sampleLocation(await onboardingAPI.seedSample(SAMPLE_ID))
    if (loc) await router.push(loc)
  } catch (e) {
    ElMessage.error(e?.message || t('home.sample.failed'))
  } finally {
    sampleLoading.value = false
  }
}

function loadExamples() {
  dramaAPI.listExamples()
    .then((res) => { exampleList.value = Array.isArray(res) ? res : (res?.data ?? []) })
    .catch(() => { exampleList.value = [] })
}

async function onImportExample(ex) {
  importingExample.value = ex.filename
  try {
    const data = await dramaAPI.importExample(ex.filename)
    ElMessage.success(t('home.sample.exampleDone', { title: data?.title || ex.name }))
    load()
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e?.message || t('home.sample.exampleFailed'))
  } finally {
    importingExample.value = null
  }
}

onMounted(() => {
  load()
  loadExamples()
})
</script>

<style scoped>
.film-list { min-height: 100vh; background: var(--bg-page); color: var(--text-primary); }
.main { max-width: 1200px; margin: 0 auto; padding: 24px 24px 64px; }
.section-title { margin: 0 0 12px; font-size: 16px; font-weight: 600; color: var(--text-bright); }

.starts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.start-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-height: 132px; padding: 16px;
  border-radius: 12px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-primary);
  font: inherit; text-align: left; cursor: pointer; transition: border-color 0.15s, background 0.15s;
}
.start-card:hover { border-color: var(--el-color-primary); background: var(--bg-hover); }
.start-card:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.start-card.primary { border: 2px solid var(--el-color-primary); }
.start-icon { color: var(--el-color-primary); }
.start-title { font-size: 15px; font-weight: 600; color: var(--text-bright); }
.start-sub { font-size: 13px; line-height: 1.5; color: var(--text-muted); }
.start-then { margin-top: auto; font-size: 12px; color: var(--text-subtle); }

.tryout { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 14px; font-size: 13px; color: var(--text-muted); }
.tryout-hint { display: inline-flex; align-items: center; gap: 4px; }

.projects { margin-top: 32px; }
.projects-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
.projects-head .section-title { margin-bottom: 0; }
.search { width: 260px; max-width: 100%; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; min-height: 80px; margin-top: 12px; }
.empty { margin: 36px 0; text-align: center; font-size: 14px; color: var(--text-subtle); }
</style>
