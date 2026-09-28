/**
 * Config single-source pin.
 *
 * `index.js` reads every default from one `CONFIG_DEFAULTS` object, and
 * `cordis.patch.yml` is the human-authored mirror of that contract. The two are
 * allowed to differ only where the patch comments a key out (its default meaning
 * "use the platform value"), but they must not drift silently: this file fails
 * the moment a default the code ships is not the one the patch documents, or a
 * key the code reads is missing from the patch entirely.
 *
 * This needs no peer package — it only imports `index.js` and reads the patch
 * file as text, so it runs on a clean checkout.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveSettings, CONFIG_DEFAULTS, resolveAuthOverrides } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const patch = readFileSync(join(here, "..", "cordis.patch.yml"), "utf8");

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

// --- 1. resolveSettings({}) returns the single-source defaults -----------
{
  const { settings, configError } = resolveSettings({});
  check("no config error on an empty config", configError === null, String(configError));
  check("consoleBase default", settings.consoleBase === CONFIG_DEFAULTS.consoleBase, settings.consoleBase);
  check("apiBase default", settings.apiBase === CONFIG_DEFAULTS.apiBase, settings.apiBase);
  check("trendHours default", settings.trendHours === CONFIG_DEFAULTS.trendHours, String(settings.trendHours));
  check("cacheSeconds default", settings.cacheSeconds === CONFIG_DEFAULTS.cacheSeconds, String(settings.cacheSeconds));
  check("pollSeconds default", settings.pollSeconds === CONFIG_DEFAULTS.pollSeconds, String(settings.pollSeconds));
  check("consoleTimeoutMs default", settings.consoleTimeoutMs === CONFIG_DEFAULTS.consoleTimeoutMs, String(settings.consoleTimeoutMs));
  check("tokenSkewSeconds default", settings.tokenSkewSeconds === CONFIG_DEFAULTS.tokenSkewSeconds, String(settings.tokenSkewSeconds));
  check("default allowedHosts match the schema",
    [...settings.allowedHosts].join(",") === CONFIG_DEFAULTS.admittedHosts.join(","),
    [...settings.allowedHosts].join(","));
  check("default auth only carries consoleOrigin",
    Object.keys(settings.auth).length === 1 && settings.auth.consoleOrigin === CONFIG_DEFAULTS.consoleBase,
    JSON.stringify(settings.auth));
}

// --- 2. the patch documents every user-facing key the code reads ----------
// Active keys always carry a value; the auth overrides are commented by design.
const USER_FACING = [
  "consoleBase", "trendHours", "cacheSeconds", "tokenSkewSeconds",
  "iamBase", "tokenEndpoint", "jwksEndpoint", "redirectUri",
  "clientId", "scope", "encKeyId", "maxHops", "requestTimeoutMs"
];
for (const key of USER_FACING) {
  // Matches `key:` (active) or `# key:` / `#key:` (commented) — either way the
  // patch acknowledges the key, so a code-side addition cannot go undocumented.
  const mentioned = new RegExp(`(^|\\s)#?\\s*${key}\\s*:`, "m").test(patch);
  check(`cordis.patch.yml documents ${key}`, mentioned, mentioned ? "" : "key absent from patch");
}

// The active keys must carry the SAME default the code ships, or the panel's
// "defaults" and the bundle's "defaults" disagree.
function activeValue(key) {
  const m = patch.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, "m"));
  return m ? m[1] : null;
}
check("patch consoleBase matches code default", activeValue("consoleBase") === CONFIG_DEFAULTS.consoleBase.replace(/\/+$/, ""), activeValue("consoleBase"));
check("patch trendHours matches code default", Number(activeValue("trendHours")) === CONFIG_DEFAULTS.trendHours, activeValue("trendHours"));
check("patch cacheSeconds matches code default", Number(activeValue("cacheSeconds")) === CONFIG_DEFAULTS.cacheSeconds, activeValue("cacheSeconds"));
check("patch tokenSkewSeconds matches code default", Number(activeValue("tokenSkewSeconds")) === CONFIG_DEFAULTS.tokenSkewSeconds, activeValue("tokenSkewSeconds"));

// --- 3. the auth overrides resolve to the keys the code and patch share ---
{
  const auth = resolveAuthOverrides(
    { consoleBase: CONFIG_DEFAULTS.consoleBase, iamBase: "https://iam.example", tokenEndpoint: "https://tok.example" },
    CONFIG_DEFAULTS.consoleBase
  );
  check("resolveAuthOverrides forwards iamBase -> iamOrigin", auth.iamOrigin === "https://iam.example", auth.iamOrigin);
  check("resolveAuthOverrides forwards tokenEndpoint", auth.tokenEndpoint === "https://tok.example", auth.tokenEndpoint);
  check("resolveAuthOverrides keeps consoleOrigin", auth.consoleOrigin === CONFIG_DEFAULTS.consoleBase, auth.consoleOrigin);
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
