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
 * a profile that deliberately pins no `reasoning` default (the BFF defaults
 * thinking ON; the wire channel is unverified in v1).
 *
 * @module dsh-connect-agnes-token-plan/agnescode-llm-adapter
 */
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { name } from "./host-config.ts";
import { AGNESCODE_PROVIDER_ID, AGNESCODE_DISPLAY_NAME, buildAgnescodeDescriptors, agnescodeRoster } from "./agnescode-models.ts";
import { buildRetryPolicyConfig } from "./llm-retry.ts";
import { createWrappedPiAiAdapter, STREAM_IDLE_TIMEOUT_MS, REQUEST_IMAGE_BUDGETS } from "./pi-ai-adapter-core.ts";
import type { AgnescodeAdapterOptions } from "./types.ts";

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
export function createAgnescodeAdapter({
  rows,
  bffBase,
  resolveToken,
  get
}: AgnescodeAdapterOptions = {}) {
  const models = buildAgnescodeDescriptors(rows ?? agnescodeRoster(null), { bffBase: String(bffBase ?? "") });

  const provider = {
    ...createProvider({
      id: AGNESCODE_PROVIDER_ID,
      name: AGNESCODE_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: "AgnesCode access token",
          async resolve({ credential }: { credential?: { key?: string } } = {}) {
            const token = credential?.key;
            return token === undefined || token === ""
              ? undefined
              : { auth: { apiKey: token }, source: AGNESCODE_DISPLAY_NAME };
          }
        }
      },
      models,
      api: openAICompletionsApi()
    }),
    getModels: () => models
  };

  // No `reasoning` key on purpose: the AgnesCode BFF defaults thinking ON and
  // the wire channel that would switch it is unverified in v1, so this profile
  // must NOT pin the Token Plan route's effort default.
  const profiles = new Map([
    [
      AGNESCODE_PROVIDER_ID,
      {
        provider: AGNESCODE_PROVIDER_ID,
        displayName: AGNESCODE_DISPLAY_NAME,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(buildRetryPolicyConfig(), `${name}.${AGNESCODE_PROVIDER_ID}.retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider
      }
    ]
  ]);

  // The live AgnesCode JWT, re-read per request so a re-harvest needs no
  // re-registration. Both image hooks and the 429 correction layer come from
  // the shared core.
  const adapter = createWrappedPiAiAdapter({
    profiles,
    resolveApiKey: async () => resolveToken?.() ?? "",
    get
  });

  return { adapter, providerIds: [AGNESCODE_PROVIDER_ID] };
}