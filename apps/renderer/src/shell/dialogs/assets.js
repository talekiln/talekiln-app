// assets lane 的对话框表：{ 'assets.someDialog': () => import('@/components/assets/SomeDialog.vue') }
// 对话框组件接收 props，完成或取消时 emit('close', result)；openDialog() 的 Promise 以 result 兑现。
// 只有 assets lane 修改本文件。
export default {
  // 新建 / 编辑资产。props: { kind, id? }；结果：保存后的资产，取消为 undefined
  'assets.edit': () => import('@/components/assets/AssetFormDialog.vue'),
  // 选择一个资产。props: { kinds?, kind? }；结果：{ kind, asset, token }，取消为 undefined
  'assets.pick': () => import('@/components/assets/AssetPickDialog.vue'),
  // 从剧本提取资产。props: { outline? }；结果：{ extracted: [kind] }
  'assets.extract': () => import('@/components/assets/AssetExtractDialog.vue'),
  // 从素材库（全局 / 本项目）导入。props: { kind?, scope? }；结果：{ imported, kind }
  'assets.globalLibrary': () => import('@/components/assets/GlobalLibraryDialog.vue'),
}
