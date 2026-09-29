// @ts-check
/**
 * Gate for the client build pipeline (docs/ROADMAP.md §6.2).
 *
 * The client.js split is gated on introducing a build chain, and the one risk
 * that decision carries is the loader ABI: the bundle must keep loading in
 * three module worlds (browser module table, Node CJS `require`, Node ESM
 * `import`) with no top-level import/export statements and no dependency
 * other than react-through-factory-require. This gate rehearses the whole
 * chain against TODAY'S source — bundling the root `client.js` passthrough
 * style and proving the artifact behaves identically — so the day the split
 * lands, the only new variable is the file layout, not the toolchain.
 *
 * Same rule as test/e2e-gate.mjs: if tsdown is not installed, print a loud
 * SKIP and exit 0 — a machine without dev deps is not a regression. (CI's
 * offline job installs nothing, so it always SKIPs here for now; wiring build
 * + freshness into CI is on the split-day checklist in ROADMAP §6.2.)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(root, "tmp", "build-dry", "client.js");

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

// 1. the dry build itself must succeed
const build = spawnSync("npm", ["run", "build:client:dry"], {
  cwd: root,
  shell: true,
  encoding: "utf8",
  timeout: 120_000,
});
check("npm run build:client:dry exits 0", !build.error && build.status === 0,
  String(build.stderr ?? build.error ?? "").slice(-2000));

if (build.error || build.status !== 0) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}

// 2. the artifact must carry no top-level import/export statement: the file is
//    evaluated by the browser module table AND imported as legal ESM in Node
//    (the client.js tail comment pins all three worlds). A bundler that leaks
//    a static import — e.g. a real `import ... from "react"` — breaks both
//    worlds at once, so this stays checked even though it looks like a text
//    anchor: it pins a property of the GENERATED output, not of the source.
const artifactText = readFileSync(ARTIFACT, "utf8");
check("artifact exists and is non-empty", artifactText.length > 0);
check("artifact has no top-level import/export statement",
  !/^\s*import\s*[{*"'\w]/m.test(artifactText) && !/^\s*export\s*[{*\w]/m.test(artifactText));

// 3. behavioral ABI: load source and artifact as ESM with a capturing
//    `window.__ModuleLoader__` (the client-surface pattern), materialize both
//    factories with the same stand-in require, and demand identical
//    registrations. Deliberately NOT a text comparison — the transform is
//    allowed to rewrite the code; only the observed surface must survive.
const reactStandin = {
  createElement: (type, props, ...children) => ({ type, props, children }),
};
const requireStandin = (spec) => {
  if (spec === "react") return reactStandin;
  throw new Error(`the client factory required "${spec}" — only react may pass`);
};

const win = /** @type {any} */ (globalThis.window ?? {});
globalThis.window = win;

async function loadRegistration(path) {
  const captured = [];
  win.__ModuleLoader__ = { load: (registration) => captured.push(registration) };
  await import(path);
  return captured;
}

const fromSource = await loadRegistration(new URL("../client.js", import.meta.url).href);
const fromArtifact = await loadRegistration(pathToFileURL(ARTIFACT).href);

check("source registers exactly one bundle", fromSource.length === 1, `got ${fromSource.length}`);
check("artifact registers exactly one bundle", fromArtifact.length === 1, `got ${fromArtifact.length}`);

if (fromSource.length === 1 && fromArtifact.length === 1) {
  const surfaceOf = (registration) => {
    const instance = registration.factory(requireStandin);
    return {
      inject: instance.inject,
      panel: instance.panel,
      applyIsFunction: typeof instance.apply === "function",
    };
  };
  const normalize = (value) => JSON.stringify(
    value,
    (_key, x) => (typeof x === "function" ? `ƒ${x.length}` : x)
  );
  const sourceSurface = normalize(surfaceOf(fromSource[0]));
  const artifactSurface = normalize(surfaceOf(fromArtifact[0]));
  check("artifact registration is identical to source (inject/panel/apply)",
    sourceSurface === artifactSurface,
    `source=${sourceSurface.slice(0, 400)} artifact=${artifactSurface.slice(0, 400)}`);
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
