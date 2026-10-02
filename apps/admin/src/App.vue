<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { auth } from './api.js'
import { ROLE_LABEL, roleLabel, visibleMenu } from './permissions.js'
import { clearMe, me } from './session.js'

const route = useRoute()
const router = useRouter()
const isLogin = computed(() => route.name === 'login')
const menu = [
  { path: '/overview', label: '概览与漏斗', perm: 'read' },
  { path: '/orders', label: '订单', perm: 'read' },
  { path: '/refunds', label: '退款与发票', perm: 'read' },
  { path: '/plans', label: '套餐与价格', perm: 'read' },
  { path: '/releases', label: '版本灰度', perm: 'read' },
  { path: '/announcements', label: '公告', perm: 'read' },
  { path: '/invites', label: '邀请码', perm: 'read' },
  { path: '/users', label: '用户', perm: 'read' },
  { path: '/content', label: '模型目录', perm: 'read' },
  { path: '/templates', label: '模板市场', perm: 'read' },
  { path: '/plugins', label: '插件审核', perm: 'read' },
  { path: '/admins', label: '管理员与审计', perm: 'admins:manage' },
]
const items = computed(() => visibleMenu(menu, me.value))
const roleTag = computed(() => (me.value && ROLE_LABEL[me.value.role]) || null)

function logout() {
  auth.clear()
  clearMe()
  router.replace({ name: 'login' })
}
</script>

<template>
  <router-view v-if="isLogin" />
  <el-container v-else style="height: 100%">
    <el-aside width="180px" style="background: #1f2937">
      <div style="color: #fff; padding: 18px 16px; font-weight: 600">Talekiln 运营后台</div>
      <el-menu :default-active="route.path" router background-color="#1f2937" text-color="#cbd5e1" active-text-color="#fff">
        <el-menu-item v-for="m in items" :key="m.path" :index="m.path">{{ m.label }}</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header style="display: flex; align-items: center; justify-content: flex-end; gap: 12px; background: #fff; border-bottom: 1px solid #ebeef5">
        <template v-if="me">
          <span class="muted">{{ me.email }}</span>
          <el-tag v-if="roleTag" :type="roleTag.type" size="small">{{ roleLabel(me.role) }}</el-tag>
        </template>
        <el-button link type="primary" @click="logout">退出登录</el-button>
      </el-header>
      <el-main style="padding: 0"><router-view /></el-main>
    </el-container>
  </el-container>
</template>
