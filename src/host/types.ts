/**
 * Shared structural types for the Host half.
 *
 * The Host wires its modules together with an injected dependency object
 * (`HostDeps`). That object is built once in `index.ts` from the Cordis
 * context and passed down; the runtime fields are many and come from peers
 * that ship no `.d.ts`, so the single source of truth for "what a dep may
 * carry" lives here rather than in per-file `{}` placeholders (which TS
 * reads as an empty object and then rejects every field access on).
 * @module dsh-connect-agnes-token-plan/types
 */

import type { createTokenStore } from "./token-store.ts";
import type { createApiKeyStore } from "./api-key-store.ts";
import type { createFileCatalogStore } from "./catalog-store.ts";
import type { createFileProviderStore } from "./provider-store.ts";
import type { createFileDrawStore } from "./draw-store.ts";
import type { createFileVideoStore } from "./video-store.ts";
import type { createProviderPublisher } from "./provider-publish.ts";
import type { createAgnescodeStore } from "./agnescode-store.ts";
import type { createFileAgnescodeStore } from "./agnescode-switch-store.ts";
import type { wireAgnescodePublisher } from "./agnescode-lifecycle.ts";

/** A failure code this plugin can produce or carry (a `CODE` wire value). */
export type CodeValue = string;

/**
 * The dependency bag injected into the Host modules. Every field is optional:
 * each consumer falls back to a local default when a field is absent, so a
 * module keeps working even if `index.ts` does not wire a given capability.
 * Peer-typed members (`logger`, `emit`, …) use loose types because the
 * matching `@deepseek-ai/*` packages ship no declarations in this repo.
 */
export interface HostDeps {
  /** Resolved plugin settings object. */
  settings?: any;
  /** Toggle that flips the sidebar panel on/off from the Host. */
  panelSwitch?: any;
  /** Lazy-load the LLM adapter module (peer `dsh-llm-pi-ai`). */
  loadAdapterModule?: any;
  /** Lazy-load the AgnesCode LLM adapter module (ROADMAP §6.3 third provider). */
  loadAgnescodeAdapterModule?: any;
  /** Resolve the registered LLM instance. */
  getLlm?: any;
  /** Resolve the API key from the credentials service. */
  resolveApiKey?: any;
  /** Cordis event emitter. */
  emit?: (...args: any[]) => void;
  /** Cordis logger (loose: peer has no declarations here). */
  logger?: any;
  /** Lazy-load the tools module. */
  loadToolsModule?: any;
  /** Host webserver fetch used by the draw route. */
  drawFetch?: (...args: any[]) => Promise<any>;
  /** Host webserver fetch used by the video route (mirrors `drawFetch`). */
  videoFetch?: (...args: any[]) => Promise<any>;
  /** Login-trace sink used by the auth half. */
  onTrace?: (...args: any[]) => void;
  /** The resolved credential record. */
  credential?: any;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Base URL override for the LLM adapter / provider config. */
  baseUrl?: string;
  /** Login request timeout in milliseconds (config alias). */
  requestTimeoutMs?: number;
}

/**
 * The host root context the Host modules read: the Cordis service bag.
 *
 * Loose on `get` because the matching `@deepseek-ai/*` packages ship no
 * declarations in this repo; the members the Host actually touches are named.
 * Declared here rather than per-module so `lifecycle.ts` and the routes family
 * share one shape — an untyped `ctx` is how a renamed service escapes the
 * compiler.
 */
export interface HostCtx {
  get(service: string): any;
  tools?: { register(definition: unknown): unknown } | null;
  effect?(callback: () => () => void, label?: string): void;
  /**
   * The Host web server every route registers on. REQUIRED (not optional like
   * the probes above): a route module cannot do anything without it, and a
   * `webServer?` would force a null-check that duplicates the fact that the
   * Host always provides it. Loose on the route shape — the peer ships no
   * declarations — but the member the routes actually touch is named, and
   * `register` is declared to return the `off()` callback it really returns.
   */
  webServer: {
    register(route: {
      kind: string;
      path: string;
      handler: (request: any, response: any) => unknown;
    }): () => void;
  };
}

/** Options every file-backed store accepts. */
export interface StoreOptions {
  /** Profile key; stores are segmented per profile. */
  profile?: string | null;
  /** Clock override for tests. */
  now?: () => number;
  /** Idle entry TTL in milliseconds. */
  ttlMs?: number;
  /** Directory the store persists into. */
  dir?: string;
}

/** A draw (image generation) request body. */
export interface DrawRequest {
  model: string;
  prompt: string;
  n: number;
  size: string;
  responseFormat: string;
  /** Aspect ratio (e.g. "16:9"); forwarded under `extra_body.ratio` (Agnes dialect). */
  ratio?: string;
  /** Reference image URLs / Data URIs for img2img; forwarded as `extra_body.image`. */
  image?: string[];
  /** Request Base64 output instead of a URL (text2img only); forwarded as `extra_body.return_base64`. */
  returnBase64?: boolean;
}

/** A provider/adapter configuration object. */
export interface AdapterConfig {
  providerId?: string;
  enabledIds?: string[];
  unavailableModelIds?: string[];
  baseUrl?: string;
}

/** Dependency bag for the AgnesCode provider publisher (`agnescode-publish.ts`). */
export interface AgnescodePublisherDeps {
  /** Panel-saved switch value; `null` = state file untouched (provider stays OFF). */
  panelSwitch?: () => Promise<boolean | null>;
  /** Resolve the live AgnesCode JWT per request (empty when not harvested). */
  resolveToken?: () => Promise<string>;
  /** Optional-service resolver for the `llm` registration service. */
  getLlm?: (service: string) => any;
  /** Lazy-load the AgnesCode adapter factory module (peer `dsh-llm-pi-ai`). */
  loadAdapterModule?: () => Promise<{ createAgnescodeAdapter: (...args: any[]) => any }>;
  /** Cordis event emitter for `llm/adapters-updated`. */
  emit?: (event: string) => void;
  /** Cordis logger (loose: the peer ships no declarations here). */
  logger?: { warn: (message: string) => void };
}

/** Options for the AgnesCode adapter factory (`agnescode-llm-adapter.ts`). */
export interface AgnescodeAdapterOptions {
  /** The roster rows to offer (`agnescodeRoster` result). */
  rows?: any[];
  /** The credential's pinned per-account BFF base (`bffPublicBaseUrl`). */
  bffBase?: string;
  /** Resolve the live AgnesCode JWT per request (re-harvested when expired). */
  resolveToken?: () => Promise<string>;
  /** Service resolver (reserved for the image hooks). */
  get?: (service: string) => any;
}

/**
 * An `Error` with the stable `code` the panel branches on, plus optional
 * structured fields. The fields are attached at runtime (not inherited), so
 * this is a structural annotation: a `catch (e)` downstream may read `e.code`.
 */
export interface PluginError extends Error {
  code?: CodeValue;
  retryAfterMs?: number;
  detail?: unknown;
  trace?: unknown[];
}

// ---------------------------------------------------------------------------
// Wiring / options shapes. Annotating a parameter with one of these clears the
// "injected dependency bag" family of implicit-any errors in one place rather
// than one binding at a time; each field mirrors a real runtime shape (the
// wiring object `apply()` builds, the tool mount bag, the settings row), so the
// type is derived rather than guessed.
// ---------------------------------------------------------------------------

/** Operator login-flow overrides, exactly the keys `host-config.ts` writes. */
export interface AuthOverrides {
  consoleOrigin: string;
  loginPath?: string;
  requestTimeoutMs?: number;
  fallbackExpiresInSeconds?: number;
}

/**
 * The plugin's resolved settings row (`resolveSettings`).
 *
 * Structural on purpose: consumers read only the fields they need, and the row
 * is built from the operator's patch config, so this is the contract the Host
 * half consumes rather than a description of how the row is produced.
 */
export interface Settings {
  consoleBase: string;
  apiBase: string;
  usageDays: number;
  cacheSeconds: number;
  pollSeconds: number;
  consoleTimeoutMs: number;
  tokenSkewSeconds: number;
  allowedHosts: Set<string>;
  trendMultipliers: Record<string, number>;
  registerProvider: boolean;
  drawEnabled: boolean;
  drawModelId: string;
  drawTimeoutMs: number;
  videoEnabled: boolean;
  videoModelId: string;
  videoTimeoutMs: number;
  videoWidth: number;
  videoHeight: number;
  videoNumFrames: number;
  videoFrameRate: number;
  writeImageModelIds: boolean;
  imageModelIds: string[];
  visionModels: unknown[];
  auth: AuthOverrides;
}

/** One console-response cache entry (`{body, at}`). */
export interface CacheEntry {
  body: unknown;
  at: number;
}

/** The console-response cache shared across polls. */
export type CacheMap = Map<string, CacheEntry>;

/** The single-flight map: one in-flight console call per URL. */
export type InflightMap = Map<string, Promise<unknown>>;

/**
 * A panel-saved switch store's FULL surface, as `createSwitchStore` returns it
 * (`draw-store` / `video-store`): the panel's live value always beats the
 * config default, and an untouched state file reports `null` so the caller
 * falls back to it.
 *
 * The write half (`save` / `saveModel`) is part of the interface because the
 * switch routes call it; leaving it out only pushed that fact into an implicit
 * `any`. `createFileProviderStore` deliberately exposes a SUBSET (on/off only,
 * no model preference) and is typed by its own factory — do not widen either
 * one to fit the other.
 */
export interface SwitchStore {
  enabled(): Promise<boolean | null>;
  modelId(): Promise<string | null>;
  isSet(): Promise<boolean>;
  save(value: unknown): Promise<void>;
  forget(): Promise<void>;
  saveModel(value: string | null): Promise<void>;
  forgetModel(): Promise<void>;
}

/**
 * The fetch these modules perform. `RequestInit` matches every call site (the
 * JSON header / bearer / body objects they build); the return is loose because
 * tests stub a minimal `{ok, json, text}` response.
 */
export type FetchFn = (url: string, options?: RequestInit) => Promise<any>;

/**
 * The bag `mountAgentTool` hands `defineDrawTool` / `defineVideoTool`.
 *
 * Pure wiring: every side effect (key resolution, the live catalog, the fetch,
 * disposal) is injected rather than read from module state. Loose on the peer
 * edges (`defineTool`, `fetchImpl`) because the matching `@deepseek-ai/*`
 * packages ship no declarations here.
 */
export interface ToolWiring {
  /** The peer's tool factory (`dsh-tools`). */
  defineTool: (...args: any[]) => any;
  /** Resolve the live `sk-` key (empty when not configured). */
  resolveApiKey: () => Promise<string | undefined>;
  /** Read the discovery set at call time (the catalog, not the picker). */
  getEntries: () => Promise<unknown[]>;
  settings: Settings;
  fetchImpl: FetchFn;
  /** `true` after unmount, so a late call fails instead of leaking. */
  isDisposed?: () => boolean;
}

/** The mount-time test seams `apply`'s `deps` inject (`startSideEffects`). */
export interface ToolSide {
  loadToolsModule?: () => any;
  drawFetch: FetchFn;
  videoFetch: FetchFn;
}

/**
 * The wiring bag `apply()` assembles once at mount and hands to the routes and
 * the side effects. Store / publisher members are derived from their factory
 * return types so a renamed method cannot silently drift from the type.
 */
export interface HostWiring {
  settings: Settings;
  configError: string | null;
  cache: CacheMap;
  inflight: InflightMap;
  tokenStore: ReturnType<typeof createTokenStore>;
  apiKeyStore: ReturnType<typeof createApiKeyStore>;
  catalogStore: ReturnType<typeof createFileCatalogStore>;
  providerStore: ReturnType<typeof createFileProviderStore>;
  drawStore: ReturnType<typeof createFileDrawStore>;
  videoStore: ReturnType<typeof createFileVideoStore>;
  publisher: ReturnType<typeof createProviderPublisher>;
  providerState: ReturnType<typeof createProviderPublisher>["state"];
  publishProvider: (entries: any[], enabledIds: string[], unavailableModelIds?: any[]) => unknown;
  releaseProvider: () => unknown;
  resolveApiKey: () => Promise<string | undefined>;
  visionPublish: { current: ((visionEntries: unknown[], ids: string[]) => Promise<void>) | null };
  logger?: {
    warn?: (message: string, ...rest: unknown[]) => void;
    error?: (message: string, ...rest: unknown[]) => void;
    info?: (message: string, ...rest: unknown[]) => void;
  };
  agnescodeStore: ReturnType<typeof createAgnescodeStore>;
  agnescodeSwitch: ReturnType<typeof createFileAgnescodeStore>;
  agnescodePublisher: ReturnType<typeof wireAgnescodePublisher>["publisher"];
}
