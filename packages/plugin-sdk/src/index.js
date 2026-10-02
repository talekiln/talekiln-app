'use strict';
const constants = require('./constants');
const errors = require('./errors');
const manifest = require('./manifest');
const adapter = require('./adapter');
const signing = require('./signing');

/** Identity helpers: give plugin authors type inference without a runtime cost. */
const defineManifest = (m) => m;
const defineAdapter = (a) => a;

module.exports = {
  ...constants,
  ...errors,
  ...manifest,
  ...adapter,
  ...signing,
  defineManifest,
  defineAdapter,
};
