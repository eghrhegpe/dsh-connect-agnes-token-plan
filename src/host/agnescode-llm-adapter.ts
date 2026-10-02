/**
 * The peer-dependent half of the directly-registered AgnesCode provider —
 * the desktop-app upstream (ROADMAP §6.3).
 *
 * ONE `PiAiAdapter` carrying ONE
 * profile (`agnes-agnescode` → the credential's per-account BFF base), an
 * INERT pi-ai auth plane (the AgnesCode JWT is resolved per request from the
 * plugin's own credential store, pi-ai never manufactures it), and no token
 * baked into the profile — the picker advertises models without one and a
 * request fails at resolve time, where the panel status is visible.
 *
 * Both IMAGE hooks are wired, mirroring the Token Plan adapter (`llm-adapter.ts`)
 * and the qoder adapter — the shape a working vision route has. The catalogue
 * still declares no modality field (`model_type: "text"`), so the vision CLAIM
 * is borrowed from `PROBED_VISION` in the peer-free `agnescode-models.ts` (the
 * Agnes family is the same gateway the Token Plan side probed accepting
 * `image_url`); the descriptor's `input` and this adapter's hooks must agree,
 * or a message carrying an image reaches the durable attachment service with no
 * way to locate the image and fails. Wiring the hooks without the claim would
 * be inert; making the claim without the hooks is the bug this closes.
 *
 * The descriptor mapping lives in the peer-free `agnescode-models.ts`, so this
 * module holds only assembly against the runtime and is exercised by the
 * wiring/e2e checks, exactly as `llm-adapter.ts` is.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-llm-adapter
 */
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy, resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import { name } from "./host-config.ts";
import { AGNESCODE_PROVIDER_ID, AGNESCODE_DISPLAY_NAME, buildAgnescodeDescriptors, agnescodeRoster } from "./agnescode-models.ts";
import { buildRetryPolicyConfig } from "./llm-retry.ts";
import { reclassifyStream } from "./llm-error-fix.ts";
import type { AgnescodeAdapterOptions } from "./types.ts";

/** Idle ceiling while one stream read is outstanding (dsh-llm-pi-ai default). */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Image budgets at the `dsh-llm-pi-ai` defaults — the SAME figures the Token
 * Plan route pins (`llm-adapter.ts`), so both Agnes upstreams resize a request
 * image identically. They bound requests to models whose descriptor declares
 * image input; text-only models never see images.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576
};

/**
 * Inert pi-ai auth plane.
 *
 * Authentication goes through `resolveApiKey` (the stored AgnesCode JWT, read
 * per request from `agnescode-store.ts`) — pi-ai's own credential lifecycle
 * must never manufacture a credential for this route, so every ambient
 * question answers "nothing stored, nothing set".
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
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

  const inner = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => resolveToken?.() ?? "",
    // Both image hooks wired exactly as the Token Plan route wires them: an
    // image-carrying message reaches the durable attachment service, and
    // `resolveImageAccess` maps one reference onto a request-readable path.
    // Wiring `resolveAttachments` alone (the v1 state) makes the store
    // reachable but leaves no image locatable — the failure this closes.
    resolveAttachments: () => get?.("attachments"),
    resolveImageAccess: (attachments: any, ref: any) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath: string) => (get?.("fs") as { processPathFromHostPath?: (hostPath: string) => unknown } | undefined)?.processPathFromHostPath?.(hostPath),
        ref
      )
  });

  // The same 429-misclassification correction layer `llm-adapter.ts` applies
  // (a "budget/credits" worded 429 is reclassified to RATE_LIMIT so the
  // retry backoff actually fires). It is provider-agnostic.
  const adapter = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "stream") {
        return (options: any) => reclassifyStream(target.stream(options));
      }
      if (typeof value === "function" && prop === "prepareCall") {
        return (...args: any[]) => {
          const prepared = value.apply(target, args);
          if (prepared && typeof prepared.then === "function") {
            return prepared.then((p: any) => p && typeof p.stream === "function"
              ? { ...p, stream: (o: any) => reclassifyStream(p.stream(o)) }
              : p);
          }
          return prepared && typeof prepared.stream === "function"
            ? { ...prepared, stream: (o: any) => reclassifyStream(prepared.stream(o)) }
            : prepared;
        };
      }
      return value;
    }
  });

  return { adapter, providerIds: [AGNESCODE_PROVIDER_ID] };
}
