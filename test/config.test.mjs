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
import { resolveSettings, CONFIG_DEFAULTS, resolveAuthOverrides, credentialKey, hostName, isAdmitted, name } from "../src/host/index.ts";
import { resolveTrendMultipliers } from "../src/host/host-config.ts";
import { AUTH_DEFAULTS } from "../src/host/agnes-auth.ts";

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
  // Red line 4 pins the backend origin as ONE value, but it ships twice on
  // purpose: `AUTH_DEFAULTS.consoleOrigin` (agnes-auth.ts, the no-credential
  // fallback login path) and `CONFIG_DEFAULTS.consoleBase` (host-config.ts, the
  // operator-facing row). Each file only proves it equals its OWN default, so
  // before this pin NO test crossed the two literals — a one-sided edit would
  // let the fallback login and the normal login hit different hosts while every
  // suite stayed green. This is that missing cross-source pin (red line 4).
  check("the two shipped backend-origin literals agree",
    CONFIG_DEFAULTS.consoleBase === AUTH_DEFAULTS.consoleOrigin,
    `${CONFIG_DEFAULTS.consoleBase} vs ${AUTH_DEFAULTS.consoleOrigin}`);
  check("apiBase default", settings.apiBase === CONFIG_DEFAULTS.apiBase, settings.apiBase);
  check("usageDays default", settings.usageDays === CONFIG_DEFAULTS.usageDays, String(settings.usageDays));
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
// The list is DERIVED from CONFIG_DEFAULTS, not hand-written. It used to be a
// literal array that quietly omitted half the keys (apiBase, pollSeconds,
// consoleTimeoutMs, allowedHosts, loginTimeoutMs), so "a code-side addition
// cannot go undocumented" was only true for whoever remembered to edit this
// file too. Now every top-level default and every auth override must appear in
// the patch — active or commented — or the check fails on its own.
const ACTIVE_KEYS = Object.keys(CONFIG_DEFAULTS).filter((key) => key !== "auth" && key !== "admittedHosts");
const AUTH_KEYS = Object.keys(CONFIG_DEFAULTS.auth);
for (const key of [...ACTIVE_KEYS, ...AUTH_KEYS]) {
  // Matches `key:` (active) or `# key:` / `#key:` (commented) — either way the
  // patch acknowledges the key, so a code-side addition cannot go undocumented.
  const mentioned = new RegExp(`(^|\\s)#?\\s*${key}\\s*:`, "m").test(patch);
  check(`cordis.patch.yml documents ${key}`, mentioned, mentioned ? "" : "key absent from patch");
}
// admittedHosts is spelled `allowedHosts` in the patch (the operator's name for
// it), so derive-and-check would miss it; assert that alias is documented too.
check("cordis.patch.yml documents allowedHosts", /(^|\s)#?\s*allowedHosts\s*:/m.test(patch), "alias absent from patch");

// The active keys must carry the SAME default the code ships, or the panel's
// "defaults" and the bundle's "defaults" disagree.
function activeValue(key) {
  const m = patch.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, "m"));
  return m ? m[1] : null;
}
check("patch consoleBase matches code default", activeValue("consoleBase") === CONFIG_DEFAULTS.consoleBase.replace(/\/+$/, ""), activeValue("consoleBase"));
check("patch usageDays matches code default", Number(activeValue("usageDays")) === CONFIG_DEFAULTS.usageDays, activeValue("usageDays"));
check("patch cacheSeconds matches code default", Number(activeValue("cacheSeconds")) === CONFIG_DEFAULTS.cacheSeconds, activeValue("cacheSeconds"));
check("patch tokenSkewSeconds matches code default", Number(activeValue("tokenSkewSeconds")) === CONFIG_DEFAULTS.tokenSkewSeconds, activeValue("tokenSkewSeconds"));

// --- 3. the credentialKey shim is pinned to its literal shape --------------
// `index.js` hand-rolls `credentialKey` so the plugin runs without the peer
// package, but that duplicate can drift from the real service silently: if the
// format ever changes (a different separator, escaping), the panel would write
// its grant to one address and read it from another — a lost account with every
// test still green. This pins the EXACT shape on any machine, clean checkout
// included; store.test.mjs adds the cross-check against the real peer function
// where that peer resolves. Together they replace the old comment's untested
// claim ("the store's checks pin the shape") with an assertion.
{
  check("credentialKey joins scope and id with a single slash",
    credentialKey("scope", "id") === "scope/id", credentialKey("scope", "id"));
  // The two addresses this plugin actually stores under — a rename of either the
  // scope or the id is a breaking change to stored grants, so the exact strings
  // are worth a line here even though they are assembled elsewhere.
  check("credentialKey builds the record address the plugin reads back",
    credentialKey("dsh-connect-agnes-token-plan", "agnes-console") ===
      "dsh-connect-agnes-token-plan/agnes-console");
  check("credentialKey does not trim or transform its parts",
    credentialKey("a b", "c/d") === "a b/c/d", credentialKey("a b", "c/d"));
}

// --- 4. the auth overrides resolve to the keys the code and patch share ---
// Agnes signs in with ONE request, so the only overrides left are the sign-in
// path, its deadline and the assumed token lifetime. Pin each name — especially
// the deadline, which travels under `requestTimeoutMs` even though the row
// spells it `loginTimeoutMs` (that mismatch is where a config silently reverts).
{
  const auth = resolveAuthOverrides(
    {
      consoleBase: CONFIG_DEFAULTS.consoleBase,
      loginPath: "/api/user/login",
      loginTimeoutMs: 9000,
      fallbackExpiresInSeconds: 1800
    },
    CONFIG_DEFAULTS.consoleBase
  );
  check("resolveAuthOverrides forwards loginPath", auth.loginPath === "/api/user/login", auth.loginPath);
  check("resolveAuthOverrides forwards loginTimeoutMs as requestTimeoutMs",
    auth.requestTimeoutMs === 9000, String(auth.requestTimeoutMs));
  check("resolveAuthOverrides forwards fallbackExpiresInSeconds",
    auth.fallbackExpiresInSeconds === 1800, String(auth.fallbackExpiresInSeconds));
  check("resolveAuthOverrides keeps consoleOrigin", auth.consoleOrigin === CONFIG_DEFAULTS.consoleBase, auth.consoleOrigin);
  // Unset keys must NOT travel: `agnes-auth.ts` owns the platform defaults, and
  // forwarding a zero would replace a real default with "no deadline".
  const bare = resolveAuthOverrides({}, CONFIG_DEFAULTS.consoleBase);
  check("unset overrides stay out of the object",
    Object.keys(bare).join(",") === "consoleOrigin", Object.keys(bare).join(","));

  // The legacy spelling still wins when only it is set, so a config written
  // against an earlier version keeps its deadline.
  const legacy = resolveAuthOverrides({ requestTimeoutMs: 4000 }, CONFIG_DEFAULTS.consoleBase);
  check("the legacy requestTimeoutMs still feeds the login deadline",
    legacy.requestTimeoutMs === 4000, String(legacy.requestTimeoutMs));

  // A nested `auth:` block is the silent-drop trap from AGENTS.md red line 3:
  // the loader accepts it, this resolver reads nothing from it, and the panel
  // then runs on shipped defaults that point at the REAL platform. It must
  // throw, not be ignored.
  let nested = null;
  try {
    resolveAuthOverrides({ auth: { loginPath: "/api/user/login" } }, CONFIG_DEFAULTS.consoleBase);
  } catch (error) {
    nested = error;
  }
  check("a nested auth block is refused rather than ignored",
    nested !== null && String(nested.message).includes("loginPath"), String(nested));
}

// --- 5. hostName()/isAdmitted(): every Host-header spelling the fence must answer ---
// The old `split(":")[0]` turned "::1:19387" into "" (and even "::1" into ":"),
// so the default whitelist entries "::1" / "[::1]" were reachable only through
// the bracketed form — bare-IPv6 loopback clients were silently refused, a
// direction an operator has no console to fix from. Pin every form, including
// the public-IPv6 ones that must stay REFUSED.
{
  const cases = [
    // [spelling, expected name]
    ["::1", "::1"],
    ["::1:3080", "::1"],
    ["::1:80", "::1"],
    ["[::1]", "[::1]"],
    ["[::1]:19387", "[::1]"],
    ["fe80::1", "fe80::1"],
    ["fe80::1:3080", "fe80::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["2001:db8::1:443", "2001:db8::1"],
    ["127.0.0.1", "127.0.0.1"],
    ["127.0.0.1:19387", "127.0.0.1"],
    ["localhost", "localhost"],
    ["localhost:3080", "localhost"],
    ["example.com", "example.com"]
  ];
  for (const [spelling, expected] of cases) {
    check(`hostName normalizes "${spelling}"`, hostName(spelling) === expected, hostName(spelling));
  }

  const { settings } = resolveSettings({});
  const admit = (host, origin = undefined) => {
    const headers = { host };
    if (origin !== undefined) headers.origin = origin;
    return isAdmitted({ headers }, settings.allowedHosts);
  };
  const admitCases = [
    // Loopback spellings: all four default whitelist entries must be reachable.
    ["::1", null, true, "bare ::1 with no port"],
    ["::1:3080", null, true, "bare ::1 with a port — the old dead entry"],
    ["[::1]", null, true, "bracketed ::1 without a port"],
    ["[::1]:19387", null, true, "bracketed ::1 with a port"],
    ["localhost:3080", null, true, "hostname with a port"],
    ["127.0.0.1:19387", null, true, "IPv4 with a port"],
    // Not loopback: the whitelist must keep refusing it.
    ["2001:db8::1", null, false, "a public IPv6 literal is refused"],
    ["2001:db8::1:443", null, false, "a public IPv6 literal with a port is refused"],
    ["example.com", null, false, "a foreign hostname is refused"],
    // The cross-site forgery layer still fires on top of the whitelist.
    ["localhost:3080", "http://evil.test", false, "a foreign Origin is refused even on a whitelisted host"]
  ];
  for (const [host, origin, expected, note] of admitCases) {
    check(`isAdmitted ${note}`, admit(host, origin) === expected, String(admit(host, origin)));
  }
}

// --- 6. the one slug every addressable surface derives from ----------------
// `name` is the route prefix, the credential scope, and the state directory.
// Two files cannot import it and repeat it literally — package.json#name and
// the patch row's id/name pair — so a rename used to be checked by hand in
// three places. The old comment admitted the test pinned CONFIG_DEFAULTS only.
// Pin all three here: a rename that touches the code but not either mirror
// (or vice versa) now goes red, because the stored grant's scope moves with it.
{
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  check("package.json name equals the host-config slug", pkg.name === name, `${pkg.name} !== ${name}`);
  // The row is `- insert:` → a list item whose own fields are `- id:` /
  // `name:`; accept an optional list dash and any indentation on either.
  const rowId = patch.match(/^\s*-?\s*id:\s*(\S+)\s*$/m)?.[1];
  check("cordis.patch.yml row id equals the slug", rowId === name, `${rowId} !== ${name}`);
  const rowName = patch.match(/^\s*-?\s*name:\s*(\S+)\s*$/m)?.[1];
  check("cordis.patch.yml row name equals the slug", rowName === name, `${rowName} !== ${name}`);
  // The scope the grant is actually stored under must be this same slug, so the
  // two checks above are really guarding the stored credential's address.
  check("the credential scope derives from the same slug",
    credentialKey(name, "agnes-console") === `${name}/agnes-console`);
}

// --- 7. trendMultipliers sanitization ----------------------------------
// The pseudo-multiplier map reaches the panel as ×N labels, so a malformed
// entry must be dropped (not thrown — one typo must not take the panel down)
// while insertion order survives, because matching is first-key-wins.
{
  // resolveSettings routes through the same sanitizer.
  const viaSettings = resolveSettings({ trendMultipliers: { "glm-5.2": 10, bad: 0 } }).settings.trendMultipliers;
  check("resolveSettings keeps only positive entries", JSON.stringify(viaSettings) === JSON.stringify({ "glm-5.2": 10 }), JSON.stringify(viaSettings));

  const dropped = resolveTrendMultipliers({ "": 5, zero: 0, negative: -2, nan: NaN, inf: Infinity, text: "10", "kimi-k3": 20 });
  check("invalid entries are silently dropped",
    JSON.stringify(dropped) === JSON.stringify({ "kimi-k3": 20 }), JSON.stringify(dropped));

  const order = resolveTrendMultipliers({ z: 1, a: 2 });
  check("insertion order survives (first match wins)", Object.keys(order).join(",") === "z,a", Object.keys(order).join(","));

  check("an explicit {} disables all multipliers",
    Object.keys(resolveTrendMultipliers({})).length === 0, JSON.stringify(resolveTrendMultipliers({})));

  check("undefined falls back to the shipped defaults",
    JSON.stringify(resolveTrendMultipliers(undefined)) === JSON.stringify(CONFIG_DEFAULTS.trendMultipliers), "");
  check("a non-object falls back to the shipped defaults",
    JSON.stringify(resolveTrendMultipliers("glm-5.2=10")) === JSON.stringify(CONFIG_DEFAULTS.trendMultipliers), "");
  check("an array falls back to the shipped defaults",
    JSON.stringify(resolveTrendMultipliers([10])) === JSON.stringify(CONFIG_DEFAULTS.trendMultipliers), "");
}

// --- 8. numeric field clamping boundaries ----------------------------
// Every numeric field flows through `clampInt(raw, def, min, max?)` in
// `resolveSettings`: floor, then clamp low, then clamp high; a non-positive or
// NaN `raw` falls back to `def`. Pin each bound so a future edit to the clamp
// cannot change the effective range the panel reports without going red.
// (Note: `num` rejects 0, so to exercise the *lower* clamp a small FRACTIONAL
// raw is used — an integer 0 would fall back to `def` instead.)
{
  const clamp = (cfg) => resolveSettings(cfg).settings;
  const uFloor = clamp({ usageDays: 12.9 }).usageDays;
  check("usageDays floors fractional input", uFloor === 12, String(uFloor));
  const uMax = clamp({ usageDays: 9999 }).usageDays;
  check("usageDays caps at 365", uMax === 365, String(uMax));
  const uLow = clamp({ usageDays: 0.5 }).usageDays;
  check("usageDays clamps to its 1 floor on a fractional raw", uLow === 1, String(uLow));
  const cLow = clamp({ cacheSeconds: 3 }).cacheSeconds;
  check("cacheSeconds clamps to its 5 floor", cLow === 5, String(cLow));
  const pLow = clamp({ pollSeconds: 3 }).pollSeconds;
  check("pollSeconds clamps to its 5 floor", pLow === 5, String(pLow));
  const ctLow = clamp({ consoleTimeoutMs: 500 }).consoleTimeoutMs;
  check("consoleTimeoutMs clamps to its 1000 floor", ctLow === 1000, String(ctLow));
  const skLow = clamp({ tokenSkewSeconds: 0.5 }).tokenSkewSeconds;
  check("tokenSkewSeconds clamps to its 0 floor on a fractional raw", skLow === 0, String(skLow));
  const dtLow = clamp({ drawTimeoutMs: 10 }).drawTimeoutMs;
  check("drawTimeoutMs clamps to its 5000 floor", dtLow === 5000, String(dtLow));
  const nanFall = clamp({ usageDays: "not a number" }).usageDays;
  check("a non-numeric usageDays falls back to default", nanFall === CONFIG_DEFAULTS.usageDays, String(nanFall));
}

// --- 8b. the catch branch carries the SAME settings as the success branch ----
// `resolveSettings` is the ONE function that can take the whole plugin down at
// mount: `apply` calls it before anything is built, so a throw here is not a
// degraded panel but a plugin that never loads. That is why the try block
// exists — and why the catch branch hand-writes a second full settings object
// instead of spreading the first.
//
// A hand-written second copy is exactly the shape that rots. The comment above
// it PROMISES the fallback carries the same settings ("minus the malformed
// field"), but nothing asserted it: the only input that reaches the catch is a
// nested `auth:` block, and the one test for that (`check 4` above) calls
// `resolveAuthOverrides` DIRECTLY — so the very branch the promise lives in had
// zero coverage. Adding a config key to the success branch and forgetting the
// fallback would leave a consumer reading `undefined` from a row that is
// perfectly valid, with every suite green. That is PITFALLS §39's exact shape
// (naming the guardian, not checking it), committed by the file that diagnosed
// it.
//
// These checks close it. The key list is DERIVED from both branches (never
// hand-written — a hand-written list is a third copy of the same contract), and
// the values are checked against `CONFIG_DEFAULTS` key by key, so a fallback
// that carries a plausible-but-wrong value is caught as loudly as one missing a
// key entirely.
{
  // The one input that reaches the catch: `resolveAuthOverrides` throws on a
  // nested `auth:` block (red line 3). Driven through `resolveSettings` this
  // time, so the branch is entered the way a real malformed row enters it.
  const malformed = { auth: { loginPath: "/api/user/login" } };
  const fell = resolveSettings(malformed);
  check("a malformed row reports a config error instead of throwing", fell.configError !== null,
    String(fell.configError));
  check("the config error names the refused nested key",
    typeof fell.configError === "string" && fell.configError.includes("loginPath"),
    String(fell.configError));

  const ok = resolveSettings({});
  const successKeys = Object.keys(ok.settings).sort();
  const fallbackKeys = Object.keys(fell.settings).sort();
  check("the fallback row carries every key the success branch does",
    successKeys.join(",") === fallbackKeys.join(","),
    `only in success: ${successKeys.filter((k) => !fallbackKeys.includes(k)).join(",") || "none"}; ` +
    `only in fallback: ${fallbackKeys.filter((k) => !successKeys.includes(k)).join(",") || "none"}`);

  // `allowedHosts` is the one renamed key (`admittedHosts` is the schema name,
  // `allowedHosts` the resolved one), so it is compared against the schema.
  // `auth` is skipped here and checked on its own below: it is the one nested
  // value, and the fallback carries a DIFFERENT shape by design (just the
  // origin, no overrides) — comparing it to the three-key schema default would
  // be comparing two different contracts.
  const defaultOf = (key) => (key === "allowedHosts" ? CONFIG_DEFAULTS.admittedHosts : CONFIG_DEFAULTS[key]);
  const mismatched = [];
  for (const key of successKeys) {
    if (key === "auth") continue;
    const expected = defaultOf(key);
    if (expected === undefined) continue;
    const actual = fell.settings[key];
    const same = key === "allowedHosts"
      ? [...actual].join(",") === [...expected].join(",")
      : JSON.stringify(actual) === JSON.stringify(expected);
    if (!same) mismatched.push(`${key}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
  check("every fallback value is the shipped default, not a plausible guess",
    mismatched.length === 0, mismatched.join(" | ") || "all keys match CONFIG_DEFAULTS");

  // The fallback's own `auth` shape: the origin it was given and nothing else.
  // An override set on the row is dropped along with the rest of the row — the
  // row is malformed as a whole, so carrying part of it would be worse than
  // carrying none.
  check("the fallback auth block carries the origin alone",
    Object.keys(fell.settings.auth).join(",") === "consoleOrigin",
    Object.keys(fell.settings.auth).join(","));
  check("the fallback auth origin is the row's own consoleBase",
    fell.settings.auth.consoleOrigin === fell.settings.consoleBase,
    `${fell.settings.auth.consoleOrigin} vs ${fell.settings.consoleBase}`);

  // The two endpoints resolve BEFORE the try (they cannot throw), so the
  // fallback keeps the operator's configured hosts rather than reverting them
  // to the shipped ones. Pinning it because it is the single place the fallback
  // deliberately does NOT carry the default — a "fix" that made it uniform
  // would send a local-stub deployment back to the real platform. (The trailing
  // slash is stripped by the resolver, so the expectation spells it that way.)
  const stub = "http://127.0.0.1:9";
  const stubbed = resolveSettings({ ...malformed, consoleBase: `${stub}/`, apiBase: `${stub}/v1` });
  check("a malformed row keeps the operator's configured endpoints (no silent revert to the real platform)",
    stubbed.settings.consoleBase === stub && stubbed.settings.apiBase === `${stub}/v1`,
    `${stubbed.settings.consoleBase} / ${stubbed.settings.apiBase}`);
  check("a malformed row keeps the auth overrides on the same (configured) origin",
    stubbed.settings.auth.consoleOrigin === stub,
    stubbed.settings.auth.consoleOrigin);
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
