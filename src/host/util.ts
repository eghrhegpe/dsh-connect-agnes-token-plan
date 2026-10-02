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

/** Read a finite positive number, else the fallback. */
export function num(value: any, fallback?: any): any {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Read a non-empty string, else the fallback. */
export function str(value: any, fallback?: any): string {
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
      // 3) Bare Agnes inference keys, e.g. sk-a1b2c3... (long alnum + - _ .)
      .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[REDACTED]")
      // 4) Known secret JSON pairs, quoted: {"api_key":"..."}.
      .replace(/(["']?(?:password|access_token|refresh_token|api[_-]?key|token)["']?\s*:\s*["'])[^"']+(?=["'])/gi, "$1[REDACTED]")
      // 5) Known secret key=value pairs.
      .replace(/\b(password|access_token|refresh_token|api[_-]?key|token)\s*=\s*[^&;\s]+/gi, "$1=[REDACTED]")
  );
}

/** Read a plain object, else `{}`. */
export function obj(value?: any): any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Read a string exactly as it was given, else the fallback.
 *
 * The companion to `str()` for secrets: a password is stored, read back and
 * sent as typed, because trimming it is a change the user cannot see. A
 * password of only whitespace is still "not filled in", which the caller
 * judges with `.trim()`.
 */
export function verbatim(value: any, fallback?: any): string {
  return typeof value === "string" ? value : fallback;
}

/** Read a finite number, else `null`. */
export function numOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
