/**
 * Unit checks for the AgnesCode "third upstream provider" (ROADMAP §6.3) —
 * the PEER-FREE layers only:
 *
 * - `agnescode.ts`: the protocol half (the pinned BFF base, the session
 *   parser, the `/v1`-less API root, the JWT exp decode, the header map, the
 *   os_crypt blob decrypt, the Local State key unwrap, the harvest walk's
 *   per-file tiers, the catalogue/balance fetchers, the 7-model fallback
 *   roster);
 * - `agnescode-store.ts`: the DSH-credentials reference store (save / forget /
 *   resolve, the base-without-token refusal, the secret-free state);
 * - `agnescode-models.ts`: roster → pi-ai descriptor mapping (the per-account
 *   base rides the descriptor, `reasoning:false`, the memberOnly badge, the
 *   no-multiplier honesty);
 * - `agnescode-publish.ts`: the third, independent publisher (the switch-off /
 *   no-token / register path, the base in the signature, the `disposed` gate,
 *   the rollback on failure);
 * - `agnescode-switch-store.ts`: the opt-in file-backed switch (atomic
 *   round-trip, version rejection);
 * - the client surface: `AgnescodeRoster` mounted through the shipped bundle's
 *   own test surface (row shape + memberOnly badge, hook-free).
 *
 * The decrypt fixtures are real AES-256-GCM round-trips built in-test with a
 * FIXED key; the DPAPI call is injected, so nothing here touches a real
 * `Local State` or spawns PowerShell. Nothing imports a Host peer; the
 * peer-dependent `agnescode-llm-adapter.ts` is exercised in wiring/e2e.
 */
import {
  trustAgnescodeBffBase,
  parseAgnescodeSession,
  agnescodeApiRoot,
  decodeAgnescodeJwtExpMs,
  agnescodeHeaders,
  decryptAgnescodeSessionBlob,
  unwrapAgnescodeLocalStateKey,
  harvestAgnescodeLocalSession,
  fetchAgnescodeCatalog,
  fetchAgnescodeBalance,
  AGNESCODE_FALLBACK_MODELS,
  AGNESCODE_HARVEST_TIER
} from "../src/host/agnescode.ts";
import {
  createAgnescodeStore,
  parseAgnescodeCredential,
  serializeAgnescodeCredential,
  AGNESCODE_CREDENTIAL_REF
} from "../src/host/agnescode-store.ts";
import {
  AGNESCODE_PROVIDER_ID,
  AGNESCODE_DISPLAY_NAME,
  agnescodeRoster,
  agnescodeToDescriptor,
  buildAgnescodeDescriptors,
  agnescodeRequestHeaders
} from "../src/host/agnescode-models.ts";
import { createAgnescodePublisher, agnescodeSignature } from "../src/host/agnescode-publish.ts";
import { createFileAgnescodeStore, normalizeAgnescodeEnabled, AGNESCODE_SWITCH_VERSION } from "../src/host/agnescode-switch-store.ts";
import { installNetworkGuard } from "./peer-roots.mjs";
import { surface as clientSurface } from "./client-surface.js";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}
function section(title) {
  console.log(`\n— ${title}`);
}

/** The fixed os_crypt key every decrypt fixture in this file uses. */
const FIXTURE_KEY = randomBytes(32);

/**
 * Build one in-test encrypted session blob (the shape the desktop App writes:
 * `v10` prefix + AES-256-GCM with a 12-byte nonce and a 16-byte tag).
 * @param {object|string} session - the plaintext session document.
 * @returns {Buffer} the blob.
 */
function encryptSessionBlob(session) {
  const plain = Buffer.from(typeof session === "string" ? session : JSON.stringify(session), "utf8");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", FIXTURE_KEY, nonce);
  const head = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), nonce, head, cipher.getAuthTag()]);
}

/** A syntactically-valid JWT whose `exp` sits `hours` ahead of now. */
function makeJwt(hours = 24 * 28) {
  const payload = Buffer.from(JSON.stringify({ sub: "u", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + hours * 3600 })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.c2ln`;
}

const GOOD_SESSION = {
  accessToken: makeJwt(),
  userInfo: { id: "4d1a2b3c-0000-0000-0000-000000000001", username: "测试用户", auth_provider: "wechat", app_id: "agnes", is_active: true },
  newapiReady: true,
  bffPublicBaseUrl: "https://api-agnes-code.agnes-ai.cn/v1"
};

// --- 1. protocol layer -------------------------------------------------------
{
  section("protocol layer (agnescode.ts)");
  try {
    // The base pin: the ONLY hosts the stored token may be aimed at.
    check("the CN BFF base is accepted and normalized",
      trustAgnescodeBffBase("https://api-agnes-code.agnes-ai.cn/v1/") === "https://api-agnes-code.agnes-ai.cn/v1",
      String(trustAgnescodeBffBase("https://api-agnes-code.agnes-ai.cn/v1/")));
    check("the international sibling host is accepted",
      trustAgnescodeBffBase("https://api-agnes-code.agnes-ai.com/v1") !== null);
    check("plain-text http is refused (TLS is the only transport here)",
      trustAgnescodeBffBase("http://api-agnes-code.agnes-ai.cn/v1") === null);
    check("a foreign host is refused even over https",
      trustAgnescodeBffBase("https://evil.example.com/v1") === null);
    check("a look-alike suffix is refused (not endsWith alone)",
      trustAgnescodeBffBase("https://api-agnes-code.agnes-ai.cn.evil.com/v1") === null);
    check("a non-default port is refused (a hostile file must not aim the token at a listener)",
      trustAgnescodeBffBase("https://api-agnes-code.agnes-ai.cn:8443/v1") === null);
    check("a non-URL and an empty value are refused",
      trustAgnescodeBffBase("not a url") === null && trustAgnescodeBffBase("") === null);

    // The API root: the credits endpoint lives OUTSIDE /v1 — a caller that
    // concatenates the full base would 404.
    check("the api root strips the /v1 suffix",
      agnescodeApiRoot("https://api-agnes-code.agnes-ai.cn/v1") === "https://api-agnes-code.agnes-ai.cn",
      agnescodeApiRoot("https://api-agnes-code.agnes-ai.cn/v1"));
    check("a non-/v1 prefix is preserved verbatim",
      agnescodeApiRoot("https://api-agnes-code.agnes-ai.cn/v2/x") === "https://api-agnes-code.agnes-ai.cn/v2/x");

    // The session parser: only the four fields the store needs survive.
    const session = parseAgnescodeSession(GOOD_SESSION);
    check("a well-formed session parses to token + user + base",
      session !== null && session.accessToken === GOOD_SESSION.accessToken
      && session.userId === GOOD_SESSION.userInfo.id && session.nickname === GOOD_SESSION.userInfo.username
      && session.bffBase === "https://api-agnes-code.agnes-ai.cn/v1",
      JSON.stringify(session === null ? null : { ...session, accessToken: "<len>" }));
    check("a session without a token parses as null", parseAgnescodeSession({ bffPublicBaseUrl: GOOD_SESSION.bffPublicBaseUrl }) === null);
    check("a session with a foreign base parses as null (never aimed off-family)",
      parseAgnescodeSession({ ...GOOD_SESSION, accessToken: "t", bffPublicBaseUrl: "https://evil.example.com/v1" }) === null);
    check("a session with no base parses as null (a guessed base aims the token wrong)",
      parseAgnescodeSession({ accessToken: "t" }) === null);

    check("the JWT exp decodes to milliseconds",
      Math.abs(decodeAgnescodeJwtExpMs(makeJwt(24)) - (Date.now() + 24 * 3600 * 1000)) < 5000);
    check("a non-JWT decodes as undefined", decodeAgnescodeJwtExpMs("garbage") === undefined);

    // The header map: the catalogue gates are REQUIRED on /v1/models.
    const headers = agnescodeHeaders({ accessToken: "tok" });
    check("the headers carry the bearer token", headers.Authorization === "Bearer tok");
    check("the headers carry the catalogue gates", headers["X-App-Id"] === "1" && headers["X-Platform"] === "1");
    check("the headers carry the desktop client's language", headers["X-User-Language"] === "zh-Hans");

    // The os_crypt blob: a real round-trip, plus the two wrong-input refusals.
    const blob = encryptSessionBlob(GOOD_SESSION);
    const plain = decryptAgnescodeSessionBlob(blob, FIXTURE_KEY);
    check("a real AES-256-GCM blob round-trips", JSON.parse(plain.toString("utf8")).bffPublicBaseUrl === GOOD_SESSION.bffPublicBaseUrl);
    let threw = "";
    try { decryptAgnescodeSessionBlob(blob, randomBytes(32)); } catch (why) { threw = why.message; }
    check("a wrong key fails the auth tag (loud, not silent)", threw.includes("auth"), threw);
    threw = "";
    try { decryptAgnescodeSessionBlob(Buffer.from("v12xxxx"), FIXTURE_KEY); } catch (why) { threw = why.message; }
    check("an unknown blob prefix is refused", threw.includes("prefix"), threw);
    threw = "";
    try { decryptAgnescodeSessionBlob(blob, randomBytes(16)); } catch (why) { threw = why.message; }
    check("a non-256-bit key is refused", threw.includes("32 bytes"), threw);

    // The Local State unwrap: the DPAPI prefix and the injected call.
    const wrappedKey = Buffer.concat([Buffer.from("DPAPI", "latin1"), randomBytes(32)]);
    const unwrapped = await unwrapAgnescodeLocalStateKey({ os_crypt: { encrypted_key: wrappedKey.toString("base64") } }, async (w) => {
      check("the unwrap strips the DPAPI prefix before the DPAPI call", w.length === 32);
      return FIXTURE_KEY;
    });
    check("the unwrapped key is what the decryptor receives", Buffer.compare(unwrapped, FIXTURE_KEY) === 0);
    threw = "";
    try { await unwrapAgnescodeLocalStateKey({ os_crypt: {} }, async () => FIXTURE_KEY); } catch (why) { threw = why.message; }
    check("a Local State without the key throws (mapped to no_key)", threw.includes("encrypted_key"), threw);
    threw = "";
    try { await unwrapAgnescodeLocalStateKey({ os_crypt: { encrypted_key: Buffer.from("XXXXXbad").toString("base64") } }, async () => FIXTURE_KEY); } catch (why) { threw = why.message; }
    check("a non-DPAPI prefix throws before any DPAPI call", threw.includes("DPAPI"), threw);
  } catch (error) {
    fail("protocol layer", error);
  }
}

// --- 2. the harvest walk -----------------------------------------------------
{
  section("harvest walk (per-file tier diagnosis)");
  try {
    // A fake app directory with the real file layout the harvest expects:
    // `<APPDATA>/AgnesCode/{code-auth-session.cn.v1, Local State}`.
    const root = mkdtempSync(join(tmpdir(), "agnescode-harvest-"));
    const dir = join(root, "AgnesCode");
    mkdirSync(dir, { recursive: true });
    const blob = encryptSessionBlob(GOOD_SESSION);
    writeFileSync(join(dir, "code-auth-session.cn.v1"), blob);
    writeFileSync(join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), randomBytes(32)]).toString("base64") } }));

    const io = {
      env: { APPDATA: root },
      platform: "win32",
      readFile: async (path) => {
        const { readFile } = await import("node:fs/promises");
        return readFile(path);
      },
      readDir: async (path) => {
        const { readdir } = await import("node:fs/promises");
        return readdir(path);
      },
      dpapiUnprotect: async () => FIXTURE_KEY
    };

    const happy = await harvestAgnescodeLocalSession(io);
    check("a logged-in App harvests the session",
      happy.ok === true && happy.session.bffBase === "https://api-agnes-code.agnes-ai.cn/v1"
      && happy.session.userId === GOOD_SESSION.userInfo.id,
      JSON.stringify(happy.attempts));
    check("the winning attempt's row carries a SHAPE fact, not the token",
      happy.attempts.at(-1)?.tier === AGNESCODE_HARVEST_TIER.OK
      && JSON.stringify(happy.attempts).includes(GOOD_SESSION.accessToken) === false);

    // Tier: the App directory absent entirely.
    const missing = await harvestAgnescodeLocalSession({ ...io, env: { APPDATA: join(dir, "nope") } });
    check("an absent App directory reads as file_missing",
      missing.ok === false && missing.attempts[0]?.tier === AGNESCODE_HARVEST_TIER.FILE_MISSING,
      JSON.stringify(missing.attempts));

    // Tier: the session file there but the sibling Local State gone.
    const rootNoKey = mkdtempSync(join(tmpdir(), "agnescode-nokey-"));
    const dirNoKey = join(rootNoKey, "AgnesCode");
    mkdirSync(dirNoKey, { recursive: true });
    writeFileSync(join(dirNoKey, "code-auth-session.cn.v1"), blob);
    const noKey = await harvestAgnescodeLocalSession({ ...io, env: { APPDATA: rootNoKey } });
    check("a missing Local State reads as no_key (the App is here, its crypto is not)",
      noKey.ok === false && noKey.attempts[0]?.tier === AGNESCODE_HARVEST_TIER.NO_KEY,
      JSON.stringify(noKey.attempts));

    // Tier: the key unwraps but does not decrypt (wrong key / changed crypto).
    const decryptFailed = await harvestAgnescodeLocalSession({ ...io, dpapiUnprotect: async () => randomBytes(32) });
    check("a wrong key reads as decrypt_failed, not as no session",
      decryptFailed.ok === false && decryptFailed.attempts[0]?.tier === AGNESCODE_HARVEST_TIER.DECRYPT_FAILED,
      JSON.stringify(decryptFailed.attempts));

    // Tier: decrypts fine but the session carries no token (App signed out).
    const rootNoToken = mkdtempSync(join(tmpdir(), "agnescode-notok-"));
    const dirNoToken = join(rootNoToken, "AgnesCode");
    mkdirSync(dirNoToken, { recursive: true });
    writeFileSync(join(dirNoToken, "code-auth-session.cn.v1"), encryptSessionBlob({ bffPublicBaseUrl: GOOD_SESSION.bffPublicBaseUrl }));
    writeFileSync(join(dirNoToken, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), randomBytes(32)]).toString("base64") } }));
    const noToken = await harvestAgnescodeLocalSession({ ...io, env: { APPDATA: rootNoToken } });
    check("a signed-out session reads as no_token",
      noToken.ok === false && noToken.attempts[0]?.tier === AGNESCODE_HARVEST_TIER.NO_TOKEN,
      JSON.stringify(noToken.attempts));

    // Tier: decrypts fine but the base points off-family — refused, not used.
    const rootEvil = mkdtempSync(join(tmpdir(), "agnescode-evil-"));
    const dirEvil = join(rootEvil, "AgnesCode");
    mkdirSync(dirEvil, { recursive: true });
    writeFileSync(join(dirEvil, "code-auth-session.cn.v1"), encryptSessionBlob({ ...GOOD_SESSION, bffPublicBaseUrl: "https://evil.example.com/v1" }));
    writeFileSync(join(dirEvil, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), randomBytes(32)]).toString("base64") } }));
    const evil = await harvestAgnescodeLocalSession({ ...io, env: { APPDATA: rootEvil } });
    check("a hostile base reads as untrusted_base (the token never goes there)",
      evil.ok === false && evil.attempts[0]?.tier === AGNESCODE_HARVEST_TIER.UNTRUSTED_BASE,
      JSON.stringify(evil.attempts));

    // Tier: an unknown platform with no candidate layout at all — now an
    // up-front refusal, because non-Windows harvest paths are unimplemented
    // (a walk there would show a misleading `no_key`).
    const unknownPlatform = await harvestAgnescodeLocalSession({ ...io, platform: "sunos" });
    check("an unknown platform reads as unsupported_platform",
      unknownPlatform.ok === false && unknownPlatform.attempts[0]?.tier === AGNESCODE_HARVEST_TIER.UNSUPPORTED_PLATFORM,
      JSON.stringify(unknownPlatform.attempts));
    const darwin = await harvestAgnescodeLocalSession({ ...io, platform: "darwin", env: { HOME: root } });
    check("macOS reads as unsupported_platform too (state.vscdb variant unimplemented)",
      darwin.ok === false && darwin.attempts[0]?.tier === AGNESCODE_HARVEST_TIER.UNSUPPORTED_PLATFORM,
      JSON.stringify(darwin.attempts));

    // Tier: the file is there but the reader cannot open it (permissions).
    const rootUnreadable = mkdtempSync(join(tmpdir(), "agnescode-unread-"));
    const dirUnreadable = join(rootUnreadable, "AgnesCode");
    mkdirSync(dirUnreadable, { recursive: true });
    // The file exists on disk (readDir is the real readdir) but the injected
    // reader refuses it — the walk must tell the tiers apart.
    writeFileSync(join(dirUnreadable, "code-auth-session.cn.v1"), blob);
    const unreadable = await harvestAgnescodeLocalSession({
      ...io,
      env: { APPDATA: rootUnreadable },
      readFile: async (path) => {
        if (String(path).endsWith(".v1")) throw new Error("EACCES: permission denied");
        return (await import("node:fs/promises")).readFile(path);
      }
    });
    check("an unreadable session file reads as unreadable, not file_missing",
      unreadable.ok === false && unreadable.attempts[0]?.tier === AGNESCODE_HARVEST_TIER.UNREADABLE,
      JSON.stringify(unreadable.attempts));

    // Tier: decrypts fine but the plaintext is not JSON (shape drift).
    const rootMalformed = mkdtempSync(join(tmpdir(), "agnescode-malformed-"));
    const dirMalformed = join(rootMalformed, "AgnesCode");
    mkdirSync(dirMalformed, { recursive: true });
    writeFileSync(join(dirMalformed, "code-auth-session.cn.v1"), encryptSessionBlob("this is not json"));
    writeFileSync(join(dirMalformed, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), randomBytes(32)]).toString("base64") } }));
    const malformed = await harvestAgnescodeLocalSession({ ...io, env: { APPDATA: rootMalformed } });
    check("non-JSON plaintext reads as malformed",
      malformed.ok === false && malformed.attempts[0]?.tier === AGNESCODE_HARVEST_TIER.MALFORMED,
      JSON.stringify(malformed.attempts));

    // Order: the CN build wins over another region variant in the same dir.
    const rootTwo = mkdtempSync(join(tmpdir(), "agnescode-two-"));
    const dirTwo = join(rootTwo, "AgnesCode");
    mkdirSync(dirTwo, { recursive: true });
    writeFileSync(join(dirTwo, "code-auth-session.v1"), encryptSessionBlob({ ...GOOD_SESSION, accessToken: "other-variant-token" }));
    writeFileSync(join(dirTwo, "code-auth-session.cn.v1"), blob);
    writeFileSync(join(dirTwo, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), randomBytes(32)]).toString("base64") } }));
    const two = await harvestAgnescodeLocalSession({ ...io, env: { APPDATA: rootTwo } });
    check("the CN session file is tried first",
      two.ok === true && two.session.userId === GOOD_SESSION.userInfo.id,
      JSON.stringify(two.attempts.map((a) => a.file)));

    rmSync(root, { recursive: true, force: true });
    rmSync(rootNoKey, { recursive: true, force: true });
    rmSync(rootNoToken, { recursive: true, force: true });
    rmSync(rootEvil, { recursive: true, force: true });
    rmSync(rootTwo, { recursive: true, force: true });
    rmSync(rootUnreadable, { recursive: true, force: true });
    rmSync(rootMalformed, { recursive: true, force: true });
  } catch (error) {
    fail("harvest walk", error);
  }
}

// --- 3. fetchers -------------------------------------------------------------
{
  section("catalogue + balance fetchers (stubbed fetch)");
  try {
    const credential = { accessToken: "tok", bffBase: "https://api-agnes-code.agnes-ai.cn/v1" };
    const rows = [
      { id: "agnes-3.0-flash", model_type: "text", max_input_tokens: 512000, max_output_tokens: 65536, is_member_only: false, supported_endpoint_types: ["openai"] },
      { id: "kimi-k3", model_type: "text", max_input_tokens: 1048576, max_output_tokens: 131072, is_member_only: true },
      { id: "dup", model_type: "text", max_input_tokens: 1, max_output_tokens: 1 },
      { id: "dup", model_type: "text", max_input_tokens: 1, max_output_tokens: 1 },
      { id: "media-x", model_type: "video", max_input_tokens: 1, max_output_tokens: 1 }
    ];
    const fetchJson = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    const catalog = await fetchAgnescodeCatalog(credential, fetchJson({ data: rows }));
    check("the catalogue normalizes to the roster shape with memberOnly kept",
      catalog?.length === 3 && catalog[0].id === "agnes-3.0-flash" && catalog[0].memberOnly === false
      && catalog[1].memberOnly === true && catalog[1].contextWindow === 1048576,
      JSON.stringify(catalog));
    // The /v1 suffix rides the per-account base; a drift here would 404 the
    // whole provider against a silently different endpoint (the balance probe
    // pins its own URL below — this one pins the catalogue's).
    let catalogUrl = "";
    await fetchAgnescodeCatalog(credential, async (url) => {
      catalogUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ data: rows }) };
    });
    check("the catalogue addresses {per-account base}/models exactly",
      catalogUrl === "https://api-agnes-code.agnes-ai.cn/v1/models", catalogUrl);
    check("vision stays false — the rows declare no image modality (never invented)",
      catalog.every((row) => row.vision === false));
    check("a non-text model_type is dropped, a duplicate id deduped",
      !catalog.some((row) => row.id === "media-x") && catalog.filter((row) => row.id === "dup").length === 1);
    check("a non-200 catalogue reads as null", await fetchAgnescodeCatalog(credential, fetchJson({}, 503)) === null);
    check("a foreign base reads as null before any request", await fetchAgnescodeCatalog({ accessToken: "t", bffBase: "https://evil.example.com/v1" }, fetchJson({ data: rows })) === null);

    const balance = await fetchAgnescodeBalance(credential, fetchJson({ code: "000000", message: "success", data: { total_balance: 1200, time_sensitive_balance: 1200, permanent_balance: 0, subscription_credits: 0, daily_free_credits: 0, level: 0 } }));
    check("the balance maps the subscription-pool envelope",
      balance?.totalBalance === 1200 && balance?.timeSensitiveBalance === 1200 && balance?.permanentBalance === 0,
      JSON.stringify(balance));
    check("a refused balance envelope reads as null",
      await fetchAgnescodeBalance(credential, fetchJson({ code: "400000", message: "no" })) === null);
    check("a balance without a total reads as null",
      await fetchAgnescodeBalance(credential, fetchJson({ code: "000000", data: {} })) === null);

    // The balance URL must address the ORIGIN-scoped /api path, not /v1.
    let calledUrl = "";
    await fetchAgnescodeBalance(credential, async (url) => {
      calledUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ code: "000000", data: { total_balance: 1 } }) };
    });
    check("the balance endpoint lives OUTSIDE the /v1 prefix",
      calledUrl === "https://api-agnes-code.agnes-ai.cn/api/v2/subscription/credits-balance", calledUrl);
  } catch (error) {
    fail("fetchers", error);
  }
}

// --- 4. fallback roster ------------------------------------------------------
{
  section("fallback roster");
  try {
    check("the fallback roster carries the seven probed models", AGNESCODE_FALLBACK_MODELS.length === 7);
    check("the ids are unique", new Set(AGNESCODE_FALLBACK_MODELS.map((row) => row.id)).size === 7);
    check("member gating is stated, never guessed", AGNESCODE_FALLBACK_MODELS.every((row) => typeof row.memberOnly === "boolean"));
    check("every row declares a positive window (pi-ai does arithmetic on it)",
      AGNESCODE_FALLBACK_MODELS.every((row) => row.contextWindow > 0 && row.maxOutputLength > 0));
  } catch (error) {
    fail("fallback roster", error);
  }
}

// --- 5. credential store -----------------------------------------------------
{
  section("credential store (agnescode-store.ts)");
  try {
    const saved = [];
    const service = {
      async set(ref, value) { saved.push({ ref, value }); },
      async resolve(ref) { return saved.find((entry) => entry.ref === ref) ?? undefined; },
      async unset(ref) { const i = saved.findIndex((entry) => entry.ref === ref); if (i >= 0) saved.splice(i, 1); }
    };
    const store = createAgnescodeStore({ credentials: () => service });
    const credential = { accessToken: makeJwt(), bffBase: "https://api-agnes-code.agnes-ai.cn/v1", userId: "u1", nickname: "测试用户" };

    let threw = "";
    try { await store.save({ accessToken: "t" }); } catch (why) { threw = why.message; }
    check("a save without the per-account base is refused (the base aims the token)", threw.includes("base"), threw);
    threw = "";
    try { await store.save({ bffBase: "https://api-agnes-code.agnes-ai.cn/v1" }); } catch (why) { threw = why.message; }
    check("a save without a token is refused", threw.includes("token"), threw);

    await store.save(credential);
    check("the credential lands under the plugin's own reference name",
      saved.length === 1 && saved[0].ref === AGNESCODE_CREDENTIAL_REF);
    check("the serialized form carries no plaintext user object (only the four fields)",
      !saved[0].value.includes("auth_provider") && !saved[0].value.includes("avatar"));
    const round = parseAgnescodeCredential(saved[0].value);
    check("the serialized credential round-trips",
      round?.accessToken === credential.accessToken && round?.bffBase === credential.bffBase
      && typeof round?.expiresAtMs === "number",
      JSON.stringify(round === null ? null : { ...round, accessToken: "<len>" }));

    const resolved = await store.resolve();
    check("the service answer wins the precedence", resolved.source === "credentials" && resolved.credential !== null);
    const state = await store.state();
    check("the secret-free state carries nickname + base + expiry, never the token",
      state.hasCredential === true && state.nickname === "测试用户"
      && state.bffBase === credential.bffBase && JSON.stringify(state).includes(credential.accessToken) === false,
      JSON.stringify(state));
    check("a fresh 28-day credential is not expired", await store.isExpired() === false);

    await store.forget();
    check("forget clears both the service and the memory", (await store.resolve()).credential === null);

    // Ephemeral Host: no credentials service → memory only.
    const memoryOnly = createAgnescodeStore({});
    await memoryOnly.save(credential);
    const ephemeral = await memoryOnly.resolve();
    check("a Host without the credentials service keeps the credential in memory",
      ephemeral.source === "memory" && (await memoryOnly.state()).ephemeral === true);

    check("a malformed stored value reads as no credential (never a crash)",
      parseAgnescodeCredential("{not json") === null && parseAgnescodeCredential(undefined) === null);
    check("a serialized credential without a base parses as null",
      parseAgnescodeCredential(JSON.stringify({ version: 1, access_token: "t" })) === null);
  } catch (error) {
    fail("credential store", error);
  }
}

// --- 6. roster → descriptors -------------------------------------------------
{
  section("roster → pi-ai descriptors (agnescode-models.ts)");
  try {
    check("the provider id groups the SenseNova family", AGNESCODE_PROVIDER_ID === "sensenova-agnescode");
    check("the display name is the picker's own label", AGNESCODE_DISPLAY_NAME === "SenseNova AgnesCode");

    const rows = agnescodeRoster(null);
    check("a null catalogue falls back to the probed roster", rows.length === AGNESCODE_FALLBACK_MODELS.length);
    const live = [{ id: "live-x", name: "Live X", memberOnly: false, contextWindow: 1000, maxOutputLength: 100 }];
    check("a live catalogue beats the fallback", agnescodeRoster(live)[0].id === "live-x");
    check("a live row without a multiplier stays multiplier-less (no invented rate)",
      agnescodeRoster(live)[0].multiplier === undefined);

    const descriptor = agnescodeToDescriptor(rows[0], { bffBase: "https://api-agnes-code.agnes-ai.cn/v1" });
    check("the descriptor's baseUrl is the PER-ACCOUNT base, not a constant",
      descriptor.baseUrl === "https://api-agnes-code.agnes-ai.cn/v1");
    check("the descriptor pins the same OpenAI-compat family fixes as the Token Plan route",
      descriptor.compat?.maxTokensField === "max_tokens" && descriptor.compat?.supportsDeveloperRole === false);
    check("a text-only row offers text only", JSON.stringify(descriptor.input) === '["text"]');
    check("reasoning is false in v1 (the thinking wire channel is unverified)",
      descriptor.reasoning === false);
    check("the descriptor headers carry the catalogue gates",
      agnescodeRequestHeaders()["X-App-Id"] === "1" && agnescodeRequestHeaders()["X-Platform"] === "1");
    check("the cost is the zero sentinel (credit-gated, per-token prices unknowable)",
      descriptor.cost.input === 0 && descriptor.cost.output === 0);

    let threw = "";
    try { agnescodeToDescriptor({ id: "x" }, {}); } catch (why) { threw = why.message; }
    check("a descriptor without a pinned base is a type error, not a guessed URL", threw.includes("bffBase"), threw);
    threw = "";
    try { agnescodeToDescriptor({ name: "no id" }, { bffBase: "https://api-agnes-code.agnes-ai.cn/v1" }); } catch (why) { threw = threw || why.message; }
    check("a row without an id is a type error", threw.includes("id"), threw);

    const built = buildAgnescodeDescriptors([...rows, rows[0]], { bffBase: "https://api-agnes-code.agnes-ai.cn/v1" });
    check("the builder dedupes by id", built.length === rows.length);
  } catch (error) {
    fail("descriptors", error);
  }
}

// --- 7. publisher ------------------------------------------------------------
{
  section("third publisher (agnescode-publish.ts)");
  try {
    const rows = agnescodeRoster(null);
    const base = "https://api-agnes-code.agnes-ai.cn/v1";
    const makeLlm = () => {
      const calls = [];
      return {
        calls,
        async registerAdapter(ids, adapter) { calls.push(["adapter", ...ids]); return () => calls.push(["release-adapter"]); },
        registerConfigurableProviders(list) { calls.push(["directory", list[0].provider]); return () => calls.push(["release-directory"]); }
      };
    };
    const makeFactory = () => async (options) => ({
      adapter: { token: options.resolveToken, base: options.bffBase },
      providerIds: [AGNESCODE_PROVIDER_ID]
    });
    // The publisher imports a MODULE (defaulting to the real adapter file) and
    // reads `createAgnescodeAdapter` off it — so the stub returns that shape.
    const adapterModule = () => async () => ({ createAgnescodeAdapter: makeFactory() });

    // Switch OFF: nothing registers (opt-in default OFF).
    const llmOff = makeLlm();
    const off = createAgnescodePublisher({ panelSwitch: async () => false, getLlm: () => llmOff, loadAdapterModule: adapterModule(), resolveToken: async () => "t" });
    const offResult = await off.publish(rows, base);
    check("a switch-off publish skips without registering", offResult.skipped === true && llmOff.calls.length === 0);

    // Switch ON, no token: a clean release with the not_configured reason.
    const llmNoToken = makeLlm();
    const noToken = createAgnescodePublisher({ panelSwitch: async () => true, getLlm: () => llmNoToken, loadAdapterModule: adapterModule(), resolveToken: async () => "" });
    const noTokenResult = await noToken.publish(rows, base);
    check("a tokenless publish degrades to not_configured (the panel says so)",
      noTokenResult.skipped === true && noToken.state.error === "not_configured" && llmNoToken.calls.length === 0);

    // Switch ON + token + base: register through the factory.
    const llm = makeLlm();
    const publisher = createAgnescodePublisher({ panelSwitch: async () => true, getLlm: () => llm, loadAdapterModule: adapterModule(), resolveToken: async () => "live-token" });
    const okResult = await publisher.publish(rows, base);
    check("a configured publish registers the adapter + directory pair",
      okResult.ok === true && publisher.state.registered === true
      && llm.calls.some((c) => c[0] === "adapter") && llm.calls.some((c) => c[0] === "directory" && c[1] === AGNESCODE_PROVIDER_ID),
      JSON.stringify(llm.calls));
    check("the factory received the per-account base",
      publisher.state.built?.adapter?.base === base);
    check("the state records the offered rows and base",
      publisher.state.rows.length === rows.length && publisher.state.bffBase === base);

    // A re-harvest that lands on another base must rebuild (signature covers it).
    check("the signature covers the base, so a base change rebuilds",
      agnescodeSignature(rows, base) !== agnescodeSignature(rows, "https://api-agnes-code.agnes-ai.com/v1")
      && agnescodeSignature(rows, base) === agnescodeSignature([...rows], base));

    // Rollback: a failed registration restores the previous pair.
    const failingLlm = makeLlm();
    let calls = 0;
    const failing = createAgnescodePublisher({
      panelSwitch: async () => true,
      getLlm: () => failingLlm,
      loadAdapterModule: async () => ({
        createAgnescodeAdapter: async () => {
          calls += 1;
          if (calls === 1) return { adapter: { v: 1 }, providerIds: [AGNESCODE_PROVIDER_ID] };
          throw new Error("boom");
        }
      }),
      resolveToken: async () => "t"
    });
    await failing.publish(rows, base);
    const failedResult = await failing.publish(rows, base);
    check("a failed build keeps the previous registration live (rollback)",
      failedResult.ok === false && failing.state.registered === true && failing.state.built?.adapter?.v === 1,
      JSON.stringify({ error: failing.state.error }));

    // The disposed gate: a late publish never registers.
    const disposedLlm = makeLlm();
    const disposed = createAgnescodePublisher({ panelSwitch: async () => true, getLlm: () => disposedLlm, loadAdapterModule: adapterModule(), resolveToken: async () => "t" });
    disposed.dispose();
    const disposedResult = await disposed.publish(rows, base);
    check("a disposed publisher skips every later publish",
      disposedResult.skipped === true && disposed.isDisposed() === true && disposedLlm.calls.length === 0);

    // A factory returning garbage is an error, not a broken registration.
    const garbageLlm = makeLlm();
    const garbage = createAgnescodePublisher({ panelSwitch: async () => true, getLlm: () => garbageLlm, loadAdapterModule: async () => (async () => ({ nope: true })), resolveToken: async () => "t" });
    const garbageResult = await garbage.publish(rows, base);
    check("a shape-violating factory records the error secret-free",
      garbageResult.ok === false && garbage.state.registered === false
      && JSON.stringify(garbage.state.error ?? "").includes("token") === false,
      String(garbage.state.error));
  } catch (error) {
    fail("publisher", error);
  }
}

// --- 8. switch store ---------------------------------------------------------
{
  section("opt-in switch (agnescode-switch-store.ts)");
  try {
    check("the normalizer admits only booleans",
      normalizeAgnescodeEnabled(true) === true && normalizeAgnescodeEnabled(false) === false
      && normalizeAgnescodeEnabled("true") === null && normalizeAgnescodeEnabled(null) === null);

    const dir = mkdtempSync(join(tmpdir(), "agnescode-switch-"));
    const store = createFileAgnescodeStore({ dir, ttlMs: 20 });
    check("an untouched state file reads as null (opt-in default OFF)", await store.enabled() === null && await store.isSet() === false);
    await store.save(true);
    check("a saved switch round-trips", await store.enabled() === true && await store.isSet() === true);
    const second = createFileAgnescodeStore({ dir, ttlMs: 20 });
    check("a second reader sees the saved value", await second.enabled() === true);
    await store.forget();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const third = createFileAgnescodeStore({ dir, ttlMs: 20 });
    check("forget clears the persisted value", await third.enabled() === null && await third.isSet() === false);

    // On-disk parse checks: a mismatched version reads as not set.
    const { writeFileSync } = await import("node:fs");
    const file = join(dir, "agnescode-provider.json");
    writeFileSync(file, JSON.stringify({ version: 999, enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const mismatchedStore = createFileAgnescodeStore({ dir, ttlMs: 20 });
    const mismatchedRead = await mismatchedStore.enabled();
    check("a mismatched version reads as not set", mismatchedRead === null, String(mismatchedRead));
    writeFileSync(file, JSON.stringify({ version: AGNESCODE_SWITCH_VERSION, enabled: true, updatedAt: new Date().toISOString() }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const wellFormedStore = createFileAgnescodeStore({ dir, ttlMs: 20 });
    const wellFormedRead = await wellFormedStore.enabled();
    check("a well-formed versioned payload reads its value", wellFormedRead === true, String(wellFormedRead));
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    fail("switch store", error);
  }
}

// --- 9. client surface -------------------------------------------------------
{
  section("client surface (the shipped bundle's own definitions)");
  try {
    const { AgnescodeRoster, AgnescodeTab } = clientSurface.components ?? clientSurface;
    const { dictionaries } = clientSurface;
    check("the surface exposes the AgnesCode tab + roster", typeof AgnescodeTab === "function" && typeof AgnescodeRoster === "function");

    // The roster mounts hook-free: the two-line row shape shared with the
    // sibling rosters, plus the memberOnly badge this provider declares.
    const tt = (key) => dictionaries.zh[key] ?? key;
    const tree = AgnescodeRoster({ models: [
      { id: "agnes-3.0-flash", name: "Agnes 3.0 Flash", memberOnly: false, contextWindow: 512000, maxOutputLength: 65536 },
      { id: "kimi-k3", name: "Kimi K3", memberOnly: true, contextWindow: 1048576, maxOutputLength: 131072 }
    ], tt });
    const json = JSON.stringify(tree);
    check("the roster renders the member badge for a gated model", json.includes(tt("agnescode.memberOnly")));
    check("the roster renders the count header", json.includes("2"));
    check("the roster carries both model names", json.includes("Agnes 3.0 Flash") && json.includes("Kimi K3"));

    // The tab covers the fourth dictionary key set: every agnescode.* key the
    // tab can render exists in BOTH dictionaries (panel.test pins parity
    // globally; this pins the tab's own consumption).
    const needed = ["tab.agnescode", "agnescode.title", "agnescode.desc", "agnescode.notLogged", "agnescode.harvestFail"];
    check("the zh dictionary covers the tab's keys",
      needed.every((key) => typeof dictionaries.zh[key] === "string" && dictionaries.zh[key] !== ""));

    // The tier values the harvest emits must map onto real dictionary keys in
    // BOTH languages: the tab renders `agnescode.tier.${tier}`, and without
    // this pin a renamed tier would sail through every suite and render as a
    // bare key at runtime.
    const tierValues = Object.values(AGNESCODE_HARVEST_TIER);
    check("every harvest tier has a zh + en tier label",
      tierValues.every((tier) => typeof dictionaries.zh[`agnescode.tier.${tier}`] === "string"
        && dictionaries.zh[`agnescode.tier.${tier}`] !== ""
        && typeof dictionaries.en[`agnescode.tier.${tier}`] === "string"
        && dictionaries.en[`agnescode.tier.${tier}`] !== ""),
      tierValues.filter((tier) => typeof dictionaries.zh[`agnescode.tier.${tier}`] !== "string").join(","));
    check("the dictionary defines no tier label the harvest never emits (no dead keys)",
      !Object.keys(dictionaries.zh).some((key) => key.startsWith("agnescode.tier.")
        && !tierValues.includes(key.slice("agnescode.tier.".length))));
  } catch (error) {
    fail("client surface", error);
  }
}

// --- report ------------------------------------------------------------------
releaseNetworkGuard();
const passed = results.filter((result) => result.pass).length;
const failed = results.filter((result) => !result.pass);
for (const result of failed) {
  console.error(`  FAIL  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}
console.log(`\nagnescode.test.mjs: ${passed}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
