/**
 * The peer-dependent half of the directly-registered SenseNova provider.
 *
 * Everything here runs against Host-shipped peers (`pi-ai`, `dsh-llm`,
 * `dsh-llm-pi-ai`), which is exactly why the descriptor mapping lives in the
 * peer-free `llm-models.js` instead: this module cannot be imported by the
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
import { name } from "./host-config.js";
import { buildDescriptors, LLM_PROVIDER_ID, LLM_DISPLAY_NAME } from "./llm-models.js";

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
    // `api-key-store.js`, not here.
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
 * @returns {{adapter: object, providerIds: string[]}} the adapter and the ids
 *   it owns.
 */
export function createSensenovaAdapter({ entries, enabledIds = [], baseUrl, resolveApiKey, get }) {
  const models = buildDescriptors(entries, { providerId: LLM_PROVIDER_ID, baseUrl, enabledIds });

  const provider = {
    ...createProvider({
      id: LLM_PROVIDER_ID,
      name: LLM_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: "SenseNova API key",
          async resolve({ credential } = {}) {
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
        retryPolicy: resolveRetryPolicy(undefined, `${name}.${LLM_PROVIDER_ID}.retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider
      }
    ]
  ]);

  const adapter = new PiAiAdapter({
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
        (hostPath) => get?.("fs")?.processPathFromHostPath?.(hostPath),
        ref
      )
  });

  return { adapter, providerIds: [LLM_PROVIDER_ID] };
}
