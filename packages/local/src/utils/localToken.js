'use strict';
const crypto = require('crypto');

/** 本地服务令牌校验中间件：令牌由桌面主进程每次启动生成；未设置时（纯开发）放行。 */
function localTokenGuard(token) {
  if (!token) return (req, res, next) => next();
  const expected = Buffer.from(token);
  return (req, res, next) => {
    const got = Buffer.from(String(req.headers['x-talekiln-token'] || ''));
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}

module.exports = { localTokenGuard };
