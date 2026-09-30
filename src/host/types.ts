/**
 * Shared structural types for the Host half.
 *
 * The Host wires its modules together with an injected dependency object
 * (`HostDeps`). That object is built once in `index.ts` from the Cordis
 * context and passed down; the runtime fields are many and come from peers
 * that ship no `.d.ts`, so the single source of truth for "what a dep may
 * carry" lives here rather than in per-file `{}` placeholders (which TS
 * reads as an empty object and then rejects every field access on).
 * @module dsh-connect-sensenova-token-plan/types
 */

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
  /** Lazy-load the Raccoon LLM adapter module (ROADMAP §6.1 second provider). */
  loadRaccoonAdapterModule?: any;
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
  /** Login-trace sink used by the auth half. */
  onTrace?: (...args: any[]) => void;
  /** The resolved credential record. */
  credential?: any;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** JWKS endpoint override. */
  jwksEndpoint?: string;
  /** Encryption key id used by the JWE sealer. */
  encKeyId?: string;
  /** Base URL override for the LLM adapter / provider config. */
  baseUrl?: string;
  /** Shared JWKS cache. */
  cache?: any;
  /** Max redirect hops for the login trace. */
  maxHops?: number;
  /** Login request timeout in milliseconds (config alias). */
  requestTimeoutMs?: number;
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
}

/** A provider/adapter configuration object. */
export interface AdapterConfig {
  providerId?: string;
  enabledIds?: string[];
  unavailableModelIds?: string[];
  baseUrl?: string;
}

/** Options for the JWKS cache / JWE sealer. */
export interface JwksOptions {
  /** A caller-owned key-set cache; typed loosely (see createJwksCache). */
  cache?: any;
  jwksEndpoint?: string;
  encKeyId?: string;
  timeoutMs?: number;
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
