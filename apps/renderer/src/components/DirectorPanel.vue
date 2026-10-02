<template>
  <el-drawer
    v-model="directorOpen"
    title="导演模式"
    direction="rtl"
    size="560px"
    :append-to-body="true"
    data-test="director-drawer"
    @opened="reload"
  >
    <div v-if="!episodeId" class="dr-empty" data-test="director-noepisode">请先打开一个剧集（分镜表 / 工作台 / 四视图）。</div>
    <template v-else>
      <section class="dr-ask">
        <el-input
          v-model="message"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          :maxlength="MESSAGE_MAX"
          placeholder="用一句话说要改什么，例如：第二镜改成夜景特写，第三镜的旁白短一点"
          data-test="director-input"
          @keydown.ctrl.enter.prevent="submit"
          @keydown.meta.enter.prevent="submit"
        />
        <div class="dr-ask-row">
          <span class="dr-muted">计划只用项目已有的编辑动作；执行前会列出会改什么、不会改什么、要花多少钱，执行后可一键撤销。</span>
          <el-button type="primary" :loading="planning" :disabled="!canSubmit" data-test="director-plan" @click="submit">生成计划</el-button>
        </div>
        <div v-if="planError" class="dr-error" data-test="director-error">{{ planError }}</div>
      </section>

      <div v-if="loadError" class="dr-error">{{ loadError }}</div>
      <div v-else-if="!cards.length" class="dr-empty" data-test="director-empty">还没有导演模式的记录。</div>

      <article
        v-for="t in cards"
        :key="t.id"
        class="dr-turn"
        :class="[`s-${t.status.key}`, { rejected: t.rejected }]"
        data-test="director-turn"
        :data-turn="t.id"
        :data-status="t.status.key"
      >
        <header class="dr-head">
          <div class="dr-msg">「{{ t.message }}」</div>
          <el-tag size="small" :type="t.status.type" effect="light" data-test="director-status">{{ t.status.label }}</el-tag>
        </header>
        <div class="dr-muted">{{ t.time }}<template v-if="t.model"> · {{ t.model }}</template><template v-if="t.attempts > 1"> · 修正 {{ t.attempts - 1 }} 次</template></div>
        <p v-if="t.summary" class="dr-summary">{{ t.summary }}</p>

        <div v-if="t.rejected" class="dr-reject" data-test="director-reject">
          <b>计划未通过校验，没有改动项目：</b>
          <ul><li v-for="e in t.errors" :key="e">{{ e }}</li></ul>
          <el-button link size="small" data-test="director-raw-toggle" @click="toggleRaw(t.id)">{{ rawOpen.has(t.id) ? '收起模型原文' : '查看模型原文' }}</el-button>
          <pre v-if="rawOpen.has(t.id)" class="dr-raw" data-test="director-raw">{{ t.raw }}</pre>
        </div>

        <ol v-if="t.steps.length" class="dr-steps" data-test="director-steps">
          <li v-for="s in t.steps" :key="s.index" class="dr-step" :class="{ bad: !s.ok }" data-test="director-step">
            <div class="dr-step-head">
              <b>{{ s.title }}</b><span v-if="s.target" class="dr-target"> · {{ s.target }}</span>
              <span class="dr-step-cost" :class="{ zero: !s.cost }" data-test="director-step-cost">{{ s.costText }}</span>
            </div>
            <div v-if="s.detail" class="dr-detail">{{ s.detail }}</div>
            <div v-if="s.reason" class="dr-reason">{{ s.reason }}</div>
            <div v-if="s.error" class="dr-error">{{ s.error }}</div>
          </li>
        </ol>

        <template v-if="t.impact">
          <div class="dr-impact" data-test="director-impact">
            <div class="dr-col">
              <div class="dr-col-title">会改</div>
              <div v-if="!t.impact.changed.length" class="dr-muted">没有镜头级变化</div>
              <ul v-else>
                <li v-for="c in t.impact.changed" :key="c.id" :class="`c-${c.change}`">镜头 {{ c.no }}<template v-if="c.title"> {{ c.title }}</template> · {{ c.changeText }}</li>
              </ul>
              <div v-if="t.impact.staleCount" class="dr-muted">{{ t.impact.staleCount }} 个生成节点会过期（图 / 视频 / 配音）</div>
            </div>
            <div class="dr-col">
              <div class="dr-col-title">不会改</div>
              <div class="dr-muted">{{ t.impact.unchangedText }}</div>
              <ul v-if="t.impact.untouched.length"><li v-for="u in t.impact.untouched" :key="u">{{ u }}</li></ul>
            </div>
          </div>

          <div class="dr-duration" data-test="director-duration">
            <div class="dr-muted">时长 {{ t.impact.durationText }}</div>
            <div class="dr-bars-row"><span class="dr-bars-label">前</span>
              <div class="dr-bars"><span v-for="b in t.bars.before" :key="b.id" class="dr-bar" :class="`c-${b.change}`" :style="{ width: `${b.width}%` }" :title="`镜头 ${b.no} ${b.title} ${b.seconds}`" /></div>
            </div>
            <div class="dr-bars-row"><span class="dr-bars-label">后</span>
              <div class="dr-bars"><span v-for="b in t.bars.after" :key="b.id" class="dr-bar" :class="`c-${b.change}`" :style="{ width: `${b.width}%` }" :title="`镜头 ${b.no} ${b.title} ${b.seconds}`" /></div>
            </div>
          </div>

          <div class="dr-cost" data-test="director-cost">
            <b>{{ t.cost.text }}</b><span v-if="t.cost.note" class="dr-muted"> · {{ t.cost.note }}</span>
            <el-button v-if="t.cost.items.length" link size="small" @click="toggleCost(t.id)">{{ costOpen.has(t.id) ? '收起明细' : '明细' }}</el-button>
            <ul v-if="costOpen.has(t.id)" class="dr-cost-items"><li v-for="i in t.cost.items" :key="i.node">{{ i.text }}</li></ul>
            <div v-if="t.cost.refusal" class="dr-warn">{{ t.cost.refusal }}</div>
          </div>

          <div class="dr-preview" data-test="director-preview">
            <div class="dr-muted">计划后的镜头（虚线 = 会变）</div>
            <div class="dr-shots">
              <div v-for="s in t.preview" :key="s.id" class="dr-shot" :class="[`c-${s.change}`, { dashed: s.dashed }]" :data-change="s.change" :title="s.changeText">
                <b>{{ s.no }}</b><span class="dr-shot-title">{{ s.title }}</span><i>{{ s.seconds }}</i>
              </div>
            </div>
          </div>
        </template>

        <footer class="dr-actions">
          <el-button-group>
            <el-button type="primary" size="small" :disabled="!t.canApply || !!acting" :loading="acting === `apply:${t.id}`" data-test="director-apply" @click="doApply(t)">执行</el-button>
            <el-button size="small" :disabled="!t.canUndo || !!acting" :loading="acting === `undo:${t.id}`" data-test="director-undo" @click="doUndo(t)">撤销</el-button>
          </el-button-group>
          <span v-if="t.status.note" class="dr-muted">{{ t.status.note }}</span>
          <span v-else-if="t.status.key === 'applied'" class="dr-muted">已作为一步写入历史，顶栏撤销也能回退</span>
        </footer>
      </article>
    </template>
  </el-drawer>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { directorAPI } from '@/api/director'
import { useProjectViewsStore } from '@/stores/projectViews'
import { directorOpen, directorEpisodeId } from '@/composables/useDirectorPanel'
import { episodeOfRoute } from '@/utils/episodeContext'
import { MESSAGE_MAX, describeTurn, sortTurns, upsertTurn, validateMessage } from '@/utils/director'

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
const episodeId = computed(() => directorEpisodeId.value || episodeOfRoute(route, views.episodeId))
const canSubmit = computed(() => validateMessage(message.value).ok && !planning.value)
const cards = computed(() => turns.value.map((t) => describeTurn(t, { busy: views.busy || !!acting.value })))

const errText = (e, fallback) => `${e?.message || fallback}${e?.action ? `（${e.action}）` : ''}`
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
    loadError.value = errText(e, '读取导演模式记录失败')
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
      ElMessage.warning('计划未通过校验，原因见下方')
    } else {
      message.value = ''
    }
  } catch (e) {
    planError.value = errText(e, '生成计划失败')
  } finally {
    planning.value = false
  }
}

/** 执行 / 撤销后：共享 store 刷新（四视图立刻看到）；revision +1 让旧页面（分镜表 / 工作台 / 时间线）重新读取旧表。 */
async function afterChange(ep) {
  if (views.episodeId === ep) await views.refresh()
  views.revision += 1
}

async function doApply(t) {
  const ep = episodeId.value
  if (!ep || acting.value) return
  acting.value = `apply:${t.id}`
  try {
    const r = await directorAPI.apply(ep, t.id)
    turns.value = upsertTurn(turns.value, r.turn)
    await afterChange(ep)
    ElMessage.success(`已执行：${t.summary || t.message}`)
  } catch (e) {
    ElMessage.error(errText(e, '执行失败'))
    await reload()
  } finally {
    acting.value = ''
  }
}

async function doUndo(t) {
  const ep = episodeId.value
  if (!ep || acting.value) return
  acting.value = `undo:${t.id}`
  try {
    const r = await directorAPI.undo(ep, t.id)
    turns.value = upsertTurn(turns.value, r.turn)
    await afterChange(ep)
    ElMessage.success('已撤销这次执行')
  } catch (e) {
    ElMessage.error(errText(e, '撤销失败'))
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
