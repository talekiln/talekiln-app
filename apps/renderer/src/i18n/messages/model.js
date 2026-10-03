// 模型选择 / 服务商开关（utils/modelSelection.js、utils/providerEnablement.js）里前端自己生成的文案。
// 服务端下发的服务商名称、模型名保持原样。
// key 必须以 model. 开头；用 [key, 中文, English] 三元组书写，保证两种语言键集合一致。
const rows = [
  ['model.unit.image', '张', 'image'],
  ['model.unit.second', '秒', 's'],
  ['model.unit.char', '字', 'char'],
  ['model.provider.bailian', '阿里云百炼', 'Alibaba Cloud Bailian'],
  ['model.listSep', '、', ', '],
  // ROWS-END
]

export default {
  'zh-CN': Object.fromEntries(rows.map(([k, zh]) => [k, zh])),
  en: Object.fromEntries(rows.map(([k, , en]) => [k, en])),
}
