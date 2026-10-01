/**
 * The plugin's configuration contract and the Host trust fence.
 *
 * Everything the Host half reads from the row's patch config lives here, plus
 * the `isAdmitted` check that keeps a foreign page from planting an account.
 * `test/config.test.mjs` pins `CONFIG_DEFAULTS` and the resolvers against this
 * file and `cordis.patch.yml`, so the code and the documented contract cannot
 * silently drift.
 * @module dsh-connect-agnes-token-plan/host-config
 */

import { str, obj, num } from "./util.ts";
import type { Settings, AuthOverrides } from "./types.ts";

/**
 * The one slug every addressable surface of this plugin derives from.
 *
 * Besides the name the Loader reports for the row, it is also the `/api` route
 * prefix (`index.ts`), the credential record's scope (`token-store.ts`) and the
 * state directory (`throttle-store.ts`) — so a rename has to carry the user's
 * stored grant and parked throttle with it, not just the text. The two files
 * that cannot import from here repeat it literally: `package.json#name` and the
 * `id`/`name` pair in `cordis.patch.yml`. Neither is pinned against this
 * constant by `test/config.test.mjs` (it pins `CONFIG_DEFAULTS` only), so a
 * rename must check all three by hand.
 */
export const name = "dsh-connect-agnes-token-plan";
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
  consoleBase: "https://platform-backend.agnes-ai.cn",
  apiBase: "https://api.agnes-ai.cn/v1",
  /**
   * How many days of usage the panel's chart covers, inclusive of today.
   *
   * Days, not hours: `/api/usage/series` takes `start_date` / `end_date` as
   * DATES, so an hour-granular window cannot be asked for. Snapping to whole
   * days also keeps the request URL stable for the day, which is what lets the
   * series cache actually hit.
   */
  usageDays: 30,
  /**
   * Pseudo multipliers for the model roster, keyed by a case-insensitive
   * SUBSTRING of a model id (first matching key wins, in insertion order).
   *
   * Empty by default, and that is not an oversight: the factor used to scale a
   * per-model credit figure, and Agnes publishes no per-model usage at all
   * (its console never reads a `model` field). What is left is the operator's
   * own annotation — a `×N` badge on a roster row — so there is no defensible
   * default to ship. Set it to tag models for your own routing notes; rows
   * without a match get no badge, never a guessed 1.
   */
  trendMultipliers: {},
  cacheSeconds: 60,
  pollSeconds: 30,
  consoleTimeoutMs: 15_000,
  tokenSkewSeconds: 120,
  /**
   * Login-flow overrides, in the shape `agnes-auth.ts` reads them.
   *
   * Agnes signs in with ONE request (`POST /api/user/login`), so the SenseNova
   * OIDC knobs — `iamBase`, `tokenEndpoint`, `jwksEndpoint`, `redirectUri`,
   * `clientId`, `scope`, `encKeyId`, `maxHops` — have no counterpart here and
   * are gone. The three below are the ones that still mean something.
   */
  auth: {
    loginPath: "",
    loginTimeoutMs: 0,
    fallbackExpiresInSeconds: 0
  },
  /** Host names the Host answers as, by default. The operator's list is added. */
  admittedHosts: ["localhost", "127.0.0.1", "[::1]", "::1"],
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
  visionModels: [],
  /**
   * Step three ("one-stop service"): register the LLM provider DIRECTLY.
   *
   * When true, the plugin calls `ctx.llm.registerAdapter` itself with an
   * OpenAI-compatible pi-ai adapter aimed at `apiBase`, the catalog poll feeds
   * its model list, vision models carry image input automatically, and the
   * panel-saved `AGNES_TOKEN_PLAN_API_KEY` reference authenticates requests. Off by
   * default for the same reason `writeImageModelIds` is: registering a model
   * source is a Host-wide change, not a read-only panel view, so it stays an
   * explicit opt-in and an operator with the hand-written `llm-pi-ai` row is
   * not suddenly offered two providers.
   */
  registerProvider: false,
  /**
   * Draw absorption (ARCHITECTURE §5.4 route B): register the
   * `agnes_draw_image` agent tool. When true AND the Host exposes a tools
   * service, image-generation requests go to `{apiBase}/images/generations`
   * with the panel-saved `AGNES_TOKEN_PLAN_API_KEY`, and the model list comes
   * from `modality.ts` — the declared `output_modalities` field when the
   * gateway sends one, the platform's own `agnes-image-*` family segment when
   * it does not (the Agnes gateway sends no modality metadata at all; see that
   * module's header). Off by
   * default like every execution module: a tool the agent can call is a
   * Host-wide change, and a Host without the tools service must simply never
   * see it rather than fail.
   *
   * 0.4.2: this value is now the DEPLOYMENT DEFAULT only. The panel's draw
   * tool switch (`POST /api/<name>/draw`, stored in `draw-store.ts`)
   * overrides it live with no restart. See `docs/PROVIDER-HOT-RELOAD.md` §7.
   */
  drawEnabled: false,
  /** Preferred draw model id; empty means "first image-gen model of the catalog". */
  drawModelId: "",
  /** Deadline for one image request. Image models are slow; chat deadlines do not apply. */
  drawTimeoutMs: 120_000,
  /**
   * Video absorption: register the `agnes_video_generate` agent tool
   * (`video.ts`). A SEPARATE opt-in from `drawEnabled` on purpose — wanting
   * image generation without video (or the reverse) is an ordinary
   * preference, and one switch would force both on together.
   *
   * The protocol differs from drawing in the way that matters here: video is
   * an ASYNCHRONOUS TASK (create, then poll until terminal), so this is the
   * only module whose deadline is measured in MINUTES. Off by default, and
   * degraded exactly like the draw tool: no tools service or a failing peer
   * leaves the panel and the provider untouched.
   *
   * The panel's video switch (`POST /api/<name>/video`, stored in
   * `video-store.ts`) overrides this live with no restart.
   */
  videoEnabled: false,
  /** Preferred video model id; empty means "first V2.0-family video model of the catalog". */
  videoModelId: "",
  /** The whole-generation poll budget (create + poll). Video tasks run for minutes. */
  videoTimeoutMs: 600_000,
  /** Default video width in pixels (16:9). */
  videoWidth: 1152,
  /** Default video height in pixels (16:9). */
  videoHeight: 768,
  /** Default frame count — must satisfy 8n+1 and be ≤441; 121 @ 24fps ≈ 5 seconds. */
  videoNumFrames: 121,
  /** Default frame rate (1–60). */
  videoFrameRate: 24
});

/**
 * Sanitize the operator's pseudo-multiplier map: keep only string keys and
 * finite positive numbers, preserving insertion order (matching is
 * first-key-wins). A non-object or empty input falls back to the shipped
 * defaults; the operator sets `{}` explicitly to disable all multipliers.
 * Exported so `test/config.test.mjs` drives the same sanitizer the resolve
 * path uses, instead of a copy that could drift.
 * @param {unknown} raw - the raw `trendMultipliers` config value.
 * @returns {Record<string, number>} the sanitized map.
 */
export function resolveTrendMultipliers(raw: unknown) {
  const source = raw === undefined || raw === null ? CONFIG_DEFAULTS.trendMultipliers : raw;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return { ...CONFIG_DEFAULTS.trendMultipliers };
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof key === "string" && key !== "" && typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Clamp a raw numeric setting to its effective integer.
 *
 * Every numeric field in {@link resolveSettings} follows the same shape: floor
 * the raw value, clamp it at a lower bound, then (optionally) at an upper bound;
 * a non-positive or non-finite raw falls back to `def` (because `num` only
 * accepts a positive finite number). The sequence — `Math.min(max, Math.max(min,
 * Math.floor(raw)))` with `max` defaulting to `Infinity` — is exactly what the
 * inline `Math.max`/`Math.min` chains used to spell out one field at a time, so
 * this is a MOVE of that pattern into one tested place, not a behaviour change.
 * @param {unknown} raw - the raw value read from the row.
 * @param {number} def - the fallback when `raw` is not a positive finite number.
 * @param {number} min - the lower clamp (inclusive) applied after flooring.
 * @param {number} [max] - the upper clamp (inclusive); omit for no upper bound.
 * @returns {number} the clamped integer.
 */
export function clampInt(raw: unknown, def: number, min: number, max: number = Infinity) {
  return Math.min(max, Math.max(min, Math.floor(num(raw, def))));
}

/**
 * Resolve the row's raw patch config into effective settings.
 *
 * A malformed row must not throw out of here: `apply` runs at mount, and an
 * exception would take the whole plugin down instead of leaving a panel that
 * explains itself. So problems are returned as `configError` and surfaced
 * through the snapshot route.
 * @param {object} config - the row's raw patch config.
 * @returns {{settings: Settings, configError: string|null}}
 */
export function resolveSettings(config: Record<string, unknown>): { settings: Settings; configError: string | null } {
  const source = obj(config);
  const consoleBase = str(source.consoleBase, CONFIG_DEFAULTS.consoleBase).replace(/\/+$/, "");
  const apiBase = str(source.apiBase, CONFIG_DEFAULTS.apiBase).replace(/\/+$/, "");
  try {
    return {
      settings: {
        consoleBase,
        apiBase,
        // How many days of usage the chart covers (max 365). The series
        // endpoint takes dates, so this is a day count, not an hour count.
        usageDays: clampInt(source.usageDays, CONFIG_DEFAULTS.usageDays, 1, 365),
        // Pseudo roster multipliers: only well-formed entries travel (string
        // key, finite positive number); anything else is dropped rather than
        // throwing — a typo in one row must not take the panel down.
        trendMultipliers: resolveTrendMultipliers(source.trendMultipliers),
        cacheSeconds: clampInt(source.cacheSeconds, CONFIG_DEFAULTS.cacheSeconds, 5),
        // How often the panel asks again. The Host states it rather than the
        // panel assuming one, so the two cannot disagree about how fresh the
        // screen is.
        pollSeconds: clampInt(source.pollSeconds, CONFIG_DEFAULTS.pollSeconds, 5),
        // Deadline for one console call. The login flow has its own
        // (`loginTimeoutMs`, below): signing in is a single request but it
        // carries a password over the network and may be rate-limited, so the
        // two are not the same number and pretending otherwise is how a slow
        // login gets blamed on the console.
        consoleTimeoutMs: clampInt(source.consoleTimeoutMs, CONFIG_DEFAULTS.consoleTimeoutMs, 1_000),
        // Which host names this Host answers as. See `isAdmitted`: the panel
        // has a write route, so the loopback defaults can be widened but not
        // replaced.
        allowedHosts: resolveAllowedHosts(source),
        // Renew the console token this long before it actually expires, so a
        // panel poll never races the expiry boundary.
        tokenSkewSeconds: clampInt(source.tokenSkewSeconds, CONFIG_DEFAULTS.tokenSkewSeconds, 0),
        // Console login-flow overrides, handed to `createAuth` verbatim: it owns
        // the platform defaults, so only what the operator actually set travels.
        auth: resolveAuthOverrides(source, consoleBase),
        // Vision step two: the opt-in and the last published lists. The
        // lists are read back from the row so a restart does not lose the
        // answer the Host last computed (a reader that arrives before the
        // first catalog poll still sees the previous catalog's set).
        writeImageModelIds: source.writeImageModelIds === true,
        imageModelIds: Array.isArray(source.imageModelIds)
          ? source.imageModelIds.filter((id: string) => typeof id === "string")
          : CONFIG_DEFAULTS.imageModelIds,
        visionModels: Array.isArray(source.visionModels)
          ? source.visionModels.filter((entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry))
          : CONFIG_DEFAULTS.visionModels,
        // Step three opt-in: register the OpenAI-compatible LLM provider
        // directly (strict boolean, like writeImageModelIds).
        registerProvider: source.registerProvider === true,
        // Draw absorption opt-in (strict boolean, same reasoning as
        // registerProvider) plus its two knobs. The deadline has its own
        // floor: image models regularly take tens of seconds, and a chat-
        // sized deadline would abort healthy requests.
        drawEnabled: source.drawEnabled === true,
        drawModelId: str(source.drawModelId, ""),
        drawTimeoutMs: clampInt(source.drawTimeoutMs, CONFIG_DEFAULTS.drawTimeoutMs, 5_000),
        // Video absorption opt-in (strict boolean, independent of the draw
        // switch) plus its knobs. The poll budget is clamped at 30s rather
        // than 5s: this deadline covers a whole create-and-poll cycle, and a
        // draw-sized value would abort every healthy generation.
        videoEnabled: source.videoEnabled === true,
        videoModelId: str(source.videoModelId, ""),
        videoTimeoutMs: clampInt(source.videoTimeoutMs, CONFIG_DEFAULTS.videoTimeoutMs, 30_000),
        videoWidth: clampInt(source.videoWidth, CONFIG_DEFAULTS.videoWidth, 1),
        videoHeight: clampInt(source.videoHeight, CONFIG_DEFAULTS.videoHeight, 1),
        videoNumFrames: clampInt(source.videoNumFrames, CONFIG_DEFAULTS.videoNumFrames, 1),
        videoFrameRate: clampInt(source.videoFrameRate, CONFIG_DEFAULTS.videoFrameRate, 1)
      },
      configError: null
    };
  } catch (error) {
    // Fall back to the shipped defaults so the panel still mounts and can show
    // the reason, rather than vanishing.
    return {
      settings: {
        consoleBase,
        apiBase,
        usageDays: CONFIG_DEFAULTS.usageDays,
        trendMultipliers: CONFIG_DEFAULTS.trendMultipliers,
        cacheSeconds: CONFIG_DEFAULTS.cacheSeconds,
        pollSeconds: CONFIG_DEFAULTS.pollSeconds,
        consoleTimeoutMs: CONFIG_DEFAULTS.consoleTimeoutMs,
        allowedHosts: new Set(CONFIG_DEFAULTS.admittedHosts),
        tokenSkewSeconds: CONFIG_DEFAULTS.tokenSkewSeconds,
        auth: { consoleOrigin: consoleBase },
        // The fallback carries the SAME settings as the success branch, minus
        // the malformed field: a settings consumer that reads `drawEnabled` or
        // `imageModelIds` must not find it absent just because a typo elsewhere
        // pushed the whole row onto the default branch.
        registerProvider: CONFIG_DEFAULTS.registerProvider,
        drawEnabled: CONFIG_DEFAULTS.drawEnabled,
        drawModelId: CONFIG_DEFAULTS.drawModelId,
        drawTimeoutMs: CONFIG_DEFAULTS.drawTimeoutMs,
        videoEnabled: CONFIG_DEFAULTS.videoEnabled,
        videoModelId: CONFIG_DEFAULTS.videoModelId,
        videoTimeoutMs: CONFIG_DEFAULTS.videoTimeoutMs,
        videoWidth: CONFIG_DEFAULTS.videoWidth,
        videoHeight: CONFIG_DEFAULTS.videoHeight,
        videoNumFrames: CONFIG_DEFAULTS.videoNumFrames,
        videoFrameRate: CONFIG_DEFAULTS.videoFrameRate,
        writeImageModelIds: CONFIG_DEFAULTS.writeImageModelIds,
        imageModelIds: CONFIG_DEFAULTS.imageModelIds,
        visionModels: CONFIG_DEFAULTS.visionModels
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
 *
 * The emitted set is exactly what `agnes-auth.ts:resolveAuthConfig` reads. The
 * SenseNova OIDC knobs (`iamBase` / `tokenEndpoint` / `jwksEndpoint` /
 * `redirectUri` / `clientId` / `scope` / `encKeyId` / `maxHops`) are gone with
 * the OIDC walk they configured — passing them through now would hand
 * `createAuth` keys it never reads, which is the silent-drop failure this
 * function exists to prevent.
 * @param {object} source - the row's raw patch config.
 * @param {string} consoleBase - the resolved console origin.
 * @returns {object} the override object for `createAuth`.
 * @throws {Error} when the row looks like it nests overrides it does not read.
 */
export function resolveAuthOverrides(source: Record<string, unknown>, consoleBase: string) {
  // ANY nested `auth` block is refused, not just the names below: none of its
  // keys are read, so a block of any shape is silently ignored. Testing for a
  // fixed list would leave `auth: { loginPath: ... }` — the exact key an
  // operator reaches for — as the one case that still fails quietly.
  if (source.auth !== undefined && source.auth !== null) {
    const keys = Object.keys(obj(source.auth));
    throw new Error(
      "auth overrides are top-level keys on this row, not a nested `auth:` block" +
        `${keys.length === 0 ? "" : ` (found: ${keys.join(", ")})`}. ` +
        "Use `loginPath`, `loginTimeoutMs` or `fallbackExpiresInSeconds` at the top " +
        "level; a nested block is ignored and the panel would keep using the real platform."
    );
  }
  const overrides: AuthOverrides = { consoleOrigin: consoleBase };
  const loginPath = str(source.loginPath, "");
  if (loginPath !== "") overrides.loginPath = loginPath;
  // How long a token is assumed to live when it is not a readable JWT. The
  // direction is load-bearing (see `AUTH_DEFAULTS`): too SHORT spends a real
  // sign-in on every poll, and Agnes locks an account after a few bad
  // attempts, so an operator shortening this is trading accuracy for a
  // lockout risk. Exposed anyway, because a deployment behind a slow proxy
  // may genuinely need it.
  const fallbackExpiresInSeconds = Math.floor(num(source.fallbackExpiresInSeconds, 0));
  if (fallbackExpiresInSeconds > 0) overrides.fallbackExpiresInSeconds = fallbackExpiresInSeconds;
  // `requestTimeoutMs` is what this option shipped as, but it only ever fed
  // the login flow — the console calls had their own deadline. The old name
  // still wins when only it is set, so a config written against an earlier
  // version keeps its deadline instead of silently reverting to the default.
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
export function resolveAllowedHosts(source: Record<string, unknown>) {
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
export function hostName(host: string) {
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
    if (/^\d+$/.test(colons[colons.length - 2]!) && /^\d+$/.test(colons[colons.length - 1]!)) {
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
 *
 * The boundary this draws is the BROWSER, not the machine. A process running
 * as the user sets `Host` and `Origin` to whatever it likes, and there is no
 * CSRF token here to tell it apart from the panel — so anything that can open
 * a socket to this port can also plant an account. That is the same trust the
 * Host places in the user's own processes generally, but it is worth saying
 * plainly: an `Origin` check reads like more protection than it is, and a
 * reader who believes otherwise will build something on top of it. Closing
 * that gap needs a token the Host serves in its own page and the POST carries
 * back, not a header a client can choose.
 * @param request - the incoming HTTP request.
 * @param {Set<string>} allowedHosts - the host names this Host answers as.
 * @returns {boolean} whether the request may be served.
 */
export function isAdmitted(request: { headers: { host?: string; origin?: unknown } }, allowedHosts: Set<string>) {
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
