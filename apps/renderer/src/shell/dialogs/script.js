// script lane 的对话框表：{ 'script.someDialog': () => import('@/components/script/SomeDialog.vue') }
// 对话框组件接收 props，完成或取消时 emit('close', result)；openDialog() 的 Promise 以 result 兑现。
// 只有 script lane 修改本文件。
export default {
  'script.aiWrite': () => import('@/components/script/AiWriteDialog.vue'),
  'script.importScript': () => import('@/components/script/ImportScriptDialog.vue'),
  'script.episodes': () => import('@/components/script/EpisodeManagerDialog.vue'),
  // 项目设置：标题、画幅、风格、语言、片段时长、梗概（PUT /dramas/:id）。左栏的设置按钮打开它。
  'home.projectSettings': () => import('@/components/script/ProjectSettingsDialog.vue'),
}
