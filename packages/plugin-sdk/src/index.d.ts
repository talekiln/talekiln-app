// @talekiln/plugin-sdk (MIT). Types for provider-adapter plugins.

export declare const SDK_VERSION: string;
export declare const CAPABILITIES: readonly ['llm.chat', 'image.generate', 'video.submit', 'video.poll', 'tts.synthesize'];
export declare const VIDEO_STATUSES: readonly ['pending', 'running', 'succeeded', 'failed'];

export type Capability = (typeof CAPABILITIES)[number];
export type ErrorCode =
  | 'INVALID_API_KEY' | 'MODEL_NOT_ENABLED' | 'INSUFFICIENT_BALANCE' | 'RATE_LIMITED'
  | 'INVALID_PARAMS' | 'TASK_FAILED' | 'NETWORK' | 'BAD_RESPONSE' | 'UNKNOWN';
export declare const ERROR_CODES: Readonly<Record<ErrorCode, ErrorCode>>;

export declare class PluginError extends Error {
  constructor(code: ErrorCode, detail?: string, extra?: { status?: number; vendorCode?: string | null });
  code: ErrorCode;
  detail: string;
  status: number | null;
  vendorCode: string | null;
}

/** `network:<host>` (host or `*.domain`) or `secret:apiKey`. At least one network permission is required. */
export type Permission = `network:${string}` | 'secret:apiKey';

export interface Manifest {
  /** ^[a-z][a-z0-9-]{1,39}$ ; becomes the provider id */
  name: string;
  version: string;
  /** SDK version the plugin was written against; same major as the host, minor not newer */
  sdkVersion: string;
  capabilities: Capability[];
  permissions: Permission[];
  /** relative .js/.cjs file exporting createAdapter(ctx) */
  entry: string;
  label?: string;
  description?: string;
  homepage?: string;
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface Usage { [key: string]: unknown }

export interface LlmChatRequest { model?: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number; signal?: AbortSignal }
export type LlmChatEvent = { type: 'delta'; text: string } | { type: 'done'; text: string; usage?: Usage };
export interface ImageGenerateRequest { model?: string; prompt: string; size?: string; referenceImages?: string[]; negativePrompt?: string; signal?: AbortSignal }
export interface VideoSubmitRequest {
  model?: string; prompt: string; imageUrl?: string; firstFrameUrl?: string; lastFrameUrl?: string;
  referenceUrls?: string[]; duration?: number; resolution?: string; signal?: AbortSignal;
}
export interface VideoPollRequest { taskId: string; signal?: AbortSignal }
export interface VideoPollResult {
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  videoUrl?: string; usage?: Usage; actualPrompt?: string; error?: PluginError;
}
export interface TtsRequest {
  model?: string; text: string; voice?: string; format?: string; sampleRate?: number;
  rate?: number; pitch?: number; volume?: number; wordTimestamps?: boolean; signal?: AbortSignal;
}
export interface TtsResult {
  audio: Uint8Array; format: string;
  words?: { text: string; startMs: number; endMs: number }[]; usage?: Usage;
}

export interface CapabilityMap {
  /** Promise of the full reply, or an async iterable of delta/done events. */
  'llm.chat': (req: LlmChatRequest) => Promise<{ text: string; usage?: Usage }> | AsyncIterable<LlmChatEvent> | Promise<AsyncIterable<LlmChatEvent>>;
  'image.generate': (req: ImageGenerateRequest) => Promise<{ urls: string[] }>;
  'video.submit': (req: VideoSubmitRequest) => Promise<{ taskId: string }>;
  'video.poll': (req: VideoPollRequest) => Promise<VideoPollResult>;
  'tts.synthesize': (req: TtsRequest) => Promise<TtsResult>;
}

export interface ProbeResult { ok: boolean; costly: boolean }

export interface Adapter {
  label?: string;
  /** Only the capabilities declared in the manifest, each exactly once. */
  capabilities: Partial<CapabilityMap>;
  /** Zero or near-zero cost connectivity test per capability; failures throw PluginError (key / model / balance distinguishable). */
  probe?: (capability: Capability, opts?: { model?: string; signal?: AbortSignal }) => Promise<ProbeResult>;
  /** Vendor HTTP error -> unified error. Must never throw, must not echo secrets. */
  mapError: (status: number, body: unknown, extra?: Record<string, unknown>) => PluginError;
}

export interface AdapterContext {
  /** Present only when the manifest requests `secret:apiKey`. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Permission-guarded fetch: https only, hosts from the manifest's network permissions. */
  readonly fetch: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;
  readonly log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

export type CreateAdapter = (ctx: AdapterContext) => Adapter;

export interface Validation { ok: boolean; errors: string[] }
export declare function validateManifest(input: unknown): Validation & { manifest: Readonly<Manifest> | null };
export declare function validateAdapter(adapter: unknown, manifest: Manifest): Validation;
export declare function allowedHosts(manifest: Manifest): string[];
export declare function hostAllowed(hostname: string, patterns: string[]): boolean;
export declare function createGuardedFetch(fetchImpl: AdapterContext['fetch'], manifest: Manifest, onRequest?: (u: URL) => void): AdapterContext['fetch'];
export declare function loadPlugin(dir: string): { manifest: Readonly<Manifest>; createAdapter: CreateAdapter };
export declare function instantiate(
  plugin: { manifest: Manifest; createAdapter: CreateAdapter },
  cfg?: { apiKey?: string; baseUrl?: string; fetch?: AdapterContext['fetch']; log?: AdapterContext['log']; onRequest?: (u: URL) => void },
): { manifest: Readonly<Manifest>; adapter: Adapter; id: string; label: string };
export declare function defineManifest<T extends Manifest>(m: T): T;
export declare function defineAdapter<T extends Adapter>(a: T): T;
