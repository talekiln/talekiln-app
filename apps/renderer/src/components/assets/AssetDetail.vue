<template>
  <div v-if="item" class="asset-detail" :data-test="`asset-detail-${kind}`">
    <header class="head">
      <div class="titles">
        <h3 class="name">{{ name || t('assets.unnamed') }}</h3>
        <el-tag size="small" effect="plain">{{ t(`assets.kind.${kind}.label`) }}</el-tag>
      </div>
      <div class="head-acts">
        <el-button size="small" data-test="detail-edit" @click="onEdit">{{ t('assets.action.edit') }}</el-button>
        <el-button size="small" type="danger" plain data-test="detail-delete" @click="onDelete">{{ t('common.delete') }}</el-button>
      </div>
    </header>

    <p v-if="desc" class="desc">{{ desc }}</p>
    <p v-else class="desc empty">{{ t('assets.noDescription') }}</p>

    <AssetImages :kind="kind" :id="id" />

    <section class="block">
      <h4 class="h">{{ t('assets.library.title') }}</h4>
      <div class="row">
        <el-button size="small" :loading="actions.isBusy('lib-project', kind, id)" :disabled="!hasImage" data-test="save-project-lib" @click="actions.saveToLibrary(kind, item, 'project')">{{ t('assets.library.toProject') }}</el-button>
        <el-button size="small" :loading="actions.isBusy('lib-global', kind, id)" :disabled="!hasImage" data-test="save-global-lib" @click="actions.saveToLibrary(kind, item, 'global')">{{ t('assets.library.toGlobal') }}</el-button>
      </div>
      <p v-if="!hasImage" class="hint">{{ t('assets.library.needImage') }}</p>
    </section>

    <AssetCandidates v-if="kind !== 'props'" :kind="kind" :id="id" />
    <section v-else class="block">
      <h4 class="h">{{ t('assets.lock.title') }}</h4>
      <p class="hint" data-test="props-no-lock">{{ t('assets.lock.propsUnsupported') }}</p>
    </section>

    <section v-if="kind === 'characters'" class="block" data-test="sd2-block">
      <h4 class="h">{{ t('assets.sd2.title') }}</h4>
      <div class="row">
        <el-button
          size="small"
          plain
          :type="actions.sd2Status(item) === 'active' ? 'success' : 'warning'"
          :loading="actions.isBusy('sd2', kind, id)"
          :disabled="!hasImage"
          @click="onSd2"
        >{{ t(actions.sd2LabelKey(item)) }}</el-button>
      </div>
      <div class="row">
        <template v-if="actions.sd2VoiceStatus(item) === 'active'">
          <el-button size="small" type="success" plain @click="actions.playVoice(item)">{{ t('assets.sd2.listen') }}</el-button>
          <el-button size="small" type="primary" plain :loading="actions.isBusy('sd2voice', kind, id)" @click="voiceInput && voiceInput.click()">{{ t('assets.sd2.voiceReplace') }}</el-button>
          <span class="ok">{{ t('assets.sd2.voiceReady') }}</span>
        </template>
        <template v-else>
          <el-button size="small" plain :type="actions.sd2VoiceStatus(item) === 'stale' ? 'warning' : 'info'" :loading="actions.isBusy('sd2voice', kind, id)" @click="onVoice">{{ t(actions.sd2VoiceLabelKey(item)) }}</el-button>
          <span v-if="actions.sd2VoiceStatus(item) === 'stale'" class="warn">{{ t('assets.sd2.voiceStale') }}</span>
        </template>
        <span class="hint">{{ t('assets.sd2.onlyForSd2') }}</span>
        <input ref="voiceInput" type="file" accept="audio/*" class="hidden" @change="onVoiceFile" />
      </div>
    </section>

    <AssetUsage :kind="kind" :id="id" />

    <el-dialog v-model="certOpen" :title="t('assets.sd2.certTitle')" width="min(720px, 92vw)" append-to-body destroy-on-close>
      <el-descriptions v-if="cert" :column="1" border size="small">
        <el-descriptions-item :label="t('assets.sd2.assetId')">{{ cert.hub_asset_id || '—' }}</el-descriptions-item>
        <el-descriptions-item label="asset_url"><code class="wrap">{{ cert.asset_url || '—' }}</code></el-descriptions-item>
        <el-descriptions-item :label="t('assets.sd2.status')">{{ cert.status || '—' }}</el-descriptions-item>
        <el-descriptions-item :label="t('assets.sd2.sourceImage')">{{ cert.source_image_url || '—' }}</el-descriptions-item>
        <el-descriptions-item v-if="cert.sd2_provider" :label="t('assets.sd2.provider')">{{ cert.sd2_provider }}</el-descriptions-item>
      </el-descriptions>
      <template #footer><el-button @click="certOpen = false">{{ t('common.close') }}</el-button></template>
    </el-dialog>
  </div>
  <el-empty v-else :description="t('assets.detail.missing')" />
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from '@/i18n'
import { openDialog } from '@/shell/dialogs'
import { assetDescription, assetName, hasAssetImage } from '@/utils/assets'
import AssetImages from './AssetImages.vue'
import AssetCandidates from './AssetCandidates.vue'
import AssetUsage from './AssetUsage.vue'
import { useAssetActions } from './assetActions'

const props = defineProps({
  kind: { type: String, required: true },
  id: { type: [Number, String], required: true },
})
const emit = defineEmits(['removed'])
const { t } = useI18n()
const actions = useAssetActions()
const { assets } = actions

const item = computed(() => assets.find(props.kind, props.id))
const name = computed(() => assetName(props.kind, item.value))
const desc = computed(() => assetDescription(props.kind, item.value))
const hasImage = computed(() => hasAssetImage(item.value))

const certOpen = ref(false)
const cert = ref(null)
const voiceInput = ref(null)

function onEdit() {
  openDialog('assets.edit', { kind: props.kind, id: props.id })
}

async function onDelete() {
  if (await actions.remove(props.kind, item.value)) emit('removed', props.id)
}

async function onSd2() {
  const r = await actions.sd2Primary(item.value)
  if (r === 'view') {
    cert.value = item.value.seedance2_asset ? { ...item.value.seedance2_asset } : null
    certOpen.value = true
  }
}

function onVoice() {
  if (actions.sd2VoiceStatus(item.value) === 'processing' || actions.sd2VoiceStatus(item.value) === 'stale') actions.sd2VoiceRefresh(item.value)
  else if (voiceInput.value) voiceInput.value.click()
}

function onVoiceFile(ev) {
  const file = ev.target?.files?.[0]
  if (ev.target) ev.target.value = ''
  if (file) actions.sd2VoiceUpload(item.value, file)
}
</script>

<style scoped>
.asset-detail { display: flex; flex-direction: column; gap: 14px; }
.head { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
.titles { display: flex; align-items: center; gap: 8px; min-width: 0; }
.name { margin: 0; font-size: 16px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; }
.head-acts { display: flex; gap: 6px; }
.desc { margin: 0; font-size: 13px; line-height: 1.6; color: var(--text-primary); white-space: pre-wrap; }
.desc.empty, .hint { color: var(--text-muted); }
.hint { margin: 0; font-size: 12px; line-height: 1.5; }
.block { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border-color); }
.h { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ok { font-size: 12px; color: var(--el-color-success); }
.warn { font-size: 12px; color: var(--el-color-warning); }
.wrap { word-break: break-all; }
.hidden { display: none; }
</style>
