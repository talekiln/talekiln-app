<template>
  <el-dialog
    :model-value="true"
    :title="t(`assets.form.title.${editing ? 'edit' : 'create'}.${kind}`)"
    width="min(640px, 94vw)"
    append-to-body
    :close-on-click-modal="false"
    @closed="emit('close')"
  >
    <el-form label-position="top" data-test="asset-form" @submit.prevent>
      <template v-if="kind === 'characters'">
        <el-form-item :label="t('assets.field.name')" required>
          <el-input v-model="form.name" maxlength="60" data-test="field-name" />
        </el-form-item>
        <el-form-item :label="t('assets.field.role')">
          <el-select v-model="form.role" clearable :placeholder="t('assets.field.rolePh')" style="width: 100%">
            <el-option v-for="r in ROLE_VALUES" :key="r" :label="t(`assets.role.${r}`)" :value="r" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="lbl">{{ t('assets.field.appearance') }}
              <el-button v-if="editing" link type="primary" size="small" :loading="actions.isBusy('extractImage', kind, id)" data-test="extract-appearance" @click="onExtractImage">{{ t('assets.form.extractImage') }}</el-button>
            </span>
          </template>
          <el-input v-model="form.appearance" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item :label="t('assets.field.personality')">
          <el-input v-model="form.personality" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item :label="t('assets.field.description')">
          <el-input v-model="form.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item v-if="editing">
          <template #label>
            <span class="lbl">{{ t('assets.field.polished_prompt') }}
              <el-button link type="primary" size="small" :loading="actions.isBusy('prompt', kind, id)" data-test="gen-prompt" @click="onGenPrompt()">{{ t('assets.form.genPrompt') }}</el-button>
            </span>
          </template>
          <el-input v-model="form.polished_prompt" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item v-if="editing">
          <template #label>
            <span class="lbl">{{ t('assets.field.identity_anchors') }}
              <el-button link type="primary" size="small" :loading="actions.isBusy('anchors', kind, id)" data-test="extract-anchors" @click="onAnchors">{{ t('assets.form.extractAnchors') }}</el-button>
            </span>
          </template>
          <div class="anchors" :class="{ empty: !anchors }">{{ anchors || t('assets.form.anchorsEmpty') }}</div>
        </el-form-item>
        <el-form-item :label="t('assets.field.stages')">
          <el-input v-model="form.stages" type="textarea" :rows="3" :placeholder="t('assets.field.stagesPh')" />
        </el-form-item>
      </template>

      <template v-else-if="kind === 'scenes'">
        <el-form-item :label="t('assets.field.location')" required>
          <el-input v-model="form.location" maxlength="80" data-test="field-location" />
        </el-form-item>
        <el-form-item :label="t('assets.field.time')">
          <el-input v-model="form.time" maxlength="40" :placeholder="t('assets.field.timePh')" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="lbl">{{ t('assets.field.scenePrompt') }}
              <el-button v-if="editing" link type="primary" size="small" :loading="actions.isBusy('extractImage', kind, id)" data-test="extract-prompt" @click="onExtractImage">{{ t('assets.form.extractImage') }}</el-button>
            </span>
          </template>
          <el-input v-model="form.prompt" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item v-if="editing">
          <template #label>
            <span class="lbl">{{ t('assets.field.polished_prompt') }}
              <el-button link type="primary" size="small" :loading="actions.isBusy('prompt', kind, id)" data-test="gen-prompt" @click="onGenPrompt()">{{ t('assets.form.genPrompt') }}</el-button>
            </span>
          </template>
          <el-input v-model="form.polished_prompt" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item v-if="editing">
          <template #label>
            <span class="lbl">{{ t('assets.field.polished_prompt_single') }}
              <el-button link type="primary" size="small" :loading="actions.isBusy('prompt', kind, id)" data-test="gen-prompt-single" @click="onGenPrompt('single')">{{ t('assets.form.genPrompt') }}</el-button>
            </span>
          </template>
          <el-input v-model="form.polished_prompt_single" type="textarea" :rows="3" />
        </el-form-item>
      </template>

      <template v-else>
        <el-form-item :label="t('assets.field.name')" required>
          <el-input v-model="form.name" maxlength="60" data-test="field-name" />
        </el-form-item>
        <el-form-item :label="t('assets.field.propType')">
          <el-input v-model="form.type" maxlength="40" :placeholder="t('assets.field.propTypePh')" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="lbl">{{ t('assets.field.description') }}
              <el-button v-if="editing" link type="primary" size="small" :loading="actions.isBusy('extractImage', kind, id)" data-test="extract-description" @click="onExtractImage">{{ t('assets.form.extractImage') }}</el-button>
            </span>
          </template>
          <el-input v-model="form.description" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="lbl">{{ t('assets.field.propPrompt') }}
              <el-button v-if="editing" link type="primary" size="small" :loading="actions.isBusy('prompt', kind, id)" data-test="gen-prompt" @click="onGenPrompt()">{{ t('assets.form.genPrompt') }}</el-button>
            </span>
          </template>
          <el-input v-model="form.prompt" type="textarea" :rows="3" />
        </el-form-item>
      </template>

      <el-form-item :label="t('assets.field.refImage')">
        <div class="ref">
          <div class="ref-thumb">
            <img v-if="refSrc" :src="refSrc" :alt="t('assets.field.refImage')" />
            <span v-else>{{ t('assets.field.refNone') }}</span>
          </div>
          <div class="ref-side">
            <div class="ref-btns">
              <el-button size="small" :loading="refUploading" data-test="ref-upload" @click="fileInput && fileInput.click()">{{ t('assets.field.refUpload') }}</el-button>
              <el-button v-if="form.ref_image" size="small" @click="form.ref_image = ''">{{ t('assets.field.refClear') }}</el-button>
            </div>
            <p class="hint">{{ t('assets.field.refHint') }}</p>
          </div>
          <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="onRefFile" />
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('close')">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" data-test="asset-form-save" @click="onSave">{{ editing ? t('common.save') : t('assets.form.add') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from '@/i18n'
import { useAssetActions } from './assetActions'
import { ROLE_VALUES, createParts, formFromAsset, updatePatch, validateForm } from '@/utils/assetForm'
import { assetImageUrl } from '@/utils/assets'

const props = defineProps({
  kind: { type: String, required: true },
  // 编辑已有资产时传 id；不传表示新建
  id: { type: [Number, String], default: null },
})
const emit = defineEmits(['close'])
const { t } = useI18n()
const actions = useAssetActions()
const { assets } = actions

const editing = computed(() => props.id != null && props.id !== '')
const item = computed(() => (editing.value ? assets.find(props.kind, props.id) : null))
const form = reactive(formFromAsset(props.kind, item.value))
const saving = ref(false)
const refUploading = ref(false)
const fileInput = ref(null)

const anchors = computed(() => item.value?.identity_anchors || '')
const refSrc = computed(() => (form.ref_image ? assetImageUrl({ local_path: form.ref_image }) : ''))

async function onRefFile(ev) {
  const file = ev.target?.files?.[0]
  if (ev.target) ev.target.value = ''
  if (!file) return
  refUploading.value = true
  try {
    const path = await actions.uploadRef(file)
    if (path) form.ref_image = path
  } finally {
    refUploading.value = false
  }
}

async function onGenPrompt(mode) {
  if (!item.value) return
  const res = await actions.generatePrompt(props.kind, item.value, mode)
  if (!res) return
  if (props.kind === 'characters' && res.polished_prompt) form.polished_prompt = res.polished_prompt
  else if (props.kind === 'scenes') {
    if (mode === 'single' && res.polished_prompt_single) form.polished_prompt_single = res.polished_prompt_single
    else if (res.polished_prompt) form.polished_prompt = res.polished_prompt
  } else if (props.kind === 'props' && res.prompt) form.prompt = res.prompt
}

async function onExtractImage() {
  if (!item.value) return
  // 后端读的是已保存的图片：表单里刚换的参考图先存下来
  if ((form.ref_image || '') !== (item.value.ref_image || '')) {
    const saved = await actions.update(props.kind, props.id, { ref_image: form.ref_image || null }, null)
    if (!saved) return
  }
  const res = await actions.extractFromImage(props.kind, assets.find(props.kind, props.id) || item.value)
  if (!res) return
  if (props.kind === 'characters' && res.appearance) form.appearance = res.appearance
  else if (props.kind === 'scenes' && res.prompt) form.prompt = res.prompt
  else if (props.kind === 'props' && res.description) form.description = res.description
}

async function onAnchors() {
  if (!item.value) return
  await actions.extractAnchors({ ...item.value, appearance: form.appearance || item.value.appearance })
}

async function onSave() {
  const bad = validateForm(props.kind, form)
  if (bad) {
    ElMessage.warning(t(bad))
    return
  }
  saving.value = true
  try {
    if (editing.value) {
      const patch = updatePatch(props.kind, form, item.value)
      if (!Object.keys(patch).length) {
        emit('close', item.value)
        return
      }
      const saved = await actions.update(props.kind, props.id, patch)
      if (saved) emit('close', saved)
      return
    }
    const { body, after } = createParts(props.kind, form)
    const created = await actions.create(props.kind, body)
    if (!created) return
    if (Object.keys(after).length) await actions.update(props.kind, created.id, after, null)
    emit('close', assets.find(props.kind, created.id) || created)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.lbl { display: inline-flex; align-items: center; gap: 8px; }
.anchors { width: 100%; padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; color: var(--text-primary); background: var(--bg-hover); max-height: 120px; overflow: auto; }
.anchors.empty { color: var(--text-muted); }
.ref { display: flex; gap: 12px; align-items: flex-start; width: 100%; }
.ref-thumb { flex: 0 0 auto; width: 96px; height: 96px; border-radius: 8px; overflow: hidden; background: var(--bg-hover); display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--text-muted); }
.ref-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ref-side { min-width: 0; }
.ref-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.hint { margin: 6px 0 0; font-size: 12px; color: var(--text-muted); line-height: 1.5; }
.hidden { display: none; }
</style>
