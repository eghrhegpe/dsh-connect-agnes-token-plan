// @ts-check
/**
 * Gate for the build (docs/ARCHITECTURE.md / ROADMAP §6.2).
 *
 * `src/` holds ALL sources (host + client); `lib/` and the root `client.js`
 * are GENERATED artifacts — TRACKED in git (committed so a git/marketplace
 * install clones them ready to load: pnpm's `packageShouldBeBuilt` skips the
 * build pipeline when the main file is present), fully rebuildable from `src/`.
 * This gate owns the
 * properties the offline suites (which import the SOURCES directly) cannot see:
 *
 * 1. BUILD — `npm run build` (host bundle + client artifact) must succeed.
 * 2. FRESHNESS — the committed-into-the-working-tree `client.js` must match a
 *    rebuild of the current `src/client/`. A stale artifact silently ships
 *    yesterday's client; the suite that fails here tells you to rebuild (the
 *    fresh artifact is already in the working tree). When no artifact exists
 *    yet (clean checkout, never built), a fresh build trivially satisfies it.
 * 3. SHAPE — the artifact carries no top-level `import`/`export` statement
 *    (legal in all three module worlds), registers exactly one bundle under
 *    the plugin id when imported as ESM, materializes with a react-only
 *    stand-in require, and still exposes the panel test surface.
 *
 * Same rule as test/e2e-gate.mjs: if tsdown is not installed, print a loud
 * SKIP and exit 0 — a machine without dev deps is not a regression. (CI's
 * offline job installs devDeps and runs this gate for real, so a failed build
 * or a missing artifact is red there; the SKIP path only covers a bare clone,
 * as ROADMAP §6.2 records.)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(root, "client.js");
const HOST_BUNDLE = join(root, "lib", "index.js");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  if (!pass) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!existsSync(join(root, "node_modules", "tsdown", "package.json"))) {
  process.stderr.write(
    `\n[build-gate] SKIPPED — tsdown is not installed.\n` +
    `[build-gate]   Bootstrap dev deps with: npm i -D tsdown --legacy-peer-deps\n` +
    `[build-gate]   (the repo's peerDependencies are Host-runtime packages and do not\n` +
    `[build-gate]   resolve from a registry, so a plain npm install cannot run here).\n\n`
  );
  process.exit(0);
}

const normalized = (path) => existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
const before = normalized(ARTIFACT);

// 1. the full build (host bundle + client artifact) must succeed
const build = spawnSync("npm", ["run", "build"], {
  cwd: root,
  shell: true,
  encoding: "utf8",
  timeout: 180_000,
});
check("npm run build exits 0", !build.error && build.status === 0,
  String(build.stderr ?? build.error ?? "").slice(-2000));

if (build.error || build.status !== 0) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}

// 2. the host bundle was produced (single lib/index.js entry point)
check("host bundle lib/index.js is produced", existsSync(HOST_BUNDLE),
  existsSync(HOST_BUNDLE) ? "" : "the host build did not emit lib/index.js");
check("host bundle is non-empty", existsSync(HOST_BUNDLE) && readFileSync(HOST_BUNDLE, "utf8").trim().length > 0,
  "");

// 3. freshness: the working-tree artifact must equal a rebuild of the sources.
//    `before` is null only when the artifact is absent (deleted); on a clean
//    checkout it is the COMMITTED artifact, so this same check doubles as the
//    CI freshness gate: a `src/` commit without a rebuilt + committed artifact
//    drifts here. A STALE artifact is a real failure, as ROADMAP §6.2
//    documents ("过期即红"): it means `src/client/` changed without a rebuild,
//    so the panel would have shipped yesterday's client. The gate has already
//    rebuilt above, so the working tree is fresh again — the red just makes the
//    drift visible instead of hiding it inside a green run's detail string.
const after = normalized(ARTIFACT);
const drifted = before !== null && before !== after;
check("client.js is fresh (rebuild reproduces it byte-for-byte)", !drifted,
  drifted ? "the artifact did not match a rebuild of src/client/ — it was rebuilt above; run `npm run build` and commit the rebuilt client.js / lib/ together with the src change (the artifact is tracked in git)" : "");
if (drifted) {
  process.stderr.write(
    `\n[build-gate] WARNING: client.js did not match a rebuild of src/client/.\n` +
    `[build-gate]   A fresh build is already in the working tree. If you edited src/client,\n` +
    `[build-gate]   commit the rebuilt artifact together with the src change — it is\n` +
    `[build-gate]   tracked in git, not gitignored.\n\n`
  );
}

// 4. shape: no top-level import/export statement — the file is evaluated by
//    the browser module table AND imported as legal ESM in Node (the tail in
//    src/client/index.ts pins all three worlds). This pins a property of the
//    GENERATED output, not of the sources, so it is a contract check, not a
//    text anchor.
const artifactText = after ?? "";
check("artifact has no top-level import/export statement",
  !/^\s*import\s*[{*"'\w]/m.test(artifactText) && !/^\s*export\s*[{*\w]/m.test(artifactText));

// 5. behavioral surface: imported as ESM with a capturing
//    `window.__ModuleLoader__` (the client-surface pattern), the artifact
//    must register exactly one bundle under the plugin id, materialize with
//    a react-only stand-in require, and expose the panel surface keys.
const reactStandin = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => undefined,
  useCallback: (callback) => callback,
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial })
};

const win = /** @type {any} */ (globalThis.window ?? {});
globalThis.window = win;
const captured = [];
win.__ModuleLoader__ = { load: (registration) => captured.push(registration) };

await import(pathToFileURL(ARTIFACT).href);

check("artifact registers exactly one bundle", captured.length === 1, `got ${captured.length}`);
if (captured.length === 1) {
  const registration = captured[0];
  check("registration carries the plugin id", registration.id === "dsh-connect-agnes-token-plan",
    String(registration.id));
  let surface = null;
  try {
    const instance = registration.factory((specifier) => {
      if (specifier === "react") return reactStandin;
      throw new Error(`unexpected require of "${specifier}"`);
    });
    surface = instance.panel;
    check("factory returns an apply function", typeof instance.apply === "function",
      String(typeof instance.apply));
    check("factory returns the inject list", Array.isArray(instance.inject) && instance.inject.join(",") === "slots,locale",
      JSON.stringify(instance.inject));
  } catch (error) {
    check("factory materializes with a react-only require", false, String(error));
  }
  const surfaceKeys = ["interpretSnapshot", "viewOf", "errorOfStatus", "dictionaries", "tables", "styles", "helpers", "components"];
  check("panel surface exposes every documented key", surface !== null && surfaceKeys.every((key) => key in surface),
    surface === null ? "panel missing" : surfaceKeys.filter((key) => !(key in surface)).join(","));

  // The keys being present is only a mount smoke test. Drive a few of the REAL
  // definitions through the artifact, so it is proven to carry working logic —
  // not just a shape. The behaviour suites already exercise these definitions
  // against the SOURCES (test/client-surface.js); this pair of checks is the
  // artefact's own half: the same logic, shipped.
  if (surface !== null) {
    // `tt` is an identity translator: the decision returns dictionary KEYS
    // (see `viewOf`), so a real dictionary is not needed to assert it.
    const tt = (key) => key;
    const healthy = { ok: true, quota: { consoleConnected: true } };
    const read = surface.interpretSnapshot(healthy);
    check("artifact reads a healthy body as data",
      read.data === healthy && read.error === null, JSON.stringify(read.error));
    const refused = surface.interpretSnapshot({ ok: false, code: "login_rejected" });
    check("artifact reads a refused body as a structured error",
      refused.data === null && refused.error?.code === "login_rejected",
      JSON.stringify(refused.error));
    const view = surface.viewOf(null, { code: "not_configured" }, tt);
    check("artifact resolves the setup decision",
      view.needsSetup === true && view.guidanceKey === "panel.jwtMissing",
      JSON.stringify({ needsSetup: view.needsSetup, guidanceKey: view.guidanceKey }));
    const zhKeys = Object.keys(surface.dictionaries.zh ?? {});
    const enKeys = Object.keys(surface.dictionaries.en ?? {});
    check("artifact carries both dictionaries with content",
      zhKeys.length > 20 && enKeys.length > 20 && "tab.quota" in (surface.dictionaries.zh ?? {}),
      `zh=${zhKeys.length} en=${enKeys.length}`);
    const named = Object.keys(surface.components ?? {});
    check("artifact exposes the panel components",
      named.includes("PanelPage") && named.includes("PlanCard"), named.join(","));
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
