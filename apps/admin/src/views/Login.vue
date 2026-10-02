<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, auth, errorText } from '../api.js'

const router = useRouter()
const form = reactive({ email: '', password: '' })
const loading = ref(false)

async function submit() {
  if (!form.email || !form.password) return ElMessage.warning('请输入邮箱和密码')
  loading.value = true
  try {
    const r = await api.login(form.email.trim(), form.password)
    auth.set(r.token)
    form.password = ''
    router.replace({ name: 'overview' })
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <template #header><b>Talekiln 运营后台</b></template>
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="管理员邮箱">
          <el-input v-model="form.email" autocomplete="username" placeholder="admin@example.com" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password autocomplete="current-password" @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" style="width: 100%" :loading="loading" native-type="submit" @click="submit">登录</el-button>
      </el-form>
      <p class="muted">管理员账号由部署方通过环境变量创建；连续失败会被暂时限制登录。</p>
    </el-card>
  </div>
</template>
