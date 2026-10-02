'use strict';
/**
 * Process-wide handle to the active plugin host (P3-P). providers/index.js reads it to build adapters for
 * installed plugins the same way it builds the built-in ones; app.js sets it at startup, tests set their own.
 * Kept dependency-free so it can be required from anywhere without cycles.
 */
let host = null;

function set(h) { host = h || null; }
function current() { return host; }

module.exports = { set, current };
