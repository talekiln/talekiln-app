'use strict';
/** Bundled sample: a short vertical story with a ready-made storyboard. Pure data. */
const SAMPLE_ID = 'talekiln-sample-v1';

const sample = {
  id: SAMPLE_ID,
  title: '示例：雨夜末班车',
  description: '内置示例项目：五个镜头的短故事，素材为脚本生成的占位图与提示音，离线可用，不消耗任何 API 费用。',
  genre: 'guofeng-drama',
  style: 'realistic',
  aspectRatio: '9:16',
  story: '雨夜，加班到很晚的阿宁赶上了末班公交。司机老周认出她是常客，默默调高了车里的暖风。阿宁在车窗上画了一个笑脸，老周从后视镜里看见，也笑了。到站时雨停了，老周递给她一把伞，说明天还是这班车。',
  characters: [
    { name: '阿宁', role: '主角', description: '二十多岁的上班族', appearance: '黑色长发，米色风衣，背着旧帆布包' },
    { name: '老周', role: '配角', description: '末班车司机', appearance: '五十岁上下，灰色制服，温和的笑纹' },
  ],
  locations: ['雨夜街头', '公交车内', '终点站'],
  shots: [
    { visual: '雨夜的街头，路灯在积水里拉出长长的光，阿宁小跑着冲向公交站。', location: '雨夜街头', camera: '远景', dialogue: null, narration: '这一天，阿宁又加班到了深夜。', duration: 3, hue: 230, freq: 330 },
    { visual: '阿宁刷卡上车，车厢里只有零星几位乘客，暖黄色的灯光。', location: '公交车内', camera: '中景', dialogue: '老周：今天又这么晚啊。', narration: null, duration: 3.5, hue: 35, freq: 392 },
    { visual: '车窗起了雾，阿宁伸出手指，在玻璃上画了一个笑脸。', location: '公交车内', camera: '特写', dialogue: null, narration: '她很久没有这样放松过了。', duration: 3, hue: 200, freq: 440 },
    { visual: '后视镜里，老周看到了那个笑脸，嘴角微微上扬。', location: '公交车内', camera: '近景', dialogue: '老周：明天还是这班车。', narration: null, duration: 3, hue: 20, freq: 494 },
    { visual: '终点站，雨已经停了。老周把一把黑伞递给阿宁，阿宁笑着点头。', location: '终点站', camera: '中景', dialogue: '阿宁：谢谢周师傅，明天见。', narration: null, duration: 3.5, hue: 280, freq: 523 },
  ],
};

module.exports = { SAMPLE_ID, sample };
