/**
 * Unit checks for the step-three LLM provider's PEER-FREE layers:
 *
 * - `llm-models.js`: catalog entry -> pi-ai descriptor mapping (vision
 *   detection, the load-bearing compat flags, context-window fallbacks,
 *   dedupe);
 * - `catalog-store.js`: the private state file (normalization, version
 *   rejection, atomic round-trip, the memory fallback);
 * - `api-key-store.js`: the `SENSENOVA_API_KEY` reference store (service
 *   precedence over env, save/forget, failure fall-through, ephemeral state).
 *
 * Nothing here imports a Host peer, so these decisions stay covered on a clean
 * checkout; the peer-dependent adapter is exercised in wiring/e2e instead.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateHostEnv, isolateStateDir } from "./peer-roots.mjs";
import {
  LLM_PROVIDER_ID,
  LLM_DISPLAY_NAME,
  NO_COST,
  FALLBACK_CONTEXT_WINDOW,
  contextWindowOf,
  toPiDescriptor,
  buildDescriptors,
  summarizeCatalog
} from "../llm-models.js";
import {
  CATALOG_VERSION,
  normalizeEntries,
  createFileCatalogStore,
  createMemoryCatalogStore
} from "../catalog-store.js";
import { createApiKeyStore, API_KEY_REF } from "../api-key-store.js";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

const BASE_URL = "https://token.sensenova.cn/v1";

// --- 1. toPiDescriptor: the wire contract pi-ai consumes ------------------
{
  try {
    const descriptor = toPiDescriptor({ id: "SenseNova-Lite", name: "SenseNova Lite" }, { baseUrl: BASE_URL });

    check("provider id is the collision-free own slug", LLM_PROVIDER_ID === "sensenova-token-plan", LLM_PROVIDER_ID);
    check("display name is set", LLM_DISPLAY_NAME === "SenseNova Token Plan");
    check("identity fields are mapped", descriptor.id === "SenseNova-Lite" && descriptor.name === "SenseNova Lite");
    check("api is openai-completions", descriptor.api === "openai-completions", descriptor.api);
    check("descriptor is tagged with the provider", descriptor.provider === LLM_PROVIDER_ID);
    check("base URL points at the direct endpoint", descriptor.baseUrl === BASE_URL);
    check("a model with no modality field is text-only", JSON.stringify(descriptor.input) === JSON.stringify(["text"]));
    check("not advertised as a reasoning model", descriptor.reasoning === false);
    check("cost is zeroed on all four fields", JSON.stringify(descriptor.cost) === JSON.stringify(NO_COST) &&
      descriptor.cost.input === 0 && descriptor.cost.output === 0 &&
      descriptor.cost.cacheRead === 0 && descriptor.cost.cacheWrite === 0);
    // The two load-bearing flags from the qoder route:
    check("supportsDeveloperRole is forced false (the 403 fix)",
      descriptor.compat.supportsDeveloperRole === false);
    check("max_tokens is the wire field name", descriptor.compat.maxTokensField === "max_tokens");
    check("no maxTokens VALUE is declared (declaring one truncates replies)",
      !Object.prototype.hasOwnProperty.call(descriptor, "maxTokens") &&
      !Object.prototype.hasOwnProperty.call(descriptor.compat, "maxTokens"));
  } catch (error) {
    fail("toPiDescriptor maps a text model", error);
  }
}

// --- 2. vision is automatic and identical to the panel's classification ----
{
  try {
    const byField = toPiDescriptor({ id: "SenseNova-Vision", input_modalities: ["text", "image"] }, { baseUrl: BASE_URL });
    check("input_modalities image makes the model vision",
      JSON.stringify(byField.input) === JSON.stringify(["text", "image"]));

    const byName = toPiDescriptor({ id: "SenseNova-VL" }, { baseUrl: BASE_URL });
    check("the name fallback still marks a -vl model vision",
      JSON.stringify(byName.input) === JSON.stringify(["text", "image"]));

    const textOnly = toPiDescriptor({ id: "sensenova-6.8-flash-lite", input_modalities: ["text"] }, { baseUrl: BASE_URL });
    check("flash-lite is text-only (no name-pattern vision anymore)",
      JSON.stringify(textOnly.input) === JSON.stringify(["text"]));
  } catch (error) {
    fail("vision classification flows into descriptors", error);
  }
}

// --- 3. context window: declared spellings win, positive fallback otherwise -
{
  try {
    check("context_window wins", contextWindowOf({ context_window: 32000 }) === 32000);
    check("contextWindow wins", contextWindowOf({ contextWindow: 65536 }) === 65536);
    check("max_context_tokens wins", contextWindowOf({ max_context_tokens: 8192 }) === 8192);
    check("a fractional value floors", contextWindowOf({ context_window: 100.9 }) === 100);
    check("zero falls back", contextWindowOf({ context_window: 0 }) === FALLBACK_CONTEXT_WINDOW);
    check("negative falls back", contextWindowOf({ context_window: -5 }) === FALLBACK_CONTEXT_WINDOW);
    check("junk falls back", contextWindowOf({ context_window: "lots" }) === FALLBACK_CONTEXT_WINDOW);
    check("missing falls back to a positive window (pi-ai does arithmetic on it)",
      contextWindowOf({ id: "x" }) === 128000);
    const descriptor = toPiDescriptor({ id: "x" }, { baseUrl: BASE_URL });
    check("the descriptor carries the positive fallback", descriptor.contextWindow === 128000);
  } catch (error) {
    fail("context window handling", error);
  }
}

// --- 4. buildDescriptors: ordering, junk, duplicates, missing id -----------
{
  try {
    let threw = false;
    try { toPiDescriptor({}, { baseUrl: BASE_URL }); } catch { threw = true; }
    check("an id-less entry cannot become a descriptor", threw);

    check("a non-array catalog builds nothing", buildDescriptors(undefined, { baseUrl: BASE_URL }).length === 0);

    const built = buildDescriptors(
      [
        null,
        "not-an-object",
        { id: "" },
        { id: "a", name: "A", input_modalities: ["text"] },
        { id: "b", input_modalities: ["text", "image"] },
        // Duplicate id: last occurrence wins, first-seen position kept.
        { id: "a", name: "A-prime" }
      ],
      { baseUrl: BASE_URL }
    );
    check("junk entries are dropped and ids unique", built.length === 2 && built[0].id === "a" && built[1].id === "b");
    check("duplicate id keeps the last occurrence", built[0].name === "A-prime");
    check("base URL is shared by every descriptor", built.every((d) => d.baseUrl === BASE_URL));
  } catch (error) {
    fail("buildDescriptors normalization", error);
  }
}

// --- 5. summarizeCatalog: what the snapshot llm block reports --------------
{
  try {
    const summary = summarizeCatalog([
      { id: "text-a" },
      { id: "vision-a", input_modalities: ["text", "image"] },
      { id: "vision-b", input_modalities: ["text", "image"] },
      { id: "", input_modalities: ["text", "image"] }
    ]);
    check("model count counts every addressable entry", summary.modelCount === 3, String(summary.modelCount));
    check("vision count uses the same identification", summary.visionCount === 2, String(summary.visionCount));
    check("vision ids are reported", JSON.stringify(summary.visionIds) === JSON.stringify(["vision-a", "vision-b"]));
    check("no catalog means zero/zero", summarizeCatalog(undefined).modelCount === 0 &&
      summarizeCatalog(undefined).visionCount === 0);
  } catch (error) {
    fail("summarizeCatalog", error);
  }
}

// --- 6. normalizeEntries: the persisted catalog shape ----------------------
{
  try {
    check("non-array normalizes to empty", normalizeEntries("nope").length === 0);
    check("id-less entries are dropped", normalizeEntries([{ name: "no id" }]).length === 0);
    const normalized = normalizeEntries([
      { id: "a", input_modalities: ["text"] },
      { id: "b" },
      { id: "a", input_modalities: ["text", "image"] }
    ]);
    check("duplicate id keeps the last whole entry in first-seen position",
      normalized.length === 2 && normalized[0].id === "a" &&
      JSON.stringify(normalized[0].input_modalities) === JSON.stringify(["text", "image"]));
  } catch (error) {
    fail("normalizeEntries", error);
  }
}

// --- 7. memory catalog store -----------------------------------------------
{
  try {
    const store = createMemoryCatalogStore(() => 42);
    check("memory store starts empty", (await store.list()).length === 0);
    await store.replace([{ id: "a" }, { id: "" }, "x"]);
    const entries = await store.list();
    check("memory replace normalizes and stamps", entries.length === 1 && entries[0].id === "a");
    await store.clear();
    check("memory clear empties the store", (await store.list()).length === 0);
  } catch (error) {
    fail("memory catalog store", error);
  }
}

// --- 8. file catalog store: round trip, corruption, foreign version ---------
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  let scratch = "";
  try {
    const dir = join(process.env.DSH_HOME, "state", "dsh-connect-sensenova-token-plan");
    const file = join(dir, "catalog.json");
    const clock = (() => { let t = 1000; return () => (t += 500); })();
    const store = createFileCatalogStore({ dir, now: clock });
    await store.replace([
      { id: "SenseNova-Lite", input_modalities: ["text"] },
      { id: "SenseNova-Vision", input_modalities: ["text", "image"] }
    ]);
    check("replace wrote catalog.json under the plugin state dir", (() => {
      try { readFileSync(file, "utf8"); return true; } catch { return false; }
    })());
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    check("the payload carries the format version", persisted.version === CATALOG_VERSION);
    check("the payload stamps fetchedAt", persisted.fetchedAt === 1500);
    check("the payload kept whole entries for vision detection",
      Array.isArray(persisted.entries) && persisted.entries.length === 2 &&
      JSON.stringify(persisted.entries[1].input_modalities) === JSON.stringify(["text", "image"]));

    // A SECOND store instance proves persistence, not just the held cache.
    const reopened = createFileCatalogStore({ dir, now: clock });
    const entries = await reopened.list();
    check("a fresh store reads the persisted catalog",
      entries.length === 2 && entries[0].id === "SenseNova-Lite");

    writeFileSync(file, "{ this is not json", "utf8");
    const corrupted = createFileCatalogStore({ dir, now: clock });
    check("a corrupted file reads as no catalog (never throws)", (await corrupted.list()).length === 0);

    writeFileSync(file, JSON.stringify({ version: 999, fetchedAt: 1, entries: [] }), "utf8");
    const foreign = createFileCatalogStore({ dir, now: clock });
    check("a foreign format version reads as no catalog", (await foreign.list()).length === 0);

    writeFileSync(file, JSON.stringify({ version: CATALOG_VERSION, fetchedAt: 0, entries: [] }), "utf8");
    const unstamped = createFileCatalogStore({ dir, now: clock });
    check("an unstamped catalog reads as no catalog", (await unstamped.list()).length === 0);

    await reopened.clear();
    check("clear removes the file", (() => {
      try { readFileSync(file, "utf8"); return false; } catch { return true; }
    })());
  } catch (error) {
    fail("file catalog store", error);
  } finally {
    restoreHome();
    restoreEnv();
  }
}

// --- 9. a read-only directory degrades to in-memory, never a crash ----------
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  const scratch = mkdtempSync(join(tmpdir(), "catalog-readonly-"));
  try {
    const store = createFileCatalogStore({ dir: join(scratch, "missing", "deep"), now: () => 1 });
    // The "directory" is actually a plain FILE: mkdir/rename cannot succeed.
    writeFileSync(scratch + "/blocker", "x", "utf8");
    const blocked = createFileCatalogStore({ dir: join(scratch, "blocker", "no"), now: () => 1 });
    await blocked.replace([{ id: "a" }]);
    check("a write failure keeps the catalog in memory", (await blocked.list()).length === 1);
  } catch (error) {
    fail("read-only directory degradation", error);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    restoreHome();
    restoreEnv();
  }
}

// --- 10. api key store: env fallback with no service ------------------------
{
  const restoreEnv = isolateHostEnv();
  try {
    const store = createApiKeyStore({ credentials: null, env: { SENSENOVA_API_KEY: "sk-env" } });
    const resolved = await store.resolve();
    check("env provides the key when no service exists",
      resolved.value === "sk-env" && resolved.source === "env");
    const state = await store.state();
    check("state reports hasApiKey + env source + ephemeral host",
      state.hasApiKey === true && state.keySource === "env" && state.ephemeral === true);
  } catch (error) {
    fail("env fallback", error);
  } finally {
    restoreEnv();
  }
}

// --- 11. api key store: memory save/validate/forget without a service -------
{
  const restoreEnv = isolateHostEnv(["SENSENOVA_API_KEY"]);
  try {
    const store = createApiKeyStore({ credentials: null, env: {} });
    check("no key anywhere resolves empty/null source",
      (await store.resolve()).source === null && (await store.state()).hasApiKey === false);

    let threw = false;
    try { await store.save("   "); } catch { threw = true; }
    check("a whitespace-only key is rejected", threw);

    await store.save("  sk-memory  ");
    const resolved = await store.resolve();
    check("a saved key is stored verbatim (no trim)", resolved.value === "  sk-memory  " &&
      resolved.source === "memory");

    await store.forget();
    check("forget clears the in-memory copy", (await store.resolve()).source === null);
  } catch (error) {
    fail("memory save/forget", error);
  } finally {
    restoreEnv();
  }
}

// --- 12. credentials service: precedence, persistence name, resolver --------
{
  const restoreEnv = isolateHostEnv();
  try {
    const refs = new Map();
    const service = {
      async resolve(ref) { const value = refs.get(ref); return value === undefined ? undefined : { value }; },
      async set(ref, value) { refs.set(ref, value); },
      async unset(ref) { refs.delete(ref); }
    };
    const store = createApiKeyStore({ credentials: () => service, env: { SENSENOVA_API_KEY: "sk-env" } });

    check("env still serves before a panel save", (await store.resolve()).source === "env");
    check("state says the host is not ephemeral with a service", (await store.state()).ephemeral === false);

    await store.save("sk-panel");
    check("the panel value lands under the shared reference name", refs.get(API_KEY_REF) === "sk-panel");
    const resolved = await store.resolve();
    check("a stored reference wins over the env fallback",
      resolved.value === "sk-panel" && resolved.source === "credentials");

    await store.forget();
    check("forget removes the reference but leaves the env value standing",
      !refs.has(API_KEY_REF) && (await store.resolve()).source === "env");
  } catch (error) {
    fail("credentials service precedence", error);
  } finally {
    restoreEnv();
  }
}

// --- 13. a failing/absent credentials service falls through safely ----------
{
  const restoreEnv = isolateHostEnv();
  try {
    const flaky = {
      async resolve() { throw new Error("credentials file locked"); },
      async set() { throw new Error("credentials file locked"); },
      async unset() { throw new Error("credentials file locked"); }
    };
    const store = createApiKeyStore({ credentials: flaky, env: { SENSENOVA_API_KEY: "sk-env" } });
    const resolved = await store.resolve();
    check("a throwing resolve falls through to env", resolved.source === "env" && resolved.value === "sk-env");

    let threw = false;
    try { await store.save("sk-x"); } catch { threw = true; }
    check("a save the service refuses propagates (route reports it, no silent loss)", threw);

    // forget must swallow the service error; the key was never stored anyway.
    await store.forget();
    check("forget survives a throwing service", (await store.resolve()).source === "env");
  } catch (error) {
    fail("service failure fall-through", error);
  } finally {
    restoreEnv();
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
