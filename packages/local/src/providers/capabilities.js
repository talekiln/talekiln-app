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
 *      -> Promise<{status:'pending'|'running'|'succeeded'|'failed', videoUrl?, usage?, actualPrompt?, error?: ProviderError}>
 *  tts.synthesize({model?, text, voice?, format?, sampleRate?, rate?, pitch?, volume?, wordTimestamps?, signal?})
 *      -> Promise<{audio: Buffer, format, words?: {text, startMs, endMs}[], usage?}>
 *      words: per-character timing from audio start, present when wordTimestamps is true.
 *  video.edit({model?, prompt, videoUrl, edit:{t0_ms, t1_ms, rect:{x,y,w,h}, mode:'region'|'segment'}, duration?, resolution?, signal?})
 *      -> Promise<{taskId}>   (P3-R 选镜改片：带遮罩 / 时间段的视频编辑，异步任务，结果经 video.poll 轮询)
 *      rect is normalized to the frame (0..1). Neither built-in adapter implements it yet (bailian's masked
 *      video-edit model is UNVERIFIED); the region-edit service falls back to keyframe-to-video + ffmpeg splice.
 */
const CAPABILITIES = Object.freeze(['text.stream', 'image.generate', 'video.submit', 'video.poll', 'tts.synthesize', 'video.edit']);

module.exports = { CAPABILITIES };
