// export lane 的对话框表。对话框组件接收 props，完成或取消时 emit('close', result)。
export default {
  'export.video': () => import('@/components/export/ExportDialog.vue'),
  'export.media': () => import('@/components/export/MediaExportDialog.vue'),
}
