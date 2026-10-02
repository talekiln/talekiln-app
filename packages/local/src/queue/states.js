'use strict';
const STATES = Object.freeze({
  QUEUED: 'queued',
  SUBMITTING: 'submitting',
  SUBMITTED: 'submitted',
  POLLING: 'polling',
  DOWNLOADING: 'downloading',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
/** States that occupy a provider concurrency slot. */
const ACTIVE = ['submitting', 'submitted', 'polling', 'downloading'];

const TRANSITIONS = {
  queued: ['submitting', 'cancelled', 'failed'],
  submitting: ['submitted', 'queued', 'failed', 'cancelled'],
  submitted: ['polling', 'downloading', 'succeeded', 'failed', 'cancelled'],
  polling: ['polling', 'downloading', 'succeeded', 'failed', 'cancelled'],
  downloading: ['downloading', 'succeeded', 'failed', 'cancelled'], // self: transient download error, retry later
  succeeded: [],
  failed: [],
  cancelled: [],
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = { STATES, TERMINAL, ACTIVE, TRANSITIONS, canTransition };
