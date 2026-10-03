<template>
  <el-dialog
    v-model="visible"
    :title="t('export.dialog.title.media', { target: targetName })"
    width="600px"
    :close-on-click-modal="false"
    append-to-body
    data-test="export-media"
    @closed="emit('close', result)"
  >
    <div v-loading="loading">
      <div class="md-hint">{{ t('export.dialog.media.hint') }}</div>
      <el-alert v-if="loadError" class="md-gap" type="error" :closable="false" show-icon :title="loadError" />
      <el-form label-width="96px" :disabled="busy" @submit.prevent>
        <el-form-item :label="t('export.dialog.media.target')">
          <el-radio-group v-model="target" data-test="media-target">
            <el-radio-button v-for="m in mediaTargets" :key="m.value" :value="m.value">{{ m.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="t('export.dialog.resolution')">
          <el-select v-model="form.resolution" style="width: 320px" data-test="resolution" @change="onSizeChange">
            <el-option-group :label="t('export.dialog.groupGeneral')">
              <el-option v-for="r in resolutions" :key="r.key" :label="sizeLabel(r)" :value="r.key" />
            </el-option-group>
            <el-option-group :label="t('export.dialog.groupPlatform')">
              <el-option v-for="r in presets" :key="r.key" :label="sizeLabel(r)" :value="r.key" />
            </el-option-group>
          </el-select>
        </el-form-item>
        <el-form-item :label="t('export.dialog.fps')">
          <el-radio-group v-model="form.fps" data-test="fps">
            <el-radio-button v-for="f in fpsOptions" :key="f" :value="f">{{ f }} fps</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="t('export.dialog.media.dir')">
          <el-input v-model="form.media_dir" :placeholder="t('export.dialog.media.dirPlaceholder')" data-test="media-dir" />
        </el-form-item>
        <el-form-item :label="t('export.dialog.media.name')">
          <el-input v-model="form.media_name" :placeholder="t('export.dialog.media.namePlaceholder')" style="width: 280px" data-test="media-name" />
        </el-form-item>
      </el-form>
      <el-alert v-if="error" class="md-gap" type="error" :closable="false" show-icon :title="error" data-test="media-error" />
      <el-alert v-if="conflict" class="md-gap" type="warning" :closable="false" show-icon :title="t('export.dialog.media.conflict')">
        <el-button size="small" data-test="media-overwrite" @click="run(false, true)">{{ t('export.dialog.media.overwrite') }}</el-button>
      </el-alert>
      <div v-if="done" class="md-result" data-test="media-result">
        <el-alert type="success" :closable="false" show-icon :title="mediaResultText(done)" />
        <ul v-if="done.warnings && done.warnings.length" class="md-warn">
          <li v-for="(w, i) in done.warnings" :key="i">{{ w }}</li>
        </ul>
      </div>
    </div>
    <template #footer>
      <el-button @click="visible = false">{{ t('common.close') }}</el-button>
      <el-button :disabled="busy || !!loadError" data-test="media-check" @click="run(true)">{{ t('export.dialog.media.check') }}</el-button>
      <el-button type="primary" :loading="busy" :disabled="!!loadError" data-test="media-export" @click="run(false)">{{ t('export.dialog.media.export') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { exportAPI } from '@/api/export'
import {
  FALLBACK_RESOLUTIONS, FALLBACK_PLATFORM_PRESETS, MEDIA_TARGETS, mediaTargetLabel, sizeLabel, sizeTable, presetOf,
  validateMediaForm, buildMediaRequest, mediaResultText,
} from '@/utils/exportJob'
import { applyOptions, dirOfPath } from './exportDialogModel.js'

const props = defineProps({
  dramaId: { type: [Number, String], default: null },
  episodeId: { type: [Number, String], required: true },
  target: { type: String, default: 'jianying' },
})
const emit = defineEmits(['close'])
const { t } = useI18n()

const mediaTargets = MEDIA_TARGETS
const visible = ref(true)
const loading = ref(false)
const loadError = ref('')
const busy = ref(false)
const error = ref('')
const conflict = ref(false)
const done = ref(null)
const target = ref(props.target)
const resolutions = ref(FALLBACK_RESOLUTIONS)
const presets = ref(FALLBACK_PLATFORM_PRESETS)
const fpsOptions = ref([24, 25, 30, 60])
const form = reactive({ resolution: '1080p', fps: 30, media_dir: '', media_name: '' })
let result

const sizes = computed(() => sizeTable(resolutions.value, presets.value))
const targetName = computed(() => mediaTargetLabel(target.value))

function onSizeChange() {
  const p = presetOf(presets.value, form.resolution)
  if (p) form.fps = p.fps
}

onMounted(async () => {
  loading.value = true
  try {
    const r = applyOptions(await exportAPI.options(props.episodeId, false), { fpsOptions: fpsOptions.value })
    resolutions.value = r.resolutions
    presets.value = r.presets
    fpsOptions.value = r.fpsOptions
    form.resolution = r.resolution
    form.fps = r.fps
    form.media_dir = dirOfPath(r.outputPath)
  } catch (e) {
    loadError.value = (e && e.message) || t('export.dialog.loadFailed')
  } finally {
    loading.value = false
  }
})

/** dryRun：只检查素材与估算，不写文件；overwrite：覆盖同名工程 */
async function run(dryRun, overwrite = false) {
  const bad = validateMediaForm(form)
  if (bad) return ElMessage.warning(bad)
  busy.value = true
  error.value = ''
  conflict.value = false
  done.value = null
  try {
    const { kind, body } = buildMediaRequest(form, sizes.value, props.episodeId, target.value, { dry_run: dryRun || undefined, overwrite: overwrite || undefined })
    done.value = await exportAPI[kind](body)
    if (done.value && done.value.written) result = { target: target.value, outputDir: done.value.output_dir }
  } catch (e) {
    if (e && e.code === 'EXPORT_OUTPUT_EXISTS') conflict.value = true
    else error.value = (e && e.message) || t('export.dialog.media.failed')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.md-hint { margin-bottom: 12px; font-size: 12px; line-height: 1.6; color: var(--text-subtle); }
.md-gap { margin: 8px 0; }
.md-result { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.md-warn { margin: 0; padding-left: 20px; font-size: 12px; color: var(--text-subtle); line-height: 1.6; }
</style>
