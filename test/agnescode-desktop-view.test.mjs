/**
 * Unit checks for the AgnesCode desktop-source VIEW (ADR-020,
 * `src/host/agnescode-desktop-view.ts`) — the read-only, per-read answer to
 * "is the desktop session file usable RIGHT NOW":
 *
 *   - the success path: a fresh walk's session served as a credential, with
 *     the stat-keyed cache proving no second walk (and no second DPAPI
 *     unwrap) while the file's stats are unchanged;
 *   - every cache-invalidation trigger: a rewritten file, and a NEW
 *     preferred file appearing over the cached winner (the walk's own
 *     `sortAgnescodeSessionFiles` re-determines the winner, so the view
 *     cannot outlive the walk's order);
 *   - the closed reason set: the nine harvest tiers mapped one-for-one,
 *     plus `no_expiry` / `expired` / `read_failed` — secret-free, no paths;
 *   - the single-flight + failure backoff: two concurrent reads share one
 *     walk; a failed walk buys 60 s of quiet (reads answer the last reason
 *     without touching the disk); successes clear the quiet;
 *   - the platform gate: non-win32 answers `unsupported_platform` before
 *     any other fact (a stale backoff entry must never be printed on a
 *     platform that cannot walk at all).
 *
 * Peer-free: real files in temp dirs (real stat, real mtime/size),
 * injected DPAPI (never a PowerShell spawn), injected clock for the lead
 * and backoff windows. Nothing touches a real App session.
 *
 * Counters: a WALK is counted through the reader's `walk` seam (the injected
 * wrap of the real `harvestAgnescodeLocalSession` — counting its internal
 * reads would undercount: a walk that fails at the directory listing never
 * reads a file), and a DPAPI UNWRAP through the injected `dpapiUnprotect`
 * (the cache-hit path never unwraps). The directory listing itself is cheap
 * and is deliberately not a marker — the cache hit re-lists on every read.
 */
import {
  createAgnescodeDesktopViewReader,
  AGNESCODE_DESKTOP_REASON,
  AGNESCODE_DESKTOP_LEAD_MS,
  AGNESCODE_DESKTOP_VIEW_BACKOFF_MS
} from "../src/host/agnescode-desktop-view.ts";
import { harvestAgnescodeLocalSession } from "../src/host/agnescode.ts";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNetworkGuard } from "./peer-roots.mjs";

const releaseNetworkGuard = installNetworkGuard();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function section(title) {
  console.log(`\n— ${title}`);
}

// ── fixtures (the same os_crypt shape the harvest suite builds) ────────────
const KEY = randomBytes(32);

/** One in-test encrypted session blob (`v10` + AES-256-GCM + tag). */
function encryptSessionBlob(session) {
  const plain = Buffer.from(typeof session === "string" ? session : JSON.stringify(session), "utf8");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
  const head = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), nonce, head, cipher.getAuthTag()]);
}

/** A syntactically-valid JWT whose `exp` sits `hours` ahead of `nowMs`. */
function makeJwt(nowMs, hours = 28) {
  const payload = Buffer.from(JSON.stringify({
    sub: "u",
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + hours * 3600
  })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.c2ln`;
}

function sessionDoc(nowMs, hours = 28, user = { id: "user-1", username: "桌面用户" }) {
  return {
    accessToken: makeJwt(nowMs, hours),
    userInfo: user,
    bffPublicBaseUrl: "https://api-agnes-code.agnes-ai.cn/v1"
  };
}

/**
 * One App directory: a session file plus its sibling `Local State`. The
 * walk's candidate is `${APPDATA}/AgnesCode`, so the root passed to the
 * reader's env is the PARENT; `appDir(root)` is where the files land.
 */
function writeApp(root, blob, fileName = "code-auth-session.cn.v1") {
  const appDir = join(root, "AgnesCode");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, fileName), blob);
  writeFileSync(join(appDir, "Local State"),
    JSON.stringify({
      os_crypt: {
        encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), randomBytes(32)]).toString("base64")
      }
    }));
  return appDir;
}

/**
 * One isolated fixture + reader: its own root, its own counters, its own
 * clock. `backoffMs`/`leadMs` stay injectable per case.
 * @returns {{root: string, reader: object, walkCount: () => number, dpapiCount: () => number, setNow: (ms: number) => void}}
 */
function isolated({ now = Date.now(), leadMs, backoffMs, dpapi = null, walk: walkOverride = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-agnescode-view-"));
  const counts = { walk: 0, dpapi: 0 };
  let clock = now;
  const reader = createAgnescodeDesktopViewReader({
    env: { APPDATA: root },
    platform: "win32",
    dpapiUnprotect: async () => {
      counts.dpapi += 1;
      return dpapi === null ? KEY : dpapi();
    },
    readDir: async (path) => readdir(path),
    walk: walkOverride ?? ((walkOptions) => {
      counts.walk += 1;
      return harvestAgnescodeLocalSession(walkOptions);
    }),
    now: () => clock,
    ...(leadMs !== undefined ? { leadMs } : {}),
    ...(backoffMs !== undefined ? { backoffMs } : {})
  });
  return {
    root,
    reader,
    walkCount: () => counts.walk,
    dpapiCount: () => counts.dpapi,
    setNow: (ms) => { clock = ms; },
    dispose: () => { rmSync(root, { recursive: true, force: true }); }
  };
}

try {
  // ── 1. a fresh session serves, and the cache stops the second walk ─────
  {
    section("success path + stat-keyed cache");
    const now = Date.now();
    const fx = isolated({ now });
    writeApp(fx.root, encryptSessionBlob(sessionDoc(now)));

    const first = await fx.reader.read();
    check("a fresh session file serves a credential",
      first.ok === true && first.credential !== null && first.reason === null,
      JSON.stringify({ ok: first.ok, reason: first.reason }));
    check("the credential carries the session's token, identity and pinned base verbatim",
      first.credential?.accessToken === sessionDoc(now).accessToken
      && first.credential?.userId === "user-1"
      && first.credential?.nickname === "桌面用户"
      && first.credential?.bffBase === "https://api-agnes-code.agnes-ai.cn/v1"
      && typeof first.credential?.expiresAtMs === "number",
      JSON.stringify({ ...first.credential, accessToken: "<len>" }));
    check("the walk ran exactly once", fx.walkCount() === 1, `walks=${fx.walkCount()}`);
    check("the DPAPI unwrap ran exactly once", fx.dpapiCount() === 1, `dpapi=${fx.dpapiCount()}`);

    const second = await fx.reader.read();
    check("a second read with unchanged stats re-walks NOTHING and unwraps NOTHING",
      second.ok === true && second.credential?.accessToken === first.credential.accessToken
      && fx.walkCount() === 1 && fx.dpapiCount() === 1,
      `walks=${fx.walkCount()} dpapi=${fx.dpapiCount()}`);

    // A rewrite moves the stat — the cache must die with it.
    const later = now + 1000;
    fx.setNow(later);
    writeApp(fx.root, encryptSessionBlob(sessionDoc(later)));
    const third = await fx.reader.read();
    check("a rewritten file invalidates the cache (walk + unwrap again)",
      third.ok === true && fx.walkCount() === 2 && fx.dpapiCount() === 2,
      `walks=${fx.walkCount()} dpapi=${fx.dpapiCount()}`);
    fx.dispose();

    // The PREFERRED-ORDER case: cache a `.com.v1`-only directory, then add a
    // `.cn.v1` over it — the walk's order (CN first, the shared sorter) must
    // beat the cache, which was built on the older winner.
    const fx2 = isolated({ now: later });
    writeApp(fx2.root, encryptSessionBlob(sessionDoc(later, 28, { id: "user-2", username: "com用户" })), "code-auth-session.com.v1");
    const cachedCom = await fx2.reader.read();
    check("a .com.v1 session is a valid winner on its own",
      cachedCom.ok === true && cachedCom.credential?.userId === "user-2",
      JSON.stringify({ userId: cachedCom.credential?.userId }));
    // Only the NEW session file is written — `Local State` is deliberately
    // untouched (the App's key outlives a new session file). With both stats
    // unchanged, the stat-key cache cannot invalidate; the ONE path that must
    // catch the new preferred file is the winner re-determination. A fixture
    // that rewrites `Local State` (writeApp does) would mask that path and
    // pin the wrong object.
    writeFileSync(join(join(fx2.root, "AgnesCode"), "code-auth-session.cn.v1"),
      encryptSessionBlob(sessionDoc(later, 28, { id: "user-3", username: "cn用户" })));
    const cnWins = await fx2.reader.read();
    check("a new preferred .cn.v1 file over the cached .com.v1 winner re-walks and serves the CN one",
      cnWins.ok === true && cnWins.credential?.userId === "user-3",
      JSON.stringify({ userId: cnWins.credential?.userId }));
    fx2.dispose();

    // forget(): an out-of-band edit must be visible on the next read.
    const fx3 = isolated({ now: later });
    writeApp(fx3.root, encryptSessionBlob(sessionDoc(later, 10)));
    const warm = await fx3.reader.read();
    const warmWalks = fx3.walkCount();
    fx3.reader.forget();
    writeApp(fx3.root, encryptSessionBlob(sessionDoc(later + 1000, 10)));
    const afterForget = await fx3.reader.read();
    check("forget() drops the cache (the next read walks for real)",
      warm.ok === true && afterForget.ok === true && fx3.walkCount() === warmWalks + 1,
      `walks=${fx3.walkCount()} (warm=${warmWalks})`);
    fx3.dispose();
  }

  // ── 2. the closed reason set ────────────────────────────────────────────
  {
    section("the closed reason set (secret-free)");
    const reasonFor = async (setup) => {
      const fx = isolated({ backoffMs: 1 });
      try {
        setup(fx.root);
        return await fx.reader.read();
      } finally {
        fx.dispose();
      }
    };
    let r;

    r = await reasonFor(() => {});
    check("an absent App directory reads as file_missing",
      r.ok === false && r.reason === AGNESCODE_DESKTOP_REASON.FILE_MISSING, r.reason);

    r = await reasonFor((root) => {
      const appDir = join(root, "AgnesCode");
      mkdirSync(appDir);
      writeFileSync(join(appDir, "code-auth-session.v2.bak"), "x");
    });
    check("an unrecognized session-family file reads as format_drift",
      r.ok === false && r.reason === AGNESCODE_DESKTOP_REASON.FORMAT_DRIFT, r.reason);

    r = await reasonFor((root) => {
      const appDir = join(root, "AgnesCode");
      mkdirSync(appDir);
      writeFileSync(join(appDir, "code-auth-session.cn.v1"), encryptSessionBlob(sessionDoc(Date.now())));
    });
    check("a session without its sibling Local State reads as no_key",
      r.ok === false && r.reason === AGNESCODE_DESKTOP_REASON.NO_KEY, r.reason);

    {
      const fx = isolated({ backoffMs: 1 });
      writeApp(fx.root, encryptSessionBlob(sessionDoc(Date.now())));
      const broken = createAgnescodeDesktopViewReader({
        env: { APPDATA: fx.root },
        platform: "win32",
        dpapiUnprotect: async () => { throw new Error("dpapi refused"); },
        now: () => Date.now(),
        backoffMs: 1
      });
      const brokenRead = await broken.read();
      check("a DPAPI failure reads as no_key (the key is what the walk cannot get)",
        brokenRead.ok === false && brokenRead.reason === AGNESCODE_DESKTOP_REASON.NO_KEY, brokenRead.reason);
      fx.dispose();
    }

    r = await reasonFor((root) => writeApp(root, Buffer.from("garbage-blob")));
    check("an undecryptable blob reads as decrypt_failed",
      r.ok === false && r.reason === AGNESCODE_DESKTOP_REASON.DECRYPT_FAILED, r.reason);

    r = await reasonFor((root) => writeApp(root, encryptSessionBlob("this is not json")));
    check("decrypted bytes that are not JSON read as malformed",
      r.ok === false && r.reason === AGNESCODE_DESKTOP_REASON.MALFORMED, r.reason);

    r = await reasonFor((root) => writeApp(root, encryptSessionBlob({ ...sessionDoc(Date.now()), accessToken: "" })));
    check("a session carrying no token reads as no_token",
      r.ok === false && r.reason === AGNESCODE_DESKTOP_REASON.NO_TOKEN, r.reason);

    r = await reasonFor((root) => writeApp(root, encryptSessionBlob({ ...sessionDoc(Date.now()), bffPublicBaseUrl: "https://evil.example/v1" })));
    check("a foreign base reads as untrusted_base (the token must not ride to it)",
      r.ok === false && r.reason === AGNESCODE_DESKTOP_REASON.UNTRUSTED_BASE, r.reason);

    {
      const fx = isolated({ backoffMs: 1 });
      writeApp(fx.root, encryptSessionBlob(sessionDoc(Date.now())));
      const darwin = createAgnescodeDesktopViewReader({
        env: { APPDATA: fx.root },
        platform: "darwin",
        dpapiUnprotect: async () => KEY
      });
      const platformRead = await darwin.read();
      check("non-win32 answers unsupported_platform before any other fact",
        platformRead.ok === false && platformRead.reason === AGNESCODE_DESKTOP_REASON.UNSUPPORTED_PLATFORM,
        platformRead.reason);
      fx.dispose();
    }
  }

  // ── 3. the expiry half: no_expiry / expired ────────────────────────────
  {
    section("the expiry half (the lead window is the store's renewal boundary)");
    const now = Date.now();
    let fx = isolated({ now });
    writeApp(fx.root, encryptSessionBlob({ ...sessionDoc(now), accessToken: "opaque-not-a-jwt" }));
    const noExpiry = await fx.reader.read();
    check("a walk that decrypted a token without a decodable exp reads as no_expiry",
      noExpiry.ok === false && noExpiry.reason === AGNESCODE_DESKTOP_REASON.NO_EXPIRY, noExpiry.reason);
    const noExpiryAgain = await fx.reader.read();
    check("no_expiry re-reads the cache, not the walk (an opaque token costs no DPAPI)",
      noExpiryAgain.reason === AGNESCODE_DESKTOP_REASON.NO_EXPIRY
      && fx.dpapiCount() === 1,
      `dpapi=${fx.dpapiCount()}`);
    fx.dispose();

    // Inside the lead window (default 5 min): a token with 1 minute of life
    // refuses to serve, and the NEXT read answers from the cache — the lead
    // check runs live on every read, the walk does not.
    fx = isolated({ now });
    writeApp(fx.root, encryptSessionBlob(sessionDoc(now, 1 / 60))); // 1 minute of life
    const early = await fx.reader.read();
    check("a token inside the lead window refuses (expired, the store's renewal boundary)",
      early.ok === false && early.reason === AGNESCODE_DESKTOP_REASON.EXPIRED, early.reason);
    const earlyAgain = await fx.reader.read();
    check("... and stays refused from cache (no second walk, no second unwrap)",
      earlyAgain.reason === AGNESCODE_DESKTOP_REASON.EXPIRED
      && fx.walkCount() === 1 && fx.dpapiCount() === 1,
      `walks=${fx.walkCount()} dpapi=${fx.dpapiCount()}`);
    fx.setNow(now + AGNESCODE_DESKTOP_LEAD_MS + 1000); // past the token's exp
    const dead = await fx.reader.read();
    check("past the token's exp the same cache answers expired (the App must re-login)",
      dead.ok === false && dead.reason === AGNESCODE_DESKTOP_REASON.EXPIRED, dead.reason);
    fx.dispose();
  }

  // ── 4. single-flight + failure backoff ─────────────────────────────────
  {
    section("single-flight + failure backoff");
    const now = Date.now();
    const fx = isolated({ now, backoffMs: AGNESCODE_DESKTOP_VIEW_BACKOFF_MS });
    const [a, b] = await Promise.all([fx.reader.read(), fx.reader.read()]);
    check("two concurrent reads share ONE walk",
      fx.walkCount() === 1
      && a.reason === AGNESCODE_DESKTOP_REASON.FILE_MISSING
      && b.reason === AGNESCODE_DESKTOP_REASON.FILE_MISSING,
      `walks=${fx.walkCount()}`);
    check("a failed walk buys the 60 s backoff (the next read answers from the last reason)",
      (await fx.reader.read()).reason === AGNESCODE_DESKTOP_REASON.FILE_MISSING && fx.walkCount() === 1,
      `walks=${fx.walkCount()}`);
    fx.setNow(now + AGNESCODE_DESKTOP_VIEW_BACKOFF_MS + 1000);
    await fx.reader.read();
    check("after the window the walk runs again", fx.walkCount() === 2, `walks=${fx.walkCount()}`);
    // That walk (still file_missing, no files yet) armed a SECOND backoff
    // window — advance past it before the success case can run.
    fx.setNow(now + 2 * AGNESCODE_DESKTOP_VIEW_BACKOFF_MS + 2000);
    writeApp(fx.root, encryptSessionBlob(sessionDoc(now)));
    const ok = await fx.reader.read();
    check("a successful walk clears the backoff (reads no longer answer the stale reason)",
      ok.ok === true, JSON.stringify({ ok: ok.ok, reason: ok.reason }));
    fx.dispose();

    // A walk seam that throws is read_failed through the same backoff. The
    // `walk` override is the seam: a walk that THROWS (rather than answering
    // its own tiers) is the reader's `read_failed` fact.
    {
      let clock = Date.now();
      const reader = createAgnescodeDesktopViewReader({
        env: { APPDATA: mkdtempSync(join(tmpdir(), "dsh-agnescode-view-throw-")) },
        platform: "win32",
        dpapiUnprotect: async () => KEY,
        walk: async () => { throw new Error("the walk seam blew up"); },
        now: () => clock,
        backoffMs: 60_000
      });
      const threw = await reader.read();
      check("a throwing walk seam reads as read_failed (never a stack trace to the panel)",
        threw.ok === false && threw.reason === AGNESCODE_DESKTOP_REASON.READ_FAILED, threw.reason);
      const again = await reader.read();
      check("... and it sits out the backoff like every other failure",
        again.reason === AGNESCODE_DESKTOP_REASON.READ_FAILED, again.reason);
    }
  }

  releaseNetworkGuard();
} catch (error) {
  results.push({ name: "suite crashed", pass: false, detail: String(error?.stack ?? error) });
  releaseNetworkGuard();
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((entry) => !entry.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
