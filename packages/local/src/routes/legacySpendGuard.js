// 旧同步路径（POST /images、POST /videos）没有走队列，这里补上花费上限检查：
// 估价按请求里的服务商；价目表没有该服务商时按 bailian 估，免得换个服务商名就绕过上限。
const response = require('../response');

function legacyGuard(spend, kind) {
  return (req, res) => {
    if (!spend) return true;
    const b = req.body || {};
    const params = kind === 'video'
      ? { model: b.model, duration: b.duration, resolution: b.resolution }
      : { model: b.model, n: 1 };
    let v = spend.check({ provider: b.provider || 'bailian', kind, params });
    if (v.est && v.est.known === false) v = spend.check({ provider: 'bailian', kind, params });
    if (v.ok) return true;
    response.error(res, 402, 'SPEND_LIMIT', v.message);
    return false;
  };
}

module.exports = { legacyGuard };
