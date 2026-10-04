import { t as DEFAULT_REASONING_EFFORT, w as name } from "./llm-models-Bep2p7Tp.js";
import { i as buildAgnescodeDescriptors, n as AGNESCODE_PROVIDER_ID, r as agnescodeRoster, t as AGNESCODE_DISPLAY_NAME } from "./agnescode-models-DleT9qke.js";
import { i as buildRetryPolicyConfig, n as STREAM_IDLE_TIMEOUT_MS, r as createWrappedPiAiAdapter, t as REQUEST_IMAGE_BUDGETS } from "./pi-ai-adapter-core-BKmN5s11.js";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";

//#region src/host/agnescode-llm-adapter.ts
/**
* The peer-dependent half of the directly-registered AgnesCode provider —
* the desktop-app upstream (ROADMAP §6.3).
*
* ONE `PiAiAdapter` carrying ONE profile (`agnescode` → the credential's
* per-account BFF base), an INERT pi-ai auth plane (the AgnesCode JWT is
* resolved per request from the plugin's own credential store, pi-ai never
* manufactures it), and no token baked into the profile — the picker
* advertises models without one and a request fails at resolve time, where the
* panel status is visible.
*
* Both IMAGE hooks are wired, exactly as the Token Plan adapter
* (`llm-adapter.ts`) wires them — the shape a working vision route has. The
* catalogue still declares no modality field (`model_type: "text"`), so the
* vision CLAIM is borrowed from `PROBED_VISION` in the peer-free
* `agnescode-models.ts` (the Agnes family is the same gateway the Token Plan
* side probed accepting `image_url`); the descriptor's `input` and the adapter's
* hooks must agree, or a message carrying an image reaches the durable
* attachment service with no way to locate the image and fails. Wiring the
* hooks without the claim would be inert; making the claim without the hooks is
* the bug this closes.
*
* The descriptor mapping lives in the peer-free `agnescode-models.ts`, so this
* module holds only assembly against the runtime and is exercised by the
* wiring/e2e checks, exactly as `llm-adapter.ts` is. The assembly MECHANISM
* itself (auth plane, image budgets/hooks, 429 correction) is shared with the
* Token Plan route through `pi-ai-adapter-core.ts` — what stays here is the
* AgnesCode configuration: provider id, model builder, credential resolver, and
* a profile that pins the SAME effort default as the Token Plan route (probed
* live 2026-10-03: the BFF accepts `reasoning_effort` and defaults thinking ON,
* so an unselected effort must not reach pi-ai as "no effort").
*
* @module dsh-connect-agnes-token-plan/agnescode-llm-adapter
*/
/**
* Assemble the AgnesCode adapter for one credential/catalogue snapshot.
*
* A fresh instance per rebuild is deliberate: `PiAiAdapter` memoizes the
* profiles snapshot internally, so the caller REPLACES the registered
* adapter when the credential or catalogue changes and emits
* `llm/adapters-updated`.
* @param {object} options - wiring.
* @param {object[]} [options.rows] - the AgnesCode roster rows (`agnescodeRoster`).
* @param {string} options.bffBase - the credential's pinned per-account BFF base.
* @param {() => Promise<string>} options.resolveToken - resolves the live
*   AgnesCode JWT per request (re-harvested by the caller when expired).
* @param {(service: string) => unknown} [options.get] - service resolver for
*   the image hooks (`attachments`, `fs`); resolved lazily per request because
*   a service may register after this adapter is built.
* @returns {{adapter: object, providerIds: string[]}} the adapter and the ids
*   it owns.
*/
function createAgnescodeAdapter({ rows, bffBase, resolveToken, get } = {}) {
	const models = buildAgnescodeDescriptors(rows ?? agnescodeRoster(null), { bffBase: String(bffBase ?? "") });
	const provider = {
		...createProvider({
			id: AGNESCODE_PROVIDER_ID,
			name: AGNESCODE_DISPLAY_NAME,
			auth: { apiKey: {
				name: "AgnesCode access token",
				async resolve({ credential } = {}) {
					const token = credential?.key;
					return token === void 0 || token === "" ? void 0 : {
						auth: { apiKey: token },
						source: AGNESCODE_DISPLAY_NAME
					};
				}
			} },
			models,
			api: openAICompletionsApi()
		}),
		getModels: () => models
	};
	const profiles = /* @__PURE__ */ new Map([[AGNESCODE_PROVIDER_ID, {
		provider: AGNESCODE_PROVIDER_ID,
		displayName: AGNESCODE_DISPLAY_NAME,
		streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(buildRetryPolicyConfig(), `${name}.${AGNESCODE_PROVIDER_ID}.retryPolicy`),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		reasoning: DEFAULT_REASONING_EFFORT,
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	}]]);
	return {
		adapter: createWrappedPiAiAdapter({
			profiles,
			resolveApiKey: async () => resolveToken?.() ?? "",
			get
		}),
		providerIds: [AGNESCODE_PROVIDER_ID]
	};
}

//#endregion
export { createAgnescodeAdapter };