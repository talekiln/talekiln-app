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
          当前账号：{{ status.account.email }}（{{ account.summary.label }}）
        </template>
      </el-alert>

      <el-tabs v-model="tab" class="login-tabs" @tab-change="clearErrors">
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
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAccountStore } from '@/stores/account'
import {
  validateLogin,
  validateRegister,
  accountErrorMessage,
  loginReasonText,
  safeRedirect
} from '@/utils/account'

const route = useRoute()
const router = useRouter()
const account = useAccountStore()

const tab = ref('login')
const busy = ref(false)
const serverError = ref('')
const fieldErrors = reactive({})
const loginForm = reactive({ email: '', password: '' })
const regForm = reactive({ inviteCode: '', email: '', password: '', confirm: '' })

const status = computed(() => account.status)
const reasonText = computed(() => loginReasonText(String(route.query.reason || '')))

function clearErrors() {
  serverError.value = ''
  for (const k of Object.keys(fieldErrors)) delete fieldErrors[k]
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
</style>
