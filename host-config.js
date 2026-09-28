/**
 * The plugin's configuration contract and the Host trust fence.
 *
 * Everything the Host half reads from the row's patch config lives here, plus
 * the `isAdmitted` check that keeps a foreign page from planting an account.
 * `test/config.test.mjs` pins `CONFIG_DEFAULTS` and the resolvers against this
 * file and `cordis.patch.yml`, so the code and the documented contract cannot
 * silently drift.
 * @module dsh-connect-sensenova-token-plan/host-config
 */

import { str, obj, num } from "./util.js";

/**
 * The one slug every addressable surface of this plugin derives from.
 *
 * Besides the name the Loader reports for the row, it is also the `/api` route
 * prefix (`index.js`), the credential record's scope (`token-store.js`) and the
 * state directory (`throttle-store.js`) — so a rename has to carry the user's
 * stored grant and parked throttle with it, not just the text. The two files
 * that cannot import from here repeat it literally: `package.json#name` and the
 * `id`/`name` pair in `cordis.patch.yml`. Neither is pinned against this
 * constant by `test/config.test.mjs` (it pins `CONFIG_DEFAULTS` only), so a
 * rename must check all three by hand.
 */
export const name = "dsh-connect-sensenova-token-plan";
/** Cordis services this plugin needs; without `webServer` it stays inactive. */
export const inject = ["webServer"];

/**
 * The plugin's configuration contract in one place.
 *
 * Every default the Host half reads lives here, so the code and the
 * `cordis.patch.yml` that documents it cannot silently drift: `test/config.test.mjs`
 * pins both against this object. The `auth` sub-object lists the operator-facing
 * login-flow overrides (their patch.yml entries are commented by default, which is
 * why they default to empty/zero and mean "use the platform default").
 */
export const CONFIG_DEFAULTS = Object.freeze({
  consoleBase: "https://platform.sensenova.cn",
  apiBase: "https://token.sensenova.cn/v1",
  trendHours: 24,
  cacheSeconds: 60,
  pollSeconds: 30,
  consoleTimeoutMs: 15_000,
  tokenSkewSeconds: 120,
  auth: {
    iamBase: "",
    tokenEndpoint: "",
    jwksEndpoint: "",
    redirectUri: "",
    clientId: "",
    scope: "",
    encKeyId: "",
    maxHops: 0,
    loginTimeoutMs: 0,
    requestTimeoutMs: 0
  },
  /**
   * Vision step two: whether the Host syncs the identified vision-capable
   * model ids into THIS row's own settings namespace (`imageModelIds`,
   * `visionModels`) on every catalog poll, for a later LLM connect plugin to
   * read. Off by default - the read-only info layer is the safe shape. The
   * writes go to this plugin's OWN settings row only, never another
   * provider's, so a miscalculated list cannot reach DSH's model routing.
   */
  writeImageModelIds: false,
  /** The last published image-model id list (the reader's primary field). */
  imageModelIds: [],
  /** The last full vision identification (id + source marker per model). */
  visionModels: []
});

/**
 * Resolve the row's raw patch config into effective settings.
 *
 * A malformed row must not throw out of here: `apply` runs at mount, and an
 * exception would take the whole plugin down instead of leaving a panel that
 * explains itself. So problems are returned as `configError` and surfaced
 * through the snapshot route.
 * @param {object} config - the row's raw patch config.
 * @returns {{settings: object, configError: string|null}}
 */
export function resolveSettings(config) {
  const source = obj(config);
  const consoleBase = str(source.consoleBase, CONFIG_DEFAULTS.consoleBase).replace(/\/+$/, "");
  try {
    return {
      settings: {
        consoleBase,
        apiBase: str(source.apiBase, CONFIG_DEFAULTS.apiBase).replace(/\/+$/, ""),
        trendHours: Math.min(168, Math.max(1, Math.floor(num(source.trendHours, CONFIG_DEFAULTS.trendHours)))),
        cacheSeconds: Math.max(5, Math.floor(num(source.cacheSeconds, CONFIG_DEFAULTS.cacheSeconds))),
        // How often the panel asks again. The Host states it rather than the
        // panel assuming one, so the two cannot disagree about how fresh the
        // screen is.
        pollSeconds: Math.max(5, Math.floor(num(source.pollSeconds, CONFIG_DEFAULTS.pollSeconds))),
        // Deadline for one console call. The login flow has its own
        // (`loginTimeoutMs`, below): it walks several IAM hops, so the two
        // are not the same number and pretending otherwise is how a slow
        // login gets blamed on the console.
        consoleTimeoutMs: Math.max(1_000, Math.floor(num(source.consoleTimeoutMs, CONFIG_DEFAULTS.consoleTimeoutMs))),
        // Which host names this Host answers as. See `isAdmitted`: the panel
        // has a write route, so the loopback defaults can be widened but not
        // replaced.
        allowedHosts: resolveAllowedHosts(source),
        // Renew the console token this long before it actually expires, so a
        // panel poll never races the expiry boundary.
        tokenSkewSeconds: Math.max(0, Math.floor(num(source.tokenSkewSeconds, CONFIG_DEFAULTS.tokenSkewSeconds))),
        // Console login-flow overrides, handed to `createAuth` verbatim: it owns
        // the platform defaults, so only what the operator actually set travels.
        auth: resolveAuthOverrides(source, consoleBase),
        // Vision step two: the opt-in and the last published lists. The
        // lists are read back from the row so a restart does not lose the
        // answer the Host last computed (a reader that arrives before the
        // first catalog poll still sees the previous catalog's set).
        writeImageModelIds: source.writeImageModelIds === true,
        imageModelIds: Array.isArray(source.imageModelIds)
          ? source.imageModelIds.filter((id) => typeof id === "string")
          : CONFIG_DEFAULTS.imageModelIds,
        visionModels: Array.isArray(source.visionModels)
          ? source.visionModels.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
          : CONFIG_DEFAULTS.visionModels
      },
      configError: null
    };
  } catch (error) {
    // Fall back to the shipped defaults so the panel still mounts and can show
    // the reason, rather than vanishing.
    return {
      settings: {
        consoleBase,
        apiBase: str(source.apiBase, CONFIG_DEFAULTS.apiBase).replace(/\/+$/, ""),
        trendHours: CONFIG_DEFAULTS.trendHours,
        cacheSeconds: CONFIG_DEFAULTS.cacheSeconds,
        pollSeconds: CONFIG_DEFAULTS.pollSeconds,
        consoleTimeoutMs: CONFIG_DEFAULTS.consoleTimeoutMs,
        allowedHosts: new Set(CONFIG_DEFAULTS.admittedHosts),
        tokenSkewSeconds: CONFIG_DEFAULTS.tokenSkewSeconds,
        auth: { consoleOrigin: consoleBase }
      },
      configError: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Collect just the auth keys the operator actually set.
 *
 * The keys are read from the TOP LEVEL of the row. That is not obvious, and
 * getting it wrong is not a harmless typo: a nested `auth:` block is accepted
 * by the loader, silently dropped here, and the panel then runs on its shipped
 * defaults — which point at the REAL platform. An end-to-end run meant to talk
 * to a local stub then posts a real login attempt, which is exactly how this
 * plugin locked an account once already. So a nested `auth` key is reported as
 * a configuration error rather than ignored.
 * @param {object} source - the row's raw patch config.
 * @param {string} consoleBase - the resolved console origin.
 * @returns {object} the override object for `createAuth`.
 * @throws {Error} when the row looks like it nests overrides it does not read.
 */
export function resolveAuthOverrides(source, consoleBase) {
  // ANY nested `auth` block is refused, not just the two names below: none of
  // its keys are read, so a block of any shape is silently ignored. Testing for
  // a fixed list would leave `auth: { iamBase: ... }` — the exact key an
  // operator reaches for — as the one case that still fails quietly.
  if (source.auth !== undefined && source.auth !== null) {
    const keys = Object.keys(obj(source.auth));
    throw new Error(
      "auth overrides are top-level keys on this row, not a nested `auth:` block" +
        `${keys.length === 0 ? "" : ` (found: ${keys.join(", ")})`}. ` +
        "Use `iamBase`, `tokenEndpoint`, `jwksEndpoint`, `redirectUri`, `clientId`, " +
        "`scope` or `encKeyId` at the top level; a nested block is ignored and the " +
        "panel would keep using the real platform."
    );
  }
  const text = (key) => str(source[key], "");
  const overrides = { consoleOrigin: consoleBase };
  const set = (key, value, transform) => {
    if (value === "") return;
    overrides[key] = transform === undefined ? value : transform(value);
  };
  set("iamOrigin", text("iamBase"), (value) => value.replace(/\/+$/, ""));
  set("tokenEndpoint", text("tokenEndpoint"));
  set("jwksEndpoint", text("jwksEndpoint"));
  set("redirectUri", text("redirectUri"));
  set("clientId", text("clientId"));
  set("scope", text("scope"));
  set("encKeyId", text("encKeyId"));
  const maxHops = Math.floor(num(source.maxHops, 0));
  if (maxHops > 0) overrides.maxHops = maxHops;
  // `requestTimeoutMs` is what this option shipped as, but it only ever fed
  // the login flow — the console calls below had their own hardcoded deadline.
  // The old name still wins when only it is set, so a config written against
  // an earlier version keeps its deadline instead of silently reverting to
  // the default.
  const loginTimeoutMs = Math.floor(num(source.loginTimeoutMs, num(source.requestTimeoutMs, 0)));
  if (loginTimeoutMs > 0) overrides.requestTimeoutMs = loginTimeoutMs;
  return overrides;
}

/**
 * Collect the host names this Host will answer as.
 *
 * The operator's list is ADDED to the defaults, never substituted: replacing
 * them would let a typo lock the panel out of itself, and there is no console
 * to fix it from.
 * @param {object} source - the row's raw patch config.
 * @returns {Set<string>} the admitted host names, lowercased.
 */
export function resolveAllowedHosts(source) {
  const admitted = new Set(CONFIG_DEFAULTS.admittedHosts);
  const extra = Array.isArray(source.allowedHosts) ? source.allowedHosts : [];
  for (const entry of extra) {
    const name = str(entry, "").trim().toLowerCase();
    if (name !== "") admitted.add(name);
  }
  return admitted;
}

/**
 * The host name a `Host` header names, without its port.
 * @param {string} host - the raw header value.
 * @returns {string} the name; bracketed for IPv6 literals.
 */
export function hostName(host) {
  // "[::1]:8080" keeps its brackets; "localhost:8080" loses its port.
  if (host.startsWith("[") && host.includes("]")) {
    return host.slice(0, host.indexOf("]") + 1);
  }
  // A bare IPv6 literal carries more than one colon. A "name with an optional
  // port" is valid for such a value only when the ENTIRE part after the
  // SECOND-TO-LAST colon is a bare port:
  //   "::1:3080"   -> segments ["", "", "1", "3080"], after the 2nd-to-last
  //                    colon is "3080" (digits) -> name "::1"
  //   "::1"        -> segments ["", "", "1"], after the 2nd-to-last colon is
  //                    ":1" (colons are not digits) -> name "::1"
  //   "fe80::1"    -> segments ["fe80", "", "1"], after the 2nd-to-last
  //                    colon is ":1" -> name "fe80::1"
  // So the port, when present, is ALWAYS the last segment alone, and the
  // port-separator is the last colon only when the text after it is all
  // digits AND the text between that last colon and the one before it is
  // ALSO all digits ("1:3080" — the address's final group plus the port).
  // That distinguishes "::1" (":1" after the 2nd-to-last colon: has a colon,
  // not a port) from "::1:3080" ("3080" after the last colon: bare port).
  // A host the operator did not name is returned untouched: refused, which
  // is the safe direction.
  const colons = host.split(":");
  if (colons.length > 2) {
    // "address + port" = 2nd-to-last and last segments are BOTH digits.
    if (/^\d+$/.test(colons[colons.length - 2]) && /^\d+$/.test(colons[colons.length - 1])) {
      return host.slice(0, host.lastIndexOf(":"));
    }
    return host;
  }
  // 0 or 1 colons: a bare `:port` tail, or nothing at all.
  return colons.length > 1 ? host.slice(0, host.lastIndexOf(":")) : host;
}

/**
 * Trust fence for a route the browser can reach.
 *
 * Two different attacks have to be turned away here, and they need two
 * different facts:
 *
 * 1. DNS rebinding. The attacker's page rebinds its own name to 127.0.0.1 and
 *    POSTs an account. `Origin` and `Host` now AGREE on the attacker's name
 *    while the request lands on the Host, so comparing them to each other
 *    admits it. The `Host` header is the one thing a browser cannot forge, so
 *    it is checked against a whitelist instead of against the `Origin`.
 * 2. Cross-site forgery. A page on another origin asks the browser to post to
 *    the loopback Host. Here the whitelist alone is worthless — the Host IS
 *    legitimate — and the `Origin` is what gives it away.
 *
 * So: the `Host` must be one this Host answers as, AND any stated `Origin`
 * must agree with it. A request that states no `Origin` is the ordinary
 * same-origin GET and is admitted.
 * @param request - the incoming HTTP request.
 * @param {Set<string>} allowedHosts - the host names this Host answers as.
 * @returns {boolean} whether the request may be served.
 */
export function isAdmitted(request, allowedHosts) {
  const host = str(request.headers?.host, "").toLowerCase();
  if (host === "" || !allowedHosts.has(hostName(host))) return false;
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  if (origin === "null") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
