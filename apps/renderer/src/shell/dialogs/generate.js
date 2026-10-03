// generate lane 的对话框表。对话框组件接收 props，完成或取消时 emit('close', result)。
export default {
  'generate.pipeline': () => import('@/components/generate/PipelineDialog.vue'),
  'generate.confirm': () => import('@/components/generate/GenerateConfirmDialog.vue'),
  'generate.voice': () => import('@/components/generate/VoiceDialog.vue'),
  'generate.rerunDraft': () => import('@/components/generate/RerunDraftDialog.vue'),
}
