'use strict';
/** Bump MAJOR on breaking interface changes; a plugin's sdkVersion must share the major and not exceed MINOR. */
const SDK_VERSION = '1.0.0';

/**
 * Plugin-facing capability names. `llm.chat` is what the host registry exposes as `text.stream`
 * (see bridge.js); the others keep the host's names.
 */
const CAPABILITIES = Object.freeze(['llm.chat', 'image.generate', 'video.submit', 'video.poll', 'tts.synthesize']);

const VIDEO_STATUSES = Object.freeze(['pending', 'running', 'succeeded', 'failed']);

module.exports = { SDK_VERSION, CAPABILITIES, VIDEO_STATUSES };
