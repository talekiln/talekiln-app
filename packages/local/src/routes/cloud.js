'use strict';
const response = require('../response');
const { resolveKeyPage } = require('../cloud/referral');

/** 云端错误码 -> 本地 HTTP 状态 + 稳定错误码 + 中文提示。 */
const MAP = {
  invalid_invite: [400, 'INVALID_INVITE', '邀请码无效、已被使用或已过期'],
  email_taken: [409, 'EMAIL_TAKEN', '该邮箱已注册，请直接登录'],
  invalid_credentials: [401, 'INVALID_CREDENTIALS', '邮箱或密码错误'],
  device_revoked: [403, 'DEVICE_REVOKED', '此设备已被停用，请联系管理员'],
  bad_request: [400, 'BAD_REQUEST', '输入格式不正确（邮箱格式有误，或密码少于 8 位）'],
  SESSION_EXPIRED: [401, 'SESSION_EXPIRED', '登录已失效，请重新登录'],
  NOT_LOGGED_IN: [401, 'NOT_LOGGED_IN', '尚未登录'],
  LICENCE_INVALID: [502, 'LICENCE_INVALID', '云端返回的许可证无法验证'],
  cloud_not_configured: [503, 'CLOUD_NOT_CONFIGURED', '尚未配置云端地址（config.yaml 的 cloud.base_url）'],
  network: [503, 'CLOUD_UNREACHABLE', '无法连接云端，请检查网络后重试'],
  invalid_token: [401, 'SESSION_EXPIRED', '登录已失效，请重新登录'],
  token_reuse: [401, 'SESSION_EXPIRED', '登录已失效，请重新登录'],
  SECRET_STORE_UNAVAILABLE: [500, 'SECRET_STORE_UNAVAILABLE', '系统密钥加密不可用，无法安全保存登录状态'],
  // P2-C 短信 / 微信登录
  invalid_code: [401, 'INVALID_CODE', '验证码错误'],
  code_expired: [400, 'CODE_EXPIRED', '验证码已过期或尚未发送，请重新获取'],
  invite_required: [400, 'INVITE_REQUIRED', '首次登录需要邀请码'],
  qr_expired: [410, 'QR_EXPIRED', '二维码已过期或已使用，请刷新'],
  sms_unavailable: [503, 'LOGIN_METHOD_UNAVAILABLE', '短信登录暂不可用，请改用邮箱密码登录'],
  wechat_unavailable: [503, 'LOGIN_METHOD_UNAVAILABLE', '微信登录暂不可用，请改用邮箱密码登录'],
  rate_limited: [429, 'CLOUD_RATE_LIMITED', '操作过于频繁，请稍后再试'],
  account_disabled: [403, 'ACCOUNT_DISABLED', '账号已停用，请联系管理员'],
  not_found: [404, 'NOT_FOUND', '二维码不存在或已失效'],
};

function sendError(res, err, log, name) {
  const key = err && (err.code || err.message);
  const hit = MAP[key];
  if (hit) return response.error(res, hit[0], hit[1], hit[2]);
  if (err && err.name === 'CloudError' && err.status >= 500) return response.error(res, 502, 'CLOUD_ERROR', '云端暂时不可用，请稍后重试');
  log && log.error && log.error(`cloud ${name}`, { code: key }); // 不记录请求体（含密码）
  return response.error(res, 502, 'CLOUD_ERROR', '云端请求失败，请稍后重试');
}

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

function cloudRoutes(cloud, log) {
  const wrap = (name, fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) { sendError(res, err, log, name); }
  };
  const view = (s) => ({ ...s, configured: cloud.isConfigured(), require_login: cloud.requireLogin() });
  return {
    register: wrap('register', async (req, res) => {
      const b = req.body || {};
      if (!str(b.invite_code, 100) || !str(b.email, 200) || !str(b.password, 200)) return response.badRequest(res, '邀请码、邮箱、密码均为必填');
      response.success(res, view(await cloud.account.register({ inviteCode: b.invite_code, email: b.email, password: b.password })));
    }),
    login: wrap('login', async (req, res) => {
      const b = req.body || {};
      if (!str(b.email, 200) || !str(b.password, 200)) return response.badRequest(res, '邮箱和密码均为必填');
      response.success(res, view(await cloud.account.login({ email: b.email, password: b.password })));
    }),
    logout: wrap('logout', async (req, res) => response.success(res, view(await cloud.account.logout()))),

    // ---- P2-C 短信验证码 / 微信扫码（本地只做参数检查与透传，限频、验证码、票据状态机都在云端）
    smsSend: wrap('smsSend', async (req, res) => {
      const b = req.body || {};
      if (!str(b.phone, 20)) return response.badRequest(res, '请输入手机号');
      response.success(res, await cloud.account.smsSend({ phone: b.phone }));
    }),
    smsLogin: wrap('smsLogin', async (req, res) => {
      const b = req.body || {};
      if (!str(b.phone, 20) || !str(b.code, 10)) return response.badRequest(res, '手机号和验证码均为必填');
      if (b.invite_code !== undefined && b.invite_code !== '' && !str(b.invite_code, 100)) return response.badRequest(res, '邀请码格式不正确');
      response.success(res, view(await cloud.account.smsLogin({ phone: b.phone, code: b.code, inviteCode: b.invite_code || undefined })));
    }),
    wechatQr: wrap('wechatQr', async (req, res) => response.success(res, await cloud.account.wechatQr())),
    wechatQrStatus: wrap('wechatQrStatus', async (req, res) => {
      if (!str(req.params.ticket, 64)) return response.badRequest(res, '票据不合法');
      response.success(res, await cloud.account.wechatQrStatus(req.params.ticket));
    }),
    wechatConfirm: wrap('wechatConfirm', async (req, res) => {
      if (!str(req.params.ticket, 64)) return response.badRequest(res, '票据不合法');
      const b = req.body || {};
      response.success(res, await cloud.account.wechatConfirm(req.params.ticket, { openId: str(b.open_id, 100) ? b.open_id : undefined, scanOnly: b.scan_only === true }));
    }),
    wechatLogin: wrap('wechatLogin', async (req, res) => {
      const b = req.body || {};
      if (!str(b.ticket, 64)) return response.badRequest(res, '票据不合法');
      if (b.invite_code !== undefined && b.invite_code !== '' && !str(b.invite_code, 100)) return response.badRequest(res, '邀请码格式不正确');
      response.success(res, view(await cloud.account.wechatLogin({ ticket: b.ticket, inviteCode: b.invite_code || undefined })));
    }),
    /** GET /account/status[?sync=1]：sync=1 时按需续期许可证；POST /account/refresh 强制续期。 */
    status: wrap('status', async (req, res) => response.success(res, view(await cloud.account.status({ sync: req.query.sync === '1' })))),
    refresh: wrap('refresh', async (req, res) => response.success(res, view(await cloud.account.status({ force: true })))),

    catalog: wrap('catalog', async (req, res) => response.success(res, cloud.catalog.getCatalog())),
    catalogRefresh: wrap('catalogRefresh', async (req, res) => {
      const r = await cloud.catalog.refresh();
      response.success(res, { refresh: r, catalog: cloud.catalog.getCatalog({ backgroundRefresh: false }) });
    }),

    /** GET /referral/:provider -> { url, via }，供「添加 Key」向导打开密钥页。 */
    referral: wrap('referral', async (req, res) => {
      const r = resolveKeyPage({ baseUrl: cloud.getBaseUrl(), provider: req.params.provider, src: 'addkey' });
      if (!r) return response.notFound(res, '未知的平台');
      response.success(res, r);
    }),
  };
}

module.exports = cloudRoutes;
module.exports.MAP = MAP;
