'use strict';
// 素材路径转换（纯字符串处理，不碰文件系统，不依赖运行平台）。
// 输入可以是 Windows 路径（C:\用户\a b.mp4、\\server\share\x.mp4）或 POSIX 路径（/Users/张三/a b.mp4）。

const isWindowsPath = (p) => /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);

/** 剪映草稿里的素材路径：保持原样的 Unicode，反斜杠改正斜杠（Windows 剪映草稿即如此，见文档“推测”清单）。 */
function toJianyingPath(p) {
  const s = String(p);
  return isWindowsPath(s) ? s.replace(/\\/g, '/') : s;
}

/**
 * Premiere xmeml `<pathurl>` / FCPXML `src`：file://localhost/<按段 UTF-8 百分号编码>。
 * 盘符冒号编码成 %3A（Premiere 自己导出的就是这样）。中文与空格逐段编码。
 */
function toFileUrl(p) {
  const s = String(p);
  if (/^\\\\/.test(s)) {
    const parts = s.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
    return `file://${encodeURIComponent(parts[0])}/${parts.slice(1).map(encodeURIComponent).join('/')}`;
  }
  if (isWindowsPath(s)) {
    const [drive, ...rest] = s.replace(/\\/g, '/').split('/');
    return `file://localhost/${encodeURIComponent(drive)}/${rest.map(encodeURIComponent).join('/')}`;
  }
  return `file://localhost${s.split('/').map((seg, i) => (i === 0 ? '' : encodeURIComponent(seg))).join('/')}`;
}

/** 文件名（兼容两种分隔符）。 */
function baseName(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() || '';
}

/** 转成可作为单层文件夹名的字符串：去掉分隔符与 Windows 非法字符，保留中文和空格。 */
function safeFolderName(name, fallback = 'draft') {
  // eslint-disable-next-line no-control-regex
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  return s || fallback;
}

module.exports = { isWindowsPath, toJianyingPath, toFileUrl, baseName, safeFolderName };
