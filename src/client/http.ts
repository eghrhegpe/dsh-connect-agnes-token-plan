/**
 * The client's one HTTP seam for POSTs.
 *
 * Every component that writes to the Host used to carry its own copy of the
 * fetch boilerplate — the same `{ method, headers, cache, body }` block plus
 * a `.json().catch(() => null)` — five times over, and the copies drifted
 * (one missed `accept`, another the status fallback). This module is the
 * single definition.
 *
 * Two faces, one raw core:
 *   - `postJson` returns the parsed body (or null when the response is not
 *     JSON): for call sites that must READ a refusal (AccountForm branches
 *     on `code` / `retryAfterMs` / `detail`).
 *   - `postJsonOrThrow` demands `ok:true` and throws otherwise: for the
 *     switches (ProviderSwitch, DrawSwitch, ModelPicker) that only care
 *     whether the write landed. The thrown message carries the Host's own
 *     `error` prose, or `HTTP <status>` when the body is not JSON.
 *
 * The Host answers HTTP 200 for every expected outcome and signals success
 * or refusal in the body's `ok` field, so neither face inspects
 * `response.ok` — `postJsonOrThrow` falls back to the status only when the
 * body is unusable, which is the same fallback the pre-split code used.
 */

/** A Host JSON answer; every field is optional because the fallback is the
 * body itself (null) or a plain string, never a promise of shape. */
export interface ApiBody {
  ok?: boolean;
  error?: string | null;
  code?: string;
  detail?: string;
  retryAfterMs?: number;
  /** Anything else the Host put in the body (e.g. the snapshot data). */
  [key: string]: unknown;
}

/** One POST with the panel's fixed request shape; the parsed body or null. */
async function postRaw(path: string, payload: Record<string, unknown>): Promise<{ status: number; body: ApiBody | null }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null) as ApiBody | null;
  return { status: response.status, body };
}

/** POST and return the parsed body, or null when the response is not JSON. */
export function postJson(path: string, payload: Record<string, unknown>): Promise<ApiBody | null> {
  return postRaw(path, payload).then(({ body }) => body);
}

/** POST and demand `ok:true`; refuse by throwing the Host's own wording. */
export async function postJsonOrThrow(path: string, payload: Record<string, unknown>): Promise<ApiBody> {
  const { status, body } = await postRaw(path, payload);
  if (body === null || body.ok !== true) {
    throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${status}`);
  }
  return body;
}