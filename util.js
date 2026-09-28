/**
 * Shared value readers and the error constructor used across the Host half.
 *
 * These are the small "read X or fall back" primitives every module reaches
 * for. Centralising them stops copies from drifting apart the way the error-code
 * taxonomy once did.
 * @module dsh-connect-sensenova-token-plan/util
 */

/** Read a finite positive number, else the fallback. */
export function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Read a non-empty string, else the fallback. */
export function str(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * Redact credential-shaped strings from any text that may reach a log, an
 * error message, or a panel-facing response.
 *
 * AGENTS.md's red line: "凭据不入库" — a credential never reaches a log or a
 * response. The login trace already sanitizes in `sensenova-auth.js`; this is
 * the counterpart for the LLM route, where an HTTP error object's `message`
 * often embeds the request headers it was built from (axios/fetch errors do),
 * and a SenseNova 4xx body may echo the `sk-` key back. Without this gate a
 * registration failure would leak the key through `providerState.error` and
 * `ctx.logger.warn`.
 * @param {string} text - any string that might carry a credential.
 * @returns {string} the text with credential patterns replaced by `[REDACTED]`.
 */
export function redactSecrets(text) {
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
      // 3) Bare SenseNova inference keys, e.g. sk-a1b2c3... (long alnum + - _ .)
      .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[REDACTED]")
      // 4) Known secret JSON pairs, quoted: {"api_key":"..."}.
      .replace(/(["']?(?:password|access_token|refresh_token|api[_-]?key|token)["']?\s*:\s*["'])[^"']+(?=["'])/gi, "$1[REDACTED]")
      // 5) Known secret key=value pairs.
      .replace(/\b(password|access_token|refresh_token|api[_-]?key|token)\s*=\s*[^&;\s]+/gi, "$1=[REDACTED]")
  );
}

/** Read a plain object, else `{}`. */
export function obj(value) {
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
export function verbatim(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

/** Read a finite number, else `null`. */
export function numOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * An error carrying a stable code the panel can branch on.
 *
 * The single constructor for every failure this plugin produces. `extra`
 * carries optional structured fields (retryAfterMs, detail) that the panel
 * and the trace need; only defined extras are copied, so an absent field
 * stays absent rather than reading as a zero.
 * @param {string} code - a {@link import("./codes.js").CODE} value.
 * @param {string} message - human-readable description.
 * @param {object} [extra] - optional structured fields.
 * @returns {Error}
 */
export function pluginError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  if (extra.retryAfterMs !== undefined) error.retryAfterMs = extra.retryAfterMs;
  if (extra.detail !== undefined) error.detail = extra.detail;
  return error;
}
