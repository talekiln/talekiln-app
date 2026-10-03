import { ref } from 'vue'

// 版本历史抽屉的开关：命令面板、视图顶栏按钮都可以打开（抽屉本身挂在 App.vue 里）。
export const historyOpen = ref(false)
// 想让抽屉直接定位到哪个节点（画布节点面板的“版本历史”按钮设置）；抽屉读取后清空。
export const historyFocusNode = ref('')
export const openHistory = (nodeId = '') => {
  historyFocusNode.value = typeof nodeId === 'string' ? nodeId : '' // 当作点击处理函数用时传进来的是事件对象
  historyOpen.value = true
}
export const closeHistory = () => { historyOpen.value = false }
