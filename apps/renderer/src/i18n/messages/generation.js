// 出图 / 出视频持久队列（utils/generationView.js、api/queuedGeneration.js、utils/queuedTask.js）的文案。
// 确认弹窗的行 / 警告复用 generate.confirm.* / generate.warn.*（components/generate/generateConfirm.js）。
// key 必须以 generation. 开头；用 [key, 中文, English] 三元组书写，保证两种语言键集合一致。
const rows = [
  ['generation.state.none', '未生成', 'Not generated'],
  ['generation.state.queued', '排队中', 'Queued'],
  ['generation.state.running', '生成中', 'Generating'],
  ['generation.state.stale', '需更新', 'Needs update'],
  ['generation.state.fresh', '最新', 'Up to date'],
  ['generation.state.failed', '失败', 'Failed'],
  ['generation.kind.image', '首帧图', 'First frame'],
  ['generation.kind.video', '视频', 'Video'],
  ['generation.kind.both', '首帧图 + 视频', 'First frame + video'],
  ['generation.failedSeeTasks', '生成失败，详见任务中心', 'Generation failed; see the Task Center'],
  ['generation.failed', '生成失败', 'Generation failed'],
  ['generation.cancelled', '已取消', 'Cancelled'],
  ['generation.target.shot', '镜头 #{n} · {what}', 'Shot #{n} · {what}'],
  ['generation.target.voiceover', '旁白配音', 'Narration voiceover'],
  ['generation.queue.hint', '任务在后台队列里执行，进度见任务中心。', 'Tasks run in the background queue; follow their progress in the Task Center.'],
  ['generation.queue.confirm', '确认并生成', 'Confirm and generate'],
  ['generation.queue.noEpisode', '缺少分集，无法生成', 'No episode, so nothing can be generated'],
]

export default {
  'zh-CN': Object.fromEntries(rows.map(([k, zh]) => [k, zh])),
  en: Object.fromEntries(rows.map(([k, , en]) => [k, en])),
}
