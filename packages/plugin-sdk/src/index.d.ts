// @talekiln/plugin-sdk (MIT). Types for provider-adapter plugins.

export declare const SDK_VERSION: string;
export declare const CAPABILITIES: readonly ['llm.chat', 'image.generate', 'video.submit', 'video.poll', 'tts.synthesize', 'video.edit'];
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

/** ES256 signature over canonicalJson({ manifest without `signature`, files: { path: sha256 } }); `kid` names the official key. */
export interface ManifestSignature { alg: 'ES256'; kid: string; value: string }

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
  /** Relative paths (inside the plugin folder) whose sha256 the signature covers; must include `entry`. */
  files?: string[];
  signature?: ManifestSignature;
}

export type SignatureStatus = 'official' | 'unsigned' | 'invalid';
export declare const SIGNATURE_STATUSES: readonly ['official', 'unsigned', 'invalid'];

export interface SignatureResult {
  ok: boolean;
  status: SignatureStatus;
  /** Why it is not 'official' (e.g. 'no signature', 'unknown kid', 'bad signature', 'missing file: x', 'unlisted file: y'). */
  reason: string | null;
  kid: string | null;
  /** sha256 of the signing payload: the fingerprint shown in the UI (also computed for unsigned folders when readable). */
  hash: string | null;
  files: string[];
}

export interface Jwk { kty: string; kid?: string; [k: string]: unknown }
/** A JWKS, an array of JWKs, one JWK, a public key (KeyObject / PEM) or a resolver by kid. */
export type KeySource = { keys: Jwk[] } | Jwk[] | Jwk | import('node:crypto').KeyObject | string | ((kid: string) => Jwk | import('node:crypto').KeyObject | string | null | undefined);

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface Usage { [key: string]: unknown }

export interface LlmChatRequest { model?: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number; signal?: AbortSignal }
export type LlmChatEvent = { type: 'delta'; text: string } | { type: 'done'; text: string; usage?: Usage };
export interface ImageGenerateRequest { model?: string; prompt: string; size?: string; referenceImages?: string[]; negativePrompt?: string; signal?: AbortSignal }
export interface VideoSubmitRequest {
  model?: string; prompt: string; imageUrl?: string; firstFrameUrl?: string; lastFrameUrl?: string;
  referenceUrls?: string[]; duration?: number; resolution?: string; signal?: AbortSignal;
}
/** Region / time-range edit of an existing clip (rect normalized to 0..1); the task is polled through video.poll. */
export interface VideoEditRequest {
  model?: string; prompt: string; videoUrl: string;
  edit: { t0_ms: number; t1_ms: number; rect: { x: number; y: number; w: number; h: number }; mode: 'region' | 'segment' };
  duration?: number; resolution?: string; signal?: AbortSignal;
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
  'video.edit': (req: VideoEditRequest) => Promise<{ taskId: string }>;
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
export declare function safeRelativePath(p: unknown): boolean;
export declare function createGuardedFetch(fetchImpl: AdapterContext['fetch'], manifest: Manifest, onRequest?: (u: URL) => void): AdapterContext['fetch'];
/** Reads and validates manifest.json without running any plugin code (verify the signature before loadPlugin). */
export declare function readPluginManifest(dir: string): { root: string; manifest: Readonly<Manifest>; raw: unknown };
export declare function loadPlugin(dir: string): { manifest: Readonly<Manifest>; createAdapter: CreateAdapter };
export declare function canonicalJson(v: unknown): string;
export declare function listPluginFiles(dir: string): { files: string[]; symlinks: string[] };
export declare function hashFiles(dir: string, files: string[]): Record<string, string>;
export declare function signingPayload(manifest: object, hashes: Record<string, string>): string;
export declare function payloadHash(payload: string): string;
export declare function resolveKey(keys: KeySource, kid: string): import('node:crypto').KeyObject | null;
/** Sign a plugin folder with an EC P-256 private key (KeyObject or PKCS8 PEM); returns the manifest to write back. */
export declare function signManifest(
  manifest: Manifest | object, dir: string, privateKey: import('node:crypto').KeyObject | string, opts: { kid: string; files?: string[] },
): { manifest: Manifest & { files: string[]; signature: ManifestSignature }; hash: string; files: string[] };
/** Verify `manifest.signature` against the folder contents and the given keys. strict (default) also rejects unlisted files and symlinks. */
export declare function verifySignature(manifest: Manifest | object, dir: string, keys: KeySource, opts?: { strict?: boolean }): SignatureResult;
export declare function instantiate(
  plugin: { manifest: Manifest; createAdapter: CreateAdapter },
  cfg?: { apiKey?: string; baseUrl?: string; fetch?: AdapterContext['fetch']; log?: AdapterContext['log']; onRequest?: (u: URL) => void },
): { manifest: Readonly<Manifest>; adapter: Adapter; id: string; label: string };
export declare function defineManifest<T extends Manifest>(m: T): T;
export declare function defineAdapter<T extends Adapter>(a: T): T;
