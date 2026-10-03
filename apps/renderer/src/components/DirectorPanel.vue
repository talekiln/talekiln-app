<template>
  <el-drawer
    v-model="directorOpen"
    :title="t('director.title')"
    direction="rtl"
    size="560px"
    :append-to-body="true"
    data-test="director-drawer"
    @opened="reload"
  >
    <div v-if="!episodeId" class="dr-empty" data-test="director-noepisode">{{ t('director.noEpisode') }}</div>
    <template v-else>
      <section class="dr-ask">
        <el-input
          v-model="message"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          :maxlength="MESSAGE_MAX"
          :placeholder="t('director.placeholder')"
          data-test="director-input"
          @keydown.ctrl.enter.prevent="submit"
          @keydown.meta.enter.prevent="submit"
        />
        <div class="dr-ask-row">
          <span class="dr-muted">{{ t('director.askHint') }}</span>
          <el-button type="primary" :loading="planning" :disabled="!canSubmit" data-test="director-plan" @click="submit">{{ t('director.plan') }}</el-button>
        </div>
        <div v-if="planError" class="dr-error" data-test="director-error">{{ planError }}</div>
      </section>

      <div v-if="loadError" class="dr-error">{{ loadError }}</div>
      <div v-else-if="!cards.length" class="dr-empty" data-test="director-empty">{{ t('director.empty') }}</div>

      <article
        v-for="tn in cards"
        :key="tn.id"
        class="dr-turn"
        :class="[`s-${tn.status.key}`, { rejected: tn.rejected }]"
        data-test="director-turn"
        :data-turn="tn.id"
        :data-status="tn.status.key"
      >
        <header class="dr-head">
          <div class="dr-msg">{{ t('director.quote', { message: tn.message }) }}</div>
          <el-tag size="small" :type="tn.status.type" effect="light" data-test="director-status">{{ tn.status.label }}</el-tag>
        </header>
        <div class="dr-muted">{{ tn.time }}<template v-if="tn.model"> · {{ tn.model }}</template><template v-if="tn.attempts > 1"> · {{ t('director.attempts', { n: tn.attempts - 1 }) }}</template></div>
        <p v-if="tn.summary" class="dr-summary">{{ tn.summary }}</p>

        <div v-if="tn.rejected" class="dr-reject" data-test="director-reject">
          <b>{{ t('director.rejectedTitle') }}</b>
          <ul><li v-for="e in tn.errors" :key="e">{{ e }}</li></ul>
          <el-button link size="small" data-test="director-raw-toggle" @click="toggleRaw(tn.id)">{{ rawOpen.has(tn.id) ? t('director.rawHide') : t('director.rawShow') }}</el-button>
          <pre v-if="rawOpen.has(tn.id)" class="dr-raw" data-test="director-raw">{{ tn.raw }}</pre>
        </div>

        <ol v-if="tn.steps.length" class="dr-steps" data-test="director-steps">
          <li v-for="s in tn.steps" :key="s.index" class="dr-step" :class="{ bad: !s.ok }" data-test="director-step">
            <div class="dr-step-head">
              <b>{{ s.title }}</b><span v-if="s.target" class="dr-target"> · {{ s.target }}</span>
              <span class="dr-step-cost" :class="{ zero: !s.cost }" data-test="director-step-cost">{{ s.costText }}</span>
            </div>
            <div v-if="s.detail" class="dr-detail">{{ s.detail }}</div>
            <div v-if="s.reason" class="dr-reason">{{ s.reason }}</div>
            <div v-if="s.error" class="dr-error">{{ s.error }}</div>
          </li>
        </ol>

        <template v-if="tn.impact">
          <div class="dr-impact" data-test="director-impact">
            <div class="dr-col">
              <div class="dr-col-title">{{ t('director.willChange') }}</div>
              <div v-if="!tn.impact.changed.length" class="dr-muted">{{ t('director.noShotChange') }}</div>
              <ul v-else>
                <li v-for="c in tn.impact.changed" :key="c.id" :class="`c-${c.change}`">{{ t('director.shotRow', { no: c.no }) }}<template v-if="c.title"> {{ c.title }}</template> · {{ c.changeText }}</li>
              </ul>
              <div v-if="tn.impact.staleCount" class="dr-muted">{{ t('director.staleNodes', { n: tn.impact.staleCount }) }}</div>
            </div>
            <div class="dr-col">
              <div class="dr-col-title">{{ t('director.wontChange') }}</div>
              <div class="dr-muted">{{ tn.impact.unchangedText }}</div>
              <ul v-if="tn.impact.untouched.length"><li v-for="u in tn.impact.untouched" :key="u">{{ u }}</li></ul>
            </div>
          </div>

          <div class="dr-duration" data-test="director-duration">
            <div class="dr-muted">{{ t('director.duration', { text: tn.impact.durationText }) }}</div>
            <div class="dr-bars-row"><span class="dr-bars-label">{{ t('director.before') }}</span>
              <div class="dr-bars"><span v-for="b in tn.bars.before" :key="b.id" class="dr-bar" :class="`c-${b.change}`" :style="{ width: `${b.width}%` }" :title="t('director.barTitle', { no: b.no, title: b.title, seconds: b.seconds })" /></div>
            </div>
            <div class="dr-bars-row"><span class="dr-bars-label">{{ t('director.after') }}</span>
              <div class="dr-bars"><span v-for="b in tn.bars.after" :key="b.id" class="dr-bar" :class="`c-${b.change}`" :style="{ width: `${b.width}%` }" :title="t('director.barTitle', { no: b.no, title: b.title, seconds: b.seconds })" /></div>
            </div>
          </div>

          <div class="dr-cost" data-test="director-cost">
            <b>{{ tn.cost.text }}</b><span v-if="tn.cost.note" class="dr-muted"> · {{ tn.cost.note }}</span>
            <el-button v-if="tn.cost.items.length" link size="small" @click="toggleCost(tn.id)">{{ costOpen.has(tn.id) ? t('director.costHide') : t('director.costShow') }}</el-button>
            <ul v-if="costOpen.has(tn.id)" class="dr-cost-items"><li v-for="i in tn.cost.items" :key="i.node">{{ i.text }}</li></ul>
            <div v-if="tn.cost.refusal" class="dr-warn">{{ tn.cost.refusal }}</div>
          </div>

          <div class="dr-preview" data-test="director-preview">
            <div class="dr-muted">{{ t('director.previewTitle') }}</div>
            <div class="dr-shots">
              <div v-for="s in tn.preview" :key="s.id" class="dr-shot" :class="[`c-${s.change}`, { dashed: s.dashed }]" :data-change="s.change" :title="s.changeText">
                <b>{{ s.no }}</b><span class="dr-shot-title">{{ s.title }}</span><i>{{ s.seconds }}</i>
              </div>
            </div>
          </div>
        </template>

        <footer class="dr-actions">
          <el-button-group>
            <el-button type="primary" size="small" :disabled="!tn.canApply || !!acting" :loading="acting === `apply:${tn.id}`" data-test="director-apply" @click="doApply(tn)">{{ t('director.apply') }}</el-button>
            <el-button size="small" :disabled="!tn.canUndo || !!acting" :loading="acting === `undo:${tn.id}`" data-test="director-undo" @click="doUndo(tn)">{{ t('director.undo') }}</el-button>
          </el-button-group>
          <span v-if="tn.status.note" class="dr-muted">{{ tn.status.note }}</span>
          <span v-else-if="tn.status.key === 'applied'" class="dr-muted">{{ t('director.appliedNote') }}</span>
        </footer>
      </article>
    </template>
  </el-drawer>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { directorAPI } from '@/api/director'
import { useProjectViewsStore } from '@/stores/projectViews'
import { directorOpen, directorEpisodeId } from '@/composables/useDirectorPanel'
import { episodeOfRoute } from '@/utils/episodeContext'
import { MESSAGE_MAX, describeTurn, sortTurns, upsertTurn, validateMessage } from '@/utils/director'

const { t } = useI18n()
const route = useRoute()
const views = useProjectViewsStore()

const message = ref('')
const planning = ref(false)
const planError = ref('')
const loadError = ref('')
const acting = ref('')
const turns = ref([])
const rawOpen = ref(new Set())
const costOpen = ref(new Set())

// 打开时指定的剧集优先（工作台不在剧集路由上）；否则按当前路由推断
const episodeId = computed(() => directorEpisodeId.value || episodeOfRoute(route))
const canSubmit = computed(() => validateMessage(message.value).ok && !planning.value)
const cards = computed(() => turns.value.map((turn) => describeTurn(turn, { busy: views.busy || !!acting.value })))

const errText = (e, fallback) => (e?.action ? t('director.errAction', { message: e?.message || fallback, action: e.action }) : e?.message || fallback)
const toggle = (set, id) => { const s = new Set(set.value); if (s.has(id)) s.delete(id); else s.add(id); set.value = s }
const toggleRaw = (id) => toggle(rawOpen, id)
const toggleCost = (id) => toggle(costOpen, id)

async function reload() {
  const ep = episodeId.value
  if (!ep || !directorOpen.value) return
  try {
    const r = await directorAPI.turns(ep, 50)
    if (ep !== episodeId.value) return
    loadError.value = ''
    turns.value = sortTurns(r.turns || [])
  } catch (e) {
    loadError.value = errText(e, t('director.loadFailed'))
  }
}

async function submit() {
  const v = validateMessage(message.value)
  if (!v.ok) { planError.value = v.error; return }
  const ep = episodeId.value
  if (!ep || planning.value) return
  planning.value = true
  planError.value = ''
  try {
    const turn = await directorAPI.plan(ep, v.value)
    if (ep !== episodeId.value) return
    turns.value = upsertTurn(turns.value, turn)
    if (turn.status === 'rejected') {
      planError.value = ''
      ElMessage.warning(t('director.planRejected'))
    } else {
      message.value = ''
    }
  } catch (e) {
    planError.value = errText(e, t('director.planFailed'))
  } finally {
    planning.value = false
  }
}

/** 执行 / 撤销后：共享 store 刷新（四视图立刻看到）；revision +1 让旧页面（分镜表 / 工作台 / 时间线）重新读取旧表。 */
async function afterChange(ep) {
  if (views.episodeId === ep) await views.refresh()
  views.revision += 1
}

async function doApply(tn) {
  const ep = episodeId.value
  if (!ep || acting.value) return
  acting.value = `apply:${tn.id}`
  try {
    const r = await directorAPI.apply(ep, tn.id)
    turns.value = upsertTurn(turns.value, r.turn)
    await afterChange(ep)
    ElMessage.success(t('director.applied', { what: tn.summary || tn.message }))
  } catch (e) {
    ElMessage.error(errText(e, t('director.applyFailed')))
    await reload()
  } finally {
    acting.value = ''
  }
}

async function doUndo(tn) {
  const ep = episodeId.value
  if (!ep || acting.value) return
  acting.value = `undo:${tn.id}`
  try {
    const r = await directorAPI.undo(ep, tn.id)
    turns.value = upsertTurn(turns.value, r.turn)
    await afterChange(ep)
    ElMessage.success(t('director.undone'))
  } catch (e) {
    ElMessage.error(errText(e, t('director.undoFailed')))
    await reload()
  } finally {
    acting.value = ''
  }
}

// 打开时、剧集变化时、内核历史前进时（任何视图的编辑 / 撤销都可能让计划失效或改变撤销栈）重新读取
watch([directorOpen, episodeId, () => views.seq], () => { if (directorOpen.value) reload() })
</script>

<style scoped>
.dr-empty { padding: 24px 8px; text-align: center; color: var(--el-text-color-secondary); font-size: 13px; }
.dr-error { color: var(--el-color-danger); font-size: 12px; margin-top: 4px; }
.dr-warn { color: var(--el-color-warning); font-size: 12px; margin-top: 4px; }
.dr-muted { font-size: 12px; color: var(--el-text-color-secondary); }
.dr-ask { margin-bottom: 14px; }
.dr-ask-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.dr-ask-row .dr-muted { flex: 1; }
.dr-turn { border: 1px solid var(--el-border-color-light); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.dr-turn.s-applied { border-color: var(--el-color-success-light-5); }
.dr-turn.rejected { border-color: var(--el-color-danger-light-5); }
.dr-head { display: flex; align-items: flex-start; gap: 8px; }
.dr-msg { flex: 1; font-size: 13px; font-weight: 600; }
.dr-summary { margin: 6px 0; font-size: 13px; }
.dr-reject { background: var(--el-color-danger-light-9); border-radius: 6px; padding: 8px 10px; font-size: 12px; margin: 6px 0; }
.dr-reject ul { margin: 4px 0 0; padding-left: 18px; }
.dr-raw { white-space: pre-wrap; word-break: break-all; font-size: 11px; max-height: 200px; overflow: auto; background: var(--el-fill-color); padding: 6px; border-radius: 4px; }
.dr-steps { margin: 6px 0; padding-left: 20px; }
.dr-step { margin-bottom: 6px; font-size: 13px; }
.dr-step.bad { color: var(--el-color-danger); }
.dr-step-head { display: flex; align-items: baseline; gap: 4px; }
.dr-target { color: var(--el-text-color-regular); }
.dr-step-cost { margin-left: auto; font-size: 12px; color: var(--el-color-warning); white-space: nowrap; }
.dr-step-cost.zero { color: var(--el-text-color-secondary); }
.dr-detail { font-size: 12px; color: var(--el-text-color-regular); }
.dr-reason { font-size: 12px; color: var(--el-text-color-secondary); font-style: italic; }
.dr-impact { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 8px 0; font-size: 12px; }
.dr-col-title { font-weight: 600; margin-bottom: 2px; }
.dr-col ul { margin: 2px 0; padding-left: 16px; }
.dr-col li.c-added { color: var(--el-color-success); }
.dr-col li.c-removed { color: var(--el-color-danger); }
.dr-duration { margin: 8px 0; }
.dr-bars-row { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
.dr-bars-label { font-size: 11px; color: var(--el-text-color-secondary); width: 14px; }
.dr-bars { flex: 1; display: flex; gap: 2px; height: 10px; }
.dr-bar { display: block; height: 100%; border-radius: 2px; background: var(--el-fill-color-dark); min-width: 2px; }
.dr-bar.c-modified { background: var(--el-color-warning); }
.dr-bar.c-moved { background: var(--el-color-primary-light-3); }
.dr-bar.c-added { background: var(--el-color-success); }
.dr-bar.c-removed { background: var(--el-color-danger-light-5); opacity: .6; }
.dr-cost { font-size: 13px; margin: 6px 0; }
.dr-cost-items { margin: 2px 0; padding-left: 16px; font-size: 12px; color: var(--el-text-color-regular); }
.dr-preview { margin: 8px 0; }
.dr-shots { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.dr-shot {
  display: flex; flex-direction: column; width: 84px; padding: 6px; border: 1px solid var(--el-border-color); border-radius: 6px; font-size: 11px;
  background: var(--el-fill-color-lighter);
}
.dr-shot.dashed { border: 2px dashed var(--el-color-warning); }
.dr-shot.c-added.dashed { border-color: var(--el-color-success); }
.dr-shot.c-moved.dashed { border-color: var(--el-color-primary); }
.dr-shot b { font-size: 13px; }
.dr-shot-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-shot i { font-style: normal; color: var(--el-text-color-secondary); }
.dr-actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
</style>
