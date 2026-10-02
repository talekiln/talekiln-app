<template>
  <div class="st-page" data-test="studio-page">
    <header class="st-header">
      <el-button size="small" @click="$router.back()">
        <el-icon><ArrowLeft /></el-icon> 返回
      </el-button>
      <h1>工作室</h1>
      <div class="st-spacer" />
      <el-button size="small" :loading="loading" data-test="refresh" @click="reloadAll(true)">同步</el-button>
    </header>

    <section class="st-card" data-test="status-card">
      <el-alert :type="summary.tone" :closable="false" show-icon :title="summary.text" />
      <div v-if="!account.loggedIn" class="st-actions">
        <el-button type="primary" size="small" @click="$router.push({ name: 'login' })">去登录</el-button>
      </div>
    </section>

    <!-- 我所在的工作室 / 创建 / 接受邀请 -->
    <section v-if="account.loggedIn" class="st-card" data-test="identity-card">
      <h2 class="st-card-title">我的工作室</h2>
      <div class="st-row-inline">
        <el-select v-if="studios.length" v-model="currentId" placeholder="选择工作室" style="min-width: 320px" data-test="studio-select" @change="switchStudio">
          <el-option v-for="o in studioOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-input v-model="newName" placeholder="新工作室名称" maxlength="60" style="width: 220px" data-test="new-name" />
        <el-button size="small" :loading="busy.create" @click="createStudio">创建工作室</el-button>
        <el-input v-model="inviteCode" placeholder="邀请码" style="width: 180px" data-test="invite-code" />
        <el-button size="small" :loading="busy.accept" @click="acceptInvite">接受邀请</el-button>
      </div>
      <p class="st-note">{{ SEAT_NOTE }}</p>
    </section>

    <!-- 成员与席位 -->
    <section v-if="account.loggedIn && current" class="st-card" data-test="members-card">
      <div class="st-card-head">
        <h2 class="st-card-title">{{ current.name }} · 成员与席位</h2>
        <div class="st-spacer" />
        <el-tag size="small" :type="seats.tone" effect="plain">{{ seats.text }}</el-tag>
        <el-tag size="small" effect="plain">我是{{ roleLabel(current.my_role) }}</el-tag>
      </div>
      <el-progress :percentage="seats.percent" :status="seats.tone === 'danger' ? 'exception' : seats.tone === 'warning' ? 'warning' : 'success'" :show-text="false" />
      <el-alert v-if="detailError" type="error" :closable="false" show-icon :title="detailError" class="st-gap" />
      <div v-for="m in memberRows" :key="m.account_id" class="st-row" data-test="member-row">
        <div class="st-main">
          <div class="st-title">{{ m.email || m.account_id }} <span v-if="m.self" class="st-dim">（我）</span></div>
          <div class="st-meta"><span>{{ m.roleLabel }}</span><span>加入于 {{ m.joinedText }}</span></div>
        </div>
        <el-select v-if="m.canChangeRole" :model-value="m.role" size="small" style="width: 110px" @change="(r) => changeRole(m, r)">
          <el-option v-for="o in ROLE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-button v-if="m.canRemove" size="small" type="danger" plain :loading="busy[`rm:${m.account_id}`]" @click="removeMember(m)">{{ m.removeLabel }}</el-button>
      </div>

      <template v-if="canManage">
        <h3 class="st-sub">邀请成员</h3>
        <div class="st-row-inline">
          <el-input v-model="inviteForm.email" placeholder="邮箱（可留空：凭邀请码任何人可加入）" style="width: 280px" data-test="invite-email" />
          <el-select v-model="inviteForm.role" style="width: 120px">
            <el-option v-for="o in ROLE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-input-number v-model="inviteForm.expiresInDays" :min="1" :max="90" size="small" /> 天
          <el-button size="small" type="primary" :disabled="seats.full" :loading="busy.invite" @click="sendInvite">生成邀请码</el-button>
          <span v-if="seats.full" class="st-hint warn">席位已满，先调整席位数或撤销待处理邀请</span>
        </div>
        <div v-for="i in detail.invites || []" :key="i.id" class="st-row" data-test="invite-row">
          <div class="st-main">
            <div class="st-title"><code>{{ i.code }}</code> <span class="st-dim">{{ i.email || '任何人' }} · {{ roleLabel(i.role) }}</span></div>
            <div class="st-meta"><span>有效期至 {{ formatDate(i.expires_at) }}</span></div>
          </div>
          <el-button size="small" @click="copy(i.code)">复制</el-button>
          <el-button size="small" type="danger" plain @click="revokeInvite(i)">撤销</el-button>
        </div>
      </template>
    </section>

    <!-- 共享库 -->
    <section v-if="account.loggedIn && current" class="st-card" data-test="shared-card">
      <div class="st-card-head">
        <h2 class="st-card-title">共享库</h2>
        <el-radio-group v-model="kind" size="small" @change="loadShared">
          <el-radio-button value="characters">共享角色</el-radio-button>
          <el-radio-button value="templates">共享模板</el-radio-button>
        </el-radio-group>
        <div class="st-spacer" />
        <el-button size="small" :loading="sharedLoading" @click="loadShared">刷新</el-button>
      </div>
      <p class="st-note">{{ STORAGE_NOTE }}</p>
      <el-alert v-if="sharedError" :type="sharedErrorTone" :closable="false" show-icon :title="sharedError" class="st-gap">
        <el-button v-if="sharedErrorCode === 'BACKUP_NOT_CONFIGURED'" size="small" link type="primary" @click="$router.push({ name: 'backup' })">去「云备份」页配置对象存储</el-button>
      </el-alert>

      <div v-if="shared.can_publish" class="st-row-inline st-gap" data-test="publish-bar">
        <template v-if="kind === 'characters'">
          <el-select v-model="publishDramaId" placeholder="项目" style="width: 200px" @change="loadCharacters">
            <el-option v-for="d in dramas" :key="d.id" :label="d.title" :value="d.id" />
          </el-select>
          <el-select v-model="publishCharacterId" placeholder="角色" style="width: 220px" :disabled="!publishDramaId">
            <el-option v-for="c in characterOptions" :key="c.value" :label="c.label" :value="c.value" :disabled="!c.hasImage" />
          </el-select>
          <el-button size="small" type="primary" :disabled="!publishCharacterId" :loading="busy.publish" @click="publishCharacter">发布到共享库</el-button>
        </template>
        <template v-else>
          <el-select v-model="publishTemplateId" placeholder="本机模板" style="width: 300px">
            <el-option v-for="t in templates" :key="t.id" :label="`${t.name} · v${t.version}`" :value="t.id" />
          </el-select>
          <el-button size="small" type="primary" :disabled="!publishTemplateId" :loading="busy.publish" @click="publishTemplate">发布到共享库</el-button>
        </template>
      </div>
      <p v-else-if="!sharedError" class="st-hint">普通成员只能拉取；发布与更新需要所有者或管理员。</p>

      <div v-if="!sharedLoading && !rows.length && !sharedError" class="st-empty">共享库里还没有{{ kind === 'characters' ? '角色' : '模板' }}。</div>
      <div v-for="r in rows" :key="r.shared_id" class="st-row" data-test="shared-row">
        <div class="st-main">
          <div class="st-title">{{ r.name }} <el-tag size="small" :type="r.stateType || 'info'" effect="plain">{{ r.stateLabel }}</el-tag></div>
          <div v-if="r.subtitle" class="st-sub-text">{{ r.subtitle }}</div>
          <div class="st-meta"><span v-for="(m, i) in r.meta" :key="i">{{ m }}</span></div>
        </div>
        <el-select v-if="r.needsDrama" v-model="pullDrama[r.shared_id]" placeholder="放到项目" size="small" style="width: 160px">
          <el-option v-for="d in dramas" :key="d.id" :label="d.title" :value="d.id" />
        </el-select>
        <el-button v-for="a in r.actions" :key="a.key" size="small" :type="a.type" :loading="busy[`${a.key}:${r.shared_id}`]" :disabled="r.needsDrama && a.key === 'pull' && !pullDrama[r.shared_id]" @click="runAction(r, a)">{{ a.label }}</el-button>
      </div>
      <p v-if="shared.invalid && shared.invalid.length" class="st-hint warn">有 {{ shared.invalid.length }} 个条目的清单校验失败，已隐藏（可能被改动或来自更新版本的应用）。</p>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { studioAPI } from '@/api/studio'
import { dramaAPI } from '@/api/drama'
import { templatesAPI } from '@/api/templates'
import { useAccountStore } from '@/stores/account'
import {
  ROLE_OPTIONS, SEAT_NOTE, STORAGE_NOTE, characterOption, formatDate, identitySummary, invitePayload, memberRow, normalizeInviteCode, roleLabel,
  seatSummary, sharedRow, studioOption, validateInvite,
} from '@/utils/studioView'

const account = useAccountStore()
const loading = ref(false)
const identity = ref(null)
const currentId = ref(null)
const detail = ref({})
const detailError = ref('')
const newName = ref('')
const inviteCode = ref('')
const inviteForm = reactive({ email: '', role: 'member', expiresInDays: 7 })
const kind = ref('characters')
const shared = ref({ items: [], invalid: [], can_publish: false })
const sharedLoading = ref(false)
const sharedError = ref('')
const sharedErrorCode = ref('')
const dramas = ref([])
const templates = ref([])
const characters = ref([])
const publishDramaId = ref(null)
const publishCharacterId = ref(null)
const publishTemplateId = ref(null)
const pullDrama = reactive({})
const busy = reactive({})

const studios = computed(() => identity.value?.studios || [])
const studioOptions = computed(() => studios.value.map(studioOption))
const current = computed(() => studios.value.find((s) => s.id === currentId.value) || null)
const summary = computed(() => identitySummary(identity.value, { loggedIn: account.loggedIn }))
const seats = computed(() => seatSummary(detail.value.seats || current.value?.seats))
const myEmail = computed(() => account.status?.account?.email || '')
const canManage = computed(() => ['owner', 'admin'].includes(current.value?.my_role))
const memberRows = computed(() => (detail.value.members || []).map((m) => memberRow(m, { myRole: current.value?.my_role, myEmail: myEmail.value })))
const rows = computed(() => (shared.value.items || []).map((i) => sharedRow(i, { canPublish: shared.value.can_publish })))
const characterOptions = computed(() => characters.value.map(characterOption).sort((a, b) => Number(b.hasImage) - Number(a.hasImage)))
const sharedErrorTone = computed(() => (sharedErrorCode.value === 'BACKUP_NOT_CONFIGURED' ? 'warning' : 'error'))

const errText = (e) => (e.action ? `${e.message} ${e.action}` : e.message || '操作失败')

async function reloadAll(sync = false) {
  loading.value = true
  try {
    if (!account.loaded) await account.fetch()
    if (!account.loggedIn) { identity.value = null; return }
    identity.value = await studioAPI.identity(sync)
    currentId.value = identity.value.current_studio_id
    const [list, tpl] = await Promise.all([dramaAPI.list({ page: 1, page_size: 200 }).catch(() => null), templatesAPI.list().catch(() => null)])
    const items = list?.items || list?.data?.items || (Array.isArray(list) ? list : [])
    dramas.value = items.map((d) => ({ id: d.id, title: d.title }))
    templates.value = (tpl?.items || []).map((t) => ({ id: t.id, name: t.name, version: t.version }))
    await Promise.all([loadDetail(), loadShared()])
  } catch (e) {
    ElMessage.error(errText(e))
  } finally {
    loading.value = false
  }
}

async function loadDetail() {
  detailError.value = ''
  if (!currentId.value) { detail.value = {}; return }
  try {
    detail.value = await studioAPI.detail(currentId.value)
  } catch (e) {
    detail.value = {}
    detailError.value = `成员列表加载失败：${errText(e)}`
  }
}

async function loadShared() {
  if (!currentId.value) return
  sharedLoading.value = true
  sharedError.value = ''
  sharedErrorCode.value = ''
  try {
    shared.value = await studioAPI.listShared(currentId.value, kind.value)
  } catch (e) {
    shared.value = { items: [], invalid: [], can_publish: false }
    sharedErrorCode.value = e.code || ''
    sharedError.value = errText(e)
  } finally {
    sharedLoading.value = false
  }
}

async function switchStudio(id) {
  try {
    identity.value = await studioAPI.setCurrent(id)
    currentId.value = id
    await Promise.all([loadDetail(), loadShared()])
  } catch (e) {
    ElMessage.error(errText(e))
  }
}

async function createStudio() {
  const name = newName.value.trim()
  if (!name) return ElMessage.warning('请填写工作室名称')
  busy.create = true
  try {
    const s = await studioAPI.createStudio(name)
    newName.value = ''
    ElMessage.success(`已创建「${s.name}」`)
    await reloadAll(true)
    if (s.id) await switchStudio(s.id)
  } catch (e) {
    ElMessage.error(errText(e))
  } finally {
    busy.create = false
  }
}

async function acceptInvite() {
  const code = normalizeInviteCode(inviteCode.value)
  if (!code) return ElMessage.warning('请输入邀请码')
  busy.accept = true
  try {
    const r = await studioAPI.accept(code)
    inviteCode.value = ''
    ElMessage.success(`已加入「${r.studio?.name || '工作室'}」`)
    await reloadAll(true)
    if (r.studio?.id) await switchStudio(r.studio.id)
  } catch (e) {
    ElMessage.error(errText(e))
  } finally {
    busy.accept = false
  }
}

async function sendInvite() {
  const errs = validateInvite(inviteForm)
  if (Object.keys(errs).length) return ElMessage.warning(Object.values(errs)[0])
  busy.invite = true
  try {
    const inv = await studioAPI.invite(currentId.value, invitePayload(inviteForm))
    inviteForm.email = ''
    ElMessage.success(`邀请码 ${inv.code} 已生成`)
    await Promise.all([loadDetail(), reloadIdentityQuiet()])
  } catch (e) {
    ElMessage.error(errText(e))
  } finally {
    busy.invite = false
  }
}

async function reloadIdentityQuiet() {
  try { identity.value = await studioAPI.identity(true) } catch (_) { /* 离线时保留原状 */ }
}

async function revokeInvite(i) {
  try {
    await studioAPI.revokeInvite(currentId.value, i.id)
    await Promise.all([loadDetail(), reloadIdentityQuiet()])
  } catch (e) {
    ElMessage.error(errText(e))
  }
}

async function removeMember(m) {
  try {
    await ElMessageBox.confirm(m.self ? `确定退出「${current.value.name}」？` : `确定移除 ${m.email || m.account_id}？`, m.removeLabel, { type: 'warning' })
  } catch (_) { return }
  busy[`rm:${m.account_id}`] = true
  try {
    await studioAPI.removeMember(currentId.value, m.account_id)
    ElMessage.success(m.self ? '已退出' : '已移除')
    await reloadAll(true)
  } catch (e) {
    ElMessage.error(errText(e))
  } finally {
    busy[`rm:${m.account_id}`] = false
  }
}

async function changeRole(m, role) {
  try {
    await studioAPI.setRole(currentId.value, m.account_id, role)
    ElMessage.success(`${m.email || m.account_id} 现在是${roleLabel(role)}`)
    await loadDetail()
  } catch (e) {
    ElMessage.error(errText(e))
  }
}

async function loadCharacters() {
  publishCharacterId.value = null
  characters.value = []
  if (!publishDramaId.value) return
  try {
    const r = await studioAPI.dramaCharacters(publishDramaId.value)
    characters.value = Array.isArray(r) ? r : r?.items || r?.characters || []
  } catch (_) { characters.value = [] }
}

async function publishCharacter() {
  busy.publish = true
  try {
    const r = await studioAPI.publishCharacter(currentId.value, publishCharacterId.value)
    ElMessage.success(`已发布 v${r.version}（${r.files.length} 张图${r.skipped?.length ? `，跳过 ${r.skipped.length} 张远程 / 缺失图片` : ''}）`)
    await loadShared()
  } catch (e) {
    ElMessage.error(errText(e))
  } finally {
    busy.publish = false
  }
}

async function publishTemplate() {
  busy.publish = true
  try {
    const r = await studioAPI.publishTemplate(currentId.value, publishTemplateId.value)
    ElMessage.success(`模板已发布 v${r.version}`)
    await loadShared()
  } catch (e) {
    ElMessage.error(errText(e))
  } finally {
    busy.publish = false
  }
}

async function runAction(row, a) {
  const key = `${a.key}:${row.shared_id}`
  busy[key] = true
  try {
    if (a.key === 'republish') {
      const r = row.kind === 'template' ? await studioAPI.publishTemplate(currentId.value, row.published_local_id) : await studioAPI.publishCharacter(currentId.value, Number(row.published_local_id))
      ElMessage.success(`已重新发布 v${r.version}`)
    } else if (row.kind === 'template') {
      const r = await studioAPI.pullTemplate(currentId.value, row.shared_id)
      ElMessage.success(`模板「${r.template?.name || row.name}」已安装到本机`)
    } else {
      const r = await studioAPI.pullCharacter(currentId.value, row.shared_id, a.key === 'pull' ? pullDrama[row.shared_id] : undefined)
      ElMessage.success(r.updated ? `已更新本机角色（${r.files.length} 张图）` : `已拉取为新角色（${r.files.length} 张图），参考图已锁定`)
    }
    await loadShared()
  } catch (e) {
    ElMessage.error(errText(e))
  } finally {
    busy[key] = false
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); ElMessage.success('已复制') } catch (_) { ElMessage.info(text) }
}

onMounted(() => reloadAll(false))
</script>

<style scoped>
.st-page { max-width: 920px; margin: 0 auto; padding: 16px; color: var(--text-primary); }
.st-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.st-header h1 { margin: 0; font-size: 18px; color: var(--text-bright); }
.st-spacer { flex: 1; }
.st-card { padding: 12px 16px; border-radius: 12px; border: 1px solid var(--el-border-color); background: var(--el-bg-color); margin-bottom: 12px; }
.st-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.st-card-head .st-card-title { margin: 0; }
.st-card-title { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.st-sub { margin: 14px 0 6px; font-size: 13px; font-weight: 600; }
.st-note, .st-hint { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; margin: 6px 0; }
.st-hint.warn, .warn { color: var(--el-color-warning); }
.st-row-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.st-actions { margin-top: 8px; }
.st-gap { margin-top: 8px; }
.st-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.st-row:last-child { border-bottom: none; }
.st-main { flex: 1; min-width: 0; }
.st-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.st-sub-text { font-size: 12px; color: var(--el-text-color-regular); margin-top: 2px; }
.st-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; font-size: 12px; color: var(--el-text-color-secondary); }
.st-dim { color: var(--el-text-color-secondary); font-weight: 400; }
.st-empty { padding: 18px 0; text-align: center; font-size: 13px; color: var(--el-text-color-secondary); }
</style>
