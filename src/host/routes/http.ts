/**
 * The HTTP primitives shared by every route of the family: the JSON shape,
 * the bounded body reader, and the two standard refusals.
 *
 * Extracted in the routes split (the token-store playbook: behaviour frozen
 * first — `routes.test.mjs` and `agnescode.test.mjs` ran green against the
 * `routes.ts` facade before and after the move). Handlers keep exactly the
 * behaviour they had inline; only the wording of the fence/method refusals
 * and the body ceilings lives here, so a route cannot drift its own 403.
 *
 * Nothing here imports a Host peer.
 *
 * @module dsh-connect-agnes-token-plan/routes/http
 */

/** Family default response headers for a JSON route. */
export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer"
};

/** Write one JSON response with the family headers. */
export function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(payload);
}

/** Ceiling on a submitted account, so a hostile page cannot stream a body. */
export const MAX_ACCOUNT_BODY_BYTES = 4096;

/**
 * Read a small JSON request body, refusing anything oversized.
 *
 * The account form is the only thing that posts here, so the ceiling is tiny
 * and the reader is deliberately dull: no content-type negotiation, no
 * streaming, just a bounded collect and a parse.
 * @param request - the incoming HTTP request.
 * @param limit - the byte ceiling.
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
 */
export async function readJsonBody(request, limit = MAX_ACCOUNT_BODY_BYTES) {
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > limit) return { ok: false, error: "request body is too large" };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: "could not read the request body" };
  }
  if (chunks.length === 0) return { ok: false, error: "a JSON body is required" };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "the body must be a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: "the body is not valid JSON" };
  }
}

/**
 * Refuse a request the trust fence rejects, with the one body the panel reads.
 *
 * Every route opens with the identical line, so the wording and the 403 shape
 * live in one place: a route that forgets the fence, or words it differently,
 * is now the odd one out rather than a second truth.
 * @param response - the outgoing HTTP response.
 * @returns {void}
 */
export function refuseOrigin(response) {
  writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
}

/**
 * The request's method, with the route's own fallback for a caller that omits
 * it.
 *
 * The web server always supplies a method, so the fallback is for the route
 * tests and any in-process caller. It is the ROUTE's choice, not a family
 * constant: a write route falls back to POST, a read route to GET, and the
 * wrong one turns a methodless request into a write. Shared here rather than
 * repeated, so the family's fallback wording has one home.
 * @param request - the incoming HTTP request.
 * @param fallback - the method to assume when the caller sent none.
 * @returns {string} the method.
 */
export function requestMethod(request, fallback: "GET" | "POST") {
  return request.method === undefined ? fallback : request.method;
}

/**
 * Refuse a disallowed method with the family's 405 shape.
 *
 * The 405 carries no `cache-control`: unlike a snapshot, a method refusal is
 * not a fresh answer anyone would want to keep, so there is nothing to tell a
 * cache not to store.
 * @param response - the outgoing HTTP response.
 * @returns {void}
 */
export function refuseMethod(response) {
  writeJson(response, 405, { ok: false, error: "method not allowed" });
}

/**
 * Read and validate a JSON body, or answer 400 and signal the caller to stop.
 *
 * Collapses the "read body -> not ok ? write 400 and return" block every POST
 * route repeats. Returns the `readJsonBody` result on success (so callers keep
 * reading the parsed object through `body.value`, exactly as before), or `null`
 * after it has already written the 400 — a `null` is the caller's cue to return.
 * @param request - the incoming HTTP request.
 * @param response - the outgoing HTTP response (written on failure).
 * @returns {Promise<object|null>} the read result, or null if a 400 was sent.
 */
export async function readJsonBodyOr400(request, response) {
  const body = await readJsonBody(request);
  if (!body.ok) {
    writeJson(response, 400, { ok: false, error: /** @type {{ok: false, error: string}} */ (body).error }, { "cache-control": "no-store" });
    return null;
  }
  return body;
}
