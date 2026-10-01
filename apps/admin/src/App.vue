<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { auth } from './api.js'

const route = useRoute()
const router = useRouter()
const isLogin = computed(() => route.name === 'login')
const menu = [
  { path: '/overview', label: '概览' },
  { path: '/invites', label: '邀请码' },
  { path: '/users', label: '用户' },
  { path: '/content', label: '公告与目录' },
]

function logout() {
  auth.clear()
  router.replace({ name: 'login' })
}
</script>

<template>
  <router-view v-if="isLogin" />
  <el-container v-else style="height: 100%">
    <el-aside width="180px" style="background: #1f2937">
      <div style="color: #fff; padding: 18px 16px; font-weight: 600">Talekiln 运营后台</div>
      <el-menu :default-active="route.path" router background-color="#1f2937" text-color="#cbd5e1" active-text-color="#fff">
        <el-menu-item v-for="m in menu" :key="m.path" :index="m.path">{{ m.label }}</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header style="display: flex; align-items: center; justify-content: flex-end; background: #fff; border-bottom: 1px solid #ebeef5">
        <el-button link type="primary" @click="logout">退出登录</el-button>
      </el-header>
      <el-main style="padding: 0"><router-view /></el-main>
    </el-container>
  </el-container>
</template>
