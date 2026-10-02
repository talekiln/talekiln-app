<template>
  <div class="app">
    <router-view />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAccountStore } from '@/stores/account'
import { routeDecision } from '@/utils/account'

// 后台定期同步登录/授权状态；会话失效或授权过期且开启门禁时回到登录页
const router = useRouter()
const account = useAccountStore()
onMounted(() => account.startWatcher(router, routeDecision))
onBeforeUnmount(() => account.stopWatcher())
</script>

<style>
* {
  box-sizing: border-box;
}
html, body, #app, .app {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  background: var(--bg-page);
  color: var(--text-primary);
  transition: background 0.25s, color 0.25s;
}
</style>
