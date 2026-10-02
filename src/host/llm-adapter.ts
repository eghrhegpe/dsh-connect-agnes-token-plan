/**
 * The peer-dependent half of the directly-registered Agnes provider.
 *
 * Everything here runs against Host-shipped peers (`pi-ai`, `dsh-llm`,
 * `dsh-llm-pi-ai`), which is exactly why the descriptor mapping lives in the
 * peer-free `llm-models.ts` instead: this module cannot be imported by the
 * offline unit suite, so it holds only assembly against the runtime and is
 * exercised in wiring/e2e checks.
 *
 * This file is the CONFIGURATION half; the shared assembly mechanism (inert
 * auth plane, image budgets/hooks, 429 correction Proxy) lives in
 * `pi-ai-adapter-core.ts`, because the AgnesCode route needs the identical
 * mechanism and a second hand-maintained copy of a patch is how one route keeps
 * a bug the other already fixed. What stays HERE is everything that differs:
 *
 * - the provider id / display name and the model builder;
 * - the profile's `reasoning` default, which this route pins and AgnesCode must
 *   NOT (see the note at the profile below);
 * - the credential resolver (a stored `sk-` key, read per request).
 *
 * @module dsh-connect-agnes-token-plan/llm-adapter
 */
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { name } from "./host-config.ts";
import { buildDescriptors, LLM_PROVIDER_ID, LLM_DISPLAY_NAME, DEFAULT_REASONING_EFFORT } from "./llm-models.ts";
import { buildRetryPolicyConfig } from "./llm-retry.ts";
import { createWrappedPiAiAdapter, STREAM_IDLE_TIMEOUT_MS, REQUEST_IMAGE_BUDGETS } from "./pi-ai-adapter-core.ts";

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
export function createAgnesAdapter({ entries, enabledIds = [], baseUrl, resolveApiKey, get, unavailableModelIds = [] }: {
  entries: any;
  enabledIds?: string[];
  baseUrl?: string;
  resolveApiKey: any;
  get?: (service: string) => any;
  unavailableModelIds?: string[];
}) {
  const models = buildDescriptors(entries, { providerId: LLM_PROVIDER_ID, ...(baseUrl === undefined ? {} : { baseUrl }), enabledIds, unavailableModelIds });

  const provider = {
    ...createProvider({
      id: LLM_PROVIDER_ID,
      name: LLM_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: "Agnes API key",
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
        // The picker's "Default" pins to DEFAULT_REASONING_EFFORT (high).
        // Agnes thinks by default (reasoning_effort default high), and the
        // descriptor's thinkingLevelMap spells off as `none`, so an unselected
        // effort must not reach pi-ai as "no effort" — that would dispatch
        // `map.off` and silently turn thinking off. Pinning the profile default
        // keeps the platform default; the snapshot quotes this same constant to
        // the panel roster, so the displayed default cannot drift from it.
        //
        // AgnesCode deliberately does NOT pin this (its thinking wire channel is
        // unverified), which is one reason the two profiles stay hand-built
        // while the adapter mechanism below is shared.
        reasoning: DEFAULT_REASONING_EFFORT,
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider
      }
    ]
  ]);

  // The stored API-key reference is the only credential this route presents; it
  // is read per request, so rotating the key needs no re-registration.
  const adapter = createWrappedPiAiAdapter({
    profiles,
    resolveApiKey: async () => resolveApiKey(),
    get
  });

  return { adapter, providerIds: [LLM_PROVIDER_ID] };
}