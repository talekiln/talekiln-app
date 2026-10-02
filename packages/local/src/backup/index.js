'use strict';
// P3-K 可选云备份：S3 兼容客户端 + 备份服务 + 每日调度器。见 docs/phase3-backup.md。
const s3 = require('./s3');
const service = require('./service');

module.exports = { ...service, ...s3 };
