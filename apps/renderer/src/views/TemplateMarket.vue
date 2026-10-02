<template>
  <div class="template-market">
    <header class="header">
      <div class="header-inner">
        <h1 class="logo" @click="goList">模板市场</h1>
        <span class="muted">按类型挑一个模板，先看「套用后会得到」和估价，再一键套用到新项目或已有项目的下一集。</span>
        <el-button size="small" :loading="cloudLoading" @click="openCloud">浏览云端模板</el-button>
        <el-button size="small" @click="installDialog = true">从文件安装</el-button>
        <el-button class="btn-back" @click="goList">返回</el-button>
      </div>
    </header>

    <main v-loading="loading" class="main">
      <el-alert
        v-if="!proAvailable && hasPro"
        type="info"
        :closable="false"
        show-icon
        :title="`付费模板：${proReason || '登录并开通套餐后可用'}`"
      />

      <div class="layout">
        <section class="catalog">
          <div v-if="!groups.length" class="empty">还没有模板。内置模板会在本地服务启动时自动安装。</div>
          <div v-for="g in groups" :key="g.genre" class="genre">
            <h2 class="genre-title">{{ g.label }}<span class="genre-count">{{ g.items.length }}</span></h2>
            <div class="cards">
              <div
                v-for="t in g.items"
                :key="t.id"
                class="card"
                :class="{ active: selected && selected.id === t.id }"
                :data-test="'tpl-' + t.id"
                @click="select(t)"
              >
                <div class="card-top">
                  <span class="card-name">{{ t.name }}</span>
                  <el-tag size="small" :type="tierLabel(t.tier).type">{{ tierLabel(t.tier).label }}</el-tag>
                </div>
                <div class="card-desc">{{ t.description || '（没有简介）' }}</div>
                <div class="card-meta">
                  <span>{{ t.summary.shot_count }} 镜 · {{ formatDuration(t.summary.total_duration_ms) }}</span>
                  <span>已套用 {{ t.use_count }} 次</span>
                  <el-tag v-if="t.signature_status === 'official'" size="small" type="primary" effect="plain">官方</el-tag>
                  <el-tag v-else size="small" type="info" effect="plain">{{ sourceLabel(t.source) }}</el-tag>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside class="detail">
          <div v-if="!selected" class="empty">点一张卡片查看详情</div>
          <template v-else>
            <div class="detail-head">
              <h2>{{ selected.name }}</h2>
              <el-tag size="small" :type="tierLabel(selected.tier).type">{{ tierLabel(selected.tier).label }}</el-tag>
              <span class="muted">v{{ selected.version }} · {{ sourceLabel(selected.source) }} · {{ signatureLabel(selected.signature_status).label }}</span>
            </div>
            <p class="detail-desc">{{ selected.description }}</p>

            <h3>套用后会得到</h3>
            <ul class="lines" data-test="summary-lines">
              <li v-for="(l, i) in lines" :key="i">{{ l }}</li>
            </ul>

            <h3>估价（每镜一张图 + 一段视频）</h3>
            <div v-if="estimateLoading" class="muted">计算中…</div>
            <div v-else-if="estimate" class="estimate">
              <div class="estimate-total" data-test="estimate-total">{{ estimateText(estimate) }}</div>
              <div v-if="!estimate.provider_ready" class="muted">尚未配置可用的服务商 Key，估价按默认模型计算；生成前请先在「AI 配置」里填写。</div>
              <div v-if="estimate.check && !estimate.check.ok" class="warn">{{ estimate.check.message }}</div>
              <el-collapse>
                <el-collapse-item title="逐镜明细">
                  <el-table :data="estimate.items" size="small" max-height="260">
                    <el-table-column label="#" width="44"><template #default="{ row }">{{ row.index + 1 }}</template></el-table-column>
                    <el-table-column prop="title" label="镜头" min-width="110" />
                    <el-table-column label="时长" width="70"><template #default="{ row }">{{ row.seconds }}s</template></el-table-column>
                    <el-table-column label="出图" min-width="120"><template #default="{ row }">{{ row.image.model || '默认' }} · {{ money(row.image.estimate) }}</template></el-table-column>
                    <el-table-column label="视频" min-width="130"><template #default="{ row }">{{ row.video.model || '默认' }} · {{ money(row.video.estimate) }}</template></el-table-column>
                    <el-table-column label="小计" width="90" align="right"><template #default="{ row }">{{ money(row.subtotal) }}</template></el-table-column>
                  </el-table>
                </el-collapse-item>
              </el-collapse>
            </div>

            <h3>镜头</h3>
            <ol class="shots">
              <li v-for="(s, i) in (selected.manifest ? selected.manifest.shots : [])" :key="i">
                <span class="shot-title">{{ s.title }}</span>
                <span class="muted">{{ formatDuration(s.duration_ms) }}<template v-if="s.camera"> · {{ s.camera }}</template><template v-if="s.group"> · {{ s.group }}</template></span>
              </li>
            </ol>

            <div class="actions">
              <el-tooltip :disabled="applyable.ok" :content="applyable.reason" placement="top">
                <span>
                  <el-button type="primary" :disabled="!applyable.ok" data-test="apply-open" @click="openApply">一键套用</el-button>
                </span>
              </el-tooltip>
              <el-button v-if="selected.source !== 'builtin'" type="danger" plain @click="removeSelected">删除模板</el-button>
            </div>
          </template>
        </aside>
      </div>
    </main>

    <!-- 一键套用 -->
    <el-dialog v-model="applyDialog" title="一键套用" width="640px" :close-on-click-modal="false">
      <el-form label-width="96px">
        <el-form-item label="套用到">
          <el-radio-group v-model="form.mode" @change="onModeChange">
            <el-radio value="new">新项目</el-radio>
            <el-radio value="episode">已有项目的下一集</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="form.mode === 'new' ? '项目名称' : '本集标题'">
          <el-input v-model="form.title" maxlength="200" :placeholder="selected ? selected.name : ''" />
        </el-form-item>
        <el-form-item :label="form.mode === 'new' ? '沿用角色自' : '项目'">
          <el-select v-model="form.dramaId" filterable :placeholder="form.mode === 'new' ? '可选：从已有项目沿用角色' : '选择项目'" clearable style="width: 100%" @change="loadCharacters">
            <el-option v-for="d in dramas" :key="d.id" :label="d.title || `项目 ${d.id}`" :value="d.id" />
          </el-select>
        </el-form-item>
        <template v-if="slots.length">
          <el-divider content-position="left">角色槽位映射</el-divider>
          <div class="muted slot-hint">映射到已有角色会沿用它锁定的参考图；留空则按模板描述新建占位角色。</div>
          <el-form-item v-for="s in slots" :key="s.id" :label="s.name">
            <el-select v-model="form.map[s.id]" clearable filterable placeholder="新建占位角色" style="width: 100%" :disabled="!characterOpts.length" :data-test="'slot-' + s.id">
              <el-option v-for="o in characterOpts" :key="o.id" :label="o.label" :value="o.id" />
            </el-select>
            <div v-if="s.description" class="muted small">{{ s.description }}</div>
          </el-form-item>
          <div v-if="form.dramaId && !characterOpts.length && !charactersLoading" class="muted slot-hint">该项目还没有角色。</div>
        </template>
        <el-alert v-for="(e, i) in mapping.errors" :key="i" type="error" :closable="false" :title="e" />
        <div v-if="estimate" class="muted slot-hint">{{ estimateText(estimate) }}；套用本身不花钱，生成时才计费。</div>
      </el-form>
      <template #footer>
        <el-button @click="applyDialog = false">取消</el-button>
        <el-button type="primary" :loading="applying" :disabled="!mapping.ok || (form.mode === 'episode' && !form.dramaId)" data-test="apply-confirm" @click="doApply">套用</el-button>
      </template>
    </el-dialog>

    <!-- 从文件安装 -->
    <el-dialog v-model="installDialog" title="从文件安装模板" width="520px">
      <el-form label-width="80px">
        <el-form-item label="路径">
          <el-input v-model="installPath" placeholder="含 manifest.json 的目录，或 .lytpl 压缩包的本机路径" />
        </el-form-item>
        <div class="muted small">带官方签名的模板会用云端公钥验签；签名无效将拒绝安装，没有签名的按「未签名」安装。</div>
      </el-form>
      <template #footer>
        <el-button @click="installDialog = false">取消</el-button>
        <el-button type="primary" :loading="installing" :disabled="!installPath.trim()" @click="doInstall">安装</el-button>
      </template>
    </el-dialog>

    <!-- 云端目录 -->
    <el-dialog v-model="cloudDialog" title="云端模板" width="720px">
      <div v-if="cloudError" class="warn">{{ cloudError }}</div>
      <el-table v-else :data="cloudItems" size="small" empty-text="云端暂无已发布的模板">
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column label="类型" width="100"><template #default="{ row }">{{ genreLabel(row.genre) }}</template></el-table-column>
        <el-table-column label="档位" width="70"><template #default="{ row }"><el-tag size="small" :type="tierLabel(row.tier).type">{{ tierLabel(row.tier).label }}</el-tag></template></el-table-column>
        <el-table-column prop="version" label="版本" width="80" />
        <el-table-column label="镜头" width="70"><template #default="{ row }">{{ row.summary.shot_count }}</template></el-table-column>
        <el-table-column label="状态" width="150"><template #default="{ row }"><el-tag size="small" :type="cloudItemState(row).type">{{ cloudItemState(row).label }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button link type="primary" :loading="installingCloud === row.id" @click="installCloud(row)">{{ cloudItemState(row).action }}</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { templatesAPI } from '@/api/templates'
import { dramaAPI } from '@/api/drama'
import { referenceLocksAPI } from '@/api/referenceLocks'
import { formatMoney } from '@/utils/spendView'
import {
  applyBody, applyTarget, canApply, characterOptions, cloudItemState, estimateText, formatDuration, genreLabel, groupByGenre,
  signatureLabel, sourceLabel, summaryLines, tierLabel, validateSlotMapping,
} from '@/utils/templateMarket'

const router = useRouter()
const loading = ref(false)
const items = ref([])
const proAvailable = ref(false)
const proReason = ref('')
const selected = ref(null)
const estimate = ref(null)
const estimateLoading = ref(false)

const groups = computed(() => groupByGenre(items.value))
const hasPro = computed(() => items.value.some((t) => t.tier === 'pro'))
const lines = computed(() => summaryLines(selected.value && selected.value.summary))
const applyable = computed(() => canApply(selected.value, proAvailable.value, proReason.value))
const money = (v) => formatMoney(v, estimate.value ? estimate.value.currency : 'CNY')
const goList = () => router.push('/')

async function load() {
  loading.value = true
  try {
    const r = await templatesAPI.list()
    items.value = r.items || []
    proAvailable.value = !!r.pro_available
    proReason.value = r.pro_reason || ''
    if (selected.value) {
      const again = items.value.find((t) => t.id === selected.value.id)
      if (again) selected.value = { ...selected.value, ...again }
      else selected.value = null
    }
  } catch (_) {
    items.value = []
  } finally {
    loading.value = false
  }
}

async function select(t) {
  selected.value = t
  estimate.value = null
  estimateLoading.value = true
  try {
    const [full, est] = await Promise.all([templatesAPI.get(t.id), templatesAPI.estimate(t.id)])
    if (selected.value && selected.value.id === t.id) {
      selected.value = full
      estimate.value = est
    }
  } catch (_) {
    /* 请求层已提示 */
  } finally {
    estimateLoading.value = false
  }
}

// ---- 套用 ----
const applyDialog = ref(false)
const applying = ref(false)
const dramas = ref([])
const characters = ref([])
const locks = ref([])
const charactersLoading = ref(false)
const form = reactive({ mode: 'new', title: '', dramaId: null, map: {} })
const slots = computed(() => (selected.value && selected.value.summary ? selected.value.summary.slots : []))
const characterOpts = computed(() => characterOptions(characters.value, locks.value))
const mapping = computed(() => validateSlotMapping(slots.value, form.map, characterOpts.value))

async function openApply() {
  if (!selected.value) return
  form.mode = 'new'
  form.title = ''
  form.dramaId = null
  form.map = Object.fromEntries(slots.value.map((s) => [s.id, null]))
  characters.value = []
  locks.value = []
  applyDialog.value = true
  try {
    const r = await dramaAPI.list({ page: 1, page_size: 100 })
    dramas.value = r?.items ?? []
  } catch (_) {
    dramas.value = []
  }
}

function onModeChange() {
  form.dramaId = null
  characters.value = []
  locks.value = []
  form.map = Object.fromEntries(slots.value.map((s) => [s.id, null]))
}

async function loadCharacters() {
  characters.value = []
  locks.value = []
  form.map = Object.fromEntries(slots.value.map((s) => [s.id, null]))
  if (!form.dramaId) return
  charactersLoading.value = true
  try {
    const d = await dramaAPI.get(form.dramaId)
    characters.value = (d && d.characters) || []
    const ids = characters.value.map((c) => c.id)
    locks.value = ids.length ? (await referenceLocksAPI.list('character', ids)) || [] : []
  } catch (_) {
    /* 请求层已提示 */
  } finally {
    charactersLoading.value = false
  }
}

async function doApply() {
  if (!selected.value || !mapping.value.ok) return
  applying.value = true
  try {
    const r = await templatesAPI.apply(selected.value.id, applyBody({ mode: form.mode, dramaId: form.dramaId, title: form.title, map: form.map }))
    applyDialog.value = false
    ElMessage.success(`已套用「${selected.value.name}」：${r.shots} 个镜头，${r.characters.filter((c) => c.mapped).length} 个角色沿用已有角色`)
    router.push(applyTarget(r))
  } catch (_) {
    /* 请求层已提示（付费模板 / 校验错误） */
  } finally {
    applying.value = false
  }
}

async function removeSelected() {
  if (!selected.value) return
  try {
    await ElMessageBox.confirm(`删除模板「${selected.value.name}」？已套用的项目不受影响。`, '删除模板', { type: 'warning' })
  } catch (_) {
    return
  }
  try {
    await templatesAPI.remove(selected.value.id)
    selected.value = null
    estimate.value = null
    await load()
  } catch (_) { /* 请求层已提示 */ }
}

// ---- 安装 ----
const installDialog = ref(false)
const installPath = ref('')
const installing = ref(false)

async function doInstall() {
  installing.value = true
  try {
    const r = await templatesAPI.install({ path: installPath.value.trim() })
    installDialog.value = false
    installPath.value = ''
    ElMessage.success(r.signature_status === 'official' ? `已安装官方模板「${r.name}」` : `已安装「${r.name}」（${signatureLabel(r.signature_status).label}）`)
    await load()
    const t = items.value.find((x) => x.id === r.id)
    if (t) select(t)
  } catch (_) { /* 请求层已提示 */ } finally {
    installing.value = false
  }
}

// ---- 云端目录 ----
const cloudDialog = ref(false)
const cloudLoading = ref(false)
const cloudItems = ref([])
const cloudError = ref('')
const installingCloud = ref(null)

async function openCloud() {
  cloudLoading.value = true
  cloudError.value = ''
  try {
    const r = await templatesAPI.cloud()
    cloudItems.value = r.items || []
    cloudDialog.value = true
  } catch (e) {
    cloudError.value = (e && e.message) || '无法获取云端模板'
    cloudDialog.value = true
  } finally {
    cloudLoading.value = false
  }
}

async function installCloud(row) {
  installingCloud.value = row.id
  try {
    const r = await templatesAPI.install({ manifest: row.manifest, source: 'cloud' })
    ElMessage.success(`已安装「${r.name}」（${signatureLabel(r.signature_status).label}）`)
    row.installed = true
    row.installed_version = r.version
    await load()
  } catch (_) { /* 请求层已提示 */ } finally {
    installingCloud.value = null
  }
}

watch(applyDialog, (open) => { if (!open) applying.value = false })
onMounted(load)
</script>

<style scoped>
.template-market { min-height: 100vh; background: var(--el-bg-color-page, #f5f7fa); }
.header { background: var(--el-bg-color, #fff); border-bottom: 1px solid var(--el-border-color-light, #e4e7ed); }
.header-inner { max-width: 1280px; margin: 0 auto; padding: 12px 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.logo { margin: 0; font-size: 20px; cursor: pointer; }
.btn-back { margin-left: auto; }
.main { max-width: 1280px; margin: 0 auto; padding: 16px 20px 40px; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 420px; gap: 16px; margin-top: 12px; }
@media (max-width: 960px) { .layout { grid-template-columns: 1fr; } }
.genre { margin-bottom: 18px; }
.genre-title { font-size: 16px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
.genre-count { font-size: 12px; color: var(--el-text-color-secondary); font-weight: normal; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.card { background: var(--el-bg-color, #fff); border: 1px solid var(--el-border-color-light, #e4e7ed); border-radius: 8px; padding: 12px; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.card:hover { border-color: var(--el-color-primary-light-5); }
.card.active { border-color: var(--el-color-primary); box-shadow: 0 0 0 2px var(--el-color-primary-light-8); }
.card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-name { font-weight: 600; }
.card-desc { font-size: 12px; color: var(--el-text-color-regular); margin: 6px 0 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-meta { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--el-text-color-secondary); flex-wrap: wrap; }
.detail { background: var(--el-bg-color, #fff); border: 1px solid var(--el-border-color-light, #e4e7ed); border-radius: 8px; padding: 16px; align-self: start; position: sticky; top: 12px; }
.detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.detail-head h2 { margin: 0; font-size: 18px; }
.detail-desc { color: var(--el-text-color-regular); font-size: 13px; }
.detail h3 { font-size: 14px; margin: 14px 0 6px; }
.lines { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.7; }
.estimate-total { font-weight: 600; margin-bottom: 4px; }
.shots { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.7; max-height: 220px; overflow: auto; }
.shot-title { margin-right: 6px; }
.actions { display: flex; gap: 8px; margin-top: 16px; }
.empty { color: var(--el-text-color-secondary); padding: 24px; text-align: center; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.small { font-size: 12px; }
.warn { color: var(--el-color-danger); font-size: 12px; margin: 4px 0; }
.slot-hint { margin: 0 0 8px; }
</style>
