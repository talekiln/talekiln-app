// script lane 的对话框表：{ 'script.someDialog': () => import('@/components/script/SomeDialog.vue') }
// 对话框组件接收 props，完成或取消时 emit('close', result)；openDialog() 的 Promise 以 result 兑现。
// 只有 script lane 修改本文件。
export default {}
