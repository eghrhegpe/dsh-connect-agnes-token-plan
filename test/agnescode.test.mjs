/**
 * Unit checks for the AgnesCode "third upstream provider" (ROADMAP §6.3) —
 * the PEER-FREE layers only:
 *
 * - `agnescode.ts`: the protocol half (the pinned BFF base, the session
 *   parser, the `/v1`-less API root, the JWT exp decode, the header map, the
 *   os_crypt blob decrypt, the Local State key unwrap, the harvest walk's
 *   per-file tiers, the format-drift sentinel (classify + the doctor-side
 *   storage survey), the catalogue/balance fetchers, the 7-model fallback
 *   roster);
 * - `agnescode-store.ts`: the DSH-credentials reference store (save / forget /
 *   resolve, the base-without-token refusal, the secret-free state);
 * - `agnescode-models.ts`: roster → pi-ai descriptor mapping (the per-account
 *   base rides the descriptor, `reasoning:false`, the memberOnly badge, the
 *   no-multiplier honesty);
 * - `agnescode-publish.ts`: the third, independent publisher (the switch-off /
 *   no-token / register path, the per-account base, the `disposed` gate,
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
  classifyAgnescodeSessionFiles,
  surveyAgnescodeStorage,
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
import { createAgnescodePublisher } from "../src/host/agnescode-publish.ts";
import { createFileAgnescodeStore, normalizeAgnescodeEnabled, AGNESCODE_SWITCH_VERSION } from "../src/host/agnescode-switch-store.ts";
import { installNetworkGuard } from "./peer-roots.mjs";
import { surface as clientSurface } from "./client-surface.js";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, so the cross-file fence can read the adapter source by path. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

    // Tier: the App updated and the file family moved on. This is the
    // sentinel for the week-scale silent death: without it an orphan
    // `code-auth-session.cn.v2` reads EXACTLY like「没登录」, while the JWT
    // harvested before the update keeps working for days — nobody notices
    // until the credential dies.
    const rootDrift = mkdtempSync(join(tmpdir(), "agnescode-drift-"));
    const dirDrift = join(rootDrift, "AgnesCode");
    mkdirSync(dirDrift, { recursive: true });
    writeFileSync(join(dirDrift, "code-auth-session.cn.v2"), blob);
    writeFileSync(join(dirDrift, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: "x" } }));
    const drift = await harvestAgnescodeLocalSession({ ...io, env: { APPDATA: rootDrift } });
    check("an orphaned session-family file reads as format_drift, not file_missing",
      drift.ok === false && drift.attempts[0]?.tier === AGNESCODE_HARVEST_TIER.FORMAT_DRIFT
      && String(drift.attempts[0]?.file).endsWith("code-auth-session.cn.v2")
      && String(drift.attempts[0]?.detail).includes("update"),
      JSON.stringify(drift.attempts));
    check("the drift row names the file but carries no session content",
      JSON.stringify(drift.attempts).includes(GOOD_SESSION.accessToken) === false);

    // A strict match suppresses the drift claim: the v1 beside an unknown v2
    // IS harvestable, and the sibling is noise (a backup), not a format fact.
    const rootBoth = mkdtempSync(join(tmpdir(), "agnescode-both-"));
    const dirBoth = join(rootBoth, "AgnesCode");
    mkdirSync(dirBoth, { recursive: true });
    writeFileSync(join(dirBoth, "code-auth-session.cn.v1"), blob);
    writeFileSync(join(dirBoth, "code-auth-session.cn.v2"), blob);
    writeFileSync(join(dirBoth, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), randomBytes(32)]).toString("base64") } }));
    const both = await harvestAgnescodeLocalSession({ ...io, env: { APPDATA: rootBoth } });
    check("a readable v1 next to an unknown v2 harvests with no drift row",
      both.ok === true && both.attempts.every((a) => a.tier !== AGNESCODE_HARVEST_TIER.FORMAT_DRIFT),
      JSON.stringify(both.attempts));

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
    rmSync(rootDrift, { recursive: true, force: true });
    rmSync(rootBoth, { recursive: true, force: true });
    rmSync(rootUnreadable, { recursive: true, force: true });
    rmSync(rootMalformed, { recursive: true, force: true });
  } catch (error) {
    fail("harvest walk", error);
  }
}

// --- 2b. classify + doctor survey (the drift sentinel's offline half) -------
{
  section("session-file classify + storage survey (names only, never crypto)");
  try {
    const classified = classifyAgnescodeSessionFiles(["Local State", "code-auth-session.cn.v2", "code-auth-session.global.v1"]);
    check("the classifier harvests the strict shape and suppresses drift when it wins",
      classified.matched.join() === "code-auth-session.global.v1" && classified.drift.length === 0,
      JSON.stringify(classified));
    const driftOnly = classifyAgnescodeSessionFiles(["Local State", "code-auth-session.v2.bak"]);
    check("with no strict match, family-shaped files read as drift",
      driftOnly.matched.length === 0 && driftOnly.drift.join() === "code-auth-session.v2.bak",
      JSON.stringify(driftOnly));
    const nothing = classifyAgnescodeSessionFiles(["Local State", "Cookies"]);
    check("an unrelated listing is neither matched nor drift",
      nothing.matched.length === 0 && nothing.drift.length === 0);

    const survey = await surveyAgnescodeStorage({
      env: { APPDATA: "/fake" },
      platform: "win32",
      readDir: async (path) => {
        if (String(path).endsWith("AgnesCode")) return ["Local State", "code-auth-session.cn.v1", "code-auth-session.cn.v2"];
        throw new Error("ENOENT");
      }
    });
    check("the survey reports the harvestable file and stays quiet next to a v1",
      survey.surveyed === true && survey.presentDirs === 1
      && survey.sessionFiles.join() === "code-auth-session.cn.v1"
      && survey.driftFiles.length === 0,
      JSON.stringify(survey));
    const surveyDrift = await surveyAgnescodeStorage({
      env: { APPDATA: "/fake" }, platform: "win32",
      readDir: async () => ["code-auth-session.cn.v2", "Local State"]
    });
    check("the survey flags format drift when the family is only unknown shapes",
      surveyDrift.sessionFiles.length === 0 && surveyDrift.driftFiles.join() === "code-auth-session.cn.v2",
      JSON.stringify(surveyDrift));
    const surveyAbsent = await surveyAgnescodeStorage({
      env: { APPDATA: "/nope" }, platform: "win32",
      readDir: async () => { throw new Error("ENOENT"); }
    });
    check("an uninstalled machine reads as presentDirs 0, not as a failed survey",
      surveyAbsent.surveyed === true && surveyAbsent.presentDirs === 0 && surveyAbsent.sessionFiles.length === 0,
      JSON.stringify(surveyAbsent));
    const surveySkip = await surveyAgnescodeStorage({ env: {}, platform: "sunos", readDir: async () => [] });
    check("the survey is honest about unknown platforms (skipped, not zero)",
      surveySkip.surveyed === false && surveySkip.dirsChecked === 0);
  } catch (error) {
    fail("classify + survey", error);
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
    check("the fallback roster carries the eight probed models", AGNESCODE_FALLBACK_MODELS.length === 8);
    check("the ids are unique", new Set(AGNESCODE_FALLBACK_MODELS.map((row) => row.id)).size === 8);
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
    // The id must not enter the `sensenova-` namespace: the sibling plugin
    // `dsh-connect-sensenova-token-plan` registers those ids, and a duplicated
    // id is rejected as DUPLICATE_ADAPTER (one provider would silently
    // vanish). Pinning the literal here is what keeps a stray "sensenova-"
    // rename from reintroducing the collision. The bare product name also
    // keeps the id out of the stuttering `agnes-agnescode` shape a repeated
    // vendor prefix produced.
    check("the provider id is the bare product name, not sensenova- and not agnes-agnescode",
      AGNESCODE_PROVIDER_ID === "agnescode");
    check("the display name is the picker's own label", AGNESCODE_DISPLAY_NAME === "AgnesCode");

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
    check("a text-only row (non-agnes id, no official-doc vision claim) offers text only",
      JSON.stringify(agnescodeToDescriptor(rows.find((r) => r.id === "deepseek-v4-flash") ?? rows[0], { bffBase: "https://api-agnes-code.agnes-ai.cn/v1" }).input) === '["text"]');
    // The Agnes family rows borrow `PROBED_VISION`'s official-doc evidence even
    // though the catalogue itself declares no modality field — same models as
    // the Token Plan gateway, where agnes-3.0-flash accepted the standard
    // OpenAI image_url block live (AGNES-API.md §7.3).
    check("an agnes-family row (agnes-3.0-flash) offers image input from the official-doc table",
      JSON.stringify(descriptor.input) === '["text","image"]', JSON.stringify(descriptor.input));
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

// --- 6b. the vision claim and the adapter wiring must not drift apart -------
// The bug this fences: `agnescode-models.ts` declared `input: ["text","image"]`
// for the Agnes family (borrowed from `PROBED_VISION`), while
// `agnescode-llm-adapter.ts` still had `resolveImageAccess: undefined` — the v1
// state, when no row claimed vision. A message carrying an image then reached
// the durable attachment service with no way to locate the image, and failed
// before the request ever left the machine. The claim (peer-free, checked above)
// and the wiring (peer-dependent, so NOT importable in this suite) live in two
// files with nothing between them; this is that something.
//
// The hooks now live in the shared `pi-ai-adapter-core.ts`, so the fence reads
// BOTH halves: the core must wire them, and the AgnesCode shell must delegate to
// the core. Checking only the core would pass even if this route stopped using
// it; checking only the shell would pass with the hooks deleted from the core.
//
// The requirement is DERIVED, not hardcoded: ask the models layer whether ANY
// descriptor claims image input, and only then require the wiring. If the claim
// ever goes away, the wiring requirement relaxes with it — the fence tracks the
// real invariant ("claim ⟺ wiring"), not a frozen snapshot.
{
  section("vision claim ⟺ adapter image wiring (cross-file)");
  try {
    const bff = "https://api-agnes-code.agnes-ai.cn/v1";
    const anyClaimsVision = agnescodeRoster(null)
      .some((row) => agnescodeToDescriptor(row, { bffBase: bff }).input.includes("image"));
    check("at least one Agnes-family row claims image input (the premise this fence guards)",
      anyClaimsVision === true);

    if (anyClaimsVision) {
      // Read the SOURCE of both halves (they import Host peers, so this suite
      // cannot load them as modules). Strip comments first: the fix's own prose
      // names these hooks, and a fence satisfiable by a comment guards nothing.
      const stripComments = (src) => src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => {
          const i = line.indexOf("//");
          if (i === 0) return ""; // a whole-line comment carries no code
          // An inline `//` that is not part of a `https://` URL starts a comment.
          return i > 0 && line[i - 1] !== ":" ? line.slice(0, i) : line;
        })
        .join("\n");
      // The hooks live in the SHARED assembly core (both routes use one copy),
      // so that is where the wiring is asserted...
      const coreSrc = stripComments(readFileSync(join(ROOT, "src", "host", "pi-ai-adapter-core.ts"), "utf8"));
      // ...and the AgnesCode shell must actually DELEGATE to it, or the claim
      // above would be honored by a file this route never reaches.
      const shellSrc = stripComments(readFileSync(join(ROOT, "src", "host", "agnescode-llm-adapter.ts"), "utf8"));

      check("the AgnesCode shell assembles through the shared adapter core",
        /createWrappedPiAiAdapter\s*\(/.test(shellSrc));
      check("the shared core wires resolveImageAccess to a function, not undefined",
        /resolveImageAccess:\s*\(/.test(coreSrc) && !/resolveImageAccess:\s*undefined/.test(coreSrc));
      check("the shared core wires resolveAttachments",
        /resolveAttachments:\s*\(/.test(coreSrc));
      check("the shared core imports the shared image-access resolver",
        /resolveImageAttachmentAccess/.test(coreSrc));
      // The budgets the Token Plan route pins; without them the profile still
      // defaults, but the two Agnes upstreams would resize images differently.
      check("the shared core pins the same image budgets as the Token Plan route",
        /requestImagePixelBudget/.test(coreSrc) && /maxRequestImageBytes/.test(coreSrc));
    }
  } catch (error) {
    fail("vision-claim/wiring", error);
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

    // The tokenless branch must ALSO clear the pair identity. A stale `built`
    // survives into the NEXT publish as its rollback target, so a later failed
    // publish would re-register an adapter whose release has already been
    // called. Proved on the real path that triggers it: register first, then
    // lose the credential. (This branch used to leave `built` standing — the
    // copy-drift the shared `publish-core.ts` closed.)
    let liveToken = "live-token";
    const dropLlm = makeLlm();
    const dropping = createAgnescodePublisher({
      panelSwitch: async () => true,
      getLlm: () => dropLlm,
      loadAdapterModule: adapterModule(),
      resolveToken: async () => liveToken
    });
    await dropping.publish(rows, base);
    check("the pair is live before the credential is dropped",
      dropping.state.built !== null && dropping.state.registered === true);
    liveToken = "";
    const dropped = await dropping.publish(rows, base);
    check("losing the credential clears the stale built adapter",
      dropped.skipped === true && dropping.state.error === "not_configured"
      && dropping.state.built === null && dropping.state.registered === false,
      JSON.stringify({ error: dropping.state.error, built: dropping.state.built, registered: dropping.state.registered }));
    // The adapter half of the release is NOT observable through this section's
    // fake: its `registerAdapter` is `async`, so the release it hands back is a
    // Promise, and `createPairReleaser`'s guard swallows calling it. In the
    // Host `registerAdapter` is synchronous. The directory release — which
    // travels the same guarded path — proves the release actually ran.
    check("the dropped pair was released, not left registered",
      dropLlm.calls.some((c) => c[0] === "release-directory"),
      JSON.stringify(dropLlm.calls));

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

    // A re-harvest that lands on another base MUST rebuild — but that gate is
    // the CALLER's: `agnescode-lifecycle.ts` compares the harvested base
    // against `state.bffBase` and re-publishes. This publisher keeps no
    // offered-set signature, so there is nothing here to assert about one;
    // the old line claimed "the signature covers the base" while only testing
    // the pure function, which is why it read as coverage it never was. The
    // harvest walk is not injectable from this suite, so the caller's gate is
    // not reachable offline — recorded as a gap rather than faked.

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

// --- 8b. model allow-list (agnescode-models-store.ts + filterAgnescodeRows) --
{
  section("model allow-list (agnescode-models-store.ts + filterAgnescodeRows)");
  try {
    const { createFileAgnescodeModelsStore, parseAgnescodeModelsPayload, AGNESCODE_MODELS_VERSION } = await import("../src/host/agnescode-models-store.ts");
    const { filterAgnescodeRows } = await import("../src/host/agnescode-models.ts");

    const dir = mkdtempSync(join(tmpdir(), "agnescode-models-"));
    const store = createFileAgnescodeModelsStore({ dir, ttlMs: 20 });
    check("an untouched store curates nothing (empty = push the roster whole)",
      (await store.listEnabledIds()).length === 0);
    await store.save(["agnes-3.0-flash", "kimi-k3", "", "agnes-3.0-flash"]);
    check("a saved list round-trips, deduped and junk dropped",
      JSON.stringify(await store.listEnabledIds()) === JSON.stringify(["agnes-3.0-flash", "kimi-k3"]));
    const second = createFileAgnescodeModelsStore({ dir, ttlMs: 20 });
    check("a second reader sees the curated list", (await second.listEnabledIds()).includes("kimi-k3"));
    await store.save([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const third = createFileAgnescodeModelsStore({ dir, ttlMs: 20 });
    check("saving an empty list clears curation", (await third.listEnabledIds()).length === 0);

    const roster = agnescodeRoster([
      { id: "agnes-3.0-flash", name: "A" },
      { id: "kimi-k3", name: "K" },
      { id: "glm-5.2", name: "G" }
    ]);
    check("no curation keeps the roster whole", filterAgnescodeRows(roster, []).length === 3);
    check("a curated list keeps only the ticked rows",
      filterAgnescodeRows(roster, ["agnes-3.0-flash", "glm-5.2"]).map((row) => row.id).join(",") === "agnes-3.0-flash,glm-5.2");
    check("a hide-all sentinel keeps nothing (no row carries that id)",
      filterAgnescodeRows(roster, ["__hide_all__"]).length === 0);
    check("the parser rejects a foreign shape version",
      parseAgnescodeModelsPayload({ version: 999, enabledModelIds: ["a"] }) === null);
    check("the parser accepts its own version",
      parseAgnescodeModelsPayload({ version: AGNESCODE_MODELS_VERSION, enabledModelIds: ["a"] })?.enabledModelIds.join(",") === "a");

    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    fail("model allow-list", error);
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

    // The full版 affordances the picker hands in: a search/bulk tools row and a
    // no-match note. Both are SLOTS (string nodes here) — the roster draws them
    // as given, so the picker owns the behaviour and the row stays hook-free.
    const withTools = AgnescodeRoster({ models: [{ id: "a", name: "A" }], tt, tools: "TOOLS-ROW" });
    check("the roster renders the search/bulk row when handed tools",
      JSON.stringify(withTools).includes("TOOLS-ROW"));
    const emptyTree = AgnescodeRoster({ models: [], tt, emptyNote: "NO-MATCH" });
    check("the roster renders the no-match note when nothing is visible",
      JSON.stringify(emptyTree).includes("NO-MATCH"));

    // The tab covers the fourth dictionary key set: every agnescode.* key the
    // tab can render exists in BOTH dictionaries (panel.test pins parity
    // globally; this pins the tab's own consumption).
    const needed = ["tab.agnescode", "agnescode.title", "agnescode.desc", "agnescode.notLogged", "agnescode.harvestFail"];
    check("the zh dictionary covers the tab's keys",
      needed.every((key) => typeof dictionaries.zh[key] === "string" && dictionaries.zh[key] !== ""));

    // The picker's own keys plus the shared `llm.roster*` ones it reuses must
    // exist in BOTH languages — a missing one renders as a bare key.
    const rosterKeys = ["agnescode.rosterHint", "agnescode.rosterSave", "agnescode.rosterSaving",
      "agnescode.rosterDiscard", "agnescode.rosterUnsaved", "agnescode.rosterSaved", "agnescode.rosterError",
      "llm.rosterSearchPlaceholder", "llm.rosterCount", "llm.rosterAll", "llm.rosterNone", "llm.rosterNoMatch"];
    check("the picker's dictionary keys exist in both languages",
      rosterKeys.every((key) => typeof dictionaries.zh[key] === "string" && dictionaries.zh[key] !== ""
        && typeof dictionaries.en[key] === "string" && dictionaries.en[key] !== ""),
      rosterKeys.filter((key) => typeof dictionaries.zh[key] !== "string" || typeof dictionaries.en[key] !== "string").join(","));

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

// --- 10. route surface -------------------------------------------------------
// The GET is the FIRST thing the tab does on entry, and it used to THROW: the
// handler's `let lastHarvest` sat after the GET branch, so `agnescodeState()`
// read the binding inside its temporal dead zone. The Host turned the throw
// into a bodiless 400, and the tab — which could not tell a failed read from a
// signed-out desktop App — kept rendering「未关联」while the harvested
// credential was already in the store. This is the guard for that: the real
// handler, a fake ctx, no network, no peer.
{
  section("route surface (registerRoutes, the agnescode GET)");
  try {
    const { registerRoutes } = await import("../src/host/routes.ts");
    const routes = new Map();
    const ctx = {
      webServer: {
        register({ path, handler }) {
          routes.set(path, handler);
          return () => routes.delete(path);
        }
      }
    };
    // Every non-AgnesCode route stays untouched; a stub that answers `null`
    // keeps their registration cheap and proves they are not on this path.
    const unused = new Proxy({}, { get: () => async () => null });
    registerRoutes(ctx, {
      settings: { allowedHosts: new Set(["127.0.0.1"]), registerProvider: false },
      configError: null,
      cache: new Map(),
      inflight: new Map(),
      tokenStore: unused,
      apiKeyStore: unused,
      catalogStore: unused,
      providerStore: unused,
      drawStore: unused,
      videoStore: unused,
      publisher: null,
      providerState: { registered: false, error: null },
      publishProvider: async () => {},
      visionPublish: { current: null },
      logger: { info() {}, warn() {}, error() {} },
      // The credential half only has to REPORT the linked account here: a
      // credential handed to `resolve()` would send the route to the live BFF,
      // and the network guard would (correctly) trip.
      agnescodeStore: {
        async state() {
          return { hasCredential: true, source: "credentials", ephemeral: false, nickname: "测试用户", bffBase: "https://api-agnes-code.agnes-ai.cn/v1", expiresAtMs: null };
        },
        async resolve() {
          return { credential: null, source: null };
        },
        async save() {},
        async forget() {}
      },
      agnescodeSwitch: { async enabled() { return true; }, async save() {} },
      agnescodePublisher: null
    });
    const handler = routes.get("/api/dsh-connect-agnes-token-plan/agnescode");
    check("the agnescode route registers", typeof handler === "function");

    const response = {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(payload) { this.body = payload; }
    };
    await handler({ method: "GET", headers: { host: "127.0.0.1" } }, response);
    const body = JSON.parse(response.body);
    check("the tab's entry GET answers 200 instead of throwing in the route", response.status === 200, String(response.status));
    check("the GET reports the stored credential as linked",
      body.loggedIn === true && body.nickname === "测试用户" && body.enabled === true,
      JSON.stringify({ loggedIn: body.loggedIn, nickname: body.nickname, enabled: body.enabled }));
    check("the GET payload carries no token (the panel only ever sees shape facts)",
      !("accessToken" in body) && !JSON.stringify(body).includes("access_token"));
  } catch (error) {
    fail("route surface", error);
  }
}

// --- 10b. GET self-heal: a stale not_configured repairs itself ---------------
// The switch toggled BEFORE the harvest leaves the publisher's error at
// `not_configured`; nothing else re-runs the publish, so the panel showed
// 「凭据未就绪」next to「已关联」until the reader clicked something. The GET
// now repairs that exact combination (enabled + linked + not_configured) with
// one queued publish per cooldown — and only that combination, so real
// failures never loop.
{
  section("route surface (the GET self-heals a stale not_configured)");
  try {
    const { registerRoutes } = await import("../src/host/routes.ts");
    const routes = new Map();
    const ctx = {
      webServer: {
        register({ path, handler }) {
          routes.set(path, handler);
          return () => routes.delete(path);
        }
      }
    };
    const unused = new Proxy({}, { get: () => async () => null });
    // The publisher starts in the stale state and RECOVERS on the first
    // publish — the panel's next poll must see the repaired state.
    const publisherState = { registered: false, error: "not_configured" };
    let publishes = 0;
    registerRoutes(ctx, {
      settings: { allowedHosts: new Set(["127.0.0.1"]), registerProvider: false },
      configError: null,
      cache: new Map(),
      inflight: new Map(),
      tokenStore: unused,
      apiKeyStore: unused,
      catalogStore: unused,
      providerStore: unused,
      drawStore: unused,
      videoStore: unused,
      publisher: null,
      providerState: { registered: false, error: null },
      publishProvider: async () => {},
      visionPublish: { current: null },
      logger: { info() {}, warn() {}, error() {} },
      agnescodeStore: {
        async state() {
          return { hasCredential: true, source: "credentials", ephemeral: false, nickname: "测试用户", bffBase: "https://api-agnes-code.agnes-ai.cn/v1", expiresAtMs: null };
        },
        async resolve() {
          // A credential with a token: publishFromStore will try the live
          // catalogue behind it — the network guard turns that into null and
          // the route falls back to the static roster, which is the point.
          return { credential: { accessToken: "x".repeat(40), bffBase: "https://api-agnes-code.agnes-ai.cn/v1" }, source: "credentials" };
        },
        async save() {},
        async forget() {}
      },
      agnescodeSwitch: { async enabled() { return true; }, async save() {} },
      agnescodePublisher: {
        get state() { return publisherState; },
        isDisposed() { return false; },
        async publish() {
          publishes += 1;
          publisherState.registered = true;
          publisherState.error = null;
        }
      }
    });
    const handler = routes.get("/api/dsh-connect-agnes-token-plan/agnescode");
    const response = {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(payload) { this.body = payload; }
    };
    await handler({ method: "GET", headers: { host: "127.0.0.1" } }, response);
    const body = JSON.parse(response.body);
    check("the stale not_configured is repaired within the same GET",
      body.providerRegistered === true && body.providerError === undefined,
      JSON.stringify({ registered: body.providerRegistered, error: body.providerError }));
    check("the repair publish ran exactly once", publishes === 1, String(publishes));
    await handler({ method: "GET", headers: { host: "127.0.0.1" } }, response);
    check("a healthy GET does not publish again (cooldown holds)",
      publishes === 1, String(publishes));
  } catch (error) {
    fail("route surface (self-heal)", error);
  }
}

// --- 10c. saveModels: the curation persists and republishes the roster -------
// The panel's tick-list must be LIVE the moment it is saved: the action writes
// the allow-list AND re-runs the publish with the filtered rows, so a curation
// is not a promise for the next poll to keep.
{
  section("route surface (saveModels curates the pushed roster)");
  try {
    const { registerRoutes } = await import("../src/host/routes.ts");
    const routes = new Map();
    const ctx = {
      webServer: {
        register({ path, handler }) {
          routes.set(path, handler);
          return () => routes.delete(path);
        }
      }
    };
    const unused = new Proxy({}, { get: () => async () => null });
    const held = [];
    let publishedRows = null;
    registerRoutes(ctx, {
      settings: { allowedHosts: new Set(["127.0.0.1"]), registerProvider: false },
      configError: null,
      cache: new Map(),
      inflight: new Map(),
      tokenStore: unused,
      apiKeyStore: unused,
      catalogStore: unused,
      providerStore: unused,
      drawStore: unused,
      videoStore: unused,
      publisher: null,
      providerState: { registered: false, error: null },
      publishProvider: async () => {},
      visionPublish: { current: null },
      logger: { info() {}, warn() {}, error() {} },
      agnescodeStore: {
        async state() {
          return { hasCredential: true, source: "credentials", ephemeral: false, nickname: "测试用户", bffBase: "https://api-agnes-code.agnes-ai.cn/v1", expiresAtMs: null };
        },
        async resolve() {
          // A credential with a token: publishFromStore tries the live
          // catalogue, the network guard turns it into null, and the route
          // falls back to the static roster — which is what gets filtered.
          return { credential: { accessToken: "x".repeat(40), bffBase: "https://api-agnes-code.agnes-ai.cn/v1" }, source: "credentials" };
        },
        async save() {},
        async forget() {}
      },
      agnescodeSwitch: { async enabled() { return true; }, async save() {} },
      agnescodeModels: {
        async listEnabledIds() { return held.slice(); },
        async save(raw) {
          held.splice(0, held.length, ...(Array.isArray(raw) ? raw.filter((id) => typeof id === "string" && id !== "") : []));
        }
      },
      agnescodePublisher: {
        state: { registered: true, error: null },
        isDisposed() { return false; },
        async publish(rows) { publishedRows = rows; }
      }
    });
    const handler = routes.get("/api/dsh-connect-agnes-token-plan/agnescode");
    const response = {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(payload) { this.body = payload; }
    };

    await handler({ method: "GET", headers: { host: "127.0.0.1" } }, response);
    const before = JSON.parse(response.body);
    check("the GET reports no curation by default (empty = push all)",
      Array.isArray(before.enabledModelIds) && before.enabledModelIds.length === 0,
      JSON.stringify(before.enabledModelIds));

    const post = async (payload) => {
      const request = (async function* () { yield Buffer.from(JSON.stringify(payload)); })();
      request.method = "POST";
      request.headers = { host: "127.0.0.1" };
      return handler(request, response);
    };
    await post({ action: "saveModels", enabledModelIds: ["agnes-3.0-flash", "kimi-k3"] });
    check("saveModels persists the curated list",
      JSON.stringify(held) === JSON.stringify(["agnes-3.0-flash", "kimi-k3"]), JSON.stringify(held));
    check("the save re-publishes ONLY the curated rows",
      Array.isArray(publishedRows) && publishedRows.length === 2
        && publishedRows.every((row) => ["agnes-3.0-flash", "kimi-k3"].includes(String(row?.id))),
      JSON.stringify((publishedRows ?? []).map((row) => row?.id)));

    await post({ action: "saveModels", enabledModelIds: [] });
    check("clearing curation re-publishes the whole fallback roster",
      Array.isArray(publishedRows) && publishedRows.length === AGNESCODE_FALLBACK_MODELS.length,
      String(publishedRows?.length));

    await post({ action: "bogus" });
    check("an unknown action is refused", JSON.parse(response.body).ok === false);
  } catch (error) {
    fail("route surface (saveModels)", error);
  }
}

// --- 11. the mount seed converges inside a bounded window --------------------
// The bug this fences: the seed used to run ONCE at mount. The two things it
// needs — the `credentials` service the credential is read through, and the
// `llm` registration service — can register AFTER this plugin mounts, so a
// single pass hit `not_configured` (no credential read yet) or
// `no llm registration service` and gave up silently. Nothing else re-ran the
// publish, so the picker stayed empty for the whole session while the tab said
// "logged in"; only the panel's entry GET could repair it. The seed now
// re-reads both inside a bounded window and stops as soon as `registered`
// flips.
{
  section("mount seed (wireAgnescodePublisher + retryBounded)");
  try {
    const { wireAgnescodePublisher } = await import("../src/host/agnescode-lifecycle.ts");
    const base = "https://api-agnes-code.agnes-ai.cn/v1";
    const credential = { accessToken: "tok", bffBase: base };

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
    const adapterModule = () => async () => ({ createAgnescodeAdapter: makeFactory() });

    // Credential arrives LATE (the credentials service registers after this
    // plugin mounted). The seed must keep trying and converge, not give up on
    // the first empty read.
    {
      let reads = 0;
      const store = {
        async resolve() {
          reads += 1;
          return { credential: reads >= 2 ? credential : null };
        },
        async isExpired() { return false; },
        async save() {}
      };
      const llm = makeLlm();
      const { publisher, seed } = wireAgnescodePublisher({
        store,
        panelSwitch: async () => true,
        getLlm: () => llm,
        loadAdapterModule: adapterModule(),
        logger: { warn() {} },
        seedOptions: { attempts: 6, delayMs: 1 }
      });
      await seed();
      check("a late credential is picked up inside the seed window",
        publisher.state.registered === true, JSON.stringify(publisher.state));
      check("the seed stops as soon as the registration lands (window not exhausted)",
        reads < 6, `reads=${reads}`);
    }

    // `llm` service arrives LATE (a Host whose llm registers after the plugin).
    // The publish gates off with `no llm registration service` until it appears,
    // so the seed must retry the whole build.
    {
      let reads = 0;
      const store = {
        async resolve() { return { credential }; },
        async isExpired() { return false; },
        async save() {}
      };
      let llm = null;
      const llmCalls = [];
      const lateLlm = () => {
        if (reads < 2) return null;
        if (llm === null) {
          llm = makeLlm();
          llm.calls = llmCalls;
        }
        return llm;
      };
      const { publisher, seed } = wireAgnescodePublisher({
        store,
        panelSwitch: async () => true,
        getLlm: () => { reads += 1; return lateLlm(); },
        loadAdapterModule: adapterModule(),
        logger: { warn() {} },
        seedOptions: { attempts: 6, delayMs: 1 }
      });
      await seed();
      check("a late llm service is waited for and the provider registers",
        publisher.state.registered === true, JSON.stringify(publisher.state));
      check("the llm service was not probed after registration (loop stopped)",
        reads < 6, `reads=${reads}`);
    }

    // A credential that NEVER arrives exhausts the window and fails fast,
    // leaving the panel's "switch on — detect login state" state intact.
    {
      let reads = 0;
      const store = {
        async resolve() { reads += 1; return { credential: null }; },
        async isExpired() { return false; },
        async save() {}
      };
      const { publisher, seed } = wireAgnescodePublisher({
        store,
        panelSwitch: async () => true,
        getLlm: () => makeLlm(),
        loadAdapterModule: adapterModule(),
        logger: { warn() {} },
        seedOptions: { attempts: 6, delayMs: 1 }
      });
      await seed();
      check("a credential that never appears leaves the provider unregistered after the window",
        publisher.state.registered === false && reads === 6,
        JSON.stringify({ registered: publisher.state.registered, reads }));
    }

    // Switch OFF (or a concurrent panel flip) must stop the seed immediately,
    // never register behind the tab's back.
    {
      let publishes = 0;
      const store = {
        async resolve() { return { credential }; },
        async isExpired() { return false; },
        async save() {}
      };
      const { publisher, seed } = wireAgnescodePublisher({
        store,
        panelSwitch: async () => false,
        getLlm: () => makeLlm(),
        loadAdapterModule: adapterModule(),
        logger: { warn() {} },
        seedOptions: { attempts: 6, delayMs: 1 }
      });
      await seed();
      check("an off switch leaves the provider pristine (no publish at mount)",
        publisher.state.registered === false && publishes === 0,
        JSON.stringify({ registered: publisher.state.registered, publishes }));
    }
  } catch (error) {
    fail("mount seed", error);
  }
}

// --- 11b. GET self-heal covers a stale no-llm-service too --------------------
// The mount seed may have exhausted its window with the `llm` service still
// absent, leaving `no llm registration service` (NOT `not_configured`). The
// self-heal used to repair only `not_configured`, so that stale state survived
// until the reader clicked something. Any unregistered state alongside a
// linked credential is now repaired (one publish per cooldown).
{
  section("route surface (the GET self-heals a stale no-llm-service)");
  try {
    const { registerRoutes } = await import("../src/host/routes.ts");
    const routes = new Map();
    const ctx = {
      webServer: {
        register({ path, handler }) {
          routes.set(path, handler);
          return () => routes.delete(path);
        }
      }
    };
    const unused = new Proxy({}, { get: () => async () => null });
    const publisherState = { registered: false, error: "the Host exposes no llm registration service" };
    let publishes = 0;
    registerRoutes(ctx, {
      settings: { allowedHosts: new Set(["127.0.0.1"]), registerProvider: false },
      configError: null,
      cache: new Map(),
      inflight: new Map(),
      tokenStore: unused,
      apiKeyStore: unused,
      catalogStore: unused,
      providerStore: unused,
      drawStore: unused,
      videoStore: unused,
      publisher: null,
      providerState: { registered: false, error: null },
      publishProvider: async () => {},
      visionPublish: { current: null },
      logger: { info() {}, warn() {}, error() {} },
      agnescodeStore: {
        async state() {
          return { hasCredential: true, source: "credentials", ephemeral: false, nickname: "测试用户", bffBase: "https://api-agnes-code.agnes-ai.cn/v1", expiresAtMs: null };
        },
        async resolve() {
          return { credential: { accessToken: "x".repeat(40), bffBase: "https://api-agnes-code.agnes-ai.cn/v1" }, source: "credentials" };
        },
        async save() {},
        async forget() {}
      },
      agnescodeSwitch: { async enabled() { return true; }, async save() {} },
      agnescodePublisher: {
        get state() { return publisherState; },
        isDisposed() { return false; },
        async publish() {
          publishes += 1;
          publisherState.registered = true;
          publisherState.error = null;
        }
      }
    });
    const handler = routes.get("/api/dsh-connect-agnes-token-plan/agnescode");
    const response = {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(payload) { this.body = payload; }
    };
    await handler({ method: "GET", headers: { host: "127.0.0.1" } }, response);
    const body = JSON.parse(response.body);
    check("a stale no-llm-service is repaired within the same GET",
      body.providerRegistered === true && body.providerError === undefined,
      JSON.stringify({ registered: body.providerRegistered, error: body.providerError }));
    check("the repair publish ran exactly once", publishes === 1, String(publishes));
  } catch (error) {
    fail("route surface (self-heal, no-llm-service)", error);
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
