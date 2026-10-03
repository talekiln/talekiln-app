<template>
  <section class="asset-images" data-test="asset-images">
    <div
      class="main"
      :class="{ over: dragging, empty: !mainSrc }"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <el-image v-if="mainSrc" :src="mainSrc" fit="contain" class="main-img" :preview-src-list="previewList" preview-teleported />
      <div v-else class="drop-hint">
        <span>{{ t('assets.images.empty') }}</span>
        <span class="sub">{{ t('assets.images.dropHint') }}</span>
      </div>
      <div v-if="generating" class="busy"><el-icon class="is-loading"><Loading /></el-icon><span>{{ t('assets.gen.running') }}</span></div>
    </div>

    <div v-if="extras.length" class="extras" data-test="asset-extras">
      <div v-for="p in extras" :key="p" class="extra">
        <img :src="urlOf(p)" :alt="t('assets.images.extraAlt')" loading="lazy" />
        <div class="extra-acts">
          <el-button size="small" link type="primary" @click="actions.setPrimary(kind, id, p)">{{ t('assets.images.setPrimary') }}</el-button>
          <el-button size="small" link type="danger" @click="actions.removeExtra(kind, id, p)">{{ t('assets.images.removeExtra') }}</el-button>
        </div>
      </div>
    </div>

    <div class="bar">
      <el-button size="small" :loading="actions.isBusy('upload', kind, id)" data-test="images-upload" @click="fileInput && fileInput.click()">{{ t('assets.images.upload') }}</el-button>
      <el-select v-if="models.length" v-model="model" size="small" clearable :placeholder="t('assets.images.model')" style="width: 150px" :aria-label="t('assets.images.model')">
        <el-option v-for="m in models" :key="m" :label="m" :value="m" />
      </el-select>
      <el-tooltip :disabled="gate.allowed" :content="gateText" placement="top">
        <span>
          <el-button
            size="small"
            type="primary"
            :loading="generating"
            :disabled="!gate.allowed"
            data-test="images-generate"
            @click="onGenerate"
          >{{ mainSrc ? t('assets.images.regenerate') : t('assets.images.generate') }}</el-button>
        </span>
      </el-tooltip>
      <input ref="fileInput" type="file" accept="image/*" multiple class="hidden" @change="onPick" />
    </div>

    <p v-if="!gate.allowed" class="note" data-test="gen-gate-note">{{ gateText }}</p>
    <p v-if="err" class="note err" data-test="gen-error">
      {{ err.messageKey ? t(err.messageKey) : (err.message || t('assets.gen.failed')) }}
      <el-button link type="primary" size="small" @click="assets.clearGenError(kind, id)">{{ t('common.close') }}</el-button>
    </p>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'
import { useI18n } from '@/i18n'
import { assetImageUrl, parseExtraImages } from '@/utils/assets'
import { useAssetActions } from './assetActions'
import { useImageModels } from './imageModels'

const props = defineProps({
  kind: { type: String, required: true },
  id: { type: [Number, String], required: true },
})
const { t } = useI18n()
const actions = useAssetActions()
const { assets } = actions
const { models, model } = useImageModels()

const item = computed(() => assets.find(props.kind, props.id))
const mainSrc = computed(() => assetImageUrl(item.value))
const extras = computed(() => parseExtraImages(item.value?.extra_images))
const urlOf = (p) => assetImageUrl({ local_path: p })
const previewList = computed(() => [mainSrc.value, ...extras.value.map(urlOf)].filter(Boolean))
const gate = computed(() => assets.gate)
const gateText = computed(() => t(gate.value.reasonKey || 'assets.gen.unknown'))
const generating = computed(() => assets.isGenerating(props.kind, props.id))
const err = computed(() => assets.genError(props.kind, props.id))

const fileInput = ref(null)
const dragging = ref(false)

function onPick(ev) {
  const files = ev.target?.files
  const list = files ? Array.from(files) : []
  if (ev.target) ev.target.value = ''
  if (list.length) actions.uploadImages(props.kind, props.id, list)
}

function onDrop(ev) {
  dragging.value = false
  const files = Array.from(ev.dataTransfer?.files || [])
  if (files.length) actions.uploadImages(props.kind, props.id, files)
}

async function onGenerate() {
  const r = await assets.generate(props.kind, props.id, { model: model.value || undefined })
  if (r.ok) ElMessage.success(t('assets.gen.done'))
  else if (r.reasonKey) ElMessage.warning(t(r.reasonKey))
}
</script>

<style scoped>
.asset-images { display: flex; flex-direction: column; gap: 10px; }
.main { position: relative; width: 100%; aspect-ratio: 4 / 3; border: 1px dashed var(--border-color); border-radius: 10px; background: var(--bg-hover); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.main:not(.empty) { border-style: solid; }
.main.over { border-color: var(--el-color-primary); background: var(--bg-card); }
.main-img { width: 100%; height: 100%; }
.drop-hint { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--text-muted); font-size: 13px; text-align: center; padding: 0 12px; }
.drop-hint .sub { font-size: 12px; }
.busy { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 6px; background: rgba(0, 0, 0, 0.45); color: #fff; font-size: 13px; }
.extras { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
.extra { border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; background: var(--bg-card); }
.extra img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; }
.extra-acts { display: flex; justify-content: space-between; padding: 2px 6px 4px; }
.bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-muted); }
.note.err { color: var(--el-color-danger); }
.hidden { display: none; }
</style>
