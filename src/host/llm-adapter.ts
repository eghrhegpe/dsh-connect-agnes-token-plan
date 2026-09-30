/**
 * The peer-dependent half of the directly-registered SenseNova provider.
 *
 * Everything here runs against Host-shipped peers (`pi-ai`, `dsh-llm`,
 * `dsh-llm-pi-ai`), which is exactly why the descriptor mapping lives in the
 * peer-free `llm-models.ts` instead: this module cannot be imported by the
 * offline unit suite, so it holds only assembly against the runtime and is
 * exercised in wiring/e2e checks.
 *
 * The shape mirrors the qoder adapter that is known to work:
 *
 * - ONE `PiAiAdapter` carrying one profile (this provider has one region —
 *   `https://token.sensenova.cn/v1`);
 * - an INERT pi-ai auth plane — the key is resolved per request from the
 *   plugin's own store, pi-ai must never manufacture a credential;
 * - both IMAGE hooks wired, or an image-accepting model answers
 *   `UNSUPPORTED_CONTENT` the moment a message carries an image;
 * - no API key baked into the profile: the picker advertises models without
 *   one and a request fails at resolve time, where the panel status is visible.
 *
 * @module dsh-connect-sensenova-token-plan/llm-adapter
 */
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy, resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import { name } from "./host-config.ts";
import { buildDescriptors, LLM_PROVIDER_ID, LLM_DISPLAY_NAME } from "./llm-models.ts";
import { buildRetryPolicyConfig } from "./llm-retry.ts";
import { reclassifyStream } from "./llm-error-fix.ts";

/** Idle ceiling while one stream read is outstanding (dsh-llm-pi-ai default). */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Image budgets at the `dsh-llm-pi-ai` defaults. They bound requests to models
 * whose catalog descriptor declares image input; text-only models never see
 * images.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576
};

/**
 * Inert pi-ai auth plane.
 *
 * Authentication goes through `resolveApiKey` (the stored `SENSENOVA_API_KEY`
 * reference) per request. pi-ai's own credential lifecycle must never
 * manufacture a credential for this route, so every ambient question answers
 * "nothing stored, nothing set".
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    // Deliberately a no-op, not a throw: pi-ai may call `modify` as an
    // optional "persist the latest credential" hook during a normal request,
    // and an exception there would 500 a conversation that is otherwise
    // working. The credential lifecycle for this route lives in
    // `api-key-storets`, not here.
    async modify() {},
    async delete() {}
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    }
  }
};

/**
 * The `fs` service face the image hook reads — a single host-path mapper, and
 * only that. Resolved lazily through `get("fs")` because the service may be
 * registered after this adapter is built.
 * @typedef {object} FsService
 * @property {(hostPath: string) => unknown} [processPathFromHostPath]
 */

/**
 * Assemble the adapter instance for one catalog snapshot.
 *
 * A fresh instance per rebuild is deliberate: `PiAiAdapter` memoizes the
 * profiles snapshot internally (`if (this.snapshot?.profiles === profiles)`),
 * so the caller REPLACES the registered adapter when the catalog or key changes
 * and emits `llm/adapters-updated`, exactly as the qoder route refreshes its
 * own registration.
 * @param {object} options - wiring.
 * @param {object[]} options.entries - the normalized catalog entries.
 * @param {string[]} [options.enabledIds] - the curated allow-list; empty means
 *   every catalog model is offered.
 * @param {string} options.baseUrl - the OpenAI-compatible base URL.
 * @param {() => Promise<string>} options.resolveApiKey - resolves the live
 *   `sk-` key per request.
 * @param {(service: string) => unknown} [options.get] - service resolver for
 *   the image hooks (`attachments`, `fs`).
 * @param {string[]} [options.unavailableModelIds] - model ids whose quota pool
 *   is exhausted; excluded from the offer so no doomed `429` request is sent.
 * @returns {{adapter: object, providerIds: string[]}} the adapter and the ids
 *   it owns.
 */
export function createSensenovaAdapter({ entries, enabledIds = [], baseUrl, resolveApiKey, get, unavailableModelIds = [] }) {
  const models = buildDescriptors(entries, { providerId: LLM_PROVIDER_ID, baseUrl, enabledIds, unavailableModelIds });

  const provider = {
    ...createProvider({
      id: LLM_PROVIDER_ID,
      name: LLM_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: "SenseNova API key",
          /**
           * pi-ai hands the credential it resolved; this route stores none, so
           * the parameter is typed only to name what is read off it.
           * @param {{credential?: {key?: string}}} [options]
           */
          async resolve({ credential }: { credential?: { key?: string } } = {}) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: LLM_DISPLAY_NAME };
          }
        }
      },
      models,
      api: openAICompletionsApi()
    }),
    // The adapter's resolver re-reads the provider to discover its models;
    // returning the immutable descriptor set this build was registered with.
    getModels: () => models
  };

  const profiles = new Map([
    [
      LLM_PROVIDER_ID,
      {
        provider: LLM_PROVIDER_ID,
        displayName: LLM_DISPLAY_NAME,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        // Quota-aware retry policy: explicit (not `undefined`) so a future peer
        // default change cannot silently alter this provider. Excludes the quota
        // codes (a depleted pool cannot be retried into health; see
        // `llm-retry.ts`), keeps `RATE_LIMIT` with a gentle shared-pool backoff.
        retryPolicy: resolveRetryPolicy(buildRetryPolicyConfig(), `${name}.${LLM_PROVIDER_ID}.retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        // The picker's "Default" pins to high. SenseNova thinks by default
        // (reasoning_effort default high), and the descriptor's thinkingLevelMap
        // spells off as `none`, so an unselected effort must not reach pi-ai as
        // "no effort" — that would dispatch `map.off` and silently turn thinking
        // off. Pinning the profile default to high keeps the platform default.
        reasoning: "high",
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider
      }
    ]
  ]);

  const inner = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // The stored API-key reference is the only credential this route presents;
    // it is read per request, so rotating the key needs no re-registration.
    resolveApiKey: async () => resolveApiKey(),
    // Image input is a hard requirement of pi-ai, not an optional extra:
    // `streamWithSnapshot` throws UNSUPPORTED_CONTENT whenever a message
    // carries an image and `resolveAttachments()` yields undefined. Both hooks
    // are wired the same way the official `llm-pi-ai` plugin wires them.
    resolveAttachments: () => get?.("attachments"),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath) =>
          /** @type {FsService | undefined} */ (get?.("fs"))?.processPathFromHostPath?.(hostPath),
        ref
      )
  });

  // 429 误判纠正层：peer 的 `classifyPiAiError` 会把带 "budget/credits" 字眼的
  // 限频 429 抢判成 QUOTA（不重试），本 Proxy 把这类误判体在出流前纠正回
  // RATE_LIMIT，使 `llm-retry.ts` 的退避重试真正生效。只拦截流出口，不触碰
  // peer 内部逻辑，也不影响任何正常数据 chunk。详见 `llm-error-fixts`。
  const adapter = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // `stream(...)` 与 `prepareCall(...).stream` 都返回一个 async iterable；
      // 二者据此包裹重判流。其它成员（含 image/resolveApiKey 等）原样放行。
      if (prop === "stream") {
        return (options) => reclassifyStream(target.stream(options));
      }
      if (typeof value === "function" && prop === "prepareCall") {
        return (...args) => {
          const prepared = value.apply(target, args);
          if (prepared && typeof prepared.then === "function") {
            return prepared.then((p) => p && typeof p.stream === "function"
              ? { ...p, stream: (o) => reclassifyStream(p.stream(o)) }
              : p);
          }
          return prepared && typeof prepared.stream === "function"
            ? { ...prepared, stream: (o) => reclassifyStream(prepared.stream(o)) }
            : prepared;
        };
      }
      return value;
    }
  });

  return { adapter, providerIds: [LLM_PROVIDER_ID] };
}
