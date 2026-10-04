//#region src/host/util.ts
/**
* The error `pluginError` actually produces at runtime: an `Error` with a
* stable `code` the panel branches on, plus optional structured fields the
* panel and trace read. The fields are attached, not inherited, so this is a
* structural annotation, not a subclass.
* @typedef {Error & {
*   code: import("./codes.ts").CodeValue,
*   retryAfterMs?: number,
*   detail?: string,
*   trace?: object[]
* }} PluginError
*/
/**
* Read a finite positive number, else the fallback.
*
* `value` is `unknown` on purpose: every call site reads a field off a payload
* the plugin did not author (a console response, a state file, a settings row),
* so the honest type at this boundary is "could be anything". Narrowing the
* PARAMETER costs callers nothing (everything is assignable to `unknown`) and
* stops the `any` from propagating inward — the returns stay loose because the
* fallback is the caller's own value and is passed straight back.
*/
function num(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** Read a non-empty string, else the fallback. */
function str(value, fallback) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}
/**
* Redact credential-shaped strings from any text that may reach a log, an
* error message, or a panel-facing response.
*
* AGENTS.md's red line: "凭据不入库" — a credential never reaches a log or a
* response. The login trace already sanitizes in `agnes-auth.ts`; this is
* the counterpart for the LLM route, where an HTTP error object's `message`
* often embeds the request headers it was built from (axios/fetch errors do),
* and a Agnes 4xx body may echo the `sk-` key back. Without this gate a
* registration failure would leak the key through `providerState.error` and
* `ctx.logger.warn`.
* @param {string} text - any string that might carry a credential.
* @returns {string} the text with credential patterns replaced by `[REDACTED]`.
*/
function redactSecrets(text) {
	return (typeof text === "string" ? text : "").replace(/(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)(?!Bearer\s)[^"',;\s]+/g, "$1[REDACTED]").replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]").replace(/\b(sk|cpk)-[A-Za-z0-9._-]{8,}/g, "$1-[REDACTED]").replace(/(["']?(?:password|access_token|refresh_token|api[_-]?key|token)["']?\s*:\s*["'])[^"']+(?=["'])/gi, "$1[REDACTED]").replace(/\b(password|access_token|refresh_token|api[_-]?key|token)\s*=\s*[^&;\s]+/gi, "$1=[REDACTED]");
}
/**
* The panel-facing text for a thrown value: an `Error`'s message — or a plain
* value's string form — with every credential-shaped substring removed.
*
* AGENTS.md's red line names three places that must redact — the provider, the
* desktop upstream, and the ROUTE — and every route answers `ok:false` with an
* `error` field drawn from whatever was thrown. Some of those values are built
* by the console client from the request it made (an axios/fetch error embeds
* the header it was built from, and a Agnes 4xx body may echo the `sk-` key),
* so the message must not travel verbatim. A store error that carries no
* credential is left untouched by the call.
* @param {unknown} error - the thrown value, `Error` or otherwise.
* @returns {string} secret-free text for a panel-facing `error`/`detail` field.
*/
function redactError(error) {
	return redactSecrets(error instanceof Error ? error.message : String(error));
}
/**
* Read a plain object, else `{}`.
*
* Returns `Record<string, unknown>` rather than `any`: the reader's whole job is
* to hand back a shape the caller must still validate field by field, and typing
* it as `any` would silently wave through every unvalidated read downstream.
*/
function obj(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/**
* Read a string exactly as it was given, else the fallback.
*
* The companion to `str()` for secrets: a password is stored, read back and
* sent as typed, because trimming it is a change the user cannot see. A
* password of only whitespace is still "not filled in", which the caller
* judges with `.trim()`.
*/
function verbatim(value, fallback) {
	return typeof value === "string" ? value : fallback;
}
/** Read a finite number, else `null`. */
function numOrNull$1(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
/**
* Read a finite number that may legitimately be ZERO, else `undefined`.
*
* `num()` and `numOrNull()` both reject `0` because for their callers a zero is
* a missing reading (a limit, a window, a count — none of which is honestly
* zero when the platform simply did not say). This reader exists for the
* opposite case, and the distinction is load-bearing at the call site: the
* platform's `points_cost_multiplier` uses `0` to mean "this model is free",
* which is a published PRICE, not a missing value. Routing it through `num()`
* would collapse "free" into "not stated" and the panel would then render
* nothing where it should render the free badge (the sibling SenseNova plugin
* renders this exact figure as `· x0.00`).
*
* So: absent / non-numeric / non-finite / negative → `undefined` (no claim);
* `0` → `0` (a claim of free).
* @param {unknown} value - the raw field.
* @returns {number|undefined} the finite non-negative number, or `undefined`.
*/
function numZeroOk(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
/**
* Run one attempt loop inside a bounded window.
*
* The shared backoff shape for every "a service or a seed may be late" case
* in this plugin: a Host service can register AFTER this plugin mounts, and a
* one-shot mount-time read then misses it for the WHOLE session, silently. The
* caller owns the attempt count and the delay base (a single service read
* settles in a few hundred ms; a seed that must wait for two services and then
* fetch a catalogue needs a longer budget).
*
* The backoff is LINEAR (`delayMs * attempt`), so a slow Host is not hammered
* while an early success returns at once.
* @param {object} job
* @param {number} job.attempts - how many attempts the window holds.
* @param {number} job.delayMs - backoff base; the wait before attempt N is
*   `delayMs * N`.
* @param {(attempt: number) => boolean|Promise<boolean>} job.run - one
*   attempt; returns true to stop (succeeded, or gave up deliberately), false
*   to keep trying inside the window.
* @returns {Promise<boolean>} true when an attempt stopped the loop, false
*   when the window ran out.
*/
async function retryBounded({ attempts, delayMs, run }) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (await run(attempt)) return true;
		if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
	}
	return false;
}
/**
* An error carrying a stable code the panel can branch on.
*
* The single constructor for every failure this plugin produces. `extra`
* carries optional structured fields (retryAfterMs, detail) that the panel
* and the trace need; only defined extras are copied, so an absent field
* stays absent rather than reading as a zero.
*
* The runtime value is a plain `Error` with these fields attached; the
* {@link PluginError} type records that shape so a `catch (e)` downstream can
* read `e.code` as more than a hopeful guess.
* @param {import("./codes.ts").CodeValue} code - a {@link import("./codes.ts").CODE} wire value.
* @param {string} message - human-readable description.
* @param {{ retryAfterMs?: number, detail?: string }} [extra] - optional structured fields.
* @returns {PluginError}
*/
function pluginError(code, message, extra = {}) {
	const error = new Error(message);
	error.code = code;
	if (extra.retryAfterMs !== void 0) error.retryAfterMs = extra.retryAfterMs;
	if (extra.detail !== void 0) error.detail = extra.detail;
	return error;
}

//#endregion
//#region src/host/host-config.ts
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
const name = "dsh-connect-agnes-token-plan";
/** Cordis services this plugin needs; without `webServer` it stays inactive. */
const inject = ["webServer"];
/**
* The plugin's configuration contract in one place.
*
* Every default the Host half reads lives here, so the code and the
* `cordis.patch.yml` that documents it cannot silently drift: `test/config.test.mjs`
* pins both against this object. The `auth` sub-object lists the operator-facing
* login-flow overrides (their patch.yml entries are commented by default, which is
* why they default to empty/zero and mean "use the platform default").
*/
const CONFIG_DEFAULTS = Object.freeze({
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
	consoleTimeoutMs: 15e3,
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
	admittedHosts: [
		"localhost",
		"127.0.0.1",
		"[::1]",
		"::1"
	],
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
	drawTimeoutMs: 12e4,
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
	/**
	* Preferred video model id; empty means auto-pick — the first V2.0-family
	* video model of the catalog, falling back to the first 2.5 model when the
	* catalog holds no V2.0 one (`pickVideoModel` in `video-models.ts` is the
	* implementation; the wording here, in the tool's `model` description and in
	* the panel's `video.autoOption` is pinned to it by `video.test.mjs` §3d).
	*/
	videoModelId: "",
	/** Polling budget for one video task; the tool deadline is this plus the
	*  create call's own deadline (`VIDEO_REQUEST_TIMEOUT_MS`). Video tasks run for minutes. */
	videoTimeoutMs: 6e5,
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
function resolveTrendMultipliers(raw) {
	const source = raw === void 0 || raw === null ? CONFIG_DEFAULTS.trendMultipliers : raw;
	if (source === null || typeof source !== "object" || Array.isArray(source)) return { ...CONFIG_DEFAULTS.trendMultipliers };
	const out = {};
	for (const [key, value] of Object.entries(source)) if (typeof key === "string" && key !== "" && typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
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
function clampInt(raw, def, min, max = Infinity) {
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
function resolveSettings(config) {
	const source = obj(config);
	const consoleBase = str(source.consoleBase, CONFIG_DEFAULTS.consoleBase).replace(/\/+$/, "");
	const apiBase = str(source.apiBase, CONFIG_DEFAULTS.apiBase).replace(/\/+$/, "");
	try {
		return {
			settings: {
				consoleBase,
				apiBase,
				usageDays: clampInt(source.usageDays, CONFIG_DEFAULTS.usageDays, 1, 365),
				trendMultipliers: resolveTrendMultipliers(source.trendMultipliers),
				cacheSeconds: clampInt(source.cacheSeconds, CONFIG_DEFAULTS.cacheSeconds, 5),
				pollSeconds: clampInt(source.pollSeconds, CONFIG_DEFAULTS.pollSeconds, 5),
				consoleTimeoutMs: clampInt(source.consoleTimeoutMs, CONFIG_DEFAULTS.consoleTimeoutMs, 1e3),
				allowedHosts: resolveAllowedHosts(source),
				tokenSkewSeconds: clampInt(source.tokenSkewSeconds, CONFIG_DEFAULTS.tokenSkewSeconds, 0),
				auth: resolveAuthOverrides(source, consoleBase),
				writeImageModelIds: source.writeImageModelIds === true,
				imageModelIds: Array.isArray(source.imageModelIds) ? source.imageModelIds.filter((id) => typeof id === "string") : CONFIG_DEFAULTS.imageModelIds,
				visionModels: Array.isArray(source.visionModels) ? source.visionModels.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : CONFIG_DEFAULTS.visionModels,
				registerProvider: source.registerProvider === true,
				drawEnabled: source.drawEnabled === true,
				drawModelId: str(source.drawModelId, ""),
				drawTimeoutMs: clampInt(source.drawTimeoutMs, CONFIG_DEFAULTS.drawTimeoutMs, 5e3),
				videoEnabled: source.videoEnabled === true,
				videoModelId: str(source.videoModelId, ""),
				videoTimeoutMs: clampInt(source.videoTimeoutMs, CONFIG_DEFAULTS.videoTimeoutMs, 3e4),
				videoWidth: clampInt(source.videoWidth, CONFIG_DEFAULTS.videoWidth, 1),
				videoHeight: clampInt(source.videoHeight, CONFIG_DEFAULTS.videoHeight, 1),
				videoNumFrames: clampInt(source.videoNumFrames, CONFIG_DEFAULTS.videoNumFrames, 1),
				videoFrameRate: clampInt(source.videoFrameRate, CONFIG_DEFAULTS.videoFrameRate, 1)
			},
			configError: null
		};
	} catch (error) {
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
function resolveAuthOverrides(source, consoleBase) {
	if (source.auth !== void 0 && source.auth !== null) {
		const keys = Object.keys(obj(source.auth));
		throw new Error(`auth overrides are top-level keys on this row, not a nested \`auth:\` block${keys.length === 0 ? "" : ` (found: ${keys.join(", ")})`}. Use \`loginPath\`, \`loginTimeoutMs\` or \`fallbackExpiresInSeconds\` at the top level; a nested block is ignored and the panel would keep using the real platform.`);
	}
	const overrides = { consoleOrigin: consoleBase };
	const loginPath = str(source.loginPath, "");
	if (loginPath !== "") overrides.loginPath = loginPath;
	const fallbackExpiresInSeconds = Math.floor(num(source.fallbackExpiresInSeconds, 0));
	if (fallbackExpiresInSeconds > 0) overrides.fallbackExpiresInSeconds = fallbackExpiresInSeconds;
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
function resolveAllowedHosts(source) {
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
function hostName(host) {
	if (host.startsWith("[") && host.includes("]")) return host.slice(0, host.indexOf("]") + 1);
	const colons = host.split(":");
	if (colons.length > 2) {
		if (/^\d+$/.test(colons[colons.length - 2]) && /^\d+$/.test(colons[colons.length - 1])) return host.slice(0, host.lastIndexOf(":"));
		return host;
	}
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
function isAdmitted(request, allowedHosts) {
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

//#endregion
//#region src/host/parsers.ts
/**
* Console response parsing and shape-drift detection.
*
* The parsers stay forgiving so a poll never throws because a field moved;
* that forgiveness is also how a platform-side rename becomes a serene "no
* data yet" screen, so `EXPECTED_SHAPES` + `checkShape` are what let the panel
* say "the upstream shape changed" instead of "you used nothing".
*
* Every function here takes the payload AFTER `console-client.ts` unwrapped
* the `{code, message, data}` envelope — that is, it sees `data`, not the
* wrapper. The one exception is `parsePlans`, whose `data` IS the array.
* @module dsh-connect-agnes-token-plan/parsers
*/
/**
* The top-level keys each console contract is expected to carry.
*
* The parsers below stay forgiving so that a poll never throws because a field
* moved. That forgiveness is also how a platform-side rename becomes a serene
* "no data yet" screen, so this declaration is what lets the panel say
* "the upstream shape changed" instead of "you used nothing".
*
* `subscription` deliberately lists NOTHING: no session token was available to
* observe that payload (see `docs/AGNES-API.md`), and inventing an
* expectation for a contract nobody has seen would report drift on every poll.
* The plan catalogue is checked separately — its `data` is an ARRAY, which
* `checkShape` cannot describe.
*/
const EXPECTED_SHAPES = Object.freeze({
	"usage-overview": ["total_requests", "total_tokens"],
	"usage-series": ["items"],
	"subscription": ["plan_name", "billing_cycle"]
});
/**
* Parse one numeric field the console returns as a string or a number.
*
* Agnes mixes the two: plan limits arrive as real JSON numbers, while usage
* counters have been seen as strings on the sibling gateway routes. `Number`
* accepts both, and anything unparseable becomes 0 so the panel shows a
* missing figure rather than `NaN`.
*/
function countOf(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
/**
* Read one timestamp as seconds since the epoch, from any shape the platform
* might send it in: epoch seconds, epoch millis, a decimal string of either,
* or an ISO-8601 date.
*
* The millis-vs-seconds guess is safe because the two ranges do not overlap in
* practice: a seconds stamp above 1e12 would be the year 33658, and a millis
* stamp below it would be 1970. Returns `null` for anything else — a missing
* expiry must read as "unknown", never as 1970.
*/
function timestampSeconds(value) {
	if (value === void 0 || value === null || value === "") return null;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) return null;
		return Math.floor(value > 0xe8d4a51000 ? value / 1e3 : value);
	}
	const text = String(value).trim();
	if (text === "") return null;
	if (/^\d+(\.\d+)?$/.test(text)) return timestampSeconds(Number(text));
	const parsed = Date.parse(text);
	return Number.isFinite(parsed) ? Math.floor(parsed / 1e3) : null;
}
/**
* Report which expected top-level keys a console payload is missing.
* @param {unknown} body - the parsed console response (already unwrapped).
* @param {string} kind - a key of {@link EXPECTED_SHAPES}.
* @returns {{ok: boolean, missing: string[]}} the drift report.
*/
function checkShape(body, kind) {
	const expected = EXPECTED_SHAPES[kind] ?? [];
	const source = obj(body);
	const missing = expected.filter((key) => source[key] === void 0);
	return {
		ok: missing.length === 0,
		missing
	};
}
/**
* Normalize `GET /api/usage/overview` into the panel's totals row.
*
* These are CUMULATIVE figures for whatever period the platform reports — the
* parser does not claim which. Shown as their own facts alongside the
* per-window bars.
* @param {unknown} body - the unwrapped `data` object.
* @returns {{totalRequests: number, totalTokens: number, totalImages: number, totalVideoSeconds: number, activeDays: number}}
*/
function parseUsageOverview(body) {
	const source = obj(body);
	return {
		totalRequests: countOf(source.total_requests),
		totalTokens: countOf(source.total_tokens),
		totalImages: countOf(source.total_images),
		totalVideoSeconds: countOf(source.total_video_seconds),
		activeDays: countOf(source.active_days)
	};
}
/**
* Normalize `GET /api/usage/series` into per-bucket rows plus their sum.
*
* Each `items[]` entry IS one bucket (hour or day, per the platform's own
* `bucket` label), so unlike the SenseNova trend — where several points made
* up one model's row — nothing is summed per row. `totals` sums ACROSS buckets
* because that is a fact the platform does not state for the window, and the
* panel needs it for its "in the last N days" line.
*
* Agnes offers no per-model breakdown at all (the console's own usage page
* never reads a `model` field), so there is no `models` list to build.
* @param {unknown} body - the unwrapped `data` object.
* @param {number} days - the window the Host asked for, echoed for the label.
* @returns {{days: number, totals: object, buckets: object[]}}
*/
function parseUsageSeries(body, days) {
	const raw = obj(body).items;
	const items = Array.isArray(raw) ? raw : [];
	const buckets = [];
	for (const entry of items) {
		const source = obj(entry);
		const bucket = str(source.bucket, "");
		if (bucket === "") continue;
		buckets.push({
			bucket,
			requestCount: countOf(source.request_count),
			textTokens: countOf(source.text_tokens),
			imageCount: countOf(source.image_count),
			videoSeconds: countOf(source.video_seconds)
		});
	}
	buckets.sort((a, b) => a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0);
	return {
		days,
		totals: buckets.reduce((acc, bucket) => ({
			totalRequests: acc.totalRequests + bucket.requestCount,
			totalTokens: acc.totalTokens + bucket.textTokens,
			totalImages: acc.totalImages + bucket.imageCount,
			totalVideoSeconds: acc.totalVideoSeconds + bucket.videoSeconds
		}), {
			totalRequests: 0,
			totalTokens: 0,
			totalImages: 0,
			totalVideoSeconds: 0
		}),
		buckets
	};
}
/**
* Normalize the plan catalogue (`GET /api/cn/user/subscription/plans`).
*
* Verified live 2026-10-01 against an anonymous request: six entries —
* `入门版` / `专业版` / `高级版`, each in a monthly and a yearly variant. The
* numbers below are exactly the platform's field names; the daily image and
* video caps are identical across all three tiers (4000 / 500), which is why
* only the request dimensions actually differentiate the plans.
*
* `data` is an ARRAY here, not an object — the only Agnes response shaped that
* way. An unexpected shape yields `[]`, never a throw.
* @param {unknown} body - the unwrapped `data` value.
* @returns {object[]} the catalogue, in the platform's own order.
*/
function parsePlans(body) {
	return (Array.isArray(body) ? body : []).map((entry) => {
		const source = obj(entry);
		return {
			uuid: str(source.uuid, ""),
			planId: countOf(source.id),
			name: str(source.name, ""),
			displayName: str(source.display_name, str(source.name, "")),
			billingCycle: str(source.billing_cycle, ""),
			displayCycle: str(source.display_cycle, ""),
			priceMinor: countOf(source.price_minor),
			currency: str(source.currency, ""),
			concurrencyLimit: countOf(source.concurrency_limit),
			concurrencyWindowH: countOf(source.concurrency_window_h),
			textWeeklyLimit: countOf(source.text_weekly_limit),
			imageDailyLimit: countOf(source.image_daily_limit),
			videoDailyLimit: countOf(source.video_daily_limit),
			featureTexts: Array.isArray(source.feature_texts) ? source.feature_texts.filter((text) => typeof text === "string") : []
		};
	});
}
/**
* Keys a subscription payload might name the current plan under.
*
* Deliberately a fixed list rather than "scan the whole payload for a string
* that looks like a plan name": the subscription object also carries the
* user's own `name`, an order list, and possibly a catalogue of every plan, so
* a whole-payload scan would match `入门版` on an account that is on `高级版`.
*/
const PLAN_IDENTITY_KEYS = Object.freeze([
	"plan_uuid",
	"planUuid",
	"uuid",
	"plan_name",
	"planName",
	"plan",
	"plan_code",
	"planCode",
	"subscription_plan",
	"subscriptionPlan",
	"product",
	"product_name",
	"productName",
	"name",
	"display_name",
	"displayName",
	"tier"
]);
/** Every scalar anywhere in a value, as strings — used for uuid matching only. */
function collectScalars(value, depth, out) {
	if (depth > 3) return out;
	if (Array.isArray(value)) {
		for (const item of value) collectScalars(item, depth + 1, out);
		return out;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectScalars(item, depth + 1, out);
		return out;
	}
	if (typeof value === "string" || typeof value === "number") {
		const text = String(value).trim();
		if (text !== "") out.add(text);
	}
	return out;
}
/** The values held under {@link PLAN_IDENTITY_KEYS}, at the top two levels. */
function collectIdentities(value, depth, out) {
	if (depth > 2) return out;
	const source = obj(value);
	for (const [key, entry] of Object.entries(source)) {
		if (PLAN_IDENTITY_KEYS.includes(key) && (typeof entry === "string" || typeof entry === "number")) {
			const text = str(String(entry), "");
			if (text !== "") out.add(text);
		}
		if (entry && typeof entry === "object" && !Array.isArray(entry)) collectIdentities(entry, depth + 1, out);
	}
	return out;
}
/**
* Find the catalogue entry the signed-in account is currently on.
*
* Two signals, strongest first:
*
* 1. UUID — a 36-character plan uuid may be matched ANYWHERE in the payload,
*    because nothing else on the platform looks like one. This is what the
*    platform's own plan objects use as their stable identity.
* 2. NAME — matched only against the values held under
*    {@link PLAN_IDENTITY_KEYS}, never against the whole payload.
*
* A numeric plan id is deliberately NOT a signal: the ids are 1–6, and a
* subscription object is full of small integers, so `planId === 1` would
* "match" the entry tier on almost every account.
*
* A name match hits BOTH billing cycles (入门版 exists as monthly and yearly),
* so ties are broken with whatever cycle the payload states, defaulting to
* monthly — the cheaper variant, and the one a fresh signup lands on.
*
* @param {unknown} subscription - the unwrapped `/api/cn/user/subscription` data.
* @param {object[]} plans - the {@link parsePlans} result.
* @returns {object|null} the matching catalogue entry, or null when the payload
*   does not name a plan this plugin can recognise.
*/
function matchCurrentPlan(subscription, plans) {
	const list = Array.isArray(plans) ? plans.filter((plan) => plan && typeof plan === "object") : [];
	if (list.length === 0 || subscription === void 0 || subscription === null) return null;
	const everywhere = collectScalars(subscription, 0, /* @__PURE__ */ new Set());
	const identities = collectIdentities(subscription, 0, /* @__PURE__ */ new Set());
	const scoreOf = (plan) => {
		if (plan.uuid !== "" && (everywhere.has(plan.uuid) || identities.has(plan.uuid))) return 3;
		for (const value of [plan.name, plan.displayName]) if (value !== "" && identities.has(value)) return 2;
		return 0;
	};
	let bestScore = 0;
	for (const plan of list) bestScore = Math.max(bestScore, scoreOf(plan));
	if (bestScore === 0) return null;
	const tied = list.filter((plan) => scoreOf(plan) === bestScore);
	if (tied.length === 1) return tied[0];
	const stated = [...everywhere].find((value) => value === "monthly" || value === "yearly" || value === "annual");
	const cycle = stated === "annual" ? "yearly" : stated;
	return tied.find((plan) => plan.billingCycle === cycle) ?? tied.find((plan) => plan.billingCycle === "monthly") ?? tied[0];
}
/**
* Read a subscription's expiry, from whichever of the plausible key names the
* platform actually uses.
*
* No session token was available to observe the real field name, so several
* are tried in order of likelihood. `null` means "the payload did not state
* one", which the panel renders as nothing rather than as an error.
* @param {unknown} subscription - the unwrapped subscription data.
* @returns {number|null} seconds since the epoch, or null.
*/
function readSubscriptionExpiry(subscription) {
	const source = obj(subscription);
	for (const key of [
		"expires_at",
		"expiresAt",
		"expire_at",
		"expired_at",
		"end_at",
		"end_date",
		"current_period_end",
		"next_billing_at",
		"next_billing_date"
	]) {
		const value = timestampSeconds(source[key]);
		if (value !== null) return value;
	}
	return null;
}
/**
* Turn one catalogue entry into the panel's quota windows.
*
* Agnes caps four dimensions, each a WINDOW rather than a credit balance, so
* the shape is "N per W hours" and there is no balance to decrement:
*
* | key | limit field | window |
* |---|---|---|
* | `requests5h` | `concurrency_limit` | `concurrency_window_h` (5 on every plan) |
* | `requestsWeekly` | `text_weekly_limit` | 168 h |
* | `imagesDaily` | `image_daily_limit` | 24 h |
* | `videoDaily` | `video_daily_limit` | 24 h |
*
* The platform's own `usage_limit_text` ("1500 次模型请求 / 5 小时") names the
* first window's shape but is NOT parsed or rendered: it is static plan
* marketing that never moves with consumption. The live per-window figures
* come from `subscription.usage` instead (see `parseSubscriptionUsage`).
*
* `unit` is `"requests"` / `"images"` / `"video"` and carries NO seconds claim
* for video: the field is named `video_daily_limit` while the usage side
* counts `video_seconds`, and the platform never states which one the limit
* is in. The panel prints the bare number for that reason.
*
* A zero or absent limit is dropped rather than shown as "0 / 日" — an
* unstated cap must not read as "you may do nothing".
* @param {unknown} plan - one catalogue entry (or a subscription's own limits).
* @returns {object[]} the windows, in the order the panel lists them.
*/
function quotaWindows(plan) {
	const source = obj(plan);
	const windows = [];
	const requests5h = countOf(source.concurrencyLimit);
	if (requests5h > 0) windows.push({
		key: "requests5h",
		unit: "requests",
		limit: requests5h,
		windowHours: countOf(source.concurrencyWindowH) || 5
	});
	const weekly = countOf(source.textWeeklyLimit);
	if (weekly > 0) windows.push({
		key: "requestsWeekly",
		unit: "requests",
		limit: weekly,
		windowHours: 168
	});
	const images = countOf(source.imageDailyLimit);
	if (images > 0) windows.push({
		key: "imagesDaily",
		unit: "images",
		limit: images,
		windowHours: 24
	});
	const video = countOf(source.videoDailyLimit);
	if (video > 0) windows.push({
		key: "videoDaily",
		unit: "video",
		limit: video,
		windowHours: 24
	});
	return windows;
}
/**
* Parse a Shanghai-local wall clock the platform sends without an offset.
*
* The console declares `"timezone":"Asia/Shanghai"` (its overview reports it)
* and sends window timestamps as bare `"2026-10-01T15:00:00"`. Interpreting
* that with the host's own `Date.parse` would shift the reset time by the
* machine's offset, so the platform's convention is applied explicitly:
* UTC+8. Returns epoch SECONDS, or null for anything that is not that shape.
* @param {unknown} text - the raw timestamp string.
* @returns {number|null} epoch seconds, or null.
*/
function shanghaiSeconds(text) {
	const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text ?? ""));
	if (match === null) return null;
	const [, year, month, day, hour, minute, second = "0"] = match;
	return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) / 1e3 - 28800;
}
/**
* Which subscription usage slot answers which panel window.
*
* `subscription.usage` is the platform's OWN per-window reading, grouped by
* generation and keyed by the window shape it applies to:
*
* | panel window | subscription path |
* |---|---|
* | `requests5h` | `text_generation.windowed` |
* | `requestsWeekly` | `text_generation.weekly` |
* | `imagesDaily` | `image_generation.daily` |
* | `videoDaily` | `video_generation.daily` |
*
* Verified live 2026-10-01. This is the ONLY per-window consumption the
* platform publishes; it is what lets the panel draw a real `used / limit`
* bar instead of declining to compute one.
*/
const USAGE_WINDOW_MAP = Object.freeze({
	"requests5h": ["text_generation", "windowed"],
	"requestsWeekly": ["text_generation", "weekly"],
	"imagesDaily": ["image_generation", "daily"],
	"videoDaily": ["video_generation", "daily"]
});
/** A finite number, or null — so an absent figure never reads as a measurement. */
function numOrNull(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function parseSubscriptionUsage(subscription) {
	const usage = obj(obj(subscription).usage);
	if (Object.keys(usage).length === 0) return null;
	const out = {};
	for (const [windowKey, pair] of Object.entries(USAGE_WINDOW_MAP)) {
		const group = pair[0];
		const slot = pair[1];
		if (group === void 0 || slot === void 0) continue;
		const cell = obj(obj(usage[group])[slot]);
		if (Object.keys(cell).length === 0) continue;
		out[windowKey] = {
			used: numOrNull(cell.used),
			limit: countOf(cell.limit),
			usagePct: numOrNull(cell.usage_pct),
			rangeStart: shanghaiSeconds(cell.time_range_start),
			rangeEnd: shanghaiSeconds(cell.time_range_end),
			resetAt: shanghaiSeconds(cell.reset_at),
			resetInSeconds: numOrNull(cell.reset_in_seconds)
		};
	}
	return Object.keys(out).length === 0 ? null : out;
}
/**
* Whether one `GET /v1/models` entry can take image input, and WHY.
*
* This is the first step of the vision plan (ARCHITECTURE.md §5.1): the panel
* shows which of this key's callable models accept pictures, so the user
* knows which one to ask for image input.
*
* Two signals, in priority order:
*
* 1. STRUCTURED — the Agnes catalog declares `input_modalities` (an
*   array, e.g. `["text","image"]`) on every entry. This is CONFIRMED the
*   platform ships it (2026-09 probe), so it is the authoritative answer:
*   a model is vision-capable iff `"image"` appears in its input
*   modalities. The name fallback below stops mattering on this platform.
*   `inputTypes` / `modality` / `capabilities` are kept as the fallback for
*   other providers that spell the same idea differently — no parser
*   change needed when they arrive.
* 2. NAME PATTERN — only when NO structured modality field is present at
*   all: naming conventions for the multimodal/vision families. Marked
*   `source: "name"` so the panel can say "inferred from the name" and
*   never pretend the platform declared it.
*
* @param {object} entry - one catalog entry (id + any extra fields).
* @returns {{"id": string, "vision": boolean, "source": "field"|"name"|null}}
*/
function identifyVisionModel(entry) {
	const source = obj(entry);
	const id = str(source.id, "");
	const modalities = modalitiesOf(source);
	if (modalities !== void 0) return {
		id,
		vision: modalities.some((modality) => /image/i.test(modality)),
		source: "field"
	};
	const byName = VISION_NAME_PATTERNS.some((pattern) => pattern.test(id));
	return {
		id,
		vision: byName,
		source: byName ? "name" : null
	};
}
/**
* Read the first modality-listing field off a catalog entry, or undefined.
* The Agnes platform's confirmed field is `input_modalities` (array of
* strings, e.g. `["text","image"]`); the others are the spellings other
* providers are expected to use. Accepts string or array values so whatever
* the platform ships parses.
* @param {object} source - one catalog entry.
* @returns {string[]|undefined} the modality names, or undefined.
*/
function modalitiesOf(source) {
	for (const key of [
		"input_modalities",
		"inputTypes",
		"modality",
		"capabilities"
	]) {
		const value = source[key];
		if (Array.isArray(value)) return value.map((modality) => String(modality));
		if (typeof value === "string" && value !== "") return value.split(/[,|]/).map((modality) => modality.trim());
	}
}
/**
* Name patterns used ONLY when no structured modality field is present.
* `flash-lite` was the legacy guess from before the platform confirmed
* `input_modalities`; it is no longer a reliable signal (the name now maps
* to a model family whose actual modality mix the platform field decides),
* so it is dropped from the fallback set.
*/
const VISION_NAME_PATTERNS = Object.freeze([
	/-vl(-|\b)/i,
	/vision/i,
	/qwen.*vl/i,
	/glm-4v/i
]);

//#endregion
//#region src/host/modality.ts
/**
* The single source of truth for "what can this catalog entry produce?".
*
* WHY THIS MODULE EXISTS — a design premise that did not survive contact with
* the live gateway.
*
* ARCHITECTURE §5.4 chose STRUCTURED over regex-based identification, but
* the Agnes gateway (new-api lineage) returns NONE of the fields SenseNova
* carries (`output_modalities` / `input_modalities` / `supported_features`).
* Both predicates (`isImageGenModel`, `isChatModel`) now resolve through
* {@link outputModalitiesOf} so the two lists cannot disagree.
*
* THREE RESOLUTION LEVELS, in precedence order:
*
*   1. DECLARED — `output_modalities` (or a known sibling spelling) is an
*      array. Always wins, so a gateway that starts shipping the field takes
*      over automatically with no code change here.
*   2. INFERRED — no field, but the id carries the family segment the platform
*      itself uses: `agnes-image-*` → image, `agnes-video-*` → video.
*   3. ASSUMED — no field, no family segment: `["text"]`, i.e. a chat model.
*
* The name patterns are deliberately NARROW: they match a whole `image` /
* `video` path segment, never a substring. The `dsh-draw-router` lesson still
* holds — a loose substring regex is how its `/u1-fast/i` missed `u1.5-lite` —
* so the fallback matches the platform's own naming convention exactly instead
* of guessing at shapes it has never seen. `agnes-2.5-pro` and
* `agnes-3.0-flash` are untouched by it, which is the point.
*
* @module dsh-connect-agnes-token-plan/modality
*/
/** The modality token meaning "this entry produces images". */
const IMAGE_MODALITY = "image";
/** The modality token meaning "this entry produces video". */
const VIDEO_MODALITY = "video";
/** The modality token meaning "this entry produces text" — the chat default. */
const TEXT_MODALITY = "text";
/**
* The field spellings that may carry an entry's OUTPUT modalities.
*
* Mirrors `parsers.ts`'s input-side key list (`input_modalities` +
* `inputTypes`): the snake_case platform field first, then the camelCase
* sibling other gateways are expected to use. An unknown spelling is not
* guessed at — it degrades to the name fallback, which is visible in the
* resolution `source`.
*/
const OUTPUT_MODALITY_KEYS = Object.freeze(["output_modalities", "outputTypes"]);
/**
* The Agnes family segment marking an image-generation model.
*
* Matches `agnes-image-2.1-flash` / `agnes-image-2.5-flash`; requires the
* segment to stand alone (bounded by `-`, `_`, or the string ends) so a
* hypothetical `imageservice` cannot be caught by accident.
*/
const IMAGE_ID_PATTERN = /(?:^|[-_])image(?:[-_]|$)/i;
/**
* The Agnes family segment marking a video-generation model.
*
* Matches `agnes-video-2.5`, `agnes-video-2.5-flash` and `agnes-video-v2.0`.
*/
const VIDEO_ID_PATTERN = /(?:^|[-_])video(?:[-_]|$)/i;
/**
* Read the DECLARED output modalities off a catalog entry, or `null`.
*
* `null` means "the platform said nothing" — the caller falls through to the
* name fallback. An array the platform DID send is honoured verbatim, empty
* array included: "declared nothing" is still a declaration, and overriding it
* with a name guess would put the fallback above the platform's own word.
* @param {object} entry - one normalized catalog entry.
* @returns {string[]|null} lowercased modality names, or `null` when absent.
*/
function declaredOutputModalities(entry) {
	if (entry === null || typeof entry !== "object") return null;
	for (const key of OUTPUT_MODALITY_KEYS) {
		const value = entry[key];
		if (!Array.isArray(value)) continue;
		return value.map((item) => str(item, "").toLowerCase()).filter((item) => item !== "");
	}
	return null;
}
/**
* Resolve an entry's output modalities, and how they were decided.
*
* The `source` is part of the contract, not a debug extra: `"inferred"` and
* `"assumed"` mean the answer is this plugin's reading of a naming convention
* rather than the platform's own statement, and any surface that presents the
* answer as fact (the panel's per-model capability line, a future video tool's
* "not available" message) is expected to say so.
* @param {object} entry - one normalized catalog entry.
* @returns {{modalities: string[], source: "declared"|"inferred"|"assumed"}}
*/
function outputModalitiesOf(entry) {
	const declared = declaredOutputModalities(entry);
	if (declared !== null) return {
		modalities: declared,
		source: "declared"
	};
	const id = str(entry?.id, "");
	const inferred = [];
	if (IMAGE_ID_PATTERN.test(id)) inferred.push(IMAGE_MODALITY);
	if (VIDEO_ID_PATTERN.test(id)) inferred.push(VIDEO_MODALITY);
	if (inferred.length > 0) return {
		modalities: inferred,
		source: "inferred"
	};
	return {
		modalities: [TEXT_MODALITY],
		source: "assumed"
	};
}
/**
* Whether one catalog entry is an image-GENERATION model.
*
* The predicate the draw tool picks its candidates with. It stays on the
* conservative side of a false positive — sending a draw request to a model
* that cannot answer produces an error the agent cannot act on — but "no
* signal at all" no longer means "no" on a gateway that never sends a signal.
* @param {object} entry - one normalized catalog entry.
* @returns {boolean}
*/
function isImageGenModel(entry) {
	return outputModalitiesOf(entry).modalities.includes(IMAGE_MODALITY);
}
/**
* Whether one catalog entry is a video-generation model.
*
* Exists so the chat exclusion can name what it is excluding, and so a future
* video tool has one predicate to share rather than a second regex of its own.
* @param {object} entry - one normalized catalog entry.
* @returns {boolean}
*/
function isVideoGenModel(entry) {
	return outputModalitiesOf(entry).modalities.includes(VIDEO_MODALITY);
}
/**
* Whether a catalog entry can be addressed as a CHAT model on this provider's
* OpenAI-compatible endpoint.
*
* Image and video models answer 400 on `/v1/chat/completions` with a message
* naming the endpoint they DO want ("请使用 /v1/images/generations"), so
* offering them in the picker only produces errors in DSH. This shares
* {@link outputModalitiesOf} with {@link isImageGenModel} precisely so the
* chat roster and the draw candidate list can never disagree about which
* entries exist — the invariant §5.4 wanted, now enforced in one place instead
* of promised across two.
* @param {object} entry - one normalized catalog entry.
* @returns {boolean} whether the entry is usable as a chat model.
*/
function isChatModel(entry) {
	const { modalities } = outputModalitiesOf(entry);
	return !modalities.includes("image") && !modalities.includes("video");
}

//#endregion
//#region src/host/llm-models.ts
/**
* Catalog entry -> pi-ai model descriptor mapping — the pure half of the
* directly-registered Agnes LLM provider ("one-stop service", step three).
*
* Deliberately imports NO runtime peer so the mapping decisions are testable
* on a clean checkout. `llm-adapter.ts` is the peer-dependent half.
*
* Three load-bearing decisions:
* 1. `supportsDeveloperRole: false` — Agnes doesn't speak the developer role;
*    an unset flag would AUTO-DETECT true and return 403 on every request.
* 2. `maxTokens` pinned to `PROBED_MAX_TOKENS` (65536) — the harness fills
*    undeclared models with its own DEFAULT_MAX_TOKENS=32768, declaring the
*    cap lifts the truncation point instead of halving it.
* 3. `reasoning: true` + `thinkingLevelMap` unconditionally — Agnes chat
*    models always reason; the catalog carries no `supported_features` field,
*    so there is nothing to read. Extended levels follow the live ladder:
*    `max` on every chat model, `xhigh` on agnes-3.0-flash only (see PROBED_EFFORT).
*
* @module dsh-connect-agnes-token-plan/llm-models
*/
/**
* The provider id this plugin registers under.
*
* It must NOT be the bare `"Agnes"`: a hand-written `llm-pi-ai` row using
* that id can already exist in an operator's profile (apiKeyEnv
* `AGNES_TOKEN_PLAN_API_KEY`, base `https://api.agnes-ai.cn/v1`), and
* `registerAdapter` with a colliding id is refused as a duplicate. This own
* slug-shaped id cannot collide with that row or with another plugin.
*/
const LLM_PROVIDER_ID = "agnes-token-plan";
/** What the DSH model picker shows as the provider's name. */
const LLM_DISPLAY_NAME = "Agnes Token Plan";
/**
* The thinking effort the profile pins as DSH's "Default" on this provider.
*
* One constant for two claims: `llm-adapter.ts` pins it into the profile, and
* the snapshot echoes it to the panel roster, so the number the user reads is
* the number the adapter dispatches. Editing one without the other is now
* impossible by construction.
*/
const DEFAULT_REASONING_EFFORT = "high";
/**
* Per-token prices are unknowable for a quota plan; report zero everywhere.
*
* ⚠️ The zeros are a SENTINEL, not "free". Agnes Token Plan is a credit
* pool billed by pool usage, so a per-token USD price simply does not exist on
* this route — but the model still burns credits. A panel row showing
* "$0.00" is describing "no per-token price known", never "this model costs
* nothing". Keep this comment next to the set so a future reader does not
* "fix" it to real prices or, worse, to `null` (which pi-ai may render as an
* unknown-cost row and break the picker's cost arithmetic).
*/
const NO_COST = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
});
/**
* Advertised context window when the catalog declares no usable one.
*
* pi-ai's options builder does arithmetic on `model.contextWindow`, so an
* undefined value behaves like zero rather than "unknown" and breaks max-token
* calculation; the qoder route therefore always supplies a positive number.
* 128k is the conservative Agnes-family default; a catalog field that
* states a real window always wins.
*/
const FALLBACK_CONTEXT_WINDOW = 128e3;
/**
* The per-request output ceiling the Agnes gateway enforces, probed live.
*
* Evidence (2026-10-01, `api.agnes-ai.cn/v1/chat/completions`, `reasoning_effort:
* "high"`): `max_tokens: 32768` and `max_tokens: 65536` answered 200 on
* agnes-2.5-flash (65536 re-confirmed on agnes-2.0-flash), omitting the field
* entirely also answered 200, and `max_tokens: 131072` answered 400 with the
* platform's own refusal text `max_tokens 不能超过 65536` — the cap is stated
* by the platform, not inferred. The catalog carries no `max_output_length`
* field to read (AGNES-API.md §7.1), so this probed constant stands in for
* the missing declaration.
*
* Declaring it is NOT the truncation risk the original "no value" decision
* feared: the harness fills undeclared models with `DEFAULT_MAX_TOKENS =
* 32768`, so the only real choice was "half the cap" vs "the cap" (module
* header, decision 2). If the platform ever starts declaring per-model
* `max_output_length`, adopt it ONLY after a live-contract probe re-run —
* catalog values are leads, not contracts (PITFALLS §20).
*/
const PROBED_MAX_TOKENS = 65536;
/**
* Official-doc vision claims, used ONLY when the catalog declares no modality
* field (Agnes sends none — §7.1), so the model picker can still offer image
* input on models the platform's own docs say accept it.
*
* Evidence is the archived official docs (`docs/AGNES-API-docs/`, read-only):
*  - `agnes-3.0-flash.md`: "支持文本和图像 URL 输入"
*  - `agnes-2.5-pro.md`: "付费推理模型，支持文本和图像输入" + "图像理解"
*  - `agnes-2.5-flash.md`: 核心能力含 "图像 URL 输入" / "图像理解"
*  - `agnes-2.0-flash`: 2.5-flash 迁移说明称"图像 URL 输入格式保持不变"，
*    但 2.0-flash 自己的文档页**没有独立声明**，硬编码等于猜——不写
*    （目录字段优先 + 未实测不写，PITFALLS 纪律；若平台补文档页声明或
*    真机探针确认再加）。
*
* ✅ **wire 拼写已实测（2026-10-01 真机，`test/live-contract.mjs` §2d）**：
* 官方只说"图像 URL 输入"，没说拼写——探针对 `agnes-3.0-flash` 用两种拼写各发
* 一次：`{type:"image_url", image_url:{url}}`（OpenAI 标准块）→ **HTTP 200
* 接受**；`{type:"image", image_url:{url}}`（备选）→ **HTTP 500**，平台转发
* 上游报 `Invalid user message at index 0...`——该拼写不被接受。结论：走
* 标准 OpenAI 拼写，与 `dsh-llm-pi-ai` 的 `openai-completions` 方言一致，
* 无需特判。用户实测向 `agnes-3.0-flash` 发游戏截图能正确识别画面内容。
* `agnes-2.5-pro` / `agnes-2.5-flash` 未单独跑同款探针（同家族方言大概率
* 一致，但仍标"待同款探针"）。
*/
const PROBED_VISION = Object.freeze({
	"agnes-3.0-flash": true,
	"agnes-2.5-pro": true,
	"agnes-2.5-flash": true
});
/**
* Official-doc context windows, used ONLY when the catalog declares no
* `context_length` (Agnes sends none — §7.1).
*
* Evidence (`docs/AGNES-API-docs/`):
*  - `agnes-2.5-flash`: "上下文窗口 | 512K"
*  - `agnes-3.0-flash`: "上下文窗口 | 512K"
*  - `agnes-2.5-pro`: "上下文窗口 | 1M tokens"
*
* `agnes-2.0-flash` 文档页无独立声明，未入表——不硬编码（平台补文档页声明
* 或真机探针确认再加）。
*/
const PROBED_CONTEXT_WINDOWS = Object.freeze({
	"agnes-2.5-flash": 512e3,
	"agnes-3.0-flash": 512e3,
	"agnes-2.5-pro": 1e6
});
/**
* Whether a catalog entry is a vision (image-input) model on THIS provider,
* together with the evidence source the panel can quote.
*
* Resolution order — catalog field first, then the name fallback, then the
* official-doc probe table, then not-vision:
*
* 1. source === "field": the platform's own `input_modalities` said so —
*    trust it (a future catalog that starts sending the field automatically
*    wins over the hard table).
* 2. source === "name": `identifyVisionModel`'s own name-pattern fallback
*    (`-vl` / `vision` / `qwen.*vl` / `glm-4v`) — kept as-is.
* 3. `identifyVisionModel` finds nothing (catalog sends no modality field AND
*    the name matches nothing — Agnes today) but the id is in
*    {@link PROBED_VISION}: the platform's own docs claim image input, so we
*    quote source `"docs"`.
* 4. Otherwise: not a vision model on this gateway.
*
* This is deliberately NOT a change to `identifyVisionModel` itself — that
* parser is the shared "catalog says" authority; the hard table is the
* plugin's own "official docs say" layer, layered on top exactly the way
* `PROBED_EFFORT` layers per-model thinking over the safe set.
* @param {object} entry - one normalized catalog entry.
* @returns {{id: string, vision: boolean, source: "field" | "name" | "docs" | null}}
*/
function visionOf(entry) {
	const info = identifyVisionModel(entry);
	if (info.source === "field") return {
		id: info.id,
		vision: info.vision === true,
		source: "field"
	};
	if (info.source === "name") return {
		id: info.id,
		vision: info.vision === true,
		source: "name"
	};
	const id = str(entry?.id, "");
	const docs = PROBED_VISION[id] === true;
	return {
		id,
		vision: docs,
		source: docs ? "docs" : null
	};
}
/**
* The context window to advertise for a catalog entry.
*
* Catalog field wins; the official-doc probe table fills the gap only when the
* catalog declares nothing (Agnes sends no `context_length`, so the catalog
* call returns the 128k fallback — the "declared nothing" signal). A model
* absent from both keeps the conservative fallback.
* @param {object} entry - one normalized catalog entry.
* @returns {number} the window to advertise.
*/
function contextWindowFor(entry) {
	const fromCatalog = contextWindowOf(entry);
	if (fromCatalog !== 128e3) return fromCatalog;
	const id = str(entry?.id, "");
	return PROBED_CONTEXT_WINDOWS[id] ?? 128e3;
}
/**
* Read a positive context window off the catalog entry's known spellings.
*
* `context_length` is the field the platform actually emits (verified against
* the live catalog, 2026-09); the other spellings are kept as fallbacks in
* case the platform ever reverts to a different name. Agnes's `/v1/models`
* entries are kept whole by `console-client.ts`, so a field the platform adds
* later needs no parser change here — only its name has to be added to this
* list.
* @param {object} entry - one normalized catalog entry.
* @returns {number} the declared window, or the fallback.
*/
function contextWindowOf(entry) {
	for (const key of [
		"context_length",
		"context_window",
		"contextWindow",
		"max_context_tokens"
	]) {
		const value = Math.floor(num(entry?.[key], 0));
		if (value > 0) return value;
	}
	return FALLBACK_CONTEXT_WINDOW;
}
/**
* Read the platform's declared per-request output ceiling, 0 when unknown.
*
* This is a DISPLAY fact only. The descriptor pins the PROBED platform cap
* (`PROBED_MAX_TOKENS`, module header decision 2) as its request parameter;
* this roster figure still reads the catalog, which on Agnes declares nothing
* (0 = the panel draws no segment — never guess). It says what the platform
* can emit at most per the catalog's own claim, so the user learns why a long
* reply can still stop with `finish_reason: length`.
* Same spelling-first policy as {@link contextWindowOf}.
* @param {object} entry - one normalized catalog entry.
* @returns {number} the declared ceiling, or 0 when the entry states none.
*/
function maxOutputLengthOf(entry) {
	for (const key of [
		"max_output_length",
		"maxOutputLength",
		"max_output_tokens"
	]) {
		const value = Math.floor(num(entry?.[key], 0));
		if (value > 0) return value;
	}
	return 0;
}
/**
* The picker's 思考强度 levels, pinned to platform-valid wire spellings.
*
* DSH's picker offers levels from `getSupportedThinkingLevels(model)`
* (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`), and pi-ai's
* openai-completions dispatch sends `reasoning_effort = map[level] ?? level`.
* Agnes's OpenAI-compat gateway rejects `off` (the OpenAI spelling) and
* `minimal`; the extended levels are PER-MODEL, per the 2026-10-01 live
* ladder (see PROBED_EFFORT): `xhigh` only on agnes-3.0-flash, `max` on
* every Agnes chat model. So:
*
* - `off: "none"` — the picker's "关闭" must send `none`, not `off`;
*   - `low`/`medium` — 200 on every known chat model; a model ABSENT from
*     the table (an unknown id) still gets them via the Agnes safe-set so
*     the picker is never empty. A model PRESENT in the table with a level
*     set `false` keeps it closed. The live-contract replay
*     (`test/live-contract.mjs`) probes the per-model levels and flips the
*     table cells once a model's 200 is recorded.
* - `xhigh`/`max` — per the table; the safe-set keeps both closed for
*   unknown ids.
*
* A value of `null` means "the picker must not offer this level"; a string is
* the wire spelling the level dispatches to.
* @param {object} entry - one normalized catalog entry.
* @returns {object} the thinkingLevelMap.
*/
/**
* Per-model 思考档位 probe table (frozen 2026-10-01 from the live ladder
* replay, mirrored from `test/baselines/agnes-contract.json`
* §reasoningEffort — every cell is a platform answer, not a guess).
*
* The baseline records which `reasoning_effort` values the platform
* answered 200 for per model (full ladder none/low/medium/high/xhigh/max,
* max_tokens=8; 429 cells re-run clean before recording):
*   - `high` — the platform default for every chat model;
*   - `none` — thinking off, 200 on every model (the message drops the
*     reasoning field entirely);
*   - `low` / `medium` — 200 on every chat model;
*   - `xhigh` — ONLY agnes-3.0-flash. On 2.0/2.5 the platform 400s and its
*     validator states the union itself: "Input should be 'none', 'low',
*     'medium', 'high' or 'max'" — xhigh is not in it. 3.0-flash's upstream
*     runs a wider validator and answers 200.
*   - `max` — 200 on EVERY Agnes chat model. A real dialect flip from the
*     SenseNova era, where max was glm-5.2-only: the table follows the
*     platform per model, never the family history.
*
* The panel roster line must not quote a level the platform may 400 on.
* A model ABSENT from this table (an unknown / future id) is offered the
* safe OpenAI-compatible set — `off`→`none`, plus `low`/`medium`/`high` —
* while `xhigh`/`max` stay closed until a live-contract probe proves them
* on that specific model. A model PRESENT here (even all-`false`) is a
* known id whose closed levels stay closed even where the safe-set would
* open them. A new model that turns out to accept an extra level is added
* here WITH its probe evidence (the baseline's `driftLog` discipline),
* never assumed.
*/
const PROBED_EFFORT = Object.freeze({
	"agnes-2.0-flash": {
		low: true,
		medium: true,
		high: true,
		xhigh: false,
		max: true
	},
	"agnes-2.5-flash": {
		low: true,
		medium: true,
		high: true,
		xhigh: false,
		max: true
	},
	"agnes-3.0-flash": {
		low: true,
		medium: true,
		high: true,
		xhigh: true,
		max: true
	}
});
function thinkingLevelMapFor(entry) {
	const id = str(entry?.id, "");
	const probed = PROBED_EFFORT[id];
	if (!probed) return {
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null
	};
	return {
		off: "none",
		minimal: null,
		low: probed?.low === true ? "low" : null,
		medium: probed?.medium === true ? "medium" : null,
		high: "high",
		xhigh: probed?.xhigh === true ? "xhigh" : null,
		max: probed?.max === true ? "max" : null
	};
}
/**
* pi-ai's escalation ladder (`EXTENDED_THINKING_LEVELS`, dist/models.js:550).
*
* Exported because it is the authoritative spelling of "every thinking level a
* roster row can name": the panel renders `tt(\`llm.level.${level}\`)`, so its
* `llm.level.*` dictionary keys are a mirror of this ladder and
* `test/render.test.mjs` pins the two sets against each other in BOTH
* directions — a level added here must get a line in each language, and a line
* for a level that no longer exists is a dead key. Without that pin a new level
* rendered as the raw key `llm.level.<name>` (the dictionary lookup misses, and
* the client's `tt` returns the key it was given).
*/
const THINKING_LADDER = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* The thinking levels DSH's selector will actually offer for one model.
*
* This mirrors pi-ai's `getSupportedThinkingLevels` (dist/models.js:551)
* against OUR map: walk the ladder, drop levels the map pins to `null`, and
* treat `xhigh`/`max` as opt-in (they must be present and non-null). DSH
* builds the model-settings effort list through exactly that function, so a
* roster row quoting this list cannot disagree with what the picker lets the
* user select — one contract, both ends. If pi-ai's rule ever changes, this
* filter changes with it (pinned by `test/contract.test.mjs` §6, which compares
* a roster row's levels against this function cell by cell, and by the ladder
* assertions in `test/retry.test.mjs`).
* @param {object} entry - one normalized catalog entry.
* @returns {string[]} level ids in escalation order, e.g. ["off","low",...].
*/
function supportedThinkingLevels(entry) {
	const map = thinkingLevelMapFor(entry);
	return THINKING_LADDER.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== void 0;
		return true;
	});
}
/**
* Map one catalog entry onto the pi-ai model descriptor the adapter offers.
*
* Vision is the SAME identification the snapshot publishes
* (`identifyVisionModel`: the platform's `input_modalities` first, the name
* fallback only when no structured field exists) — so the model picker cannot
* disagree with the panel's vision list about which models accept images.
* @param {object} entry - one normalized catalog entry (must carry `id`).
* @param {object} [options] - wiring.
* @param {string} [options.providerId] - the provider id the descriptor belongs to.
* @param {string} [options.baseUrl] - the OpenAI-compatible base URL.
* @returns {object} the pi-ai descriptor.
*/
function toPiDescriptor(entry, options = {}) {
	const { providerId = LLM_PROVIDER_ID, baseUrl } = options;
	const id = str(entry?.id, "");
	if (id === "") throw new Error("toPiDescriptor: catalog entry has no id");
	const vision = visionOf(entry).vision === true;
	return {
		id,
		name: str(entry.name, id),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: vision ? ["text", "image"] : ["text"],
		reasoning: true,
		thinkingLevelMap: thinkingLevelMapFor(entry),
		cost: { ...NO_COST },
		contextWindow: contextWindowFor(entry),
		maxTokens: PROBED_MAX_TOKENS,
		compat: {
			maxTokensField: "max_tokens",
			supportsDeveloperRole: false
		}
	};
}
/**
* Narrow a catalog to the models the user enabled.
*
* An **empty list means "no filter"**: a fresh install has curated nothing and
* must still be offered every model (the WorkBuddy convention). Once non-empty
* the list is an allow-list; an id that names no current catalog entry is
* harmless — it simply matches nothing this catalog.
* @param {object[]} entries - the normalized catalog entries.
* @param {string[]} [enabledIds] - the allow-list; empty/absent disables it.
* @returns {object[]} the entries still offered, in catalog order.
*/
function filterByEnabled(entries, enabledIds) {
	const list = Array.isArray(enabledIds) ? enabledIds : [];
	if (list.length === 0) return Array.isArray(entries) ? entries : [];
	const allow = new Set(list);
	return (Array.isArray(entries) ? entries : []).filter((entry) => allow.has(str(entry?.id, "")));
}
/**
* Iterate the entries that can be ADDRESSED as chat models.
*
* The shared preamble of both rosters: `isChatModel` (image/video entries answer
* 400 on `/v1/chat/completions`) plus a non-empty `id` (an entry with none could
* not be named on the wire). Yields the id, the display name and the entry, so
* each caller projects only its own extra columns.
* @param {object[]} entries - the normalized catalog entries.
*/
function* chatEntries(entries) {
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!isChatModel(entry)) continue;
		const id = str(entry?.id, "");
		if (id === "") continue;
		yield {
			id,
			name: str(entry?.name, id),
			entry
		};
	}
}
/**
* A "last occurrence wins" collector keyed by `id`.
*
* Both rosters drop duplicate ids exactly the way `catalog-store`'s
* normalization does — the LAST row for an id is the one that survives, at its
* first-seen position — so the rule lives here once instead of being re-derived
* per roster.
*/
function lastWinsById() {
	const position = /* @__PURE__ */ new Map();
	const out = [];
	return {
		put(row) {
			const at = position.get(row.id);
			if (at === void 0) {
				position.set(row.id, out.length);
				out.push(row);
			} else out[at] = row;
		},
		done: () => out
	};
}
/**
* Build the whole descriptor list for one catalog.
*
* Entries without an id are dropped (they could not be addressed on the wire)
* and duplicate ids keep the LAST occurrence, matching the catalog store's
* normalization so the adapter and the persisted catalog can never diverge.
* @param {object[]} entries - the normalized catalog entries.
* @param {object} options - `{ providerId, baseUrl, enabledIds }`.
* @returns {object[]} the pi-ai descriptors, in first-seen order.
*/
function buildDescriptors(entries, options = {}) {
	const { providerId = LLM_PROVIDER_ID, baseUrl, enabledIds = [], unavailableModelIds = [] } = options;
	const blocked = new Set(Array.isArray(unavailableModelIds) ? unavailableModelIds : []);
	const filtered = filterByEnabled(entries, enabledIds).filter(isChatModel);
	const seen = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(filtered) ? filtered : []) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const id = str(entry.id, "");
		if (id === "") continue;
		if (blocked.has(id)) continue;
		if (!seen.has(id)) {
			seen.set(id, out.length);
			out.push(void 0);
		}
		out[seen.get(id)] = toPiDescriptor({
			...entry,
			id
		}, {
			providerId,
			...baseUrl === void 0 ? {} : { baseUrl }
		});
	}
	return out;
}
/**
* The panel-facing roster with per-model availability.
*
* Like {@link rosterOf} it projects one row per chat-model id, but each row also
* carries whether the model is currently callable — the "清单自带识别" the
* provider advertises to the panel. Unlike the PICKER (which drops blocked
* models via `buildDescriptors` so no doomed request is dispatched), the panel
* keeps them in the list, greyed, so the user can see *why* a model is missing
* from the picker rather than wondering where it went.
*
* `blockedIds` is handed IN rather than derived here, because what makes a
* model unavailable is a platform fact, not a roster fact. On Agnes the answer
* is currently always "nothing is blocked": the platform allocates no quota per
* model, and its account-wide request window cannot be read as a remaining
* figure (the console reports cumulative usage, not a balance), so silently
* emptying the picker would hide the models for a reason the panel could not
* explain. Account-level exhaustion is surfaced as a panel line instead.
* @param {object[]} entries - the normalized catalog entries.
* @param {string[]} [blockedIds] - model ids to report as unavailable.
* @returns {{id: string, name: string, vision: boolean, available: boolean, quotaExhausted: boolean, contextWindow: number, maxOutputLength: number, thinkingLevels: string[]}[]}
*/
function rosterWithAvailability(entries, blockedIds = []) {
	const blocked = new Set(Array.isArray(blockedIds) ? blockedIds : []);
	const rows = lastWinsById();
	for (const { id, name, entry } of chatEntries(entries)) rows.put({
		id,
		name,
		vision: visionOf(entry).vision,
		available: !blocked.has(id),
		quotaExhausted: blocked.has(id),
		contextWindow: contextWindowFor(entry),
		maxOutputLength: maxOutputLengthOf(entry),
		thinkingLevels: supportedThinkingLevels(entry)
	});
	return rows.done();
}
/**
* Counts the provider-registration status reports: how many models the catalog
* offered and how many of them accept image input, keyed by the same vision
* identification the descriptors use.
* @param {object[]} entries - the normalized catalog entries.
* @returns {{modelCount: number, visionCount: number, visionIds: string[]}}
*/
function summarizeCatalog(entries) {
	const list = (Array.isArray(entries) ? entries : []).filter(isChatModel);
	const visionIds = list.filter((entry) => str(entry?.id, "") !== "").filter((entry) => visionOf(entry).vision === true).map((entry) => str(entry?.id, ""));
	return {
		modelCount: list.filter((entry) => str(entry?.id, "") !== "").length,
		visionCount: visionIds.length,
		visionIds
	};
}

//#endregion
export { obj as A, isAdmitted as C, num as D, resolveSettings as E, str as F, verbatim as I, redactError as M, redactSecrets as N, numOrNull$1 as O, retryBounded as P, inject as S, resolveAuthOverrides as T, parseUsageSeries as _, buildDescriptors as a, CONFIG_DEFAULTS as b, summarizeCatalog as c, isVideoGenModel as d, checkShape as f, parseUsageOverview as g, parseSubscriptionUsage as h, PROBED_VISION as i, pluginError as j, numZeroOk as k, visionOf as l, parsePlans as m, LLM_DISPLAY_NAME as n, filterByEnabled as o, matchCurrentPlan as p, LLM_PROVIDER_ID as r, rosterWithAvailability as s, DEFAULT_REASONING_EFFORT as t, isImageGenModel as u, quotaWindows as v, name as w, hostName as x, readSubscriptionExpiry as y };