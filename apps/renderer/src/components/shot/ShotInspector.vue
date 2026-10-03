<template>
  <div v-if="shot" class="shot-inspector" :class="{ compact }" data-test="shot-inspector">
    <header class="head">
      <strong class="no">{{ t('storyboard.insp.shotNo', { n: number }) }}</strong>
      <el-tag size="small" :type="chipType(chips.image)" data-test="chip-image">{{ t('storyboard.insp.image') }} {{ t(chipKey(chips.image)) }}</el-tag>
      <el-tag size="small" :type="chipType(chips.video)" data-test="chip-video">{{ t('storyboard.insp.video') }} {{ t(chipKey(chips.video)) }}</el-tag>
      <span v-if="rec.saving.value" class="saving">{{ t('storyboard.insp.saving') }}</span>
      <span class="spacer" />
      <el-button size="small" type="success" plain :disabled="busy || !canGenerate" data-test="gen-image" @click="generate('image')">
        {{ t(hasFirstImage ? 'storyboard.insp.regenImage' : 'storyboard.insp.genImage') }}
      </el-button>
      <el-button size="small" type="success" plain :disabled="busy || !canGenerate" data-test="gen-video" @click="generate('video')">
        {{ t(chips.video === 'none' ? 'storyboard.insp.genVideo' : 'storyboard.insp.regenVideo') }}
      </el-button>
      <el-button size="small" data-test="more-params" @click="openParams">{{ t('storyboard.insp.moreParams') }}</el-button>
      <el-button v-if="showWorkbenchLink" size="small" data-test="open-workbench" @click="openWorkbench">{{ t('storyboard.insp.workbench') }}</el-button>
    </header>

    <el-collapse v-model="openSections" class="sections">
      <!-- story: title and description -->
      <el-collapse-item :title="t('storyboard.insp.sec.story')" name="story">
        <el-form label-position="top" class="form" @submit.prevent>
          <el-form-item :label="t('storyboard.insp.field.title')">
            <el-input v-model="form.title" :placeholder="t('storyboard.insp.placeholder.title')" data-test="field-title" @input="touch('title')" @change="commit(['title'])" />
          </el-form-item>
          <el-form-item :label="t('storyboard.insp.field.description')">
            <el-input
              v-model="form.description" type="textarea" :autosize="{ minRows: compact ? 2 : 3, maxRows: 10 }"
              :placeholder="t('storyboard.insp.placeholder.description')" data-test="field-description"
              @input="touch('description')" @blur="commit(['description'])"
            />
          </el-form-item>
        </el-form>
      </el-collapse-item>

      <!-- camera: shot size, movement, duration -->
      <el-collapse-item :title="t('storyboard.insp.sec.camera')" name="camera">
        <div class="row3">
          <el-form-item :label="t('storyboard.insp.field.shotType')" class="grow">
            <el-select v-model="form.shot_type" clearable filterable allow-create default-first-option :placeholder="t('storyboard.insp.placeholder.pick')" data-test="field-shot-type" @change="commit(['shot_type'])">
              <el-option v-for="o in shotTypeOptions" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('storyboard.insp.field.movement')" class="grow">
            <el-select v-model="form.movement" clearable filterable allow-create default-first-option :placeholder="t('storyboard.insp.placeholder.pick')" data-test="field-movement" @change="commit(['movement'])">
              <el-option-group v-for="g in movementGroups" :key="g.key" :label="g.label">
                <el-option v-for="o in g.options" :key="o.value" :label="o.label" :value="o.value" />
              </el-option-group>
              <el-option v-if="movementExtra" :label="movementExtra" :value="movementExtra" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('storyboard.insp.field.duration')">
            <el-input-number
              v-model="form.duration" :min="DURATION_RANGE.min" :max="DURATION_RANGE.max" :step="0.5" :precision="1" controls-position="right"
              data-test="field-duration" @change="commit(['duration'])"
            />
          </el-form-item>
        </div>
      </el-collapse-item>

      <!-- prompts: video prompt, AI polish, templates -->
      <el-collapse-item :title="t('storyboard.insp.sec.prompt')" name="prompt">
        <div class="prompt-tools">
          <el-dropdown trigger="click" @command="insertTemplate">
            <el-button size="small" data-test="tpl-menu">{{ t('storyboard.insp.tpl.menu') }}</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="tpl in VIDEO_PROMPT_TEMPLATES" :key="tpl.key" :command="tpl">{{ t(tpl.key) }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button size="small" :loading="rebuilding" data-test="rebuild-video-prompt" @click="rebuildPrompt">{{ t('storyboard.insp.prompt.rebuild') }}</el-button>
        </div>
        <el-form label-position="top" class="form" @submit.prevent>
          <el-form-item :label="t('storyboard.insp.field.videoPrompt')">
            <el-input
              v-model="form.video_prompt" type="textarea" :autosize="{ minRows: 3, maxRows: 12 }"
              :placeholder="t('storyboard.insp.placeholder.videoPrompt')" data-test="field-video-prompt"
              @input="touch('video_prompt')" @blur="commit(['video_prompt'])"
            />
          </el-form-item>
          <el-form-item :label="t('storyboard.insp.field.imagePrompt')">
            <el-input
              v-model="form.image_prompt" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }"
              :placeholder="t('storyboard.insp.placeholder.imagePrompt')" data-test="field-image-prompt"
              @input="touch('image_prompt')" @blur="commit(['image_prompt'])"
            />
          </el-form-item>
          <el-form-item :label="t('storyboard.insp.field.polished')">
            <div class="polish-row">
              <el-input
                v-model="polished" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }"
                :placeholder="t('storyboard.insp.placeholder.polished')" data-test="field-polished"
                @input="polishedDirty = true" @blur="savePolished"
              />
              <el-button size="small" :loading="polishing" data-test="ai-polish" @click="aiPolish">{{ t('storyboard.insp.prompt.polish') }}</el-button>
            </div>
          </el-form-item>
        </el-form>
        <ul v-if="warnings.length" class="warns">
          <li v-for="w in warnings" :key="w.key">{{ t(w.key, w.params) }}</li>
        </ul>
      </el-collapse-item>

      <!-- assets: scene, characters, props and the reference-image order -->
      <el-collapse-item :title="t('storyboard.insp.sec.assets')" name="assets">
        <el-alert v-if="assets.loadError" type="warning" :closable="false" show-icon :title="t('storyboard.insp.assets.loadFailed')" />
        <el-form label-position="top" class="form" @submit.prevent>
          <el-form-item :label="t('storyboard.insp.field.scene')">
            <el-select :model-value="sceneValue" clearable filterable :placeholder="t('storyboard.insp.assets.noScene')" data-test="field-scene" @change="setScene">
              <el-option v-for="s in assets.scenes" :key="s.id" :label="assetName('scenes', s) || `#${s.id}`" :value="s.id" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('storyboard.insp.field.characters')">
            <el-select :model-value="characterIds" multiple filterable collapse-tags collapse-tags-tooltip :placeholder="t('storyboard.insp.assets.pickCharacters')" data-test="field-characters" @change="(v) => setIds('character_ids', v)">
              <el-option v-for="c in assets.characters" :key="c.id" :label="assetName('characters', c) || `#${c.id}`" :value="c.id" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('storyboard.insp.field.props')">
            <el-select :model-value="propIds" multiple filterable collapse-tags collapse-tags-tooltip :placeholder="t('storyboard.insp.assets.pickProps')" data-test="field-props" @change="(v) => setIds('prop_ids', v)">
              <el-option v-for="p in assets.props" :key="p.id" :label="assetName('props', p) || `#${p.id}`" :value="p.id" />
            </el-select>
          </el-form-item>
        </el-form>
        <div v-if="mode !== 'universal'" class="order">
          <div class="order-title">{{ t('storyboard.insp.assets.order') }}</div>
          <AtImageEditor hide-text :slots="refSlots" :overflow="overflow" @move="onMoveRef" @remove="onRemoveRef" />
        </div>
      </el-collapse-item>

      <!-- first / last frame -->
      <el-collapse-item v-if="mode !== 'universal'" :title="t('storyboard.insp.sec.frames')" name="frames">
        <el-alert v-if="!useFirstLast" type="info" :closable="false" show-icon :title="t('storyboard.insp.frames.singleHint')" class="mb" />
        <div class="frames" :class="{ two: slots.last }">
          <FrameSlot
            :model="slots.first" :image="bound.first" :history="history"
            :upscaling="upscaling" :using-prev-tail="usingPrevTail"
            @generate="generate('image')" @upload="(f) => upload('first', f)" @edit-prompt="promptFor = 'first'"
            @pick="(img) => pick('first', img)" @upscale="upscale" @use-prev-tail="usePrevTail"
          />
          <FrameSlot
            v-if="slots.last" :model="slots.last" :image="bound.last" :history="history"
            @upload="(f) => upload('last', f)" @edit-prompt="promptFor = 'last'" @pick="(img) => pick('last', img)"
          />
        </div>
        <div class="link-row">
          <el-tooltip :disabled="slots.linkTail.enabled" :content="linkReason" placement="top">
            <span>
              <el-button size="small" :disabled="!slots.linkTail.enabled" :loading="linking" data-test="link-tail" @click="linkTail">{{ t('storyboard.insp.frames.linkTail') }}</el-button>
            </span>
          </el-tooltip>
        </div>
      </el-collapse-item>

      <!-- universal-segment mode: only when the active video model takes several reference images -->
      <el-collapse-item v-if="multiRef" :title="t('storyboard.insp.sec.universal')" name="universal">
        <div class="uni-head">
          <el-switch :model-value="mode === 'universal'" :active-text="t('storyboard.uni.switch')" data-test="uni-switch" @change="setMode" />
          <span class="hint">{{ t('storyboard.uni.hint') }}</span>
        </div>
        <template v-if="mode === 'universal'">
          <div class="prompt-tools">
            <el-dropdown trigger="click" @command="onUniMenu">
              <el-button size="small" :loading="uniBusy" data-test="uni-menu">{{ t('storyboard.uni.menu') }}</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="generate">{{ t('storyboard.uni.generate') }}</el-dropdown-item>
                  <el-dropdown-item command="generate-force">{{ t('storyboard.uni.generateForce') }}</el-dropdown-item>
                  <el-dropdown-item command="polish" divided>{{ t('storyboard.uni.polish') }}</el-dropdown-item>
                  <el-dropdown-item command="polish-force">{{ t('storyboard.uni.polishForce') }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <AtImageEditor
            v-model="uni" :slots="refSlots" :overflow="overflow" :rows="compact ? 5 : 8" :disabled="uniBusy"
            :placeholder="t('storyboard.uni.placeholder')" @blur="saveUni" @move="onMoveRef" @remove="onRemoveRef"
          />
        </template>
      </el-collapse-item>
    </el-collapse>
    <p v-if="unsupportedUniversal" class="hint warn">{{ t('storyboard.uni.unsupported') }}</p>

    <ShotGenerateDialog v-if="ownGen" :gen="gen" />
    <FramePromptDialog v-if="promptFor && rec.legacyId.value != null" :legacy-id="rec.legacyId.value" :frame="promptFor" @close="promptFor = ''" />
  </div>
  <el-empty v-else :description="t('storyboard.insp.notFound')" :image-size="64" />
</template>

<script setup>
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from '@/i18n'
import { useProjectViewsStore } from '@/stores/projectViews'
import { useShellStore } from '@/stores/shell'
import { useAssetsStore } from '@/stores/assets'
import { storyboardsAPI } from '@/api/storyboards'
import { imagesAPI } from '@/api/images'
import { uploadAPI } from '@/api/upload'
import { openDialog } from '@/shell/dialogs'
import { assetImageUrl as assetThumb, assetName } from '@/utils/assets'
import { shotNumbers } from '@/utils/projectViews'
import { rowWarnings } from '@/utils/storyboardTable'
import FrameSlot from './FrameSlot.vue'
import FramePromptDialog from './FramePromptDialog.vue'
import AtImageEditor from './AtImageEditor.vue'
import ShotGenerateDialog from './ShotGenerateDialog.vue'
import { useShotRecord } from './useShotRecord.js'
import { useShotGeneration } from './useShotGeneration.js'
import { useMultiRef } from './useMultiRef.js'
import { buildFrameSlots, pickSlotImages } from './frameSlots.js'
import { MAX_REFS, buildRefSlots, remapCanonical } from './atImageOrder.js'
import { DURATION_RANGE, MOVEMENT_GROUPS, SHOT_TYPES, VIDEO_PROMPT_TEMPLATES, applyTemplate } from './shotParams.js'
import { boundColumnOf, imageFrameTypeOf } from './framePrompt.js'
import { chipKey, diffForm, formFromShot, isShotBusy, moveId, orderedRefs, rowIds, shotChips, shotMode } from './shotInspectorModel.js'

const props = defineProps({
  /** kernel shot node id */
  shotId: { type: String, required: true },
  compact: { type: Boolean, default: false },
  /** the full workbench hosts the inspector itself, so it hides the link to itself */
  inWorkbench: { type: Boolean, default: false },
})
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const views = useProjectViewsStore()
const shell = useShellStore()
const assets = useAssetsStore()
const rec = useShotRecord(() => props.shotId)
const { shot, bound, history } = rec
const { multiRef } = useMultiRef()

const dramaId = computed(() => Number(route.params.dramaId || shell.dramaId) || null)
const episodeId = computed(() => views.episodeId)
const showWorkbenchLink = computed(() => !props.inWorkbench)

// The host (storyboard page / workbench) shares one generation flow; a standalone inspector owns its own.
const injectedGen = inject('storyboardGen', null)
const ownGen = !injectedGen
const gen = injectedGen || useShotGeneration(episodeId)
if (ownGen) onMounted(() => gen.refresh())

onMounted(() => {
  if (dramaId.value && String(assets.dramaId) !== String(dramaId.value)) assets.load(dramaId.value)
})

// ---------- derived state ----------
const number = computed(() => (shotNumbers(views.views.shots)[props.shotId]) || '')
const genShot = computed(() => gen.shotStatus(rec.legacyId.value))
const chips = computed(() => shotChips(shot.value, genShot.value))
const busy = computed(() => isShotBusy(genShot.value))
const canGenerate = computed(() => rec.legacyId.value != null && !!episodeId.value)
const hasFirstImage = computed(() => !!bound.value.first)
const chipType = (s) => ({ none: 'info', queued: 'warning', running: 'primary', stale: 'warning', fresh: 'success', failed: 'danger' }[s] || 'info')
const mode = computed(() => shotMode(shot.value, multiRef.value))
const unsupportedUniversal = computed(() => !!shot.value && shot.value.creation_mode === 'universal' && !multiRef.value)
const useFirstLast = computed(() => !!(shell.drama && shell.drama.metadata && shell.drama.metadata.storyboard_use_first_last_frame))
const warnings = computed(() => (shot.value ? rowWarnings({ description: shot.value.description, dialogue: shot.value.dialogue, duration: shot.value.duration, narration: shot.value.narration }) : []))

const openSections = ref(props.compact ? ['story', 'prompt'] : ['story', 'camera', 'prompt', 'assets', 'frames', 'universal'])

// ---------- form with commit-on-blur ----------
const polished = ref('')
const polishedDirty = ref(false)
const uni = ref('')
const uniDirty = ref(false)
const form = reactive({})
const dirty = reactive({})
watch(
  shot,
  (s) => {
    if (!s) return
    const base = formFromShot(s)
    for (const k of Object.keys(base)) if (!dirty[k]) form[k] = base[k]
    if (!polishedDirty.value) polished.value = s.polished_prompt || ''
    if (!uniDirty.value) uni.value = s.universal_segment_text || ''
  },
  { immediate: true },
)
const touch = (k) => { dirty[k] = true }
async function commit(keys) {
  const s = shot.value
  if (!s) return
  const patch = diffForm(form, s)
  const own = {}
  for (const k of keys) if (k in patch) own[k] = patch[k]
  if (!Object.keys(own).length) {
    for (const k of keys) delete dirty[k]
    return
  }
  const r = await rec.save(own)
  if (r.ok) for (const k of keys) delete dirty[k]
}
async function commitAll() {
  const keys = Object.keys(dirty)
  if (keys.length) await commit(keys)
  await savePolished()
  await saveUni()
}
onBeforeUnmount(() => { commitAll() })

// option lists with localized labels; a stored value outside the table stays selectable
const shotTypeOptions = computed(() => {
  const list = SHOT_TYPES.map((o) => ({ value: o.value, label: t(o.key) }))
  const cur = form.shot_type
  if (cur && !list.some((o) => o.value === cur)) list.push({ value: cur, label: cur })
  return list
})
const movementGroups = computed(() => MOVEMENT_GROUPS.map((g) => ({ key: g.key, label: t(g.key), options: g.options.map((o) => ({ value: o.value, label: t(o.key) })) })))
const movementExtra = computed(() => {
  const cur = form.movement
  return cur && !MOVEMENT_GROUPS.some((g) => g.options.some((o) => o.value === cur)) ? cur : ''
})

// ---------- prompts ----------
function insertTemplate(tpl) {
  form.video_prompt = applyTemplate(form.video_prompt, tpl)
  touch('video_prompt')
  commit(['video_prompt'])
}

const rebuilding = ref(false)
async function rebuildPrompt() {
  if (rec.legacyId.value == null) return
  rebuilding.value = true
  try {
    await commitAll()
    const res = await storyboardsAPI.rebuildVideoPrompt(rec.legacyId.value)
    await views.refresh()
    await rec.reload()
    delete dirty.video_prompt
    ElMessage.success(res && res.video_prompt ? t('storyboard.insp.prompt.rebuilt') : t('storyboard.insp.prompt.rebuiltNone'))
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.insp.prompt.rebuildFailed'))
  } finally {
    rebuilding.value = false
  }
}

const polishing = ref(false)
async function savePolished() {
  const s = shot.value
  if (!s || !polishedDirty.value) return
  const next = polished.value.trim()
  polishedDirty.value = false
  if (next === (s.polished_prompt || '')) return
  await rec.save({ polished_prompt: next || null })
}
async function aiPolish() {
  if (rec.legacyId.value == null) return
  polishing.value = true
  try {
    await commitAll()
    const res = await storyboardsAPI.polishPrompt(rec.legacyId.value)
    if (res && res.polished_prompt) {
      polished.value = res.polished_prompt
      polishedDirty.value = true
      await savePolished()
      ElMessage.success(t('storyboard.insp.prompt.polished'))
    } else {
      ElMessage.warning(t('storyboard.insp.prompt.polishEmpty'))
    }
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.insp.prompt.polishFailed'))
  } finally {
    polishing.value = false
  }
}

// ---------- assets and reference order ----------
const refs = computed(() => orderedRefs(rec.row.value, assets.byKind))
const sceneValue = computed(() => (refs.value.scenes[0] ? refs.value.scenes[0].id : null))
const characterIds = computed(() => rowIds(rec.row.value && rec.row.value.characters))
const propIds = computed(() => rowIds(rec.row.value && rec.row.value.prop_ids))
const allSlots = computed(() => {
  const toRef = (kind, listKey) => refs.value[listKey].map((a) => ({ kind, id: a.id, name: assetName(listKey, a), thumbUrl: assetThumb(a) }))
  return buildRefSlots([...toRef('scene', 'scenes'), ...toRef('character', 'characters'), ...toRef('prop', 'props')], 999)
})
const refSlots = computed(() => allSlots.value.slice(0, MAX_REFS))
const overflow = computed(() => Math.max(0, allSlots.value.length - MAX_REFS))

function setScene(v) { return rec.save({ scene_id: v == null || v === '' ? null : v }) }
function setIds(column, v) { return remapAfter({ [column]: v }) }

// Texts holding image tokens are re-pointed when the slot list changes, so each token keeps naming the same asset.
async function remapAfter(columnPatch) {
  const s = shot.value
  if (!s) return
  const before = allSlots.value
  const nextRow = { ...(rec.row.value || {}), ...('character_ids' in columnPatch ? { characters: columnPatch.character_ids } : {}), ...columnPatch }
  const next = orderedRefs(nextRow, assets.byKind)
  const toRef = (kind, listKey) => next[listKey].map((a) => ({ kind, id: a.id, name: assetName(listKey, a), thumbUrl: assetThumb(a) }))
  const after = buildRefSlots([...toRef('scene', 'scenes'), ...toRef('character', 'characters'), ...toRef('prop', 'props')], 999)
  const patch = { ...columnPatch }
  const texts = { universal_segment_text: uni.value, video_prompt: form.video_prompt }
  for (const [k, v] of Object.entries(texts)) {
    const re = remapCanonical(v, before, after)
    if (re !== v) patch[k] = re
  }
  if ('universal_segment_text' in patch) { uni.value = patch.universal_segment_text; uniDirty.value = false }
  if ('video_prompt' in patch) { form.video_prompt = patch.video_prompt; delete dirty.video_prompt }
  await rec.save(patch)
}
function onMoveRef({ slot, dir }) {
  if (slot.kind === 'character') return remapAfter({ character_ids: moveId(characterIds.value, slot.id, dir) })
  if (slot.kind === 'prop') return remapAfter({ prop_ids: moveId(propIds.value, slot.id, dir) })
  return undefined
}
function onRemoveRef(slot) {
  if (slot.kind === 'scene') return remapAfter({ scene_id: null })
  if (slot.kind === 'character') return remapAfter({ character_ids: characterIds.value.filter((i) => i !== slot.id) })
  return remapAfter({ prop_ids: propIds.value.filter((i) => i !== slot.id) })
}

// ---------- frames ----------
const neighbors = computed(() => {
  const flat = (views.views.shots?.groups || []).flatMap((g) => g.shots || [])
  const i = flat.findIndex((s) => s.id === props.shotId)
  return { prev: i > 0 ? flat[i - 1] : null, next: i >= 0 && i < flat.length - 1 ? flat[i + 1] : null }
})
const prevInfo = reactive({ exists: false, legacyId: null, lastImage: null, number: '' })
async function loadPrev() {
  const p = neighbors.value.prev
  prevInfo.exists = !!p
  prevInfo.legacyId = p ? p.legacy_id ?? null : null
  prevInfo.lastImage = null
  prevInfo.number = p ? String(shotNumbers(views.views.shots)[p.id] || '') : ''
  if (!p || p.legacy_id == null) return
  try {
    const [row, imgs] = await Promise.all([
      storyboardsAPI.get(p.legacy_id),
      imagesAPI.list({ storyboard_id: p.legacy_id, page: 1, page_size: 100 }),
    ])
    prevInfo.lastImage = pickSlotImages((imgs && imgs.items) || [], row).last
  } catch (_) { /* request.js already reports */ }
}
watch(() => [props.shotId, views.seq], loadPrev, { immediate: true })

const linking = ref(false)
const upscaling = ref(false)
const usingPrevTail = ref(false)
const promptFor = ref('')

const slots = computed(() => buildFrameSlots({
  useFirstLast: useFirstLast.value,
  first: { hasImage: !!bound.value.first, generating: busy.value && chips.value.image !== 'fresh', stale: chips.value.image === 'stale' },
  last: { hasImage: !!bound.value.last },
  prev: { exists: prevInfo.exists, lastHasImage: !!prevInfo.lastImage },
  next: { exists: !!neighbors.value.next },
  hasVideo: !!shot.value && shot.value.videoState !== 'none',
  linking: linking.value,
  // Only first-frame images and videos exist as queue kinds, so a last frame cannot be generated from here.
  capabilities: { lastFrameGenerate: false },
}))
const linkReason = computed(() => (slots.value.linkTail.reason ? t(`storyboard.insp.frames.linkReason.${slots.value.linkTail.reason}`) : ''))

function generate(kind) {
  if (!canGenerate.value) return
  const regenerate = kind === 'image' ? hasFirstImage.value : chips.value.video !== 'none'
  return gen.ask({ shots: [rec.legacyId.value], kind, regenerate })
}

async function upload(slot, file) {
  if (rec.legacyId.value == null || !dramaId.value) return
  try {
    const res = await uploadAPI.uploadImage(file, { dramaId: dramaId.value })
    const url = res && (res.url || res.path)
    const localPath = res && res.local_path
    if (!url && !localPath) {
      ElMessage.error(t('storyboard.frame.uploadNoUrl'))
      return
    }
    const uploaded = await imagesAPI.upload({
      storyboard_id: rec.legacyId.value,
      drama_id: dramaId.value,
      image_url: url || '',
      local_path: localPath || undefined,
      frame_type: useFirstLast.value ? imageFrameTypeOf(slot) : undefined,
    })
    if (uploaded && uploaded.id) await rec.save({ [boundColumnOf(slot)]: uploaded.id })
    else await rec.reload()
    ElMessage.success(t(slot === 'last' ? 'storyboard.frame.uploadedLast' : 'storyboard.frame.uploadedFirst'))
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.frame.uploadFailed'))
  }
}

async function pick(slot, img) {
  await rec.save({ [boundColumnOf(slot)]: img.id })
}

async function upscale() {
  if (rec.legacyId.value == null) return
  upscaling.value = true
  try {
    await storyboardsAPI.upscale(rec.legacyId.value)
    ElMessage.success(t('storyboard.frame.upscaled'))
    await rec.reload()
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.frame.upscaleFailed'))
  } finally {
    upscaling.value = false
  }
}

async function usePrevTail() {
  const img = prevInfo.lastImage
  if (!img || rec.legacyId.value == null || !dramaId.value) return
  usingPrevTail.value = true
  try {
    const uploaded = await imagesAPI.upload({
      storyboard_id: rec.legacyId.value,
      drama_id: dramaId.value,
      image_url: img.image_url || '',
      local_path: img.local_path || undefined,
      prompt: t('storyboard.frame.prevTailPrompt', { n: prevInfo.number }),
      frame_type: 'storyboard_first',
    })
    if (uploaded && uploaded.id) await rec.save({ first_frame_image_id: uploaded.id })
    else await rec.reload()
    ElMessage.success(t('storyboard.frame.prevTailDone', { n: prevInfo.number }))
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.frame.prevTailFailed'))
  } finally {
    usingPrevTail.value = false
  }
}

async function linkTail() {
  const next = neighbors.value.next
  if (!next || rec.legacyId.value == null) return
  const nextNo = String(shotNumbers(views.views.shots)[next.id] || '')
  try {
    await ElMessageBox.confirm(
      t('storyboard.insp.frames.linkConfirm', { from: number.value, to: nextNo }),
      t('storyboard.insp.frames.linkTitle'),
      { type: 'warning', confirmButtonText: t('storyboard.common.confirm'), cancelButtonText: t('storyboard.common.cancel') },
    )
  } catch (_) { return }
  linking.value = true
  try {
    const data = await storyboardsAPI.linkTailFrame(rec.legacyId.value, { drama_id: dramaId.value })
    if (data && data.error) throw new Error(data.error)
    ElMessage.success(t('storyboard.insp.frames.linked', { to: nextNo }))
    await views.refresh()
    await rec.reload()
  } catch (e) {
    ElMessage.error((e && e.message) || t('storyboard.insp.frames.linkFailed'))
  } finally {
    linking.value = false
  }
}

// ---------- universal-segment mode ----------
const uniBusy = ref(false)
watch(uni, (v) => { if (!uniBusy.value && v !== ((shot.value && shot.value.universal_segment_text) || '')) uniDirty.value = true })

async function setMode(on) {
  await rec.save({ creation_mode: on ? 'universal' : 'classic' })
}
async function saveUni() {
  const s = shot.value
  if (!s || !uniDirty.value) return
  uniDirty.value = false
  const next = uni.value.trim()
  if (next === (s.universal_segment_text || '')) return
  await rec.save({ universal_segment_text: next || null })
}

function fieldOverrides() {
  const v = (x) => { const s = (x == null ? '' : String(x)).trim(); return s || null }
  const s = shot.value
  return {
    title: v(form.title), description: v(form.description), location: v(s.location), time: v(s.time), action: v(s.action),
    dialogue: v(form.dialogue), narration: v(s.narration), result: v(s.result), atmosphere: v(form.atmosphere),
    shot_type: v(form.shot_type), movement: v(form.movement), layout_description: v(s.layout_description),
  }
}

async function runUni(kind, force) {
  const id = rec.legacyId.value
  if (id == null || uniBusy.value) return
  if (kind === 'polish' && !uni.value.trim()) {
    ElMessage.warning(t('storyboard.uni.needDraft'))
    return
  }
  if (!force && !refSlots.value.length) {
    try {
      await ElMessageBox.confirm(t('storyboard.uni.noRefsConfirm'), t('storyboard.uni.noRefsTitle'), {
        type: 'warning', confirmButtonText: t('storyboard.uni.continue'), cancelButtonText: t('storyboard.common.cancel'),
      })
    } catch (_) { return }
    force = true
  }
  const before = uni.value
  uniBusy.value = true
  try {
    await commitAll()
    const body = { duration: shot.value.duration, field_overrides: fieldOverrides(), ...(force ? { force_without_reference_images: true } : {}) }
    let live = ''
    const onDelta = (d) => { live += d; uni.value = live }
    let data
    if (kind === 'polish') data = await storyboardsAPI.polishUniversalSegmentPromptStream(id, { ...body, draft_universal_segment_text: before }, onDelta)
    else data = await storyboardsAPI.generateUniversalSegmentPromptStream(id, body, onDelta)
    const text = ((data && data.universal_segment_text) || '').toString().trim()
    if (!text) {
      uni.value = before
      ElMessage.warning(t(kind === 'polish' ? 'storyboard.uni.polishIncomplete' : 'storyboard.uni.generateIncomplete'))
      return
    }
    uni.value = text
    uniDirty.value = true
    uniBusy.value = false
    await saveUni()
  } catch (e) {
    uni.value = before
    ElMessage.error((e && e.message) || t('storyboard.uni.failed'))
  } finally {
    uniBusy.value = false
  }
}
function onUniMenu(cmd) {
  const [kind, force] = String(cmd).split('-')
  return runUni(kind, force === 'force')
}

// ---------- navigation ----------
function openParams() {
  return openDialog('storyboard.shotParams', { shotId: props.shotId })
}
function openWorkbench() {
  const legacy = rec.legacyId.value
  if (legacy == null) return
  router.push({ name: 'shot-workbench', params: { dramaId: route.params.dramaId, episodeId: route.params.episodeId, shotId: legacy } })
}

defineExpose({ commitAll, reload: rec.reload })
</script>

<style scoped>
.shot-inspector { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.no { font-size: 15px; }
.saving { font-size: 12px; color: var(--el-text-color-secondary); }
.spacer { flex: 1; }
.form :deep(.el-form-item) { margin-bottom: 10px; }
.row3 { display: flex; gap: 12px; flex-wrap: wrap; }
.row3 .grow { flex: 1; min-width: 150px; }
.row3 :deep(.el-select) { width: 100%; }
.prompt-tools { display: flex; gap: 8px; margin-bottom: 8px; }
.polish-row { display: flex; gap: 8px; width: 100%; align-items: flex-start; }
.warns { margin: 0; padding-left: 18px; font-size: 12px; color: var(--el-color-warning); }
.order { margin-top: 4px; }
.order-title { font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 4px; }
.frames { display: grid; grid-template-columns: 1fr; gap: 12px; }
.frames.two { grid-template-columns: 1fr 1fr; }
.compact .frames.two { grid-template-columns: 1fr; }
.link-row { margin-top: 10px; }
.uni-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.hint { font-size: 12px; color: var(--el-text-color-secondary); margin: 0; }
.hint.warn { color: var(--el-color-warning); }
.mb { margin-bottom: 8px; }
</style>
