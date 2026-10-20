/**
 * The AgnesCode scan-to-login device flow (ROADMAP §6.3).
 *
 * An alternative to the desktop App's os_crypt session file: the plugin opens
 * a browser to the AgnesCode login page, the user scans a QR (or clicks
 * "continue" if already logged in), and the login page POSTs a one-time
 * authorization code to a local HTTP server the plugin just started. The
 * plugin exchanges that code for the SAME access_token the desktop App would
 * have stored — so this flow covers macOS / Linux and needs no desktop App.
 *
 * Peer-free: imports only internal modules and node: builtins. No Host peer.
 *
 * The localhost callback is a POST JSON { code, state } (NOT a GET query
 * redirect) — verified by reverse-engineering the login page's S() function.
 * The browser sends a CORS preflight (https origin → http localhost), so the
 * server MUST answer OPTIONS with Access-Control-Allow-Origin.
 *
 * Red lines:
 *   ① no credential on disk or in logs — the token is returned to the caller
 *      (the store), never written to a file or trace;
 *   ⑤ every login attempt writes a sanitized trace (writeLoginTrace).
 *
 * @module dsh-connect-agnes-token-plan/agnescode-login
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { Buffer } from "node:buffer";
import { decodeAgnescodeJwtExpMs, trustAgnescodeBffBase } from "./agnescode.ts";
import { writeLoginTrace } from "./trace.ts";
import { obj, str } from "./util.ts";

/** Per-domain login endpoints and BFF bases. */
const DOMAINS = {
  cn: {
    loginUrl: "https://app.agnes-ai.cn/login",
    bffBase: "https://api-agnes-code.agnes-ai.cn",
    origin: "https://app.agnes-ai.cn"
  },
  intl: {
    loginUrl: "https://app.agnes-ai.com/login",
    bffBase: "https://api-agnes-code.agnes-ai.com",
    origin: "https://app.agnes-ai.com"
  }
} as const;

type DomainKey = keyof typeof DOMAINS;

const CLIENT_ID = "agnes-code";
const CB_PATH = "/auth/callback";
const CB_TIMEOUT_MS = 3 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 30 * 60 * 1000;

/** The credential shape returned to the caller (and stored). */
export type AgnescodeLoginResult = {
  accessToken: string;
  bffBase: string;
  expiresAtMs: number | null;
  userId: string;
  nickname: string;
};

/** Options for {@link startAgnescodeLogin}. */
export type AgnescodeLoginOptions = {
  domain?: DomainKey;
  onTrace?: (trace: object[], error: unknown) => void;
  logger?: { warn?: (message: string, ...rest: unknown[]) => void };
};

/**
 * Run the full device flow: listen on a random port, open the browser to the
 * login page, wait for the login page's POST callback, and exchange the code
 * for an access token.
 *
 * On success returns the credential shape the store persists. On failure
 * writes a sanitized trace and rethrows.
 *
 * @param {object} [options]
 * @param {"cn"|"intl"} [options.domain] - which AgnesCode domain to use.
 * @param {(trace: object[], error: unknown) => void} [options.onTrace] - the
 *   trace writer; called once on every outcome.
 * @param {{warn?: (message: string, ...rest: unknown[]) => void}} [options.logger]
 * @returns {Promise<AgnescodeLoginResult>} the credential.
 */
export async function startAgnescodeLogin(options: AgnescodeLoginOptions = {}): Promise<AgnescodeLoginResult> {
  const domain = options.domain ?? "cn";
  const cfg = DOMAINS[domain];
  const hops: object[] = [];
  const trace = {
    hop(entry: object) { hops.push(entry); },
    done() { return hops; }
  };
  const finish = async (error: unknown) => {
    await writeLoginTrace(hops, error === null ? "ok" : "error", { logger: options.logger });
    options.onTrace?.(hops, error ?? undefined);
  };
  const state = randomUUID();

  let server: Server | null = null;
  try {
    server = await listenOnRandomPort();
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("the login server could not bind a port");
    const redirectUri = `http://127.0.0.1:${addr.port}${CB_PATH}`;
    const loginUrl = `${cfg.loginUrl}?client=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

    trace.hop({ step: "open-external", domain });
    const spawnErr = openExternal(loginUrl);
    if (spawnErr !== null) throw new Error(spawnErr);

    trace.hop({ step: "wait-callback", timeoutMs: CB_TIMEOUT_MS });
    const code = await withTimeout(
      waitForCallback(server, state, cfg.origin, trace),
      CB_TIMEOUT_MS,
      "the login page did not POST back within the timeout"
    );

    const bffBase = trustAgnescodeBffBase(cfg.bffBase);
    if (bffBase === null) throw new Error("the BFF base is not trusted");

    trace.hop({ step: "exchange-code", bffBase });
    const token = await withTimeout(
      exchangeCodeForToken(code, redirectUri, state, bffBase, cfg.origin, trace),
      EXCHANGE_TIMEOUT_MS,
      "the code exchange timed out"
    );

    const expiresAtMs = decodeAgnescodeJwtExpMs(token) ?? null;
    const jwtPayload: Record<string, unknown> = decodeJwtPayload(token) ?? {};
    const userId = str(jwtPayload.sub, "");
    const nickname = str(jwtPayload.name, "");

    trace.hop({ step: "login-ok", hasToken: token !== "", bffBase, hasUserId: userId !== "" });
    await finish(null);
    return { accessToken: token, bffBase, expiresAtMs, userId, nickname };
  } catch (error) {
    await finish(error);
    throw error;
  } finally {
    server?.close();
  }
}

/** Listen on a random port on 127.0.0.1. */
function listenOnRandomPort(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

/**
 * Wait for the login page's callback.
 *
 * Handles OPTIONS (CORS preflight), POST JSON { code, state }, and GET query
 * fallback. Validates the CSRF state token and rejects empty codes. Closes
 * the server on success; a settled guard prevents double-settle.
 *
 * @param {Server} server - the HTTP server to listen on.
 * @param {string} state - the CSRF state token to validate.
 * @param {string} origin - the login page origin for CORS.
 * @param {{hop(entry: object): void}} trace - the trace hop collector.
 * @returns {Promise<string>} the authorization code.
 */
function waitForCallback(
  server: Server,
  state: string,
  origin: string,
  trace: { hop(entry: object): void }
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (code: string) => {
      if (settled) return;
      settled = true;
      server.close(() => resolve(code));
    };
    server.on("request", (req, res) => {
      const send = (status: number, body: object) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("access-control-allow-credentials", "false");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "Content-Type");
        res.end(JSON.stringify(body));
      };
      if (req.method === "OPTIONS") { return send(204, { ok: true }); }
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== CB_PATH) { return send(200, { ok: true }); }
      if (req.method === "POST") {
        let buf = "";
        req.on("data", (c) => { buf += String(c); });
        req.on("end", () => {
          let code = "";
          let st = "";
          try {
            const b = obj(JSON.parse(buf || "{}"));
            code = str(b.code, "");
            st = str(b.state, "");
          } catch {
            code = u.searchParams.get("code") ?? "";
            st = u.searchParams.get("state") ?? "";
          }
          if (st !== state) { trace.hop({ step: "bad-state" }); return send(400, { ok: false, error: "bad state" }); }
          if (code === "") { trace.hop({ step: "empty-code" }); return send(400, { ok: false, error: "missing code" }); }
          trace.hop({ step: "callback-ok", method: "POST" });
          send(200, { ok: true });
          settle(code);
        });
        return;
      }
      const code = u.searchParams.get("code") ?? "";
      const st = u.searchParams.get("state") ?? "";
      if (st !== state) { return send(400, { ok: false, error: "bad state" }); }
      if (code === "") { return send(400, { ok: false, error: "missing code" }); }
      trace.hop({ step: "callback-ok", method: "GET" });
      send(200, { ok: true });
      settle(code);
    });
    server.on("error", reject);
  });
}

/**
 * Exchange the one-time authorization code for an access token.
 *
 * POSTs to {bffBase}/api/v1/code/auth/exchange-code. The origin header must
 * match the login page's origin (the BFF checks it).
 *
 * @returns {Promise<string>} the access token (JWT).
 */
async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  state: string,
  bffBase: string,
  origin: string,
  trace: { hop(entry: object): void }
): Promise<string> {
  const url = `${bffBase}/api/v1/code/auth/exchange-code`;
  trace.hop({ step: "exchange", url, method: "POST" });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin, "x-platform": "1" },
    body: JSON.stringify({ code, redirect_uri: redirectUri, state, client_id: CLIENT_ID })
  });
  const body = obj(await response.json().catch(() => ({})));
  const codeStr = str(body.code, "");
  if (response.status !== 200 || (codeStr !== "000000" && codeStr !== "0")) {
    trace.hop({ step: "exchange-failed", status: response.status, code: codeStr });
    throw new Error(`code exchange failed (${codeStr})`);
  }
  const data = obj(body.data ?? {});
  const token = str(data.access_token, "");
  if (token === "") {
    trace.hop({ step: "exchange-no-token", status: response.status, code: codeStr });
    throw new Error("the code exchange returned no access_token");
  }
  trace.hop({ step: "exchange-ok", status: response.status, hasToken: true });
  return token;
}

/**
 * Open a URL in the system browser.
 *
 * Returns null on success, or an error message if the browser binary is
 * missing (so the caller can fail fast instead of waiting for the timeout).
 */
function openExternal(url: string): string | null {
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";
  const cmd = win ? "rundll32" : mac ? "open" : "xdg-open";
  const args = win ? ["url.dll,FileProtocolHandler", url] : [url];
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, { stdio: "ignore", detached: true });
  } catch (err) {
    return err instanceof Error ? `failed to open browser: ${err.message}` : "failed to open browser";
  }
  child.on("error", () => {});
  child.unref();
  return null;
}

/** Wrap a promise with a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]);
}

/** Decode a JWT payload without verification. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1] ?? "";
  if (payload === "") return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return null; }
}