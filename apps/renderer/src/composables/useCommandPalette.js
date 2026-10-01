import { ref } from 'vue'
import { createRegistry } from '@/utils/commandRegistry'

// 全局唯一的命令注册表与面板状态。插件 / 其它模块用 registerCommand / registerCommandProvider 扩展，
// 返回的函数用于卸载。内置命令与内容搜索由 CommandPalette.vue 挂载时注册（需要 router / store）。
export const registry = createRegistry()

export const paletteOpen = ref(false)

export const openPalette = () => { paletteOpen.value = true }
export const closePalette = () => { paletteOpen.value = false }
export const togglePalette = () => { paletteOpen.value = !paletteOpen.value }

export const registerCommand = (cmd) => registry.register(cmd)
export const registerCommands = (list) => registry.registerAll(list)
export const registerCommandProvider = (fn) => registry.registerProvider(fn)
