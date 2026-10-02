'use strict';
// 测试用的严格 XML 良构解析器（仓库没有 XML 依赖，也不为测试新增依赖）。
// 检查：单根、标签配对、属性必须带引号且不重复、实体只允许 5 个预定义和数字引用、文本里不能有裸 `<` 或 `&`、无非法控制字符。
// 返回 { name, attrs, children, text } 树。出错抛 Error（带位置）。

const ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
const NAME = '[A-Za-z_][\\w.\\-:]*';

function decode(s, where) {
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(s)) throw new Error(`bad entity near ${where}`);
  return s.replace(ENTITY, (_, e) => {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function parseXml(src) {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(src)) throw new Error('illegal control character');
  let i = 0;
  const stack = [];
  let root = null;
  const err = (m) => { throw new Error(`${m} at ${i}: ${JSON.stringify(src.slice(Math.max(0, i - 20), i + 30))}`); };
  const attach = (node) => {
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) err('multiple roots');
    else root = node;
  };
  if (src.startsWith('<?xml')) { const e = src.indexOf('?>'); if (e < 0) err('unterminated xml decl'); i = e + 2; }
  while (i < src.length) {
    if (src[i] === '<') {
      if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); if (e < 0) err('unterminated comment'); i = e + 3; continue; }
      if (src.startsWith('<!DOCTYPE', i)) { const e = src.indexOf('>', i); if (e < 0) err('unterminated doctype'); i = e + 1; continue; }
      if (src[i + 1] === '/') {
        const m = new RegExp(`^</(${NAME})\\s*>`).exec(src.slice(i));
        if (!m) err('bad close tag');
        const top = stack.pop();
        if (!top || top.name !== m[1]) err(`mismatched close tag </${m[1]}>`);
        i += m[0].length;
        continue;
      }
      const m = new RegExp(`^<(${NAME})`).exec(src.slice(i));
      if (!m) err('bad open tag');
      const node = { name: m[1], attrs: {}, children: [], text: '' };
      i += m[0].length;
      for (;;) {
        const ws = /^\s+/.exec(src.slice(i));
        if (ws) i += ws[0].length;
        if (src.startsWith('/>', i)) { i += 2; attach(node); break; }
        if (src[i] === '>') { i += 1; attach(node); stack.push(node); break; }
        const a = new RegExp(`^(${NAME})\\s*=\\s*("([^"<]*)"|'([^'<]*)')`).exec(src.slice(i));
        if (!a || !ws) err('bad attribute');
        if (a[1] in node.attrs) err(`duplicate attribute ${a[1]}`);
        node.attrs[a[1]] = decode(a[3] ?? a[4], a[1]);
        i += a[0].length;
      }
    } else {
      const e = src.indexOf('<', i);
      const text = src.slice(i, e < 0 ? src.length : e);
      if (stack.length) stack[stack.length - 1].text += decode(text, 'text');
      else if (text.trim()) err('text outside root');
      i += text.length;
    }
  }
  if (stack.length) err(`unclosed <${stack[stack.length - 1].name}>`);
  if (!root) err('no root');
  return root;
}

const child = (n, name) => n.children.find((c) => c.name === name);
const kids = (n, name) => n.children.filter((c) => c.name === name);
const find = (n, name, out = []) => { if (n.name === name) out.push(n); n.children.forEach((c) => find(c, name, out)); return out; };

module.exports = { parseXml, child, kids, find };
