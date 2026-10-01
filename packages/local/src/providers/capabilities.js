'use strict';
/**
 * Unified capability interface. Business code calls by capability, never vendor SDK.
 *
 *  text.stream({model, messages, temperature?, maxTokens?, signal?})
 *      -> AsyncIterable<{type:'delta', text} | {type:'done', text, usage?}>
 *  image.generate({model?, prompt, size?, referenceImages?, negativePrompt?, signal?})
 *      -> Promise<{urls: string[]}>
 *  video.submit({model?, prompt, imageUrl?, firstFrameUrl?, lastFrameUrl?, referenceUrls?, duration?, resolution?, signal?})
 *      -> Promise<{taskId}>
 *  video.poll({taskId, signal?})
 *      -> Promise<{status:'pending'|'running'|'succeeded'|'failed', videoUrl?, error?: ProviderError}>
 *  tts.synthesize({model?, text, voice?, format?, sampleRate?, rate?, pitch?, volume?, wordTimestamps?, signal?})
 *      -> Promise<{audio: Buffer, format, words?: {text, startMs, endMs}[], usage?}>
 *      words: per-character timing from audio start, present when wordTimestamps is true.
 */
const CAPABILITIES = Object.freeze(['text.stream', 'image.generate', 'video.submit', 'video.poll', 'tts.synthesize']);

/** Providers exposed in phase 1. Everything else stays hidden from the registry. */
const PHASE1_PROVIDERS = Object.freeze(['bailian', 'ark']);

module.exports = { CAPABILITIES, PHASE1_PROVIDERS };
