// home lane 的对话框表：{ 'home.someDialog': () => import('@/components/home/SomeDialog.vue') }
// 对话框组件接收 props，完成或取消时 emit('close', result)；openDialog() 的 Promise 以 result 兑现。
// 只有 home lane 修改本文件。
// 注意：'home.projectSettings'（项目设置）由剧本 lane 提供，不在这里注册。
export default {
  'home.newBlank': () => import('@/components/home/NewBlankDialog.vue'),
  'home.importScript': () => import('@/components/home/ImportScriptDialog.vue'),
  'home.importPackage': () => import('@/components/home/ImportPackageDialog.vue'),
  'home.rename': () => import('@/components/home/RenameDialog.vue'),
}
