// @ts-check
/**
 * Gate for the build (ADR-008, ROADMAP §6.2).
 *
 * `src/` holds ALL sources (host + client); `lib/` and the root `client.js` are
 * GENERATED artifacts that are TRACKED in git — a git/marketplace install clones
 * them ready to load, because pnpm refuses to run build scripts for git
 * dependencies outright (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, and the
 * `allowBuilds` allowlist is a knob plugin installers cannot reach). This gate
 * owns the properties the offline suites, which import the SOURCES directly,
 * cannot see:
 *
 * 1. BUILD — `tsdown -c tsdown.config.mjs` must succeed.
 * 2. FRESHNESS — BOTH `lib/` and the root `client.js` must equal a rebuild of
 *    the current `src/`, file for file. A stale artifact silently ships
 *    yesterday's code: the working tree is clean, the offline suites are green,
 *    the typecheck is green. This is the one failure mode of the committed-
 *    artifact model in which nothing else goes red, which is why the gate
 *    compares content and never a timestamp (`git clone`, unpacking and CI cache
 *    restores all rewrite mtimes, and `touch src/**` would fool an mtime gate
 *    anyway).
 * 3. SHAPE — the artifact carries no top-level `import`/`export` statement
 *    (legal in all three module worlds), registers exactly one bundle under the
 *    plugin id when imported as ESM, materializes with a react-only stand-in
 *    require, and still exposes the panel test surface.
 *
 * READ-ONLY. The rebuild lands in a gitignored staging dir and never touches
 * `lib/` or `client.js`. The previous implementation ran `npm run build` in the
 * repo itself, so a test run silently rewrote tracked artifacts and a
 * mid-build failure left the tree half-rebuilt with no signal that anything had
 * been touched. A gate must not repair the thing it is measuring.
 *
 * The staged build uses the REAL config, not a copy of it: `tsdown.config.mjs`
 * is re-emitted VERBATIM with only the two `outDir` values redirected. tsdown's
 * `defineConfig` is an identity function, so the verbatim copy is exactly what
 * `npm run build` would run. A reconstructed config would need a second,
 * hand-kept copy of the naming scheme and of the peer list; when the real config
 * drifts, the gate would report "tracked but absent from the rebuild", which
 * reads like "changed src, forgot to build" and burns a round of the wrong
 * investigation. If the config loses the shape this gate depends on (both
 * outDirs named as expected) it fails LOUD, naming the missing anchor, instead
 * of comparing against the wrong baseline.
 *
 * Same rule as test/e2e-gate.mjs: if tsdown is not installed, print a loud SKIP
 * and exit 0 — a machine without dev deps is not a regression. (CI's offline job
 * installs devDeps and runs this gate for real, so a failed build or a missing
 * artifact is red there, as ROADMAP §6.2 records.)
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_CONFIG = join(ROOT, "tsdown.config.mjs");
/** The gate's own temp config. Written inside the repo (tsdown's module
 * resolution trips over a parent package.json elsewhere) and deleted on exit. */
const STAGE_CONFIG = join(ROOT, ".build-gate.config.mjs");
/** Staging root. Inside the repo, not in the OS temp dir: Node's ESM loader
 * walks UP from an imported file looking for a package.json, and a malformed
 * one in `%TEMP%` makes the shape checks blow up with "Invalid package config"
 * instead of inspecting the artifact (measured 2026-10-06). `tmp/` is already
 * gitignored, so the staging dir is invisible to git and is removed on exit.
 * It is NOT tracked in git, so a clean checkout need not contain it — create it
 * on demand (recursive) before staging, otherwise `mkdtempSync` fails with
 * ENOENT on a fresh CI runner and every downstream freshness check fails with a
 * misleading "build could not be produced" (seen 2026-10-07: offline hard gate
 * red on both node 22 and 24 from exactly this). */
const STAGE_ROOT = join(ROOT, "tmp");
mkdirSync(STAGE_ROOT, { recursive: true });

/** Tracked artifacts and the path each one takes in the staged rebuild.
 * The staged outDirs keep the repo-relative names, so the mapping is 1:1. */
const ARTIFACTS = [
  { rel: "lib", kind: "dir", label: "lib/" },
  { rel: "client.js", kind: "file", label: "client.js" }
];

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  if (!pass) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!existsSync(join(ROOT, "node_modules", "tsdown", "package.json"))) {
  process.stderr.write(
    `\n[build-gate] SKIPPED — tsdown is not installed.\n` +
    `[build-gate]   Bootstrap dev deps with: npm i -D tsdown --legacy-peer-deps\n` +
    `[build-gate]   (the repo's peerDependencies are Host-runtime packages and do not\n` +
    `[build-gate]   resolve from a registry, so a plain npm install cannot run here).\n\n`
  );
  process.exit(0);
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Windows path → POSIX (config literals must be POSIX; a backslash path in a
 * spec is read as a URL scheme). */
const toPosix = (p) => p.split(sep).join("/");

/** Count of regex matches (a global regex, so no lastIndex drift). */
const countMatches = (text, re) => [...text.matchAll(re)].length;

/** Normalized content hash (CRLF-neutral): the comparison unit. */
const hashOf = (path) =>
  createHash("sha256")
    .update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"))
    .digest("hex")
    .slice(0, 12);

/** "relPath → hash" for every file under `dir`; null if missing or empty. */
function fingerprintDir(dir) {
  if (!existsSync(dir)) return null;
  const walk = (d, base) => {
    const out = [];
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const full = join(d, e.name);
      if (e.isDirectory()) out.push(...walk(full, base));
      else if (e.isFile()) out.push(toPosix(relative(base, full)));
    }
    return out;
  };
  const files = walk(dir, dir);
  if (files.length === 0) return null;
  return new Map(files.map((rel) => [rel, hashOf(join(dir, rel))]));
}

/** Locate tsdown's executable through its own package.json#bin rather than
 * hard-coding `dist/run.mjs` — that filename has changed between releases, and
 * a MODULE_NOT_FOUND here would read as "the artifacts are stale". */
function resolveTsdownBin() {
  const pkgPath = join(ROOT, "node_modules", "tsdown", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const rel = typeof pkg.bin === "string"
    ? pkg.bin
    : pkg.bin?.[Object.keys(pkg.bin ?? {})[0] ?? ""];
  if (typeof rel !== "string" || rel === "") {
    throw new Error(`tsdown's package.json#bin is unreadable (got ${JSON.stringify(pkg.bin)})`);
  }
  return join(ROOT, "node_modules", "tsdown", rel);
}

/**
 * The repo config verbatim, with only the two `outDir` values redirected into
 * the staging dir. tsdown's `defineConfig` returns its argument unchanged, so
 * this runs the SAME config `npm run build` runs.
 *
 * Each anchor must match EXACTLY once: a miss means the config changed shape
 * and this gate has no baseline to compare against — that is a loud failure
 * ("the gate cannot read its own inputs"), never a silent one.
 * @param {string} configSource - tsdown.config.mjs, verbatim.
 * @param {string} staging - staging dir, native separators.
 * @returns {string} staged config source.
 */
function stagedConfig(configSource, staging) {
  const hostAnchor = /outDir:\s*"lib"/g;
  const clientAnchor = /outDir:\s*"\.\/?"/g;
  const hostN = countMatches(configSource, hostAnchor);
  const clientN = countMatches(configSource, clientAnchor);
  if (hostN !== 1) {
    throw new Error(
      `tsdown.config.mjs carries ${hostN} host outDir: "lib" anchor(s) — this gate needs exactly one to ` +
      "redirect the host build into staging. The config changed shape, so the gate has no baseline; " +
      "sync test/build-gate.mjs's stagedConfig()."
    );
  }
  if (clientN !== 1) {
    throw new Error(
      `tsdown.config.mjs carries ${clientN} client outDir: "." anchor(s) — this gate needs exactly one to ` +
      "redirect the client build into staging. The config changed shape, so the gate has no baseline; " +
      "sync test/build-gate.mjs's stagedConfig()."
    );
  }
  const stagingPosix = toPosix(staging);
  let out = configSource.replace(hostAnchor, `outDir: ${JSON.stringify(stagingPosix + "/lib")}`);
  out = out.replace(clientAnchor, `outDir: ${JSON.stringify(stagingPosix)}`);
  return out;
}

// ── 1. the build, staged ────────────────────────────────────────────────────

let staging = null;
let stageFailed = false;
try {
  staging = mkdtempSync(join(STAGE_ROOT, "build-gate-"));
  const configSource = readFileSync(REPO_CONFIG, "utf8");
  writeFileSync(STAGE_CONFIG, stagedConfig(configSource, staging), "utf8");

  const build = execFileSync(
    process.execPath,
    [resolveTsdownBin(), "-c", STAGE_CONFIG],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 }
  );
  check("tsdown rebuild of src/ succeeds", true, String(build).slice(-500));
} catch (error) {
  stageFailed = true;
  // execFileSync throws an object carrying stdout/stderr; a plain `throw "x"`
  // from the config rewrite would be a bare string, so keep both shapes honest.
  const err = /** @type {{ stdout?: unknown, stderr?: unknown, message?: unknown }} */ (
    error instanceof Error || (typeof error === "object" && error !== null) ? error : {}
  );
  const detail = [
    err.stdout ? String(err.stdout) : "",
    err.stderr ? String(err.stderr) : "",
    String(err.message ?? error)
  ].join("\n").trim();
  check("tsdown rebuild of src/ succeeds", false,
    "the build could not be produced, so freshness is UNDECIDABLE — that itself is a failure:\n" +
    detail.split("\n").map((l) => `        ${l}`).join("\n"));
} finally {
  rmSync(STAGE_CONFIG, { force: true });
}

// ── 2. freshness: tracked artifacts vs the staged rebuild ──────────────────

if (!stageFailed && staging !== null) {
  for (const { rel, kind, label } of ARTIFACTS) {
    const repoAbs = join(ROOT, rel);
    const tracked = existsSync(repoAbs);
    check(`${label} is tracked in the working tree`, tracked,
      tracked ? "" : "a git/marketplace install would ship no such artifact; run `npm run build`");

    // Staged side: a dir target fingerprints the whole directory; a file target
    // fingerprints that ONE file (not the staging root, which also holds the
    // other entry's output).
    const staged = kind === "dir"
      ? fingerprintDir(join(staging, rel))
      : (existsSync(join(staging, rel)) ? new Map([[rel, hashOf(join(staging, rel))]]) : null);
    if (staged === null) {
      check(`${label} is fresh against a rebuild of src/`, false,
        `the staged rebuild produced nothing at ${rel} — the build entry or config changed, so this gate's ` +
        "ARTIFACTS list needs syncing");
      continue;
    }

    // Repo side: for a dir, the whole directory; for a file, that file only.
    const repo = kind === "dir"
      ? fingerprintDir(repoAbs)
      : (existsSync(repoAbs) ? new Map([[rel, hashOf(repoAbs)]]) : null);
    if (repo === null || repo.size === 0) {
      check(`${label} is fresh against a rebuild of src/`, false,
        `the tracked artifact cannot be read back — run \`npm run build\``);
      continue;
    }

    const renamed = [...repo.keys()].filter((k) => !staged.has(k));
    const missing = [...staged.keys()].filter((k) => !repo.has(k));
    const changed = [...repo.keys()]
      .filter((k) => staged.has(k) && staged.get(k) !== repo.get(k));

    if (renamed.length === 0 && missing.length === 0 && changed.length === 0) {
      check(`${label} is fresh against a rebuild of src/`, true,
        `${repo.size} artifact(s), byte-for-byte identical`);
      continue;
    }

    const detail = [];
    if (changed.length > 0) detail.push(`content changed: ${changed.join(", ")}`);
    if (renamed.length > 0) detail.push(`tracked but absent from the rebuild: ${renamed.join(", ")}`);
    if (missing.length > 0) detail.push(`in the rebuild but not tracked: ${missing.join(", ")}`);
    check(`${label} is fresh against a rebuild of src/`, false,
      `${detail.join("; ")}.\n` +
      "        src/ changed without a rebuild + commit. Fix: npm run build && git add lib client.js\n" +
      "        (the artifacts are tracked in git and must land in the SAME commit as the src that produced them —\n" +
      "         splitting them lets a marketplace install briefly ship the old code)");
  }
}

// ── 3. shape: the artifact of the current src/ must still load ──────────────
// Run against the STAGED client.js, not the working tree: the shape checks are
// about what src/ produces, and a stale working tree must not hide a broken
// source (the freshness check above already reports that drift).
{
  const stagedClient = join(staging ?? "", "client.js");
  if (stageFailed || staging === null || !existsSync(stagedClient)) {
    // The build itself failed; the shape checks would import a stale artifact.
    for (const n of [
      "artifact has no top-level import/export statement",
      "artifact registers exactly one bundle",
      "artifact resolves the panel surface"
    ]) check(n, false, "no staged artifact to inspect (the build failed above)");
  } else {
    const artifactText = readFileSync(stagedClient, "utf8").replace(/\r\n/g, "\n");
    check("artifact has no top-level import/export statement",
      !/^\s*import\s*[{*"'\w]/m.test(artifactText) && !/^\s*export\s*[{*\w]/m.test(artifactText));

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

    let surface = null;
    let pluginId = null;
    try {
      await import(pathToFileURL(stagedClient).href);
      check("artifact registers exactly one bundle", captured.length === 1, `got ${captured.length}`);
      if (captured.length === 1) {
        const registration = captured[0];
        pluginId = registration.id;
        check("registration carries the plugin id", pluginId === "dsh-connect-agnes-token-plan",
          String(pluginId));
        const instance = registration.factory((specifier) => {
          if (specifier === "react") return reactStandin;
          throw new Error(`unexpected require of "${specifier}"`);
        });
        surface = instance.panel;
        check("factory returns an apply function", typeof instance.apply === "function",
          String(typeof instance.apply));
        check("factory returns the inject list",
          Array.isArray(instance.inject) && instance.inject.join(",") === "slots,locale",
          JSON.stringify(instance.inject));
      }
    } catch (error) {
      check("artifact registers exactly one bundle", false, String(error));
    }

    const surfaceKeys = ["interpretSnapshot", "viewOf", "errorOfStatus", "dictionaries", "tables",
      "styles", "helpers", "components"];
    check("artifact resolves the panel surface",
      surface !== null && surfaceKeys.every((key) => key in surface),
      surface === null ? "panel missing" : surfaceKeys.filter((key) => !(key in surface)).join(","));

    // The keys being present is only a mount smoke test. Drive a few of the REAL
    // definitions through the artifact, so it is proven to carry working logic —
    // not just a shape. The behaviour suites already exercise these definitions
    // against the SOURCES (test/client-surface.js); this pair is the artifact's
    // own half: the same logic, shipped.
    if (surface !== null) {
      // `tt` is an identity translator: `viewOf` returns dictionary KEYS, so a
      // real dictionary is not needed to assert the decision.
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
}

if (staging !== null) rmSync(staging, { recursive: true, force: true });

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
