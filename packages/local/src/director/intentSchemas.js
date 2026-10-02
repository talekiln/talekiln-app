'use strict';
/**
 * 导演模式开放给大模型的意图及其参数表（P3-D）。
 * 来源：kernel/intentTable.js 的 REST 白名单（规格 §3 的 26 个意图）减去 EXCLUDED 里模型拿不到输入、或只影响画布布局的几项。
 * 每个参数：{ type, required?, enum?, shape?, nullable?, desc }；type 取值见 TYPES。shape 描述 object 参数允许的键（键名 -> 类型）。
 * 参数表既用于生成提示词里的“可用动作”清单，也用于执行前的类型检查（未知参数、类型不符、缺少必填都会拒绝整份计划）。
 */
const kernel = require('@talekiln/kernel');
const { INTENTS } = require('../kernel/intentTable');

const TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'string[]', 'any'];

/** 不对模型开放的白名单意图及原因（文档与测试都读这里）。 */
const EXCLUDED = Object.freeze({
  'timeline.addMusic': '需要音乐素材的 asset_ref，模型看不到素材库',
  'canvas.moveNode': '只改画布坐标，对成片没有意义',
  'canvas.connectNodes': '画布级结构编辑，连错线会破坏项目图；镜头与台词的增删已有专门意图',
  'canvas.disconnectNodes': '同 connectNodes',
  'canvas.addNodeAt': '同 connectNodes；新增镜头 / 台词请用 shot.addShot / script.insertLine',
  'canvas.deleteNode': '同 connectNodes；删除镜头 / 台词请用 shot.deleteShot / script.deleteLine',
  'shot.editShotRegion': '选镜改片要先估价再确认提交生成任务，由工作台的改片面板发起，不在计划里直接执行',
});

const SHOT_FIELDS = {
  title: 'string', description: 'string', location: 'string', time: 'string', shot_type: 'string', angle: 'string', movement: 'string',
  image_prompt: 'string', video_prompt: 'string', atmosphere: 'string', characters: 'string[]', duration_ms: 'integer',
};
const LINE_PATCH = { text: 'string', speaker: 'string', kind: 'string' };

const SCHEMAS = {
  script: {
    rewriteLine: {
      desc: '改一行台词 / 旁白的文字、说话人或类型。行是所属镜头的输入：改了会让该镜头的配音过期（按字计费，很便宜），已生成的首帧图 / 视频也会标记为过期。',
      args: {
        line_id: { type: 'string', required: true, desc: '行 id（上下文 lines[].id）' },
        patch: { type: 'object', required: true, shape: LINE_PATCH, desc: '要改的字段：text / speaker / kind（kind 取 narration | dialogue | action | scene_heading）' },
      },
    },
    insertLine: {
      desc: '在场景组里插入一行，可同时挂到若干镜头（挂上后这些镜头的配音过期）。',
      args: {
        group: { type: 'string', required: true, desc: '场景组 id' },
        index: { type: 'integer', desc: '在该组行序列里的位置（0 起；省略 = 末尾）' },
        kind: { type: 'string', enum: kernel.LINE_KINDS, desc: '行类型，默认 narration' },
        speaker: { type: 'string', desc: '说话人（对白用）' },
        text: { type: 'string', desc: '文字' },
        shot_ids: { type: 'string[]', desc: '挂到哪些镜头' },
      },
    },
    deleteLine: { desc: '删除一行（所属镜头的配音过期）。', args: { line_id: { type: 'string', required: true, desc: '行 id' } } },
    splitLine: {
      desc: '在字符位置 at 把一行拆成两行（后半行挂到同样的镜头）。',
      args: { line_id: { type: 'string', required: true, desc: '行 id' }, at: { type: 'integer', required: true, desc: '拆分位置（0 < at < 文字长度）' } },
    },
    mergeLines: {
      desc: '把相邻的 b 行并入 a 行（须同组且 b 紧跟 a）。',
      args: { a_id: { type: 'string', required: true, desc: '前一行 id' }, b_id: { type: 'string', required: true, desc: '后一行 id' }, sep: { type: 'string', desc: '拼接分隔符，默认空' } },
    },
    reorderLines: {
      desc: '重排一个场景组里的行；ids 必须是该组全部行的一个排列。',
      args: { group_id: { type: 'string', required: true, desc: '场景组 id' }, ids: { type: 'string[]', required: true, desc: '新顺序' } },
    },
  },
  shot: {
    setShotField: {
      desc: '改镜头字段。镜头的全部字段都是下游的输入：改任何字段（含 title / duration_ms）都会让该镜头已生成的首帧图、视频、配音过期（要重新生成，花钱；没生成过的不额外花钱）；改 duration_ms 时时间线片段自动跟随。',
      args: {
        shot_id: { type: 'string', required: true, desc: '镜头 id' },
        patch: { type: 'object', required: true, shape: SHOT_FIELDS, desc: '要改的字段子集；duration_ms 为正整数毫秒' },
      },
    },
    splitShot: {
      desc: '拆镜头：该镜头的行按剧本顺序，前 at_line_index 行留下，其余挂到紧跟其后的新镜头。新镜头克隆参数，图和视频都要重新生成（花钱）。',
      args: { shot_id: { type: 'string', required: true, desc: '镜头 id' }, at_line_index: { type: 'integer', required: true, desc: '留在原镜头的行数（0 .. 行数）' } },
    },
    mergeShots: {
      desc: '把 b 镜并入 a 镜：b 的行挂到 a，b 被删除，a 的时长 = 两者之和；a 的图和视频过期（花钱）。',
      args: { a_id: { type: 'string', required: true, desc: '保留的镜头' }, b_id: { type: 'string', required: true, desc: '被并入的镜头' } },
    },
    reorderShots: {
      desc: '在一个场景组内重排镜头，ids 必须是该组全部镜头的一个排列。只让合成过期，不花钱。',
      args: { group_id: { type: 'string', required: true, desc: '场景组 id' }, ids: { type: 'string[]', required: true, desc: '新顺序（镜头 id）' } },
    },
    moveShotToGroup: {
      desc: '把镜头移到另一个（或同一个）场景组的第 index 个镜头位置。不花钱。',
      args: { shot_id: { type: 'string', required: true, desc: '镜头 id' }, group_id: { type: 'string', required: true, desc: '目标场景组' }, index: { type: 'integer', desc: '目标位置（0 起；省略 = 末尾）' } },
    },
    addShot: {
      desc: '新建镜头（带默认的图 / 视频 / 配音节点和整段时间线片段）。新镜头要生成图和视频（花钱）。',
      args: {
        group: { type: 'string', required: true, desc: '场景组 id' },
        index: { type: 'integer', desc: '在该组镜头序列里的位置（0 起；省略 = 末尾）' },
        params: { type: 'object', shape: SHOT_FIELDS, desc: '镜头字段（title / description / shot_type / movement / image_prompt / video_prompt / duration_ms …）' },
        lines: { type: 'string[]', desc: '挂到新镜头的已有行 id' },
      },
    },
    deleteShot: { desc: '删除镜头（台词行保留在剧本里）。合成过期，不花钱。', args: { shot_id: { type: 'string', required: true, desc: '镜头 id' } } },
    regenerateShot: {
      desc: '给镜头的图 / 视频换种子，强制重新生成（花钱）；旧版本保留。',
      args: {
        shot_id: { type: 'string', required: true, desc: '镜头 id' },
        seed: { type: 'integer', desc: '指定种子；省略 = 当前种子 + 1' },
        targets: { type: 'string[]', enum: ['image', 'video'], desc: '只重做图或只重做视频；默认两者' },
      },
    },
  },
  timeline: {
    trimSegment: {
      desc: '裁剪时间线片段在源视频里的入点 / 出点（毫秒整数，0 <= in < out <= 镜头时长）。不用重新生成。',
      args: { segment_id: { type: 'string', required: true, desc: '片段 id' }, in_ms: { type: 'integer', desc: '入点' }, out_ms: { type: 'integer', desc: '出点' } },
    },
    moveSegment: {
      desc: '移动片段：只给 gap_before_ms = 改该片段前的空隙；给 before_segment_id / after_segment_id = 放到目标片段前 / 后（目标在别的镜头 = 改镜头顺序）。不花钱。',
      args: {
        segment_id: { type: 'string', required: true, desc: '片段 id' },
        gap_before_ms: { type: 'integer', desc: '片段前空隙（>= 0）' },
        before_segment_id: { type: 'string', desc: '放到这个片段之前' },
        after_segment_id: { type: 'string', desc: '放到这个片段之后' },
      },
    },
    splitSegment: {
      desc: '在源视频位置 at_ms 把片段切成两段（in < at < out）。不花钱。',
      args: { segment_id: { type: 'string', required: true, desc: '片段 id' }, at_ms: { type: 'integer', required: true, desc: '切分位置' } },
    },
    deleteSegment: {
      desc: '删除片段；删掉镜头最后一个片段等于删除整个镜头。不花钱。',
      args: { segment_id: { type: 'string', required: true, desc: '片段 id' } },
    },
    setTransition: {
      desc: '设置进入该片段的转场（null = 无转场）。不花钱。',
      args: { segment_id: { type: 'string', required: true, desc: '片段 id' }, transition: { type: 'string', nullable: true, desc: '转场名，如 fade / dissolve；null 清除' } },
    },
  },
  canvas: {
    setNodeParam: {
      desc: '改生成节点的一个参数：image / video 的 model、seed；narration 的 voice（音色）、speed（语速）。改了该节点及其下游过期。',
      args: {
        node_id: { type: 'string', required: true, desc: '节点 id（上下文 shots[].nodes 里的 image / video / narration）' },
        path: { type: 'string', required: true, desc: '参数名，如 seed / model / voice / speed' },
        value: { type: 'any', required: true, nullable: true, desc: '新值；可选参数用 null 清除' },
      },
    },
  },
};

/** 开放给模型的意图：白名单 ∩ 有参数表 − EXCLUDED。返回 [{ view, name, key, schema }]。 */
function allowedIntents() {
  const out = [];
  for (const view of Object.keys(INTENTS)) {
    for (const name of Object.keys(INTENTS[view])) {
      const key = `${view}.${name}`;
      if (EXCLUDED[key]) continue;
      const schema = SCHEMAS[view] && SCHEMAS[view][name];
      if (!schema) continue;
      out.push({ view, name, key, schema });
    }
  }
  return out;
}

const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOk(type, v) {
  switch (type) {
    case 'string': return isStr(v);
    case 'integer': return isInt(v);
    case 'number': return isNum(v);
    case 'boolean': return typeof v === 'boolean';
    case 'object': return isObj(v);
    case 'string[]': return Array.isArray(v) && v.every(isStr);
    case 'any': return true;
    default: return false;
  }
}
const TYPE_LABEL = { string: '字符串', integer: '整数', number: '数字', boolean: '布尔值', object: '对象', 'string[]': '字符串数组', any: '任意值' };
const show = (v) => { try { const s = JSON.stringify(v); return s.length > 60 ? `${s.slice(0, 60)}…` : s; } catch (_) { return String(v); } };

/**
 * 按参数表检查一步的 args。返回中文错误列表（空数组 = 通过）。
 * 规则：args 必须是对象；必填不能缺（null 视为缺，除非 nullable）；类型必须匹配；enum 限定取值（数组参数逐项检查）；
 * object 参数带 shape 时键必须在 shape 里且类型匹配；参数表外的键一律拒绝（模型编出来的参数不能悄悄丢掉）。
 */
function checkArgs(schema, args) {
  const errors = [];
  if (!isObj(args)) return [`args 应为对象，收到 ${show(args)}`];
  for (const [k, spec] of Object.entries(schema.args)) {
    const v = args[k];
    if (v === undefined || (v === null && !spec.nullable)) {
      if (spec.required) errors.push(`缺少必填参数 ${k}（${spec.desc}）`);
      continue;
    }
    if (v === null && spec.nullable) continue;
    if (!typeOk(spec.type, v)) { errors.push(`参数 ${k} 应为${TYPE_LABEL[spec.type] || spec.type}，收到 ${show(v)}`); continue; }
    if (spec.enum) {
      const bad = (Array.isArray(v) ? v : [v]).filter((x) => !spec.enum.includes(x));
      if (bad.length) errors.push(`参数 ${k} 只能取 ${spec.enum.join(' / ')}，收到 ${show(bad.length === 1 ? bad[0] : bad)}`);
    }
    if (spec.shape && isObj(v)) {
      for (const [sk, sv] of Object.entries(v)) {
        if (!Object.prototype.hasOwnProperty.call(spec.shape, sk)) { errors.push(`参数 ${k}.${sk} 不在允许的字段里（可用：${Object.keys(spec.shape).join(' / ')}）`); continue; }
        if (sv !== null && !typeOk(spec.shape[sk], sv)) errors.push(`参数 ${k}.${sk} 应为${TYPE_LABEL[spec.shape[sk]]}，收到 ${show(sv)}`);
      }
      if (!Object.keys(v).length) errors.push(`参数 ${k} 不能是空对象`);
    }
  }
  for (const k of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(schema.args, k)) errors.push(`参数 ${k} 不在该意图的参数表里（可用：${Object.keys(schema.args).join(' / ')}）`);
  }
  return errors;
}

/** 提示词里的一行：`shot.setShotField(shot_id: string*, patch: object{...})：说明`。 */
function describeIntent({ key, schema }) {
  const args = Object.entries(schema.args).map(([k, s]) => {
    let t = s.type;
    if (s.enum) t += `<${s.enum.join('|')}>`;
    if (s.shape) t += `{${Object.entries(s.shape).map(([a, b]) => `${a}:${b}`).join(',')}}`;
    if (s.nullable) t += '|null';
    return `${k}${s.required ? '*' : '?'}: ${t}`;
  });
  return `- ${key}(${args.join(', ')})：${schema.desc}`;
}

module.exports = { TYPES, SCHEMAS, EXCLUDED, SHOT_FIELDS, LINE_PATCH, allowedIntents, checkArgs, describeIntent, typeOk };
