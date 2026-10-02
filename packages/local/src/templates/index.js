'use strict';
const { createTemplateService, DEFAULT_BUILTIN_DIR } = require('./service');
const { TemplateError } = require('./errors');
const schema = require('./schema');
const { isPro, proReason } = require('./entitlement');
const { loadPackage } = require('./package');

module.exports = { createTemplateService, TemplateError, DEFAULT_BUILTIN_DIR, schema, isPro, proReason, loadPackage };
