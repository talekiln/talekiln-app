<template>
  <component :is="comp" v-if="comp && cur" :key="cur.id" v-bind="cur.props" @close="onClose" />
</template>

<script setup>
import { computed, defineAsyncComponent, markRaw } from 'vue'
import { closeDialog, currentDialog, loaderFor } from './dialogs/index.js'

// 渲染 openDialog(id, props) 打开的当前对话框。对话框组件完成 / 取消时 emit('close', result)。
const cache = new Map()
const cur = computed(() => currentDialog.value)
const comp = computed(() => {
  const id = cur.value?.id
  if (!id) return null
  if (!cache.has(id)) {
    const loader = loaderFor(id)
    cache.set(id, loader ? markRaw(defineAsyncComponent(loader)) : null)
  }
  return cache.get(id)
})

function onClose(result) {
  closeDialog(result)
}
</script>
