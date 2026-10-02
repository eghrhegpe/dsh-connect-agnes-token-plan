/**
 * The shared ASSEMBLY core of the two pi-ai adapter shells — the mechanism the
 * Token Plan route (`llm-adapter.ts`) and the AgnesCode route
 * (`agnescode-llm-adapter.ts`) both need, kept in ONE place.
 *
 * Why this file exists: the two shells are deliberately SEPARATE (different
 * provider ids, model builders, credential resolvers, and one of them pins a
 * reasoning default the other must not), but their assembly mechanism had been
 * copied verbatim — the inert auth plane, the image budgets, the image hooks,
 * and above all the 429-misclassification Proxy. That last one is the reason
 * this is not merely tidiness: the Proxy is a patch against a peer
 * (`docs/IMPROVEMENTS.md` §3.3) whose deletion is governed by an expiry date,
 * and two hand-maintained copies of a patch is how one of them silently keeps
 * the bug after the other is fixed. Mechanism shared, configuration separate —
 * the same split `publish-core.ts` already applies to the two publishers.
 *
 * This is a static-peer module by design, exactly like the shells that import
 * it: it is reached only through a dynamic `import()` from the lifecycle, so a
 * Host without the LLM peers loses the provider module and nothing else
 * (ARCHITECTURE.md §5, invariant 1).
 *
 * @module dsh-connect-agnes-token-plan/pi-ai-adapter-core
 */
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import { reclassifyStream } from "./llm-error-fix.ts";

/** Idle ceiling while one stream read is outstanding (dsh-llm-pi-ai default). */
export const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Image budgets at the `dsh-llm-pi-ai` defaults — pinned identically for both
 * Agnes upstreams so a request image is resized the same way on either route.
 * They bound requests to models whose descriptor declares image input;
 * text-only models never see images.
 */
export const REQUEST_IMAGE_BUDGETS = Object.freeze({
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576
});

/**
 * Inert pi-ai auth plane.
 *
 * Both routes authenticate through `resolveApiKey` (a credential read per
 * request from the plugin's own store), so pi-ai's credential lifecycle must
 * never manufacture one: every ambient question answers "nothing stored,
 * nothing set". `modify` is deliberately a no-op rather than a throw — pi-ai
 * may call it as an optional "persist the latest credential" hook during a
 * normal request, and an exception there would 500 a conversation that is
 * otherwise working.
 */
export const INERT_AUTH = Object.freeze({
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
});

/**
 * The `fs` service face the image hook reads — a single host-path mapper, and
 * only that. Resolved lazily through `get("fs")` because the service may be
 * registered after this adapter is built.
 * @typedef {object} FsService
 * @property {(hostPath: string) => unknown} [processPathFromHostPath]
 */

/**
 * Assemble one `PiAiAdapter` behind the shared mechanism.
 *
 * A fresh instance per rebuild is deliberate: `PiAiAdapter` memoizes the
 * profiles snapshot internally, so the caller REPLACES the registered adapter
 * when the credential or catalogue changes and emits `llm/adapters-updated`.
 *
 * Both IMAGE hooks are wired, not optional extras: `streamWithSnapshot` throws
 * UNSUPPORTED_CONTENT whenever a message carries an image and
 * `resolveAttachments()` yields undefined, and wiring the store without
 * `resolveImageAccess` leaves the image unlocatable — that pair shipped broken
 * once, which is why `test/agnescode.test.mjs` fences it.
 *
 * @param {object} options - wiring.
 * @param {Map<string, object>} options.profiles - the single provider profile
 *   map this adapter serves.
 * @param {() => Promise<string>} options.resolveApiKey - resolves the live
 *   credential per request.
 * @param {(service: string) => any} [options.get] - service resolver for the
 *   image hooks (`attachments`, `fs`); resolved lazily per request.
 * @returns {object} the adapter, with the 429 correction layer applied.
 */
export function createWrappedPiAiAdapter({ profiles, resolveApiKey, get }: {
  profiles: Map<string, any>;
  resolveApiKey: () => Promise<string>;
  // `| undefined` is required, not cosmetic: `exactOptionalPropertyTypes` is on,
  // so an optional property without it would reject a caller that forwards its
  // own optional `get` straight through (both shells do).
  get?: ((service: string) => any) | undefined;
}) {
  const inner = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey,
    resolveAttachments: () => get?.("attachments"),
    resolveImageAccess: (attachments: any, ref: any) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath: string) =>
          /** @type {FsService | undefined} */ (get?.("fs"))?.processPathFromHostPath?.(hostPath),
        ref
      )
  });

  // 429 误判纠正层：peer 的 `classifyPiAiError` 会把带 "budget/credits" 字眼的
  // 限频 429 抢判成 QUOTA（不重试），本 Proxy 把这类误判体在出流前纠正回
  // RATE_LIMIT，使 `llm-retry.ts` 的退避重试真正生效。只拦截流出口，不触碰
  // peer 内部逻辑，也不影响任何正常数据 chunk。详见 `llm-error-fix.ts`。
  //
  // ONE copy for both routes on purpose: this is a patch against an immutable
  // peer with its own expiry date, and a second hand-maintained copy is how one
  // route keeps the bug after the other is fixed.
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // `stream(...)` 与 `prepareCall(...).stream` 都返回一个 async iterable；
      // 二者据此包裹重判流。其它成员（含 image/resolveApiKey 等）原样放行。
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
}