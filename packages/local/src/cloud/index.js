'use strict';
const { createCloudHttp, resolveBaseUrl, isConfiguredBaseUrl, CloudError } = require('./http');
const { createAccountService, AccountError } = require('./account');
const { createCatalogService } = require('./catalog');

/** 组装云端相关服务；fetchImpl / now 供测试注入。 */
function createCloud({ config, db, log, fetchImpl, now } = {}) {
  const getBaseUrl = () => resolveBaseUrl(config);
  const http = createCloudHttp({ getBaseUrl, fetchImpl });
  const account = createAccountService({ db, http, log, now });
  const catalog = createCatalogService({ db, http, log, now });
  return {
    http, account, catalog, getBaseUrl,
    isConfigured: () => isConfiguredBaseUrl(getBaseUrl()),
    requireLogin: () => !!(config && config.cloud && config.cloud.require_login),
  };
}

module.exports = { createCloud, CloudError, AccountError };
