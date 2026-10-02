'use strict';
const constants = require('./constants');
const errors = require('./errors');
const manifest = require('./manifest');
const adapter = require('./adapter');

/** Identity helpers: give plugin authors type inference without a runtime cost. */
const defineManifest = (m) => m;
const defineAdapter = (a) => a;

module.exports = {
  ...constants,
  ...errors,
  ...manifest,
  ...adapter,
  defineManifest,
  defineAdapter,
};
