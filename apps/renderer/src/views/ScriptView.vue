<template>
  <div class="script-view" data-test="script-view">
    <div class="toolbar" data-test="script-toolbar">
      <el-button type="primary" plain :disabled="!dramaId" data-test="ai-write" @click="aiWrite">{{ t('script.tool.aiWrite') }}</el-button>
      <el-button plain :disabled="!dramaId" data-test="import-script" @click="importScript">{{ t('script.tool.import') }}</el-button>
      <el-divider direction="vertical" />
      <el-button plain :disabled="!hasLines || views.busy" data-test="extract-assets" @click="extractAssets">{{ t('script.tool.extract') }}</el-button>
      <el-button plain type="success" :disabled="!hasLines || views.busy" data-test="gen-storyboard" @click="genStoryboard">
        {{ hasShots ? t('script.tool.regenStoryboard') : t('script.tool.genStoryboard') }}
      </el-button>
      <span class="spacer" />
      <el-tag
        v-if="syncState !== 'idle'"
        size="small"
        :type="syncState === 'error' ? 'danger' : syncState === 'saved' ? 'success' : 'warning'"
        :class="{ clickable: syncState === 'error' }"
        data-test="sync-state"
        @click="syncState === 'error' && flushSync()"
      >{{ t(`script.sync.${syncState}`) }}</el-tag>
      <el-tooltip :disabled="fullOk" :content="t('script.mode.fullBlocked')" placement="bottom">
        <span>
          <el-radio-group v-model="mode" size="small" data-test="mode-toggle">
            <el-radio-button value="lines" data-test="mode-lines">{{ t('script.mode.lines') }}</el-radio-button>
            <el-radio-button value="full" :disabled="!fullOk || !views.ready" data-test="mode-full">{{ t('script.mode.full') }}</el-radio-button>
          </el-radio-group>
        </span>
      </el-tooltip>
      <el-dropdown trigger="click" @command="onEpisodeCommand">
        <el-button data-test="episode-menu">
          {{ episodeTitle }}<el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="add" data-test="menu-add">{{ t('script.menu.add') }}</el-dropdown-item>
            <el-dropdown-item command="import">{{ t('script.menu.import') }}</el-dropdown-item>
            <el-dropdown-item command="rename" :disabled="!episode" divided data-test="menu-rename">{{ t('script.menu.rename') }}</el-dropdown-item>
            <el-dropdown-item command="delete" :disabled="!episode || shell.episodes.length <= 1" data-test="menu-delete">{{ t('script.menu.delete') }}</el-dropdown-item>
            <el-dropdown-item command="manage" divided data-test="menu-manage">{{ t('script.menu.manage') }}</el-dropdown-item>
            <el-dropdown-item command="settings">{{ t('script.menu.settings') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <div class="content">
      <div class="body">
        <div v-if="views.loading && !views.ready" class="empty">{{ t('common.loading') }}</div>

        <FullTextEditor
          v-else-if="mode === 'full'"
          :text="fullText"
          :busy="fullBusy"
          @apply="applyFullText"
          @cancel="mode = 'lines'"
        />

        <template v-else>
          <div v-if="!groups.length" class="empty" data-test="script-empty">
            <p>{{ t('script.empty.title') }}</p>
            <div class="empty-actions">
              <el-button type="primary" plain :disabled="!dramaId" @click="aiWrite">{{ t('script.tool.aiWrite') }}</el-button>
              <el-button plain :disabled="!dramaId" @click="importScript">{{ t('script.tool.import') }}</el-button>
              <el-button plain :disabled="!views.ready" data-test="write-direct" @click="mode = 'full'">{{ t('script.empty.write') }}</el-button>
            </div>
          </div>
          <section v-for="g in groups" :key="g.id" class="scene" :data-group="g.id">
            <header class="scene-head">
              <h3>{{ g.title || t('script.scene.untitled') }}</h3>
              <span class="meta">{{ t('script.scene.lines', { n: g.lines.length }) }}</span>
              <el-button size="small" plain :disabled="views.busy" data-test="append-line" @click="addLine(g, g.lines.length, null)">
                <el-icon><Plus /></el-icon>{{ t('script.line.append') }}
              </el-button>
            </header>
            <div v-if="!g.lines.length" class="empty small">{{ t('script.scene.noLines') }}</div>
            <article
              v-for="(l, i) in g.lines"
              :key="l.id"
              class="line"
              :class="{ focus: focus && focus.id === l.id, stale: info(l).stale }"
              :data-line-id="l.id"
              data-test="script-line"
              @click="onSelectLine(l)"
            >
              <div class="line-main">
                <div class="line-top">
                  <el-select
                    :model-value="l.kind"
                    size="small"
                    class="kind"
                    @change="(v) => patch(l, { kind: v })"
                    @click.stop
                  >
                    <el-option v-for="k in LINE_KINDS" :key="k" :label="t(`script.kind.${k}`)" :value="k" />
                  </el-select>
                  <el-input
                    v-if="l.kind === 'dialogue'"
                    :model-value="draftOf(l, 'speaker')"
                    size="small"
                    class="speaker"
                    :placeholder="t('script.line.speaker')"
                    @click.stop
                    @update:model-value="(v) => setDraft(l, 'speaker', v)"
                    @change="commit(l, 'speaker')"
                  />
                  <el-tag v-if="info(l).stale" size="small" type="warning" effect="light" data-test="line-stale">{{ t('script.line.stale') }}</el-tag>
                </div>
                <textarea
                  :value="draftOf(l, 'text')"
                  class="text"
                  rows="2"
                  data-test="line-text"
                  @click="remember(l, $event)"
                  @keyup="remember(l, $event)"
                  @select="remember(l, $event)"
                  @input="onInput(l, $event)"
                  @change="commit(l, 'text')"
                />
              </div>
              <div class="line-side">
                <div class="feeds">
                  <span class="feeds-label">{{ t('script.line.feeds') }}</span>
                  <el-tag
                    v-for="sid in l.shot_ids"
                    :key="sid"
                    size="small"
                    class="shot-chip"
                    :type="shotFocus(sid) ? 'primary' : 'info'"
                    :effect="shotFocus(sid) ? 'dark' : 'plain'"
                    data-test="shot-chip"
                    @click.stop="onSelectShot(sid)"
                  >{{ t('script.shot.n', { n: nums[sid] }) }}<i v-if="shotStale(sid)" class="dot" :title="t('script.shot.staleTip')" /></el-tag>
                  <span v-if="!l.shot_ids.length" class="none">{{ t('script.line.noShots') }}</span>
                </div>
                <div class="tools" @click.stop>
                  <el-button size="small" text :disabled="i === 0 || views.busy" :title="t('script.line.up')" @click="move(g, l, -1)"><el-icon><ArrowUp /></el-icon></el-button>
                  <el-button size="small" text :disabled="i === g.lines.length - 1 || views.busy" :title="t('script.line.down')" @click="move(g, l, 1)"><el-icon><ArrowDown /></el-icon></el-button>
                  <el-button size="small" text :disabled="views.busy" :title="t('script.line.splitTip')" data-test="split-line" @click="split(l)">{{ t('script.line.split') }}</el-button>
                  <el-button size="small" text :disabled="i === g.lines.length - 1 || views.busy" :title="t('script.line.mergeTip')" data-test="merge-line" @click="merge(g, l, i)">{{ t('script.line.merge') }}</el-button>
                  <el-button size="small" text :disabled="views.busy" :title="t('script.line.insertTip')" data-test="insert-line" @click="addLine(g, i + 1, l)">{{ t('script.line.insert') }}</el-button>
                  <el-button size="small" text type="danger" :disabled="views.busy" :title="t('common.delete')" data-test="delete-line" @click="remove(l)"><el-icon><Delete /></el-icon></el-button>
                </div>
              </div>
            </article>
          </section>
        </template>
      </div>

      <aside v-if="mode === 'lines' && views.ready" class="inspector" data-test="script-inspector">
        <div v-if="!selLine" class="insp-empty">{{ t('script.insp.empty') }}</div>
        <template v-else>
          <h4>{{ t('script.insp.title') }}</h4>
          <div class="insp-field">
            <el-tag size="small" effect="plain">{{ t(`script.kind.${selLine.kind}`) }}</el-tag>
            <el-input
              v-if="selLine.kind === 'dialogue'"
              :model-value="draftOf(selLine, 'speaker')"
              size="small"
              :placeholder="t('script.line.speaker')"
              data-test="insp-speaker"
              @update:model-value="(v) => setDraft(selLine, 'speaker', v)"
              @change="commit(selLine, 'speaker')"
            />
          </div>
          <textarea
            :value="draftOf(selLine, 'text')"
            class="text"
            rows="4"
            data-test="insp-text"
            @input="setDraft(selLine, 'text', $event.target.value)"
            @change="commit(selLine, 'text')"
          />

          <h4>{{ t('script.insp.shots') }}</h4>
          <div v-if="!selShots.length" class="insp-none" data-test="insp-no-shots">{{ t('script.insp.noShots') }}</div>
          <ul v-else class="insp-shots">
            <li v-for="s in selShots" :key="s.id" data-test="insp-shot">
              <div class="shot-head">
                <strong>{{ t('script.shot.n', { n: nums[s.id] }) }}</strong>
                <span class="shot-title">{{ s.params.title || s.params.description || t('script.shot.untitled') }}</span>
              </div>
              <div class="chips">
                <el-tag size="small" :type="stateType(s.image)" effect="plain">{{ t('script.insp.image') }} · {{ t(`script.state.${s.image}`) }}</el-tag>
                <el-tag size="small" :type="stateType(s.video)" effect="plain">{{ t('script.insp.video') }} · {{ t(`script.state.${s.video}`) }}</el-tag>
                <el-tag size="small" :type="stateType(s.narration)" effect="plain">{{ t('script.insp.narration') }} · {{ t(`script.state.${s.narration}`) }}</el-tag>
              </div>
              <div class="shot-btns">
                <el-button size="small" :loading="voiceBusy === s.id" :disabled="!!voiceBusy" data-test="insp-revoice" @click="revoice(s)">{{ t('script.insp.revoice') }}</el-button>
                <el-button size="small" data-test="insp-open-storyboard" @click="openInStoryboard(s.id)">{{ t('script.insp.viewStoryboard') }}</el-button>
                <el-button size="small" :disabled="!s.legacy_id" data-test="insp-open-workbench" @click="openWorkbench(s)">{{ t('script.insp.workbench') }}</el-button>
              </div>
            </li>
          </ul>

          <template v-if="assetsReady">
            <h4>{{ t('script.insp.appearing') }}</h4>
            <div v-if="!hasAppearing" class="insp-none">{{ t('script.insp.noAppearing') }}</div>
            <div v-else class="appearing" data-test="insp-assets">
              <el-tag v-for="a in appearing.characters" :key="`c${a.id}`" size="small" effect="plain">@{{ a.name }}</el-tag>
              <el-tag v-for="a in appearing.scenes" :key="`s${a.id}`" size="small" type="success" effect="plain">#{{ a.location || a.name }}</el-tag>
              <el-tag v-for="a in appearing.props" :key="`p${a.id}`" size="small" type="warning" effect="plain">#{{ a.name }}</el-tag>
            </div>
          </template>
        </template>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowDown, ArrowUp, Delete, Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from '@/i18n'
import { useShellStore } from '@/stores/shell'
import { useProjectViewsStore } from '@/stores/projectViews'
import { useAssetsStore } from '@/stores/assets'
import { reorderedIds, lineStaleInfo, shotNumbers, validSplitAt } from '@/utils/projectViews'
import { appearingAssets, canEditFullText, scriptTextOfView, shotCountOfView } from '@/utils/scriptTools'
import { episodesAPI, scriptSync } from '@/api/episodes'
import { voiceoverAPI } from '@/api/voiceover'
import { runAction } from '@/shell/actions'
import { openDialog } from '@/shell/dialogs'
import { useActionContext } from '@/shell/context'
import FullTextEditor from '@/components/script/FullTextEditor.vue'

const LINE_KINDS = ['scene_heading', 'narration', 'dialogue', 'action']

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const shell = useShellStore()
const views = useProjectViewsStore()
const assets = useAssetsStore()
const summary = inject('shellSummary', ref(''))
const actionCtx = useActionContext()

// 外壳路由是 :episodeId；旧地址 /episodes/:id/script 是 :id
const episodeId = computed(() => Number(route.params.episodeId ?? route.params.id) || null)
const dramaId = computed(() => Number(route.params.dramaId) || views.dramaId || shell.dramaId || null)
const episode = computed(() => (shell.episodes || []).find((e) => Number(e.id) === episodeId.value) || null)
const episodeTitle = computed(() => {
  const e = episode.value
  if (!e) return t('shell.episode.none')
  return e.title ? t('shell.episode.labelTitled', { n: e.episode_number, title: e.title }) : t('shell.episode.label', { n: e.episode_number })
})

const groups = computed(() => views.views.script?.groups || [])
const hasLines = computed(() => groups.value.some((g) => g.lines.length))
const shotsById = computed(() => Object.fromEntries((views.views.shots?.groups || []).flatMap((g) => g.shots).map((s) => [s.id, s])))
const nums = computed(() => shotNumbers(views.views.shots))
const hasShots = computed(() => shotCountOfView(views.views.shots) > 0)
const fullOk = computed(() => canEditFullText({ hasShots: hasShots.value }))
const focus = computed(() => views.focusFor('script'))
const focusShot = computed(() => views.focusFor('shots')?.id || null)
const info = (l) => lineStaleInfo(l, shotsById.value, views.staleSet)
const shotStale = (sid) => { const s = shotsById.value[sid]; return !!s && (s.image !== 'fresh' || s.video !== 'fresh' || s.narration === 'stale') }
const shotFocus = (sid) => sid === focusShot.value
const stateType = (s) => (s === 'fresh' ? 'success' : s === 'stale' ? 'warning' : 'info')

watchEffect(() => {
  summary.value = views.ready
    ? t('script.summary', { scenes: groups.value.length, lines: groups.value.reduce((n, g) => n + g.lines.length, 0), shots: shotCountOfView(views.views.shots) })
    : ''
})

// ---------------------------------------------------------------- 逐行编辑

// 输入中的草稿（只有焦点所在的字段会进来，提交后丢弃，显示一律读 store）
const drafts = reactive({})
const carets = {}
const draftOf = (l, k) => (drafts[`${l.id}.${k}`] !== undefined ? drafts[`${l.id}.${k}`] : (l[k] ?? ''))
const setDraft = (l, k, v) => { drafts[`${l.id}.${k}`] = v }
function onInput(l, e) { setDraft(l, 'text', e.target.value); remember(l, e) }
function remember(l, e) { carets[l.id] = e.target.selectionStart }

async function commit(l, k) {
  const key = `${l.id}.${k}`
  if (drafts[key] === undefined) return
  const v = drafts[key]
  delete drafts[key]
  if (v === (l[k] ?? '')) return
  await views.intent('script', 'rewriteLine', { line_id: l.id, patch: { [k]: v } })
}
async function patch(l, p) { await views.intent('script', 'rewriteLine', { line_id: l.id, patch: p }) }

function onSelectLine(l) { views.select({ kind: 'line', id: l.id }) }
function onSelectShot(sid) { views.select({ kind: 'shot', id: sid }) }

async function move(g, l, delta) {
  const ids = reorderedIds(g.lines.map((x) => x.id), l.id, delta)
  if (ids) await views.intent('script', 'reorderLines', { group_id: g.id, ids })
}
async function split(l) {
  const text = draftOf(l, 'text')
  const at = carets[l.id]
  if (!validSplitAt(text, at)) { ElMessage.info(t('script.line.splitHint')); return }
  if (drafts[`${l.id}.text`] !== undefined) await commit(l, 'text')
  await views.intent('script', 'splitLine', { line_id: l.id, at })
}
async function merge(g, l, i) {
  const next = g.lines[i + 1]
  if (next) await views.intent('script', 'mergeLines', { a_id: l.id, b_id: next.id })
}
async function remove(l) {
  const r = await views.intent('script', 'deleteLine', { line_id: l.id })
  if (r && views.selection?.id === l.id) views.select(null)
}
async function addLine(g, index, after) {
  const r = await views.intent('script', 'insertLine', {
    group: g.id, index, kind: after ? after.kind : 'narration', speaker: after ? after.speaker : '', text: t('script.line.newText'), shot_ids: after ? after.shot_ids : [],
  })
  const id = r?.meta?.line_id
  if (id) views.select({ kind: 'line', id })
}

async function scrollToFocus() {
  await nextTick()
  const f = focus.value
  if (!f) return
  document.querySelector(`[data-line-id="${f.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'auto' })
}

// ---------------------------------------------------------------- 行 -> 正文（防抖写回）
// 分镜生成、提取资产读的是分集正文（episodes.script_content），而这里编辑的是项目图里的剧本行。
// 行变了就在 1 秒后把行序列化回正文；触发生成 / 提取前、离开页面时立即写。

const scriptText = computed(() => (views.ready && views.episodeId === episodeId.value && views.views.script ? scriptTextOfView(views.views.script) : null))
const syncState = ref('idle') // idle | pending | saving | saved | error
let syncedText = null
let syncTimer = null
let savedTimer = null
let saving = Promise.resolve(true)

watch(scriptText, (txt) => {
  if (txt === null) return
  if (syncedText === null) { syncedText = txt; return } // 第一次读到的就是基线：没改过就不写
  if (txt === syncedText) {
    if (syncState.value === 'pending') syncState.value = 'idle'
    clearTimeout(syncTimer)
    return
  }
  syncState.value = 'pending'
  clearTimeout(syncTimer)
  syncTimer = setTimeout(flushSync, 1000)
}, { immediate: true })

/** 写回正文；返回是否成功（没有要写的也算成功）。 */
function flushSync() {
  clearTimeout(syncTimer)
  syncTimer = null
  const txt = scriptText.value
  const d = dramaId.value
  const ep = episodeId.value
  if (txt === null || txt === syncedText || !d || !ep) return saving
  const run = async () => {
    syncState.value = 'saving'
    try {
      await episodesAPI.setContent(d, ep, { script_content: txt })
      syncedText = txt
      syncState.value = 'saved'
      clearTimeout(savedTimer)
      savedTimer = setTimeout(() => { if (syncState.value === 'saved') syncState.value = 'idle' }, 2500)
      return true
    } catch (_) {
      syncState.value = 'error'
      return false
    }
  }
  saving = saving.then(run, run)
  return saving
}

onBeforeUnmount(() => {
  clearTimeout(savedTimer)
  if (syncTimer || scriptText.value !== syncedText) flushSync()
})

// ---------------------------------------------------------------- 工具条

const ctx = () => actionCtx()
function aiWrite() { return openDialog('script.aiWrite', { dramaId: dramaId.value, episodeId: episodeId.value }) }
function importScript() { return openDialog('script.importScript', { dramaId: dramaId.value, episodeId: episodeId.value }) }

async function ensureSynced() {
  const ok = await flushSync()
  if (ok === false) ElMessage.error(t('script.sync.blocked'))
  return ok !== false
}
async function extractAssets() {
  if (!(await ensureSynced())) return
  await runAction('assets.extract', ctx())
}
async function genStoryboard() {
  if (!(await ensureSynced())) return
  await runAction(hasShots.value ? 'storyboard.regenerate' : 'storyboard.generate', ctx())
}

async function onEpisodeCommand(cmd) {
  const ids = { add: 'script.addEpisode', import: 'script.importEpisodes', rename: 'script.renameEpisode', delete: 'script.deleteEpisode', manage: 'script.reorderEpisodes' }
  if (cmd === 'settings') return openDialog('home.projectSettings', { dramaId: dramaId.value })
  if (ids[cmd]) await runAction(ids[cmd], ctx())
}

// ---------------------------------------------------------------- 全文编辑

const mode = ref('lines')
const fullBusy = ref(false)
const fullText = computed(() => scriptTextOfView(views.views.script))

watch(fullOk, (ok) => { if (!ok && mode.value === 'full') mode.value = 'lines' })

async function applyFullText(text) {
  if (fullBusy.value) return
  fullBusy.value = true
  try {
    await flushSync()
    // 先改项目图（有镜头时会拒绝），成功后再写正文，两边不会错开
    const r = await scriptSync.replaceGraphLines(episodeId.value, text, 'edit full script')
    if (r === 'has_shots') { ElMessage.warning(t('script.full.hasShots')); return }
    if (r === 'no_graph') { ElMessage.warning(t('script.full.noGraph')); return }
    await episodesAPI.setContent(dramaId.value, episodeId.value, { script_content: text })
    await views.refresh()
    syncedText = scriptText.value
    syncState.value = 'idle'
    await shell.loadProject(dramaId.value)
    ElMessage.success(t('script.full.applied'))
    mode.value = 'lines'
  } catch (e) {
    ElMessage.error(e?.message || t('script.full.failed'))
  } finally {
    fullBusy.value = false
  }
}

// ---------------------------------------------------------------- 检查器

const selLine = computed(() => {
  const id = focus.value?.id
  if (!id) return null
  for (const g of groups.value) {
    const l = g.lines.find((x) => x.id === id)
    if (l) return l
  }
  return null
})
const selShots = computed(() => (selLine.value?.shot_ids || []).map((sid) => shotsById.value[sid]).filter(Boolean))

const assetsReady = computed(() => String(assets.dramaId) === String(dramaId.value) && !assets.loading && !assets.loadError)
const appearing = computed(() => {
  if (!assetsReady.value || !selLine.value) return { characters: [], scenes: [], props: [] }
  return appearingAssets({
    shots: selShots.value,
    texts: [draftOf(selLine.value, 'text')],
    byKind: assets.byKind,
    refsFor: (params) => assets.refs(params),
    resolve: (token) => assets.resolveMention(token),
  })
})
const hasAppearing = computed(() => appearing.value.characters.length + appearing.value.scenes.length + appearing.value.props.length > 0)

function openInStoryboard(sid) {
  views.select({ kind: 'shot', id: sid })
  router.push({ name: 'episode-storyboard', params: { dramaId: dramaId.value, episodeId: episodeId.value } })
}
function openWorkbench(s) {
  router.push({ name: 'shot-workbench', params: { dramaId: dramaId.value, episodeId: episodeId.value, shotId: s.legacy_id } })
}

const voiceBusy = ref('')
/** 重新配音这一镜：先取估价，确认后才真正提交（费用由用户确认）。 */
async function revoice(shot) {
  if (voiceBusy.value) return
  voiceBusy.value = shot.id
  try {
    const est = await voiceoverAPI.run(episodeId.value, { shots: [shot.id] })
    if (Array.isArray(est?.tasks)) { ElMessage.success(t('script.voice.submitted', { n: est.tasks.length })); return }
    if (!est || !(est.shots > 0)) { ElMessage.info(t('script.voice.nothing')); return }
    if (est.allowed === false) { ElMessage.warning(est.reason || t('script.voice.notAllowed')); return }
    try {
      await ElMessageBox.confirm(
        t('script.voice.confirm', { chars: est.chars, estimate: est.estimate, max: est.max, unit: !est.currency || est.currency === 'CNY' ? t('script.voice.cny') : est.currency }),
        t('script.insp.revoice'),
        { confirmButtonText: t('script.voice.go'), cancelButtonText: t('common.cancel') },
      )
    } catch (_) { return }
    const res = await voiceoverAPI.run(episodeId.value, { shots: [shot.id], confirm: true })
    ElMessage.success(t('script.voice.submitted', { n: (res?.tasks || []).length }))
  } catch (e) {
    ElMessage.error(e?.message || t('script.voice.failed'))
  } finally {
    voiceBusy.value = ''
  }
}

onMounted(async () => {
  await views.load(episodeId.value, { drama: route.params.dramaId })
  if (dramaId.value && String(assets.dramaId) !== String(dramaId.value) && !assets.loading) assets.load(dramaId.value)
  scrollToFocus()
})
watch(() => views.selection, scrollToFocus)
</script>

<style scoped>
.script-view { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--bg-page); }
.toolbar {
  flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 16px;
  background: var(--el-bg-color); border-bottom: 1px solid var(--el-border-color-lighter);
}
.spacer { flex: 1; }
.clickable { cursor: pointer; }
.content { flex: 1; min-height: 0; display: flex; }
.body { flex: 1; min-width: 0; overflow: auto; padding: 20px 16px 60px; }
.body > * { max-width: 960px; margin-left: auto; margin-right: auto; }
.empty { color: var(--el-text-color-secondary); padding: 40px; text-align: center; }
.empty.small { padding: 12px; }
.empty-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.scene { margin-bottom: 24px; }
.scene-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.scene-head h3 { margin: 0; font-size: 16px; }
.meta { color: var(--el-text-color-secondary); font-size: 12px; flex: 1; }
.line {
  display: flex; gap: 12px; padding: 10px 12px; margin-bottom: 8px; border-radius: 8px; cursor: pointer;
  background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-left: 4px solid transparent;
}
.line.stale { border-left-color: var(--el-color-warning); }
.line.focus { border-color: var(--el-color-primary); box-shadow: 0 0 0 2px var(--el-color-primary-light-7); }
.line-main { flex: 1; min-width: 0; }
.line-top { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
.kind { width: 110px; }
.speaker { width: 130px; }
.text {
  width: 100%; resize: vertical; font: inherit; line-height: 1.6; padding: 6px 8px; border-radius: 6px; min-height: 52px;
  border: 1px solid var(--el-border-color); background: var(--el-fill-color-blank); color: var(--el-text-color-primary);
}
.text:focus { outline: none; border-color: var(--el-color-primary); }
.line-side { width: 280px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.feeds { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
.feeds-label { font-size: 12px; color: var(--el-text-color-secondary); }
.none { font-size: 12px; color: var(--el-text-color-placeholder); }
.shot-chip { cursor: pointer; }
.dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--el-color-warning); margin-left: 5px; vertical-align: middle; }
.tools { display: flex; flex-wrap: wrap; justify-content: flex-end; }

.inspector {
  flex: none; width: 320px; overflow: auto; padding: 12px 14px; border-left: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color); display: flex; flex-direction: column; gap: 8px;
}
.inspector h4 { margin: 8px 0 0; font-size: 13px; color: var(--el-text-color-secondary); font-weight: 600; }
.insp-empty, .insp-none { color: var(--el-text-color-secondary); font-size: 13px; }
.insp-field { display: flex; gap: 8px; align-items: center; }
.insp-shots { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.insp-shots li { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.shot-head { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.shot-title { color: var(--el-text-color-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chips, .shot-btns, .appearing { display: flex; flex-wrap: wrap; gap: 6px; }
.shot-btns .el-button + .el-button { margin-left: 0; }

@media (max-width: 1100px) {
  .line { flex-direction: column; }
  .line-side { width: auto; align-items: flex-start; }
}
@media (max-width: 900px) {
  .content { flex-direction: column; overflow: auto; }
  .body { overflow: visible; flex: none; }
  .inspector { width: auto; border-left: 0; border-top: 1px solid var(--el-border-color-lighter); }
}
</style>
