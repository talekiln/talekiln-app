// 选镜改片的纯逻辑文案（utils/regionEdit.js）。镜头工作台界面用的是 storyboard.wb.*（components/shot/workbenchLabels.js），
// 这里的句子沿用 regionEdit.js 原有的中文措辞；与 storyboard.wb.* 完全相同的几条（整段、导入、AI 生成、选镜改片、模型、秒、采用提示、模式名）直接复用。
// key 必须以 region. 开头；用 [key, 中文, English] 三元组书写，保证两种语言键集合一致。
const rows = [
  ['region.rect.full', '整幅画面', 'The whole frame'],
  ['region.rect.center', '画面中央', 'The center of the frame'],
  ['region.rect.side', '画面{dir}侧', 'The {dir} side of the frame'],
  ['region.rect.edge', '画面{dir}方', 'The {dir} of the frame'],
  ['region.rect.corner', '画面{ver}{hor}', 'The {ver} {hor} of the frame'],
  ['region.dir.left', '左', 'left'],
  ['region.dir.right', '右', 'right'],
  ['region.dir.top', '上', 'top'],
  ['region.dir.bottom', '下', 'bottom'],
  ['region.cost.segment', '只改这 {sec} 秒约 {price}', 'Editing only these {sec}s costs about {price}'],
  ['region.cost.full', '整镜重做约 {price}', 'redoing the whole shot costs about {price}'],
  ['region.cost.fullSave', '整镜重做约 {price}，省 {pct}%', 'redoing the whole shot costs about {price}, saving {pct}%'],
  ['region.cost.sample', '样例价', 'sample prices'],
  ['region.cost.sep', '；', '; '],
  ['region.cost.withNotes', '{base}（{notes}）', '{base} ({notes})'],
  ['region.strategy.mask', '服务商直接按区域编辑原片', 'The provider edits the region of the original clip directly'],
  ['region.strategy.splice', '服务商不支持区域编辑：按入点 / 出点两帧重新生成这一段，再拼回原片', 'The provider cannot edit a region: this segment is regenerated between the in and out frames and spliced back into the original'],
  ['region.refusal.cap', '超过花费上限', 'Over the spending cap'],
  ['region.refusal.provider', '未配置 {provider} 的视频服务或 Key', 'No video service or key is configured for {provider}'],
  ['region.status.queued', '排队中', 'Queued'],
  ['region.status.running', '生成中', 'Generating'],
  ['region.status.done', '已完成', 'Done'],
  ['region.status.failed', '失败', 'Failed'],
  ['region.source.sync', '同步旧素材', 'Synced from old assets'],
  ['region.source.rebase', '沿用旧素材', 'Kept from old assets'],
  // ROWS-END
]

export default {
  'zh-CN': Object.fromEntries(rows.map(([k, zh]) => [k, zh])),
  en: Object.fromEntries(rows.map(([k, , en]) => [k, en])),
}
