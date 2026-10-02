import { ref } from 'vue'

// 版本历史抽屉的开关：命令面板、视图顶栏按钮都可以打开（抽屉本身挂在 ViewSwitcher 里）。
export const historyOpen = ref(false)
export const openHistory = () => { historyOpen.value = true }
export const closeHistory = () => { historyOpen.value = false }
