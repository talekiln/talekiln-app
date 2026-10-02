<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-title">账号登录</h1>
      <p class="login-sub">使用邀请码注册，或用已有账号登录</p>

      <el-alert v-if="reasonText" type="warning" :closable="false" show-icon :title="reasonText" class="login-alert" />
      <el-alert
        v-if="status && status.configured === false"
        type="info"
        :closable="false"
        show-icon
        title="尚未配置云端地址，登录暂不可用"
        description="请在 config.yaml 中设置 cloud.base_url（或环境变量 TALEKILN_CLOUD_URL）"
        class="login-alert"
      />
      <el-alert v-if="status && status.logged_in" type="success" :closable="false" show-icon class="login-alert">
        <template #title>
          当前账号：{{ accountDisplayName(status.account) }}（{{ account.summary.label }}）
        </template>
      </el-alert>

      <el-tabs v-model="tab" class="login-tabs" @tab-change="onTabChange">
        <el-tab-pane label="登录" name="login">
          <el-form :model="loginForm" label-position="top" @submit.prevent="submitLogin">
            <el-form-item label="邮箱" :error="fieldErrors.email">
              <el-input v-model="loginForm.email" autocomplete="username" placeholder="name@example.com" />
            </el-form-item>
            <el-form-item label="密码" :error="fieldErrors.password">
              <el-input v-model="loginForm.password" type="password" show-password autocomplete="current-password" placeholder="请输入密码" />
            </el-form-item>
            <el-alert v-if="serverError" type="error" :closable="false" show-icon :title="serverError" class="login-alert" />
            <el-button type="primary" native-type="submit" :loading="busy" class="login-submit">登录</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="邀请码注册" name="register">
          <el-form :model="regForm" label-position="top" @submit.prevent="submitRegister">
            <el-form-item label="邀请码" :error="fieldErrors.inviteCode">
              <el-input v-model="regForm.inviteCode" autocomplete="off" placeholder="请输入邀请码" />
            </el-form-item>
            <el-form-item label="邮箱（作为登录名）" :error="fieldErrors.email">
              <el-input v-model="regForm.email" autocomplete="username" placeholder="name@example.com" />
            </el-form-item>
            <el-form-item label="密码（至少 8 位）" :error="fieldErrors.password">
              <el-input v-model="regForm.password" type="password" show-password autocomplete="new-password" placeholder="设置密码" />
            </el-form-item>
            <el-form-item label="确认密码" :error="fieldErrors.confirm">
              <el-input v-model="regForm.confirm" type="password" show-password autocomplete="new-password" placeholder="再次输入密码" />
            </el-form-item>
            <el-alert v-if="serverError" type="error" :closable="false" show-icon :title="serverError" class="login-alert" />
            <el-button type="primary" native-type="submit" :loading="busy" class="login-submit">注册并登录</el-button>
          </el-form>
        </el-tab-pane>

        <!-- P2-C：手机验证码 -->
        <el-tab-pane label="手机验证码" name="sms">
          <el-form :model="smsForm" label-position="top" @submit.prevent="submitSms">
            <el-form-item label="手机号" :error="fieldErrors.phone">
              <el-input v-model="smsForm.phone" autocomplete="tel" inputmode="numeric" placeholder="11 位大陆手机号" maxlength="20" />
            </el-form-item>
            <el-form-item label="验证码" :error="fieldErrors.code">
              <div class="sms-row">
                <el-input v-model="smsForm.code" autocomplete="one-time-code" inputmode="numeric" placeholder="短信验证码" maxlength="8" />
                <el-button :disabled="smsButton.disabled" :loading="smsSending" @click="sendSms">{{ smsButton.text }}</el-button>
              </div>
            </el-form-item>
            <el-alert
              v-if="smsDebugCode"
              type="info"
              :closable="false"
              show-icon
              :title="`开发模式：模拟短信验证码 ${smsDebugCode}`"
              class="login-alert"
            />
            <el-form-item v-if="smsNeedInvite" label="邀请码（首次登录需要）" :error="fieldErrors.inviteCode">
              <el-input v-model="smsForm.inviteCode" autocomplete="off" placeholder="请输入邀请码" />
            </el-form-item>
            <el-alert v-if="serverError" type="error" :closable="false" show-icon :title="serverError" class="login-alert" />
            <el-button type="primary" native-type="submit" :loading="busy" class="login-submit">登录</el-button>
          </el-form>
        </el-tab-pane>

        <!-- P2-C：微信扫码 -->
        <el-tab-pane label="微信扫码" name="wechat">
          <div class="qr-box">
            <div class="qr-canvas" :class="{ 'qr-dim': qrStatus !== 'pending' && qrStatus !== 'scanned' }">
              <svg v-if="qrPath" :viewBox="`0 0 ${qrSize} ${qrSize}`" shape-rendering="crispEdges" class="qr-svg" role="img" aria-label="微信登录二维码">
                <rect :width="qrSize" :height="qrSize" fill="#fff" />
                <path :d="qrPath" fill="#111" />
              </svg>
              <div v-else class="qr-empty" />
              <el-button
                v-if="qrStatus === 'expired' || qrStatus === 'error'"
                class="qr-refresh"
                type="primary"
                size="small"
                @click="startWechat"
              >刷新二维码</el-button>
            </div>
            <p class="qr-title" :class="`qr-${qrText.tone}`">{{ qrText.title }}</p>
            <p v-if="qrText.hint" class="qr-hint">{{ qrText.hint }}</p>
            <p v-if="qrStatus === 'pending' || qrStatus === 'scanned'" class="qr-hint qr-note">当前为占位二维码（未接入真实微信开放平台）</p>

            <el-form v-if="qrStatus === 'need_invite'" :model="wxForm" label-position="top" @submit.prevent="submitWechatInvite">
              <el-form-item label="邀请码" :error="fieldErrors.inviteCode">
                <el-input v-model="wxForm.inviteCode" autocomplete="off" placeholder="请输入邀请码" />
              </el-form-item>
              <el-button type="primary" native-type="submit" :loading="busy" class="login-submit">完成注册并登录</el-button>
            </el-form>

            <el-alert v-if="serverError" type="error" :closable="false" show-icon :title="serverError" class="login-alert" />

            <div v-if="canSimulate && qr && (qrStatus === 'pending' || qrStatus === 'scanned')" class="qr-simulate">
              <el-button size="small" @click="simulateConfirm(true)">模拟扫码</el-button>
              <el-button size="small" type="success" @click="simulateConfirm(false)">模拟确认</el-button>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>

      <div class="login-footer">
        <el-button v-if="status && status.logged_in" link type="danger" @click="doLogout">退出登录</el-button>
        <el-button v-if="!(status && status.require_login) || (status && status.entitled)" link @click="goBack">
          {{ status && status.logged_in ? '返回' : '暂不登录，先看看' }}
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAccountStore } from '@/stores/account'
import { accountAPI } from '@/api/account'
import {
  validateLogin,
  validateRegister,
  accountErrorMessage,
  accountErrorCode,
  loginReasonText,
  safeRedirect
} from '@/utils/account'
import {
  validateSmsLogin,
  smsButtonState,
  countdownLeft,
  needsInvite,
  qrStatusText,
  qrPollDecision,
  showSimulateConfirm,
  accountDisplayName,
  placeholderMatrix,
  matrixToPath,
  QR_POLL_MS
} from '@/utils/loginView'

const route = useRoute()
const router = useRouter()
const account = useAccountStore()

const tab = ref('login')
const busy = ref(false)
const serverError = ref('')
const fieldErrors = reactive({})
const loginForm = reactive({ email: '', password: '' })
const regForm = reactive({ inviteCode: '', email: '', password: '', confirm: '' })

// P2-C：手机验证码
const smsForm = reactive({ phone: '', code: '', inviteCode: '' })
const smsSending = ref(false)
const smsSentAt = ref(0)
const smsNow = ref(Date.now())
const smsDebugCode = ref('')
const smsNeedInvite = ref(false)
let smsTimer = null
const smsSecondsLeft = computed(() => countdownLeft(smsSentAt.value, smsNow.value))
const smsButton = computed(() => smsButtonState({ secondsLeft: smsSecondsLeft.value, phone: smsForm.phone, sending: smsSending.value }))

// P2-C：微信扫码
const qr = ref(null) // { ticket, qr_url, expires_in, simulated }
const qrStatus = ref('idle') // idle | pending | scanned | confirmed | need_invite | expired | error | unavailable
const wxForm = reactive({ inviteCode: '' })
const qrSize = 25
let qrTimer = null
let qrStartedAt = 0
const qrText = computed(() => qrStatusText(qrStatus.value))
const qrPath = computed(() => (qr.value ? matrixToPath(placeholderMatrix(qr.value.qr_url, qrSize)) : ''))
const canSimulate = computed(() => showSimulateConfirm({ dev: Boolean(import.meta.env.DEV), qr: qr.value }))

const status = computed(() => account.status)
const reasonText = computed(() => loginReasonText(String(route.query.reason || '')))

function clearErrors() {
  serverError.value = ''
  for (const k of Object.keys(fieldErrors)) delete fieldErrors[k]
}

function onTabChange(name) {
  clearErrors()
  if (name === 'wechat') {
    if (!qr.value || qrStatus.value === 'expired' || qrStatus.value === 'error') startWechat()
  } else {
    stopQrPolling()
  }
}

// ---- 手机验证码
function tickSms() {
  smsNow.value = Date.now()
  if (smsSecondsLeft.value <= 0 && smsTimer) {
    clearInterval(smsTimer)
    smsTimer = null
  }
}

async function sendSms() {
  const v = validateSmsLogin({ phone: smsForm.phone, code: '0000' })
  if (v.errors.phone) return applyFieldErrors({ phone: v.errors.phone })
  clearErrors()
  smsSending.value = true
  try {
    const r = await accountAPI.smsSend({ phone: smsForm.phone.replace(/[\s-]/g, '') })
    smsSentAt.value = Date.now()
    smsNow.value = smsSentAt.value
    smsDebugCode.value = import.meta.env.DEV && r && r.debug_code ? String(r.debug_code) : ''
    if (!smsTimer) smsTimer = setInterval(tickSms, 500)
    ElMessage.success('验证码已发送')
  } catch (e) {
    serverError.value = accountErrorMessage(e)
  } finally {
    smsSending.value = false
  }
}

async function submitSms() {
  const v = validateSmsLogin({ ...smsForm, needInvite: smsNeedInvite.value })
  if (!v.ok) return applyFieldErrors(v.errors)
  clearErrors()
  busy.value = true
  try {
    await account.loginBySms(smsForm)
    smsForm.code = ''
    smsDebugCode.value = ''
    afterSuccess('登录成功')
  } catch (e) {
    if (needsInvite(accountErrorCode(e))) {
      smsNeedInvite.value = true
      fieldErrors.inviteCode = '首次登录需要邀请码'
    } else {
      serverError.value = accountErrorMessage(e)
    }
  } finally {
    busy.value = false
  }
}

// ---- 微信扫码
function stopQrPolling() {
  if (qrTimer) clearTimeout(qrTimer)
  qrTimer = null
}

async function startWechat() {
  stopQrPolling()
  clearErrors()
  qr.value = null
  qrStatus.value = 'idle'
  wxForm.inviteCode = ''
  try {
    qr.value = await accountAPI.wechatQr()
    qrStatus.value = 'pending'
    qrStartedAt = Date.now()
    scheduleQrPoll()
  } catch (e) {
    qrStatus.value = accountErrorCode(e) === 'LOGIN_METHOD_UNAVAILABLE' ? 'unavailable' : 'error'
    serverError.value = accountErrorMessage(e)
  }
}

function scheduleQrPoll() {
  stopQrPolling()
  qrTimer = setTimeout(pollQr, QR_POLL_MS)
}

async function pollQr() {
  if (!qr.value || tab.value !== 'wechat') return
  let view
  try {
    view = await accountAPI.wechatQrStatus(qr.value.ticket)
  } catch (e) {
    // 网络抖动继续轮询；票据不存在 / 过期则停止
    const code = accountErrorCode(e)
    if (code === 'NOT_FOUND' || code === 'QR_EXPIRED') { qrStatus.value = 'expired'; return }
    return scheduleQrPoll()
  }
  const d = qrPollDecision(view, Date.now() - qrStartedAt)
  qrStatus.value = d.status
  if (d.action === 'continue') return scheduleQrPoll()
  if (d.action === 'login') return finishWechat('')
}

async function finishWechat(inviteCode) {
  busy.value = true
  try {
    await account.loginByWechat(qr.value.ticket, inviteCode)
    afterSuccess('登录成功')
  } catch (e) {
    const code = accountErrorCode(e)
    if (needsInvite(code)) {
      qrStatus.value = 'need_invite'
    } else if (code === 'QR_EXPIRED' || code === 'NOT_FOUND') {
      qrStatus.value = 'expired'
    } else {
      serverError.value = accountErrorMessage(e)
    }
  } finally {
    busy.value = false
  }
}

function submitWechatInvite() {
  if (!wxForm.inviteCode.trim()) return applyFieldErrors({ inviteCode: '请输入邀请码' })
  clearErrors()
  return finishWechat(wxForm.inviteCode)
}

/** 开发 / 模拟适配器：代替手机端扫码确认。 */
async function simulateConfirm(scanOnly) {
  if (!qr.value) return
  try {
    await accountAPI.wechatConfirm(qr.value.ticket, { scan_only: scanOnly })
    stopQrPolling()
    await pollQr()
  } catch (e) {
    serverError.value = accountErrorMessage(e)
  }
}

function applyFieldErrors(errors) {
  clearErrors()
  Object.assign(fieldErrors, errors)
}

function afterSuccess(message) {
  ElMessage.success(message)
  router.replace(safeRedirect(route.query.redirect))
}

async function submitLogin() {
  const v = validateLogin(loginForm)
  if (!v.ok) return applyFieldErrors(v.errors)
  clearErrors()
  busy.value = true
  try {
    await account.login(loginForm)
    loginForm.password = ''
    afterSuccess('登录成功')
  } catch (e) {
    serverError.value = accountErrorMessage(e)
  } finally {
    busy.value = false
  }
}

async function submitRegister() {
  const v = validateRegister(regForm)
  if (!v.ok) return applyFieldErrors(v.errors)
  clearErrors()
  busy.value = true
  try {
    await account.register(regForm)
    regForm.password = ''
    regForm.confirm = ''
    afterSuccess('注册成功，已登录')
  } catch (e) {
    serverError.value = accountErrorMessage(e)
  } finally {
    busy.value = false
  }
}

async function doLogout() {
  try {
    await account.logout()
    ElMessage.success('已退出登录')
  } catch (e) {
    serverError.value = accountErrorMessage(e)
  }
}

function goBack() {
  router.replace(safeRedirect(route.query.redirect))
}

onMounted(() => {
  account.fetch()
})

onBeforeUnmount(() => {
  stopQrPolling()
  if (smsTimer) clearInterval(smsTimer)
  smsTimer = null
})
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg-page);
}
.login-card {
  width: 100%;
  max-width: 420px;
  padding: 28px 28px 20px;
  border-radius: 12px;
  background: var(--bg-card, var(--bg-page));
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
}
.login-title {
  margin: 0 0 4px;
  font-size: 22px;
  color: var(--text-primary);
}
.login-sub {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-secondary, #888);
}
.login-alert {
  margin-bottom: 12px;
}
.login-submit {
  width: 100%;
  margin-top: 4px;
}
.login-footer {
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
}

/* P2-C：手机验证码 / 微信扫码 */
.sms-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.sms-row .el-input {
  flex: 1;
}
.sms-row .el-button {
  flex: none;
  min-width: 112px;
}
.qr-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 0 8px;
}
.qr-canvas {
  position: relative;
  width: 200px;
  height: 200px;
  padding: 8px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
}
.qr-svg,
.qr-empty {
  display: block;
  width: 100%;
  height: 100%;
}
.qr-dim .qr-svg {
  opacity: 0.15;
}
.qr-refresh {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}
.qr-title {
  margin: 12px 0 2px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.qr-info { color: var(--text-primary); }
.qr-success { color: var(--el-color-success, #67c23a); }
.qr-warning { color: var(--el-color-warning, #e6a23c); }
.qr-danger { color: var(--el-color-danger, #f56c6c); }
.qr-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-secondary, #888);
}
.qr-note {
  opacity: 0.7;
}
.qr-box .el-form,
.qr-box .login-alert {
  width: 100%;
}
.qr-simulate {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
