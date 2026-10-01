/**
 * The AgnesCode（爱思编程）protocol layer — the pure, peer-free API half of the
 * third upstream provider (ROADMAP §6.3 "third upstream").
 *
 * This is the plugin's FIRST "local-login-state harvest" line (the workbuddy /
 * qoder / trae precedent family, §5.3): the credential is NOT obtained by a
 * login this plugin performs — the user signs into the AgnesCode desktop App
 * (WeChat scan, `app_id: agnes`), the App encrypts its session file with
 * Chromium os_crypt, and this module reads THAT file. Nothing here writes to
 * the App's directory; the harvested JWT lands in the DSH credentials service
 * (`agnescode-store.ts`), never in this plugin's directory, git, or logs
 * (red line 1).
 *
 * Wire facts this module encodes (all probed live 2026-10-01, ROADMAP §6.3):
 *   - the session file is `%APPDATA%/AgnesCode/code-auth-session.cn.v1`,
 *     Chromium os_crypt: `v10` prefix + AES-256-GCM, key = DPAPI-unwrapped
 *     `os_crypt.encrypted_key` from the sibling `Local State` JSON;
 *   - the decrypted JSON carries `accessToken` (JWT, ~28-day `exp`), the user
 *     object, and `bffPublicBaseUrl` — the per-account API base, which is why
 *     NO base URL is hardcoded here (the reference reverse-proxy pins the
 *     INTERNATIONAL `.com` host as a constant — the same trap video.ts hit);
 *   - chat is plain OpenAI-compatible `{bff}/chat/completions`; models list at
 *     `{bff}/models` (needs `X-App-Id: 1` + `X-Platform: 1`); the credit pool
 *     lives OUTSIDE the `/v1` prefix at `{origin}/api/v2/subscription/
 *     credits-balance` (a subscription-pool envelope, NOT Token Plan semantics).
 *
 * Safety stance for third-party data: `bffPublicBaseUrl` is PINNED to the
 * Agnes origin family (https + `*.agnes-ai.cn` / `*.agnes-ai.com`) before any
 * Authorization header is aimed at it — a corrupted or hostile session file
 * must not be able to redirect the stored token to a foreign host.
 *
 * Everything here takes injected io/fetchers and pure data, so the offline
 * suites exercise it without a network or a real DPAPI call; no Host peer is
 * imported.
 *
 * @module dsh-connect-agnes-token-plan/agnescode
 */

import { createDecipheriv } from "node:crypto";
import { obj, num, str } from "./util.ts";

/** The model-catalogue request headers the BFF gates on (probed: required). */
export const AGNESCODE_CATALOG_HEADERS = Object.freeze({
  "X-App-Id": "1",
  "X-Platform": "1"
});

/** The request-language header the desktop client sends. */
export const AGNESCODE_LANGUAGE_HEADER = "X-User-Language";

/**
 * The session-file name pattern, matched case-insensitively against the App's
 * roaming directory. The CN build ships `code-auth-session.cn.v1`; other
 * region variants (`code-auth-session.v1`, a future `.com` tag) share the
 * shape, so the harvest matches the FAMILY rather than one literal — but each
 * match is diagnosed individually and the first usable one wins.
 */
export const AGNESCODE_SESSION_FILE_PATTERN = /^code-auth-session[^/\\]*\.v1$/i;

/** Where the desktop App keeps its Chromium profile, per platform. */
export const AGNESCODE_APP_DATA_CANDIDATES = Object.freeze([
  { platform: "win32", dirEnv: "APPDATA", leaf: "AgnesCode" },
  { platform: "darwin", dirEnv: "HOME", leaf: "Library/Application Support/AgnesCode" },
  { platform: "linux", dirEnv: "HOME", leaf: ".config/AgnesCode" }
]);

/**
 * The LOOSE family pattern — anything that reads like the session file. When
 * no strict match exists but a loose one does, the App has moved to a new file
 * shape: that is the FORMAT_DRIFT fact, not「文件不存在」. Shared by the walk
 * and the doctor survey so the two never disagree about what「像会话文件」means.
 */
export const AGNESCODE_SESSION_FAMILY_PATTERN = /^code-auth-session/i;

/**
 * The App-data candidate directories for one env + platform, in walk order.
 * A candidate whose env base is unset drops out. Single source of truth —
 * the harvest walk and the doctor survey must resolve the same dirs.
 * @param {any} env - the process env.
 * @param {string} platform - `process.platform`.
 * @returns {string[]} candidate directory paths (empty = platform unknown).
 */
export function resolveAgnescodeAppDirs(env: any, platform: string) {
  return AGNESCODE_APP_DATA_CANDIDATES
    .filter((candidate) => candidate.platform === platform)
    .map((candidate) => {
      const base = str(env[candidate.dirEnv], "");
      return base === "" ? null : `${base.replace(/[\\/]+$/, "")}/${candidate.leaf}`;
    })
    .filter(Boolean);
}

/**
 * Classify one directory listing against the session file family.
 * `drift` is only read when `matched` is empty: a strict match wins, and an
 * unrecognizable sibling next to a readable file is noise (an App-kept backup),
 * not evidence of format change.
 * @param {string[]} fileNames - names from one app-directory listing.
 * @returns {{matched: string[], drift: string[]}} harvestable vs unreadable-shape family members.
 */
export function classifyAgnescodeSessionFiles(fileNames: string[]) {
  const names = Array.isArray(fileNames) ? fileNames : [];
  const matched = names.filter((name) => AGNESCODE_SESSION_FILE_PATTERN.test(name));
  const drift = matched.length === 0
    ? names.filter((name) => AGNESCODE_SESSION_FAMILY_PATTERN.test(name))
    : [];
  return { matched, drift };
}

/**
 * The tiers of a failed harvest, one per row of the panel's diagnosis list
 * (the workbuddy five-tier discipline, restated for this file family). The
 * tiers deliberately split "the App is not here" from "the App is here but we
 * cannot read its crypto" — they want different user advice.
 *
 * FORMAT_DRIFT exists for the week-scale silent failure this reverse-engineered
 * format makes possible: when the desktop App updates its session file to a
 * new shape, a strict-pattern miss reads as FILE_MISSING — indistinguishable
 * from "signed out" — while the JWT harvested earlier keeps working for up to
 * 28 days, and every「重新登录再检测」round trips back to the same row. Naming
 * the orphaned family member turns「你没登录」into「格式变了，升级插件」at the
 * FIRST detection click instead of at the day the token finally dies.
 */
export const AGNESCODE_HARVEST_TIER = Object.freeze({
  FILE_MISSING: "file_missing",
  FORMAT_DRIFT: "format_drift",
  UNREADABLE: "unreadable",
  MALFORMED: "malformed",
  NO_KEY: "no_key",
  DECRYPT_FAILED: "decrypt_failed",
  NO_TOKEN: "no_token",
  UNTRUSTED_BASE: "untrusted_base",
  UNSUPPORTED_PLATFORM: "unsupported_platform",
  OK: "ok"
});

/**
 * Whether a BFF base may carry the account's Authorization header. Pinned to
 * the Agnes origin family over https — see the module header. Anything else
 * reads as `UNTRUSTED_BASE` and the harvest keeps walking.
 * @param {unknown} value - the `bffPublicBaseUrl` from the session file.
 * @returns {string|null} the normalized base (no trailing slash), or `null`.
 */
export function trustAgnescodeBffBase(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // A non-default port is never part of the account's real base; keeping it
  // would let a hostile session file aim the token at any port on an Agnes
  // host (a proxy/impostor listener). Only scheme-default ports pass.
  if (url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!(host === "agnes-ai.cn" || host === "agnes-ai.com"
    || host.endsWith(".agnes-ai.cn") || host.endsWith(".agnes-ai.com"))) {
    return null;
  }
  return url.origin + (url.pathname.replace(/\/+$/, ""));
}

/**
 * Parse one DECRYPTED session document into the shape the store persists.
 * Malformed input reads as `null`, never throws — one re-harvest, never a
 * crash. Only secret-FREE facts plus the token itself survive; the raw user
 * object (avatar URL, provider ids) is dropped, not stored.
 * @param {unknown} raw - the decrypted JSON value.
 * @returns {{accessToken: string, userId: string, nickname: string, bffBase: string}|null}
 */
export function parseAgnescodeSession(raw: unknown) {
  const source = obj(raw);
  const accessToken = str(source.accessToken, "");
  if (accessToken === "") return null;
  const bffBase = trustAgnescodeBffBase(source.bffPublicBaseUrl);
  // A missing/foreign base blocks the session rather than degrading to a
  // default: the base is per-account data, and a guess would aim the token
  // at a host the account never chose.
  if (bffBase === null) return null;
  const user = obj(source.userInfo);
  return {
    accessToken,
    userId: str(user.id, ""),
    nickname: str(user.username, ""),
    bffBase
  };
}

/**
 * Derive the API root the account-scoped (`/api/...`) endpoints address —
 * the BFF base WITHOUT its `/v1` suffix. The credits endpoint does NOT live
 * under `/v1` (probed: `{origin}/api/v2/...`), so a caller that concatenated
 * the full base would 404.
 * @param {string} bffBase - a {@link trustAgnescodeBffBase}-normalized base.
 * @returns {string} the origin (plus any non-`/v1` prefix, preserved).
 */
export function agnescodeApiRoot(bffBase: string) {
  const base = str(bffBase, "").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base.slice(0, -3) : base;
}

/** Decode a JWT's `exp` claim to MILLISECONDS; `undefined` on any failure. */
export function decodeAgnescodeJwtExpMs(token: string) {
  if (typeof token !== "string" || token.length === 0) return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const seconds = num(payload.exp);
    return typeof seconds === "number" ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The header set one AgnesCode BFF request carries. The catalogue headers are
 * REQUIRED on `/v1/models` (probed) and harmless elsewhere; the language
 * header mirrors the desktop client.
 * @param {object} credential - `{ accessToken }`.
 * @returns {object} the header map.
 */
export function agnescodeHeaders(credential: any) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${str(obj(credential).accessToken, "")}`,
    ...AGNESCODE_CATALOG_HEADERS,
    [AGNESCODE_LANGUAGE_HEADER]: "zh-Hans"
  };
  return headers;
}

/**
 * Chromium os_crypt blob → plaintext: strip the `v10` prefix, AES-256-GCM with
 * a 12-byte nonce and a trailing 16-byte auth tag.
 * @param {Buffer|Uint8Array} blob - the raw session-file bytes.
 * @param {Buffer|Uint8Array} key - the 32-byte os_crypt key (already unwrapped).
 * @returns {Buffer} the decrypted bytes.
 * @throws when the prefix, the key size, or the auth tag does not match.
 */
export function decryptAgnescodeSessionBlob(blob: Buffer | Uint8Array, key: Buffer | Uint8Array) {
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? []);
  const keyBytes = Buffer.isBuffer(key) ? key : Buffer.from(key ?? []);
  if (keyBytes.length !== 32) throw new Error(`os_crypt key must be 32 bytes, got ${keyBytes.length}`);
  const prefix = bytes.subarray(0, 3).toString("latin1");
  if (prefix !== "v10") throw new Error(`unexpected session-blob prefix ${JSON.stringify(prefix)}`);
  const body = bytes.subarray(3);
  if (body.length < 12 + 16) throw new Error("session blob too short for nonce + tag");
  const nonce = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const ciphertext = body.subarray(12, body.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Unwrap the os_crypt key from a `Local State` document. The stored value is
 * base64 of `DPAPI` + the DPAPI-protected key bytes; the DPAPI call itself is
 * injected (the real one is a PowerShell child process — no native deps).
 * @param {unknown} localStateRaw - the parsed (or raw) `Local State` JSON.
 * @param {(wrapped: Buffer) => Promise<Buffer>} dpapiUnprotect - injected DPAPI.
 * @returns {Promise<Buffer>} the 32-byte os_crypt key.
 * @throws on any shape mismatch — the caller maps it to `NO_KEY`/`DECRYPT_FAILED`.
 */
export async function unwrapAgnescodeLocalStateKey(localStateRaw: string | Buffer | Uint8Array, dpapiUnprotect: (wrapped: Buffer) => Promise<Buffer>) {
  // The injected reader returns a Buffer (the production shape) or a string;
  // route BOTH through text before JSON.parse — an `obj()` on a Buffer would
  // read its numeric byte properties and "find" no os_crypt key.
  let source;
  if (typeof localStateRaw === "string" || Buffer.isBuffer(localStateRaw) || localStateRaw instanceof Uint8Array) {
    const text = typeof localStateRaw === "string" ? localStateRaw : Buffer.from(localStateRaw).toString("utf8");
    try {
      source = JSON.parse(text);
    } catch {
      // A FIXED phrase, deliberately without the parse error's message: V8's
      // JSON errors quote the offending input ("Unexpected token 'x', ...is
      // not valid JSON"), and that quote would carry a fragment of the user's
      // `Local State` into the harvest attempts and on to the panel response.
      throw new Error("Local State is not valid JSON");
    }
  } else {
    source = obj(localStateRaw);
  }
  const encryptedKeyB64 = str(obj(obj(source).os_crypt).encrypted_key, "");
  if (encryptedKeyB64 === "") throw new Error("Local State carries no os_crypt.encrypted_key");
  const wrapped = Buffer.from(encryptedKeyB64, "base64");
  if (wrapped.length < 6 || wrapped.subarray(0, 5).toString("latin1") !== "DPAPI") {
    throw new Error("os_crypt.encrypted_key lacks the DPAPI prefix");
  }
  return dpapiUnprotect(wrapped.subarray(5));
}

/**
 * The production DPAPI unwrap: a PowerShell child process. No native addon and
 * no build step (the Host half is build-free, ROADMAP §6.2), and the unwrapped
 * key transits the stdout pipe IN MEMORY — it is never printed, logged, or
 * written anywhere. Runs only on win32; every other platform maps to
 * `UNSUPPORTED_PLATFORM` upstream of this call.
 * @param {Buffer} wrapped - the DPAPI-protected key bytes.
 * @returns {Promise<Buffer>} the unwrapped key bytes.
 */
export async function defaultDpapiUnprotect(wrapped: Buffer) {
  const { spawn } = await import("node:child_process");
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$in = [Console]::OpenStandardInput()",
    "$ms = New-Object IO.MemoryStream",
    "$in.CopyTo($ms)",
    "$pt = [Security.Cryptography.ProtectedData]::Unprotect($ms.ToArray(), $null, 'CurrentUser')",
    "[Console]::OpenStandardOutput().Write($pt, 0, $pt.Length)"
  ].join("; ");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const chunks: Buffer[] = [];
    let failure = "";
    // A hung PowerShell must not hold the harvest (and, through the request
    // path, the publish chain) forever: 10 s is generous for a local DPAPI
    // call and kills the child instead.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("DPAPI unprotect timed out (10s)"));
    }, 10_000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      failure += chunk.toString();
    });
    // An early child exit (crash before reading stdin) makes the write fail
    // with EPIPE; swallowed here, the close handler rejects with the real
    // exit status instead of an unhandled stream error.
    child.stdin.on("error", () => {});
    child.on("error", (why) => {
      clearTimeout(timer);
      reject(why);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`DPAPI unprotect failed (exit ${code})${failure ? `: ${failure.slice(0, 200)}` : ""}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.write(wrapped);
    child.stdin.end();
  });
}

/**
 * The doctor-side read-only SURVEY of the App's session storage: directory
 * names and file names only — it never reads file bytes, never touches the
 * os_crypt key, never decrypts. This is what makes the reverse-engineered
 * format inspectable OFFLINE: 「没装 App」「装了但没登录」「登录了但格式变了」
 * are three different facts, and the CLI can now tell them apart without a
 * Host running and without clicking anything in the panel.
 * @param {object} [options]
 * @param {any} [options.env] - the process env (defaults to `process.env`).
 * @param {string} [options.platform] - `process.platform` (defaults to real).
 * @param {(path: string) => Promise<string[]>} [options.readDir] - injected lister.
 * @returns {Promise<object>} `{platform, surveyed, dirsChecked, presentDirs, sessionFiles, driftFiles}`.
 */
export async function surveyAgnescodeStorage(options: any = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const readDir = options.readDir ?? (async (path: string) => (await import("node:fs/promises")).readdir(path));
  const appDirs = resolveAgnescodeAppDirs(env, platform);
  const report: {
    platform: string;
    surveyed: boolean;
    dirsChecked: number;
    presentDirs: number;
    sessionFiles: string[];
    driftFiles: string[];
  } = {
    platform,
    surveyed: appDirs.length > 0,
    dirsChecked: appDirs.length,
    presentDirs: 0,
    sessionFiles: [],
    driftFiles: []
  };
  if (report.surveyed === false) return report;
  for (const appDir of appDirs) {
    let listing;
    try {
      listing = await readDir(appDir);
    } catch {
      continue; // an absent directory is a fact of absence, not a stack trace
    }
    report.presentDirs += 1;
    const { matched, drift } = classifyAgnescodeSessionFiles(listing);
    report.sessionFiles.push(...matched);
    report.driftFiles.push(...drift);
  }
  return report;
}

/**
 * Harvest the AgnesCode session from the local desktop App — the walk behind
 * the panel's「重新检测」. One diagnostic row per candidate file, in the order
 * the candidates were tried; the FIRST usable session wins and the walk stops.
 * A walk that finds nothing usable returns `ok: false` WITH the rows, so the
 * panel can show exactly what was probed and why it failed (the workbuddy
 * discipline: never a bare "not logged in" when the App state is the problem).
 *
 * The token appears ONLY in the return value's `session` — the `attempts` rows
 * carry tier codes and shape facts (lengths, file sizes), never values.
 * @param {object} [options]
 * @param {object} [options.env] - the process env (defaults to `process.env`).
 * @param {object} [options.platform] - `process.platform` (defaults to real).
 * @param {(path: string) => Promise<Buffer>} [options.readFile] - injected reader.
 * @param {(path: string) => Promise<string[]>} [options.readDir] - injected lister.
 * @param {(wrapped: Buffer) => Promise<Buffer>} [options.dpapiUnprotect] - injected DPAPI.
 * @returns {Promise<{ok: boolean, session?: object, attempts: object[]}>}
 */
export async function harvestAgnescodeLocalSession(
  options: any = {}
): Promise<
  | { ok: false; attempts: Array<{ file: string | null; tier: string; detail: string }> }
  | { ok: true; attempts: Array<{ file: string | null; tier: string; detail: string }>; session: { accessToken: string; userId: string; nickname: string; bffBase: string } }
> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const readFile = options.readFile ?? (async (path: string) => (await import("node:fs/promises")).readFile(path));
  const readDir = options.readDir ?? (async (path: string) => (await import("node:fs/promises")).readdir(path));
  const dpapiUnprotect = options.dpapiUnprotect ?? defaultDpapiUnprotect;

  /** One tier row: {file, tier, detail?} — detail carries shapes, never values. */
  const attempts: Array<{ file: string | null; tier: string; detail: string }> = [];

  // Windows is the only platform with a VERIFIED harvest path (os_crypt key
  // via DPAPI + PowerShell). The darwin/linux candidates below describe where
  // the App WOULD keep its data, but the macOS IDE variant reads state.vscdb
  // (sqlite) and neither non-Windows crypto path has been probed — walking
  // them would surface a misleading `no_key` for what is really "untested
  // platform", so they are refused up front with that fact.
  if (platform !== "win32") {
    return { ok: false, attempts: [{ file: null, tier: AGNESCODE_HARVEST_TIER.UNSUPPORTED_PLATFORM, detail: `no verified harvest path for ${platform} yet (Windows only; macOS reads state.vscdb — unimplemented)` }] };
  }

  const appDirs = resolveAgnescodeAppDirs(env, platform);
  if (appDirs.length === 0) {
    return { ok: false, attempts: [{ file: null, tier: AGNESCODE_HARVEST_TIER.UNSUPPORTED_PLATFORM, detail: `no app-data candidate for platform ${platform}` }] };
  }

  for (const appDir of appDirs) {
    let fileNames: string[] = [];
    let driftNames: string[] = [];
    try {
      const classified = classifyAgnescodeSessionFiles(await readDir(appDir));
      fileNames = classified.matched;
      driftNames = classified.drift;
    } catch {
      attempts.push({ file: appDir, tier: AGNESCODE_HARVEST_TIER.FILE_MISSING, detail: "the AgnesCode app directory is absent" });
      continue;
    }
    if (fileNames.length === 0) {
      if (driftNames.length > 0) {
        // The App IS here and writing its session family — but in a shape this
        // plugin cannot read. A format fact, not a login fact (see FORMAT_DRIFT).
        attempts.push({
          file: `${appDir}/${driftNames[0]}`,
          tier: AGNESCODE_HARVEST_TIER.FORMAT_DRIFT,
          detail: `unrecognized session-family file${driftNames.length > 1 ? `s (${driftNames.slice(0, 3).join(", ")})` : ""} — the desktop App may have changed its storage format; update this plugin, then re-detect`
        });
      } else {
        attempts.push({ file: appDir, tier: AGNESCODE_HARVEST_TIER.FILE_MISSING, detail: "no code-auth-session*.v1 in the app directory" });
      }
      continue;
    }
    // Deterministic order: the CN build first, then alphabetical.
    fileNames.sort((a, b) => (a.endsWith(".cn.v1") === b.endsWith(".cn.v1") ? a.localeCompare(b) : a.endsWith(".cn.v1") ? -1 : 1));

    for (const fileName of fileNames) {
      const filePath = `${appDir}/${fileName}`;
      let blob;
      try {
        blob = await readFile(filePath);
      } catch (why) {
        attempts.push({ file: filePath, tier: AGNESCODE_HARVEST_TIER.UNREADABLE, detail: why instanceof Error ? why.message : String(why) });
        continue;
      }
      // The os_crypt key lives beside the session file; a miss is its own tier
      // ("the App is here but its crypto state is not what we expect").
      let localStateRaw;
      try {
        localStateRaw = await readFile(`${appDir}/Local State`);
      } catch {
        attempts.push({ file: filePath, tier: AGNESCODE_HARVEST_TIER.NO_KEY, detail: "the sibling Local State is absent" });
        continue;
      }
      let key;
      try {
        key = await unwrapAgnescodeLocalStateKey(localStateRaw, dpapiUnprotect);
      } catch (why) {
        attempts.push({ file: filePath, tier: AGNESCODE_HARVEST_TIER.NO_KEY, detail: why instanceof Error ? why.message : String(why) });
        continue;
      }
      let plain;
      try {
        plain = decryptAgnescodeSessionBlob(blob, key);
      } catch (why) {
        attempts.push({
          file: filePath,
          tier: AGNESCODE_HARVEST_TIER.DECRYPT_FAILED,
          detail: `${why instanceof Error ? why.message : String(why)} (blob ${blob.length} B)`
        });
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(plain.toString("utf8"));
      } catch {
        attempts.push({ file: filePath, tier: AGNESCODE_HARVEST_TIER.MALFORMED, detail: "decrypted bytes are not JSON" });
        continue;
      }
      const session = parseAgnescodeSession(parsed);
      if (session === null) {
        attempts.push({
          file: filePath,
          tier: str(obj(parsed).accessToken, "") === ""
            ? AGNESCODE_HARVEST_TIER.NO_TOKEN
            : AGNESCODE_HARVEST_TIER.UNTRUSTED_BASE,
          detail: "the decrypted session lacks a usable token or a pinned Agnes base"
        });
        continue;
      }
      attempts.push({ file: filePath, tier: AGNESCODE_HARVEST_TIER.OK, detail: `JWT ${session.accessToken.length} chars` });
      return { ok: true, session, attempts };
    }
  }
  return { ok: false, attempts };
}

/**
 * Fetch the live model catalogue, or `null` when it cannot be read. The
 * adapter falls back to the static roster on `null` (the `console-client`
 * silent-fallback discipline).
 *
 * The BFF rows carry `is_member_only` — a fact about gating, not visibility,
 * so it is KEPT (the panel badges it; offering a member-gated model is
 * preferable to silently hiding one, mirroring red line 7's spirit of stating
 * account-level limits instead of dropping models).
 * @param {object} credential - `{ accessToken, bffBase }`.
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @returns {Promise<object[]|null>} `[{id, name, vision, memberOnly, contextWindow, maxOutputLength}]`, or `null`.
 */
export async function fetchAgnescodeCatalog(credential: any, fetcher?: typeof fetch) {
  const effective = fetcher ?? globalThis.fetch;
  const source = obj(credential);
  const bffBase = trustAgnescodeBffBase(source.bffBase);
  if (bffBase === null) return null;
  try {
    const response = await effective(`${bffBase}/models`, {
      headers: agnescodeHeaders(source),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) return null;
    const body = obj(await response.json().catch(() => ({})));
    const models = Array.isArray(body.data) ? body.data : [];
    const seen = new Set();
    const out: Array<{ id: string; name: string; vision: boolean; memberOnly: boolean; contextWindow: number; maxOutputLength: number }> = [];
    for (const raw of models) {
      const model = obj(raw);
      const id = str(model.id, "");
      if (id === "" || seen.has(id)) continue;
      // `model_type: "text"` and `supported_endpoint_types: ["openai"]` are the
      // only modality facts the row declares — an image-input claim would be
      // invented, so vision is false until the platform says otherwise.
      if (str(model.model_type, "text") !== "text") continue;
      seen.add(id);
      out.push({
        id,
        name: str(model.name, id),
        vision: false,
        memberOnly: model.is_member_only === true,
        contextWindow: num(model.max_input_tokens),
        maxOutputLength: num(model.max_output_tokens)
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Read the account's credit pool. Read-only; the envelope is a SUBSCRIPTION
 * pool (level / time-sensitive vs permanent credits), NOT a Token Plan
 * usage-overview — the panel must not render it with quota semantics.
 * @param {object} credential - `{ accessToken, bffBase }`.
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @returns {Promise<object|null>} `{totalBalance, timeSensitiveBalance, permanentBalance, subscriptionCredits, dailyFreeCredits, level}` or `null`.
 */
export async function fetchAgnescodeBalance(credential: any, fetcher?: typeof fetch) {
  const effective = fetcher ?? globalThis.fetch;
  const source = obj(credential);
  const bffBase = trustAgnescodeBffBase(source.bffBase);
  if (bffBase === null) return null;
  try {
    const response = await effective(`${agnescodeApiRoot(bffBase)}/api/v2/subscription/credits-balance`, {
      headers: agnescodeHeaders(source),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) return null;
    const envelope = obj(await response.json().catch(() => ({})));
    if (str(envelope.code, "") !== "000000" || envelope.data === null || typeof envelope.data !== "object") return null;
    const data = obj(envelope.data);
    const total = numOrNullSafe(data.total_balance);
    if (total === null) return null;
    return {
      totalBalance: total,
      timeSensitiveBalance: numOrNullSafe(data.time_sensitive_balance) ?? 0,
      permanentBalance: numOrNullSafe(data.permanent_balance) ?? 0,
      subscriptionCredits: numOrNullSafe(data.subscription_credits) ?? 0,
      dailyFreeCredits: numOrNullSafe(data.daily_free_credits) ?? 0,
      level: num(data.level)
    };
  } catch {
    return null;
  }
}

/** Read a finite non-negative number, else `null`. */
function numOrNullSafe(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The static fallback roster: the seven models the CN BFF listed at probe time
 * (2026-10-01, ROADMAP §6.3). All `model_type: text`, no multiplier concept
 * (billing is the credit pool, not per-model rates). Used ONLY when
 * `fetchAgnescodeCatalog` comes back empty; a fresh catalogue always wins.
 */
export const AGNESCODE_FALLBACK_MODELS = Object.freeze([
  { id: "agnes-3.0-flash", name: "Agnes 3.0 Flash", memberOnly: false, vision: false, contextWindow: 512_000, maxOutputLength: 65_536 },
  { id: "agnes-2.5-flash", name: "Agnes 2.5 Flash", memberOnly: false, vision: false, contextWindow: 512_000, maxOutputLength: 65_536 },
  { id: "agnes-2.5-pro", name: "Agnes 2.5 Pro", memberOnly: false, vision: false, contextWindow: 512_000, maxOutputLength: 65_536 },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", memberOnly: true, vision: false, contextWindow: 1_000_000, maxOutputLength: 393_216 },
  { id: "glm-5.2", name: "GLM-5.2", memberOnly: true, vision: false, contextWindow: 1_000_000, maxOutputLength: 131_072 },
  { id: "kimi-k3", name: "Kimi K3", memberOnly: true, vision: false, contextWindow: 1_048_576, maxOutputLength: 131_072 },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", memberOnly: true, vision: false, contextWindow: 1_000_000, maxOutputLength: 393_216 }
]);
