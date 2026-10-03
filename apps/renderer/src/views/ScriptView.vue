<template>
  <div class="script-view" data-test="script-view">
    <div class="body">
      <div v-if="views.loading && !views.ready" class="empty">加载中…</div>
      <div v-else-if="!groups.length" class="empty">这个剧集的项目图里还没有剧本行。</div>
      <section v-for="g in groups" :key="g.id" class="scene" :data-group="g.id">
        <header class="scene-head">
          <h3>{{ g.title || '未命名场景' }}</h3>
          <span class="meta">{{ g.lines.length }} 行</span>
          <el-button size="small" plain :disabled="views.busy" data-test="append-line" @click="addLine(g, g.lines.length, null)">
            <el-icon><Plus /></el-icon>末尾加一行
          </el-button>
        </header>
        <div v-if="!g.lines.length" class="empty small">本场景没有剧本行</div>
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
                <el-option v-for="(label, k) in LINE_KIND_LABEL" :key="k" :label="label" :value="k" />
              </el-select>
              <el-input
                v-if="l.kind === 'dialogue'"
                :model-value="draftOf(l, 'speaker')"
                size="small"
                class="speaker"
                placeholder="说话人"
                @click.stop
                @update:model-value="(v) => setDraft(l, 'speaker', v)"
                @change="commit(l, 'speaker')"
              />
              <el-tag v-if="info(l).stale" size="small" type="warning" effect="light" data-test="line-stale">下游待重新生成</el-tag>
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
              <span class="feeds-label">喂给</span>
              <el-tag
                v-for="sid in l.shot_ids"
                :key="sid"
                size="small"
                class="shot-chip"
                :type="shotFocus(sid) ? 'primary' : 'info'"
                :effect="shotFocus(sid) ? 'dark' : 'plain'"
                data-test="shot-chip"
                @click.stop="onSelectShot(sid)"
              >镜 {{ nums[sid] }}<i v-if="shotStale(sid)" class="dot" title="该镜头有待重新生成的内容" /></el-tag>
              <span v-if="!l.shot_ids.length" class="none">未挂镜头</span>
            </div>
            <div class="tools" @click.stop>
              <el-button size="small" text :disabled="i === 0 || views.busy" title="上移" @click="move(g, l, -1)"><el-icon><ArrowUp /></el-icon></el-button>
              <el-button size="small" text :disabled="i === g.lines.length - 1 || views.busy" title="下移" @click="move(g, l, 1)"><el-icon><ArrowDown /></el-icon></el-button>
              <el-button size="small" text :disabled="views.busy" title="在光标处拆成两行" data-test="split-line" @click="split(l)">拆分</el-button>
              <el-button size="small" text :disabled="i === g.lines.length - 1 || views.busy" title="与下一行合并" data-test="merge-line" @click="merge(g, l, i)">合并下一行</el-button>
              <el-button size="small" text :disabled="views.busy" title="在下面插入一行（挂到同样的镜头）" data-test="insert-line" @click="addLine(g, i + 1, l)">插入</el-button>
              <el-button size="small" text type="danger" :disabled="views.busy" title="删除" data-test="delete-line" @click="remove(l)"><el-icon><Delete /></el-icon></el-button>
            </div>
          </div>
        </article>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowDown, ArrowUp, Delete, Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useProjectViewsStore } from '@/stores/projectViews'
import { LINE_KIND_LABEL, lineStaleInfo, reorderedIds, shotNumbers, validSplitAt } from '@/utils/projectViews'

const route = useRoute()
const views = useProjectViewsStore()

const groups = computed(() => views.views.script?.groups || [])
const shotsById = computed(() => Object.fromEntries((views.views.shots?.groups || []).flatMap((g) => g.shots).map((s) => [s.id, s])))
const nums = computed(() => shotNumbers(views.views.shots))
const focus = computed(() => views.focusFor('script'))
const focusShot = computed(() => views.focusFor('shots')?.id || null)
const info = (l) => lineStaleInfo(l, shotsById.value, views.staleSet)
const shotStale = (sid) => { const s = shotsById.value[sid]; return !!s && (s.image !== 'fresh' || s.video !== 'fresh' || s.narration === 'stale') }
const shotFocus = (sid) => sid === focusShot.value

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
  if (!validSplitAt(text, at)) { ElMessage.info('请先把光标放到要拆开的位置（不能在最前或最后）'); return }
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
    group: g.id, index, kind: after ? after.kind : 'narration', speaker: after ? after.speaker : '', text: '新的一行', shot_ids: after ? after.shot_ids : [],
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

onMounted(async () => {
  await views.load(route.params.episodeId, { drama: route.params.dramaId })
  scrollToFocus()
})
watch(() => route.params.episodeId, (id) => id && views.load(id, { drama: route.params.dramaId }))
watch(() => views.selection, scrollToFocus)
</script>

<style scoped>
.script-view { min-height: 100vh; background: var(--bg-page); }
.body { max-width: 1040px; margin: 0 auto; padding: 20px 16px 60px; }
.empty { color: var(--el-text-color-secondary); padding: 40px; text-align: center; }
.empty.small { padding: 12px; }
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
.line-side { width: 300px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.feeds { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
.feeds-label { font-size: 12px; color: var(--el-text-color-secondary); }
.none { font-size: 12px; color: var(--el-text-color-placeholder); }
.shot-chip { cursor: pointer; }
.dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--el-color-warning); margin-left: 5px; vertical-align: middle; }
.tools { display: flex; flex-wrap: wrap; justify-content: flex-end; }
@media (max-width: 800px) {
  .line { flex-direction: column; }
  .line-side { width: auto; align-items: flex-start; }
}
</style>
