'use strict';
const { createStudioService, resolveLocal, IDENTITY_KEY, CURRENT_KEY, WRITER_ROLES } = require('./service');
const { StudioError } = require('./errors');
const manifest = require('./manifest');

module.exports = { createStudioService, StudioError, manifest, resolveLocal, IDENTITY_KEY, CURRENT_KEY, WRITER_ROLES };
