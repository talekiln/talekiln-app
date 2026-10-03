<template>
  <div class="frame-slot" :class="`is-${model.state}`" :data-test="`frame-slot-${model.slot}`">
    <div class="head">
      <strong>{{ t(`storyboard.frame.${model.slot}`) }}</strong>
      <el-tag size="small" :type="stateType">{{ t(`storyboard.frame.state.${model.state}`) }}</el-tag>
    </div>

    <div class="pic" v-loading="model.state === 'generating'">
      <el-image v-if="url" :src="url" fit="contain" class="img" :preview-src-list="[url]" preview-teleported />
      <div v-else class="img empty">{{ t('storyboard.frame.none') }}</div>
    </div>

    <div class="actions">
      <el-tooltip :disabled="!generateReason" :content="generateReason" placement="top">
        <span>
          <el-button size="small" type="primary" plain :disabled="!model.canGenerate" :data-test="`frame-generate-${model.slot}`" @click="$emit('generate')">
            {{ t(url ? 'storyboard.frame.regenerate' : 'storyboard.frame.generate') }}
          </el-button>
        </span>
      </el-tooltip>
      <el-button size="small" :disabled="!model.canUpload" :data-test="`frame-upload-${model.slot}`" @click="fileInput && fileInput.click()">{{ t('storyboard.frame.upload') }}</el-button>
      <el-button size="small" :disabled="!model.canEditPrompt" :data-test="`frame-prompt-${model.slot}`" @click="$emit('edit-prompt')">{{ t('storyboard.frame.prompt') }}</el-button>
      <el-button v-if="model.slot === 'first'" size="small" :disabled="!model.canUpscale" :loading="upscaling" @click="$emit('upscale')">{{ t('storyboard.frame.upscale') }}</el-button>
      <el-tooltip v-if="model.slot === 'first'" :disabled="!prevTailReason" :content="prevTailReason" placement="top">
        <span>
          <el-button size="small" :disabled="!model.canUsePrevTail" :loading="usingPrevTail" data-test="frame-use-prev-tail" @click="$emit('use-prev-tail')">{{ t('storyboard.frame.usePrevTail') }}</el-button>
        </span>
      </el-tooltip>
      <input ref="fileInput" type="file" accept="image/*" class="file" @change="onFile">
    </div>

    <div v-if="history.length && model.canPickHistory" class="history">
      <span class="hist-label">{{ t('storyboard.frame.history') }}</span>
      <button v-for="h in history" :key="h.id" type="button" class="hist-item" :title="t('storyboard.frame.pick')" @click="$emit('pick', h)">
        <img :src="urlOf(h)" alt="">
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from '@/i18n'
import { assetImageUrl } from '@/utils/mediaUrl'

const props = defineProps({
  /** one entry of buildFrameSlots(): first | last */
  model: { type: Object, required: true },
  image: { type: Object, default: null },
  history: { type: Array, default: () => [] },
  upscaling: Boolean,
  usingPrevTail: Boolean,
})
const emit = defineEmits(['generate', 'upload', 'edit-prompt', 'pick', 'upscale', 'use-prev-tail'])
const { t } = useI18n()
const fileInput = ref(null)

const urlOf = (img) => assetImageUrl(img)
const url = computed(() => urlOf(props.image))
const stateType = computed(() => ({ generating: 'primary', has: 'success', stale: 'warning', none: 'info' }[props.model.state] || 'info'))
const generateReason = computed(() => (props.model.generateReason ? t(`storyboard.frame.reason.${props.model.generateReason}`) : ''))
const prevTailReason = computed(() => (props.model.prevTailReason ? t(`storyboard.frame.reason.${props.model.prevTailReason}`) : ''))

function onFile(ev) {
  const file = ev.target.files && ev.target.files[0]
  if (file) emit('upload', file)
  ev.target.value = ''
}
</script>

<style scoped>
.frame-slot { border: 1px solid var(--el-border-color-light); border-radius: 6px; padding: 8px; background: var(--el-fill-color-blank); min-width: 0; }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.pic { background: var(--el-fill-color-light); border-radius: 4px; }
.img { width: 100%; height: 150px; display: block; }
.img.empty { display: flex; align-items: center; justify-content: center; color: var(--el-text-color-placeholder); font-size: 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.actions .el-button { margin: 0; }
.file { display: none; }
.history { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
.hist-label { font-size: 12px; color: var(--el-text-color-secondary); }
.hist-item { border: 1px solid var(--el-border-color); padding: 0; border-radius: 3px; cursor: pointer; background: none; width: 44px; height: 44px; overflow: hidden; }
.hist-item:hover { border-color: var(--el-color-primary); }
.hist-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
</style>
