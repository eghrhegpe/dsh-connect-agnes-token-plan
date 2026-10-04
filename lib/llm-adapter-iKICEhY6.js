import { a as buildDescriptors, n as LLM_DISPLAY_NAME, r as LLM_PROVIDER_ID, t as DEFAULT_REASONING_EFFORT, w as name } from "./llm-models-Bep2p7Tp.js";
import { i as buildRetryPolicyConfig, n as STREAM_IDLE_TIMEOUT_MS, r as createWrappedPiAiAdapter, t as REQUEST_IMAGE_BUDGETS } from "./pi-ai-adapter-core-BKmN5s11.js";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";

//#region src/host/llm-adapter.ts
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
* - the profile's `reasoning` default — which BOTH routes now pin to the same
*   constant (AgnesCode included, since ADR-009's live probe retired the "its
*   thinking wire channel is unverified" note that used to say otherwise);
* - the credential resolver (a stored `sk-` key, read per request).
*
* @module dsh-connect-agnes-token-plan/llm-adapter
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
function createAgnesAdapter({ entries, enabledIds = [], baseUrl, resolveApiKey, get, unavailableModelIds = [] }) {
	const models = buildDescriptors(entries, {
		providerId: LLM_PROVIDER_ID,
		...baseUrl === void 0 ? {} : { baseUrl },
		enabledIds,
		unavailableModelIds
	});
	const provider = {
		...createProvider({
			id: LLM_PROVIDER_ID,
			name: LLM_DISPLAY_NAME,
			auth: { apiKey: {
				name: "Agnes API key",
				/**
				* pi-ai hands the credential it resolved; this route stores none, so
				* the parameter is typed only to name what is read off it.
				* @param {{credential?: {key?: string}}} [options]
				*/
				async resolve({ credential } = {}) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: LLM_DISPLAY_NAME
					};
				}
			} },
			models,
			api: openAICompletionsApi()
		}),
		getModels: () => models
	};
	const profiles = /* @__PURE__ */ new Map([[LLM_PROVIDER_ID, {
		provider: LLM_PROVIDER_ID,
		displayName: LLM_DISPLAY_NAME,
		streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(buildRetryPolicyConfig(), `${name}.${LLM_PROVIDER_ID}.retryPolicy`),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		reasoning: DEFAULT_REASONING_EFFORT,
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	}]]);
	return {
		adapter: createWrappedPiAiAdapter({
			profiles,
			resolveApiKey: async () => resolveApiKey(),
			get
		}),
		providerIds: [LLM_PROVIDER_ID]
	};
}

//#endregion
export { createAgnesAdapter };