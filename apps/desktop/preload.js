'use strict';
/**
 * 预加载脚本（sandbox + contextIsolation 下运行）：只向渲染端暴露「云端更新 / 公告状态」这一小组只读桥接，
 * 不暴露 ipcRenderer 本身。渲染端通过 window.talekilnDesktop 使用；在浏览器开发模式下该对象不存在，页面需自行降级。
 */
const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL = 'cloud:status';

contextBridge.exposeInMainWorld('talekilnDesktop', {
  /** 当前快照：{ currentVersion, channel, update: { available, version, forced, notes }, announcements: [...], checkedAt, error } */
  getCloudStatus: () => ipcRenderer.invoke('cloud:status'),
  /** 立刻检查一次（关于页「重新检查」）。 */
  checkCloudNow: () => ipcRenderer.invoke('cloud:check-now'),
  /** 「去下载」：交给 electron-updater（有结果弹窗），没启用更新时打开下载页；返回 { ok, mode, reason } */
  downloadUpdate: () => ipcRenderer.invoke('cloud:download'),
  /** 订阅主进程推送；返回取消函数。 */
  onCloudStatus: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_event, payload) => { try { cb(payload); } catch (_) {} };
    ipcRenderer.on(CHANNEL, handler);
    return () => ipcRenderer.removeListener(CHANNEL, handler);
  },
});
