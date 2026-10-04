/**
 * Shared value readers and the error constructor used across the Host half.
 *
 * These are the small "read X or fall back" primitives every module reaches
 * for. Centralising them stops copies from drifting apart the way the error-code
 * taxonomy once did.
 * @module dsh-connect-agnes-token-plan/util
 */

import type { PluginError } from "./types.ts";

/**
 * The error `pluginError` actually produces at runtime: an `Error` with a
 * stable `code` the panel branches on, plus optional structured fields the
 * panel and trace read. The fields are attached, not inherited, so this is a
 * structural annotation, not a subclass.
 * @typedef {Error & {
 *   code: import("./codes.ts").CodeValue,
 *   retryAfterMs?: number,
 *   detail?: string,
 *   trace?: object[]
 * }} PluginError
 */

/**
 * Read a finite positive number, else the fallback.
 *
 * `value` is `unknown` on purpose: every call site reads a field off a payload
 * the plugin did not author (a console response, a state file, a settings row),
 * so the honest type at this boundary is "could be anything". Narrowing the
 * PARAMETER costs callers nothing (everything is assignable to `unknown`) and
 * stops the `any` from propagating inward — the returns stay loose because the
 * fallback is the caller's own value and is passed straight back.
 */
export function num(value: unknown, fallback?: any): any {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Read a non-empty string, else the fallback. */
export function str(value: unknown, fallback?: any): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * Redact credential-shaped strings from any text that may reach a log, an
 * error message, or a panel-facing response.
 *
 * AGENTS.md's red line: "凭据不入库" — a credential never reaches a log or a
 * response. The login trace already sanitizes in `agnes-auth.ts`; this is
 * the counterpart for the LLM route, where an HTTP error object's `message`
 * often embeds the request headers it was built from (axios/fetch errors do),
 * and a Agnes 4xx body may echo the `sk-` key back. Without this gate a
 * registration failure would leak the key through `providerState.error` and
 * `ctx.logger.warn`.
 * @param {string} text - any string that might carry a credential.
 * @returns {string} the text with credential patterns replaced by `[REDACTED]`.
 */
export function redactSecrets(text: string) {
  const raw = typeof text === "string" ? text : "";
  return (
    raw
      // 1) Header values FIRST, so a whole `"authorization":"sk-..."` value is
      //    consumed in one pass instead of leaving the token behind. The
      //    `(?!Bearer\s)` skip keeps this from eating the word "Bearer" that
      //    rule 2 leaves tagged.
      .replace(/(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)(?!Bearer\s)[^"',;\s]+/g, "$1[REDACTED]")
      // 2) Bearer / Basic tokens.
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
      // 3) Bare Agnes inference keys, e.g. sk-a1b2c3... (free tier) or
      //    cpk-a1b2c3... (Token Plan) — both are first-class key shapes
      //    (README/AGNES-API §7, the i18n placeholder), so the prefix class
      //    covers both, not just `sk-`.
      .replace(/\b(sk|cpk)-[A-Za-z0-9._-]{8,}/g, "$1-[REDACTED]")
      // 3b) A bare JWT — three dot-separated base64url segments, which is
      //     exactly the shape of the Agnes `access_token` (`readJwtExpiry`
      //     parses it) and of the AgnesCode session token. It is listed
      //     separately from rule 4/5 because those match on the KEY NAME, and
      //     a token that arrives under a name this list never anticipated
      //     (`jwt`, `id_token`, `session`, a renamed field) would otherwise
      //     sail through: a blacklist that only knows names cannot redact a
      //     value whose name it has not met yet, so the VALUE shape is
      //     matched here too.
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED]")
      // 4) Known secret JSON pairs, quoted: {"api_key":"..."}.
      .replace(/(["']?(?:password|access_token|refresh_token|api[_-]?key|token)["']?\s*:\s*["'])[^"']+(?=["'])/gi, "$1[REDACTED]")
      // 5) Known secret key=value pairs.
      .replace(/\b(password|access_token|refresh_token|api[_-]?key|token)\s*=\s*[^&;\s]+/gi, "$1=[REDACTED]")
  );
}

/**
 * The panel-facing text for a thrown value: an `Error`'s message — or a plain
 * value's string form — with every credential-shaped substring removed.
 *
 * AGENTS.md's red line names three places that must redact — the provider, the
 * desktop upstream, and the ROUTE — and every route answers `ok:false` with an
 * `error` field drawn from whatever was thrown. Some of those values are built
 * by the console client from the request it made (an axios/fetch error embeds
 * the header it was built from, and a Agnes 4xx body may echo the `sk-` key),
 * so the message must not travel verbatim. A store error that carries no
 * credential is left untouched by the call.
 * @param {unknown} error - the thrown value, `Error` or otherwise.
 * @returns {string} secret-free text for a panel-facing `error`/`detail` field.
 */
export function redactError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/**
 * Read a plain object, else `{}`.
 *
 * Returns `Record<string, unknown>` rather than `any`: the reader's whole job is
 * to hand back a shape the caller must still validate field by field, and typing
 * it as `any` would silently wave through every unvalidated read downstream.
 */
export function obj(value?: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Read a string exactly as it was given, else the fallback.
 *
 * The companion to `str()` for secrets: a password is stored, read back and
 * sent as typed, because trimming it is a change the user cannot see. A
 * password of only whitespace is still "not filled in", which the caller
 * judges with `.trim()`.
 */
export function verbatim(value: unknown, fallback?: any): string {
  return typeof value === "string" ? value : fallback;
}

/** Read a finite number, else `null`. */
export function numOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Read a finite number that may legitimately be ZERO, else `undefined`.
 *
 * `num()` and `numOrNull()` both reject `0` because for their callers a zero is
 * a missing reading (a limit, a window, a count — none of which is honestly
 * zero when the platform simply did not say). This reader exists for the
 * opposite case, and the distinction is load-bearing at the call site: the
 * platform's `points_cost_multiplier` uses `0` to mean "this model is free",
 * which is a published PRICE, not a missing value. Routing it through `num()`
 * would collapse "free" into "not stated" and the panel would then render
 * nothing where it should render the free badge (the sibling SenseNova plugin
 * renders this exact figure as `· x0.00`).
 *
 * So: absent / non-numeric / non-finite / negative → `undefined` (no claim);
 * `0` → `0` (a claim of free).
 * @param {unknown} value - the raw field.
 * @returns {number|undefined} the finite non-negative number, or `undefined`.
 */
export function numZeroOk(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Run one attempt loop inside a bounded window.
 *
 * The shared backoff shape for every "a service or a seed may be late" case
 * in this plugin: a Host service can register AFTER this plugin mounts, and a
 * one-shot mount-time read then misses it for the WHOLE session, silently. The
 * caller owns the attempt count and the delay base (a single service read
 * settles in a few hundred ms; a seed that must wait for two services and then
 * fetch a catalogue needs a longer budget).
 *
 * The backoff is LINEAR (`delayMs * attempt`), so a slow Host is not hammered
 * while an early success returns at once.
 * @param {object} job
 * @param {number} job.attempts - how many attempts the window holds.
 * @param {number} job.delayMs - backoff base; the wait before attempt N is
 *   `delayMs * N`.
 * @param {(attempt: number) => boolean|Promise<boolean>} job.run - one
 *   attempt; returns true to stop (succeeded, or gave up deliberately), false
 *   to keep trying inside the window.
 * @returns {Promise<boolean>} true when an attempt stopped the loop, false
 *   when the window ran out.
 */
export async function retryBounded({ attempts, delayMs, run }: {
  attempts: number;
  delayMs: number;
  run: (attempt: number) => boolean | Promise<boolean>;
}): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await run(attempt)) return true;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  return false;
}

/**
 * Run a promise to completion without awaiting it — and guarantee it cannot
 * become an unhandled rejection.
 *
 * Every fire-and-forget in this plugin is a side effect that must not be able
 * to take the Host down, and Node has terminated the process on an unhandled
 * rejection since v15. There is deliberately no `process.on("unhandledRejection")`
 * net here: a plugin must not install a process-wide handler inside someone
 * else's process, so the guarantee has to be per-call. This is it.
 *
 * Prefer this over `void p`. `void` documents nothing and protects nothing —
 * the safety of every `void` site in this repo rests on each target having
 * remembered to swallow its own failure, which is a discipline, not a
 * mechanism. `forget` moves the swallow into the seam so a NEW call site is
 * safe by construction rather than by memory.
 *
 * @param {Promise<unknown>|unknown} promise - the promise not being awaited
 *   (a non-promise is accepted and ignored, so a call site cannot regress by
 *   passing the result of a function that stopped being async).
 * @param {{logger?: {warn?: (message: string, ...rest: unknown[]) => void}|undefined, label?: string}} [options]
 *   `label` names the task in the warning; `logger` receives it. The message
 *   is redacted unconditionally: this is a log exit, and which promise
 *   reached it must not decide whether a credential is filtered.
 * @returns {void}
 */
export function forget(
  promise: unknown,
  options: { logger?: { warn?: (message: string, ...rest: unknown[]) => void } | undefined; label?: string } = {}
): void {
  const label = str(options?.label, "background task");
  Promise.resolve(promise).catch((error: unknown) => {
    try {
      const detail = redactSecrets(error instanceof Error ? error.message : String(error));
      options?.logger?.warn?.(`${label} failed: ${detail}`);
    } catch {
      // A logger that throws must not become the rejection it was reporting.
    }
  });
}

/**
 * An error carrying a stable code the panel can branch on.
 *
 * The single constructor for every failure this plugin produces. `extra`
 * carries optional structured fields (retryAfterMs, detail) that the panel
 * and the trace need; only defined extras are copied, so an absent field
 * stays absent rather than reading as a zero.
 *
 * The runtime value is a plain `Error` with these fields attached; the
 * {@link PluginError} type records that shape so a `catch (e)` downstream can
 * read `e.code` as more than a hopeful guess.
 * @param {import("./codes.ts").CodeValue} code - a {@link import("./codes.ts").CODE} wire value.
 * @param {string} message - human-readable description.
 * @param {{ retryAfterMs?: number, detail?: string }} [extra] - optional structured fields.
 * @returns {PluginError}
 */
export function pluginError(code: string, message: string, extra: { retryAfterMs?: number; detail?: string } = {}): PluginError {
  const error = new Error(message) as PluginError;
  error.code = code;
  if (extra.retryAfterMs !== undefined) error.retryAfterMs = extra.retryAfterMs;
  if (extra.detail !== undefined) error.detail = extra.detail;
  return error;
}
