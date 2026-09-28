/**
 * End-to-end: a REAL `dsh web` process, the real plugin, real HTTP.
 *
 * Everything below the Host is a stub — a fake SenseNova platform on
 * 127.0.0.1 — but nothing below the plugin is faked: the bundle is loaded by
 * the Loader, the routes are registered with the real webserver, the browser
 * trust fence and auth cookie are the Host's own, and the panel renders from
 * the response a real HTTP client received.
 *
 * The isolation is deliberate and total:
 *
 *   - A SEPARATE `$DSH_HOME`, so the run cannot see the real credentials, the
 *     real plugin registry, or the real profiles.
 *   - NO account credentials anywhere. The panel boots into `not_configured`.
 *   - Every endpoint redirected to 127.0.0.1, so even a bug that tried to sign
 *     in would reach the fake.
 *
 * That last pair is not ceremony. An earlier attempt at this harness used a
 * nested `auth:` block, which the loader accepts and the plugin ignores — so
 * the panel used its shipped defaults and POSTED A REAL LOGIN ATTEMPT to
 * iam.sensecoreapi.cn during a test run. The plugin now rejects that shape
 * outright (see resolveAuthOverrides), and this harness asserts the redirect
 * actually took effect before it lets a sign-in happen.
 *
 * Run it with `npm run test:e2e`. It is NOT part of `npm test`: it boots a
 * server, so it is slower and needs the dsh CLI on PATH.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_DIR = process.env.PANEL_DIR ?? "C:/Users/zhujieling11/.dsh/plugins/dsh-connect-sensenova-token-plan";
/** `dsh` from the npm global bin; the shim on PATH is preferred when present. */
const DSH = process.env.DSH_CLI ?? "dsh";

/**
 * Ask the OS for a free port.
 *
 * Hard-coded ports collide with a previous run that has not finished releasing
 * its socket, and the symptom is a bare "fetch failed" with nothing pointing at
 * the real cause.
 * @returns {Promise<number>} a port nothing is listening on.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function note(text) {
  process.stdout.write(`  ${text}\n`);
}

/**
 * Deadline for ONE request to the Host.
 *
 * Only the Host's boot had a timeout, so a check whose `fetch` never settled
 * hung the run forever — no failure, no output, just a process that never
 * returns. Every call to the Host now carries its own deadline, and a refusal
 * to answer becomes a failed check naming the request that did not answer.
 */
const CALL_TIMEOUT_MS = 15_000;

/**
 * Deadline for the whole run.
 *
 * The backstop behind the per-call deadlines: nothing in a test runner should
 * be able to hang indefinitely, least of all one that spawns a real Host
 * process. Exceeding it fails the run loudly instead of waiting forever.
 */
const RUN_TIMEOUT_MS = 240_000;

/** Reject when `promise` has not settled in `ms`. */
function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/** The isolated home: a profile whose only plugin is ours, aimed at the fake. */
function buildHome(fakePort) {
  const home = mkdtempSync(join(tmpdir(), "dsh-panel-e2e-"));
  const profile = join(home, "profiles", "web");
  mkdirSync(join(profile, "node_modules"), { recursive: true });
  symlinkSync(PLUGIN_DIR, join(profile, "node_modules", "dsh-connect-sensenova-token-plan"), "junction");
  writeFileSync(join(profile, "package.json"), JSON.stringify({
    name: "dsh-profile-web-e2e",
    private: true,
    dependencies: { "dsh-connect-sensenova-token-plan": `link:${PLUGIN_DIR}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-connect-sensenova-token-plan"] } }
  }, null, 2));

  // The row id is the one the plugin's own patch declares, and the login-flow
  // overrides are TOP-LEVEL keys. A nested `auth:` block is accepted here and
  // ignored by the plugin, which is how the run once reached the real IAM.
  writeFileSync(join(profile, "cordis.patch.yml"), [
    "- id: dsh-connect-sensenova-token-plan",
    "  name: dsh-connect-sensenova-token-plan",
    "  config:",
    `    consoleBase: http://127.0.0.1:${fakePort}`,
    `    apiBase: http://127.0.0.1:${fakePort}/v1`,
    `    iamBase: http://127.0.0.1:${fakePort}`,
    `    tokenEndpoint: http://127.0.0.1:${fakePort}/oauth2/token`,
    `    jwksEndpoint: http://127.0.0.1:${fakePort}/.well-known/jwks.json`,
    `    redirectUri: http://127.0.0.1:${fakePort}`,
    ""
  ].join("\n"));
  return home;
}

/** Start the fake platform in this process and wait for it to listen. */
async function startFake(port) {
  process.env.FAKE_PORT = String(port);
  return import(`file://${join(PLUGIN_DIR, "test", "fake-platform.mjs")}?${Date.now()}`);
}

/** Boot the Host and resolve with its launch token once it prints one. */
function startHost(home, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(DSH, ["--profile", "web", "--no-open", "--port", String(port)], {
      env: { ...process.env, DSH_HOME: home },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`the Host did not report a URL:\n${out}`)), 180_000);
    const onData = (chunk) => {
      out += String(chunk);
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9._~-]+)/);
      if (match !== null) {
        clearTimeout(timer);
        resolve({ child, url: `http://127.0.0.1:${port}/?token=${match[1]}`, output: () => out });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      // Recorded rather than thrown: an exit AFTER the URL was printed is a
      // different (and much more interesting) failure than one before, and it
      // arrives while requests are in flight.
      child.exited = { code, signal };
      reject(new Error(`the Host exited (${String(code)}/${String(signal)}) before serving:\n${out}`));
    });
  });
}

/** A session carrying the Host's own browser-trust cookie. */
async function openSession(url, port) {
  const first = await fetch(url);
  const cookie = (first.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).join("; ");
  return {
    cookie,
    /** A call that presents the cookie and a matching origin. */
    async call(path, init = {}) {
      const label = `${init.method ?? "GET"} ${path}`;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        // Each request gets a deadline. Without one, a Host that accepts the
        // connection and never answers hangs the entire run with no output.
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        // No connection reuse. The Host closes sockets after a response, and
        // undici will happily hand a closed one back from its pool — which
        // surfaces as `UND_ERR_SOCKET` on a request the server never received.
        // Each call is one short-lived connection, which is exactly what a test
        // wants and costs nothing at this rate.
        headers: { cookie, origin: `http://127.0.0.1:${port}`, connection: "close", ...init.headers }
      }).catch((error) => {
        // Name the request, and say whether the Host is still alive: a bare
        // "fetch failed" from a ten-call run says nothing about which call died
        // or whether the process went with it.
        const exited = host?.child?.exited;
        throw new Error(
          `${label} failed: ${error?.cause?.code ?? error?.message ?? error}` +
          `${exited === undefined ? "" : ` (the Host exited: ${String(exited.code)}/${String(exited.signal)})`}`
        );
      });
      // The body gets a deadline too: a response that opens and then stalls
      // would otherwise hang here, past the point the request deadline covers.
      return readJson(response, label);
    }
  };
}

/**
 * Read a response as JSON when it is JSON, and as text when it is not.
 * @param {Response} response - the response to read.
 * @returns {Promise<{status: number, body: object|null, text: string}>}
 */
async function readJson(response, label = "the response") {
  const text = await withDeadline(response.text(), CALL_TIMEOUT_MS, `reading the body of ${label}`);
  try { return { status: response.status, body: JSON.parse(text), text }; } catch { return { status: response.status, body: null, text }; }
}

let host = null;
let fake = null;
let home = null;
const PORT = await freePort();
const FAKE_PORT = await freePort();
home = buildHome(FAKE_PORT);

/**
 * The run-wide backstop: past this the run is a failure, not a slow test.
 *
 * It reports which check it died on rather than just dying, because "the e2e
 * hung" is unactionable and "it hung on the token exchange" is not. The Host
 * is killed on the way out — an orphaned Host holding its port is what makes
 * the NEXT run fail for an unrelated reason.
 */
const watchdog = setTimeout(() => {
  const last = results.at(-1)?.name ?? "(none)";
  check("the e2e run finished inside its budget", false,
    `exceeded ${RUN_TIMEOUT_MS}ms; the last check reached was: ${last}`);
  host?.child?.kill();
  console.log(JSON.stringify(results, null, 2));
  console.error(
    `\nthe e2e run exceeded ${RUN_TIMEOUT_MS}ms — failing rather than hanging forever.` +
    `\nlast check reached: ${last}`
  );
  process.exit(1);
}, RUN_TIMEOUT_MS);

try {
  note(`isolated home: ${home}`);
  fake = await startFake(FAKE_PORT);
  note(`fake platform on 127.0.0.1:${FAKE_PORT}`);

  host = await startHost(home, PORT);
  note(`dsh web on 127.0.0.1:${PORT}`);

  const warnings = host.output();
  check("the plugin activated without a loader warning",
    !warnings.includes("did not activate"), warnings.split("\n").filter((l) => l.includes("activate")).join(" | "));
  check("the routes were not rejected as duplicates",
    !warnings.includes("duplicate exact route"));

  const session = await openSession(host.url, PORT);
  const call = session.call;

  // === the panel is reachable and honest about having no account ==========
  {
    const res = await call("/api/dsh-connect-sensenova-token-plan/snapshot");
    check("the snapshot route answers through the real webserver", res.status === 200, String(res.status));
    check("an unconfigured panel asks for the account",
      res.body?.ok === false && res.body?.code === "not_configured", JSON.stringify(res.body ?? {}).slice(0, 120));
    check("it demands no user action on a fresh install",
      res.body?.auth?.needsUserAction === false, String(res.body?.auth?.needsUserAction));
  }

  // === the Host's own browser-trust fence ===============================
  // A request with a foreign Origin is refused by the Host before the plugin
  // is reached. (A bare local request with no Origin IS admitted — the Host
  // treats it as same-origin — so the fence is about the Origin header.)
  {
    const res = await readJson(await fetch(`http://127.0.0.1:${PORT}/api/dsh-connect-sensenova-token-plan/snapshot`, {
      headers: { origin: "https://evil.test" }
    }));
    check("a foreign origin is refused by the Host", res.status === 401 || res.status === 403, String(res.status));
  }

  // === the cross-origin fence is the plugin's own ========================
  {
    const res = await readJson(await fetch(`http://127.0.0.1:${PORT}/api/dsh-connect-sensenova-token-plan/account`, {
      method: "POST",
      headers: { cookie: session.cookie, origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ username: "attacker", password: "x" })
    }));
    check("a cross-origin account post is refused", res.status === 403, String(res.status));
  }

  // === a real sign-in, against the fake ==================================
  {
    // The full login takes several round trips inside ONE request. The Host's
    // read timeout may be shorter than the fake's whole flow, in which case the
    // server answers and then drops the socket. Give the exchange room.
    const before = fake.log.iam;
    const res = await call("/api/dsh-connect-sensenova-token-plan/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "e2e-user", password: "e2e-test-password" })
    }).catch((error) => {
      // One retry: a socket the Host closed between the server finishing and
      // the client reading is a transport hiccup, not a verdict. The fake's
      // own counter decides whether the attempt actually happened.
      note(`sign-in transport hiccup (${error.message}); retrying once`);
      return call("/api/dsh-connect-sensenova-token-plan/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "e2e-user", password: "e2e-test-password" })
      });
    });
    check("the sign-in succeeded", res.body?.ok === true, JSON.stringify(res.body ?? {}).slice(0, 200));
    // Where the request actually went. The fake's own counter is the evidence,
    // and it is what an earlier version of this harness failed to check: a
    // nested `auth:` block was accepted by the loader, ignored by the plugin,
    // and the run POSTED A REAL LOGIN ATTEMPT to iam.sensecoreapi.cn. The
    // plugin now rejects that shape outright; this asserts the redirect holds.
    check("the request reached the fake, not the platform", fake.log.iam > before,
      `iam calls ${before} -> ${fake.log.iam}`);
    check("the password arrived sealed and opened to the submitted value",
      fake.seen.password === "e2e-test-password", String(fake.seen.password));
    check("no bad-password refusal was produced", fake.log.badPassword === 0, String(fake.log.badPassword));
    check("a refresh token was obtained", res.body?.hasRefreshToken === true,
      JSON.stringify(res.body?.hasRefreshToken));
  }

  // === the panel reads real numbers out of a real response ===============
  {
    const res = await call("/api/dsh-connect-sensenova-token-plan/snapshot");
    check("the snapshot succeeds after signing in", res.body?.ok === true,
      JSON.stringify(res.body ?? {}).slice(0, 160));
    check("the pool came back with its name", res.body?.pools?.pools?.[0]?.name === "E2E 池",
      JSON.stringify(res.body?.pools?.pools?.[0]?.name));
    check("the 5h window is parsed", res.body?.pools?.pools?.[0]?.window5h?.used === 23456,
      String(res.body?.pools?.pools?.[0]?.window5h?.used));
    check("the 7d reset_at became a number", res.body?.pools?.pools?.[0]?.window7d?.resetAt === 1800600000,
      String(res.body?.pools?.pools?.[0]?.window7d?.resetAt));
    // The trend is a SUM over the series' points (42.5 + 51.25), not the first
    // point — asserting 42.5 here only ever passed because the run used to fail
    // before reaching this check and `undefined !== 42.5` was one of many
    // failures nobody read individually.
    check("the trend came back", res.body?.trend?.models?.[0]?.credits === 93.75,
      JSON.stringify(res.body?.trend?.models?.[0]?.credits));
    check("the token is reported as self-renewing", res.body?.auth?.configured === true);
    check("no wait is being served", res.body?.auth?.retryAfterMs === null, String(res.body?.auth?.retryAfterMs));
    // The console origin proves the whole run stayed on the stub.
    check("the panel is talking to the fake, not the platform",
      res.body?.consoleBase === `http://127.0.0.1:${FAKE_PORT}`, String(res.body?.consoleBase));
  }

  // === a wrong password is classified, and the panel explains itself =====
  {
    const res = await call("/api/dsh-connect-sensenova-token-plan/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "e2e-user", password: "wrong-one" })
    });
    check("a wrong password is reported as such", res.body?.code === "login_rejected", String(res.body?.code));
    check("the platform's own words reach the user",
      typeof res.body?.detail === "string" && res.body.detail.includes("invalid account or password"),
      String(res.body?.detail));
    check("a wrong password demands user action, not a countdown",
      res.body?.needsUserAction === true, String(res.body?.needsUserAction));
    check("a wrong password serves no wait", res.body?.retryAfterMs === null, String(res.body?.retryAfterMs));
  }
} catch (error) {
  check("the e2e run completed", false, String(error?.message ?? error));
  // The Host's own output is the only place a boot-time or request-time failure
  // shows up; without it a "fetch failed" says nothing about why.
  if (host !== null) {
    const tail = host.output().split("\n").slice(-12).join("\n");
    if (tail.trim() !== "") note(`dsh output:\n${tail}`);
  }
} finally {
  clearTimeout(watchdog);
  // Kill the Host AND close its pipes. `shell: true` spawns a shell wrapper,
  // so `kill()` can leave the real process — and its inherited stdout/stderr —
  // alive. An open pipe on a child keeps this event loop up, which is how a
  // run printed all 24 results and then sat there for minutes looking busy.
  if (host?.child !== undefined) {
    host.child.kill();
    for (const stream of [host.child.stdout, host.child.stderr]) {
      try { stream?.destroy(); } catch { /* already gone */ }
    }
  }
  // Teardown gets a deadline too: a fake that will not close would otherwise
  // hang the run after every check had already passed.
  if (fake?.close !== undefined) {
    await withDeadline(Promise.resolve(fake.close()), 10_000, "closing the fake platform")
      .catch(() => { /* best effort: the results are already in hand */ });
  }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
else console.log(`\nall ${results.length} e2e checks passed`);

// Leave explicitly. The failure path used to `process.exit(1)` while the
// success path relied on the event loop draining — and it never did, because a
// spawned Host's pipes keep a handle open. A run that prints "all 24 checks
// passed" and then hangs reads exactly like a run that is still working, which
// is how six minutes disappeared. One turn for stdout to drain, then exit.
const exitCode = failed.length > 0 ? 1 : 0;
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 100).unref();
