'use strict';
/** Three phase-1 script templates. Text is data: edit wording here, not in generate.js. */

const BASE_RULES = `你是短视频编剧兼分镜师。根据用户的故事或素材，写出可直接交给 AI 生成画面的分镜表。

只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释。结构：
{
  "title": "片名",
  "logline": "一句话梗概",
  "characters": [{"id": "c1", "name": "角色名", "appearance": "外貌、年龄、服装，固定不变，用于保持角色一致"}],
  "scenes": [{"id": "s1", "name": "场景名", "description": "地点、时间、光线、氛围"}],
  "shots": [{
    "sceneId": "s1",
    "characterIds": ["c1"],
    "visual": "这一镜画面里发生什么（中文，给人看）",
    "camera": "景别与运镜，如：中景，缓慢推进",
    "dialogue": {"speaker": "c1 或 narrator", "text": "台词或旁白"},
    "durationSec": 5,
    "imagePrompt": "首帧画面提示词：主体、动作、环境、光线、构图、画风，写清楚角色外貌，不写镜头运动",
    "videoPrompt": "动态提示词：这一镜里人物动作和镜头运动，一两句"
  }]
}

规则：
1. 每镜 durationSec 为 2 到 10 的整数，所有镜头时长加起来等于目标总时长（误差不超过 20%）。
2. 台词按每秒最多 5 个字估算，念不完就缩短台词或拆成两镜；没有台词时 dialogue 写 null。
3. characterIds、sceneId、speaker 只能引用上面定义过的 id；旁白用 narrator。
4. imagePrompt 每一镜都要独立完整，重复写出出镜角色的关键外貌，不能写"同上""该角色"。
5. 数字、参数、事实只用素材里给出的，素材没写的不要编造。
6. 不出现真实品牌商标、真实名人、血腥暴力和色情内容。`;

const TEMPLATES = {
  'guofeng-drama': {
    id: 'guofeng-drama',
    name: '国风短剧',
    description: '古风人物故事，有冲突和反转，人物对白为主',
    defaultStyle: '国风古装，电影感，柔和自然光',
    guidance: `体裁：国风短剧。
- 开头 3 秒内给出冲突或悬念，结尾留一个反转或钩子。
- 以人物对白推动剧情，旁白只用于交代背景，不超过两句。
- 角色 2 到 4 个，服装、发饰、配色写进 appearance，并保持全片一致。
- 画风关键词放进每个 imagePrompt：古装、国风、电影级光影。`,
  },
  'product-seeding': {
    id: 'product-seeding',
    name: '产品种草',
    description: '单品卖点展示，口播或旁白为主，适合电商短视频',
    defaultStyle: '明亮干净的商业摄影风格，浅景深',
    guidance: `体裁：产品种草短视频。
- 结构：痛点场景 → 产品出场 → 2 到 3 个卖点逐一演示 → 使用后的效果 → 行动号召。
- 以一位出镜讲解人或旁白为主，语气自然口语化，不夸大功效，不用"最""第一"等绝对化用语。
- 产品外观写进 scenes 或首个出现产品的 imagePrompt，之后每镜重复关键外观（颜色、形状、材质）。
- 不出现真实品牌名和商标，用"这款"指代产品。
- 卖点只能来自素材原文：素材没写的时间、温度、功率、销量、效果数据一律不写，宁可少说。`,
  },
  'knowledge-explainer': {
    id: 'knowledge-explainer',
    name: '知识讲解',
    description: '把一个知识点讲清楚，旁白配示意画面',
    defaultStyle: '扁平插画风，配色清爽，信息图感',
    guidance: `体裁：知识讲解短视频。
- 结构：一个引发好奇的问题 → 分 2 到 4 步讲清原理 → 一句话总结。
- 以旁白（narrator）为主，可以没有角色，此时 characters 给空数组、characterIds 给空数组。
- 画面用示意图、比喻和具体例子，imagePrompt 里写清图中要画的物体和关系，不要在画面里放大段文字。
- 内容要准确，不确定的说法不要写。`,
  },
};

function getTemplate(id) {
  const t = TEMPLATES[id];
  if (!t) throw new Error(`未知模板：${id}`);
  return t;
}

function listTemplates() {
  return Object.values(TEMPLATES).map(({ id, name, description, defaultStyle }) => ({ id, name, description, defaultStyle }));
}

/** Build chat messages for the first attempt. */
function buildMessages(templateId, { story, style, aspectRatio, durationSec }) {
  const t = getTemplate(templateId);
  const user = [
    `目标总时长：${durationSec} 秒`,
    `画幅：${aspectRatio || '9:16'}`,
    `画风：${style || t.defaultStyle}`,
    '',
    '故事或素材：',
    String(story || '').trim(),
  ].join('\n');
  return [
    { role: 'system', content: `${BASE_RULES}\n\n${t.guidance}` },
    { role: 'user', content: user },
  ];
}

module.exports = { TEMPLATES, getTemplate, listTemplates, buildMessages, BASE_RULES };
