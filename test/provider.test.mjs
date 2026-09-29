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
  isChatModel,
  thinkingLevelMapFor,
  toPiDescriptor,
  buildDescriptors,
  filterByEnabled,
  isModelEnabled,
  rosterOf,
  HIDE_ALL_MODELS,
  summarizeCatalog
} from "../llm-models.js";
import {
  CATALOG_VERSION,
  normalizeEnabledIds,
  normalizeEntries,
  createFileCatalogStore,
  createMemoryCatalogStore
} from "../catalog-store.js";
import { createApiKeyStore, API_KEY_REF } from "../api-key-store.js";
import { PROVIDER_VERSION, createFileProviderStore } from "../provider-store.js";
import { redactSecrets } from "../util.js";
import { surface as clientSurface } from "../client-surface.js";

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
    // Every SenseNova chat model reasons by default (supported_features
    // ["reasoning"], thinking on at high, 2026-09-29): the descriptor must
    // advertise it so DSH offers the 思考强度 selector and pi-ai reads the
    // thinking back (both `reasoning` and `reasoning_content` spellings).
    check("advertised as a reasoning model", descriptor.reasoning === true);
    check("the thinking map pins picker levels to wire spellings",
      JSON.stringify(descriptor.thinkingLevelMap) === JSON.stringify({
        off: "none", minimal: null, low: "low", medium: "medium",
        high: "high", xhigh: "xhigh", max: null
      }), JSON.stringify(descriptor.thinkingLevelMap));
    check("off is the platform's none, not the OpenAI off (which 400s)",
      thinkingLevelMapFor({ id: "any" }).off === "none");
    check("minimal is not offered (unverified on this gateway)",
      thinkingLevelMapFor({ id: "any" }).minimal === null);
    check("xhigh is offered (accepted on every chat model)",
      thinkingLevelMapFor({ id: "any" }).xhigh === "xhigh");
    check("max is rejected off by default (400 on flash-lite / v4-flash)",
      thinkingLevelMapFor({ id: "sensenova-6.8-flash-lite" }).max === null);
    check("glm-5.2 alone offers max (probed 200)",
      thinkingLevelMapFor({ id: "glm-5.2" }).max === "max");
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
    check("context_length wins (the real /v1/models field, 2026-09)",
      contextWindowOf({ context_length: 262144 }) === 262144);
    check("context_length beats the legacy spellings when both present",
      contextWindowOf({ context_length: 262144, context_window: 32000 }) === 262144);
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

// --- 4.5 chat-model filtering: image-generation models are not offered -----
// The catalog lists U-series image-generation models (output_modalities
// ["image"]) that answer 404 on /v1/chat/completions; offering them as chat
// models would only produce errors in DSH. Every "offered" surface — the
// descriptors, the panel roster and the registration counts — must exclude
// them identically.
{
  try {
    const gen = { id: "u-gen", output_modalities: ["image"], input_modalities: ["text"] };
    const visionChat = { id: "v-chat", output_modalities: ["text"], input_modalities: ["text", "image"] };
    const textChat = { id: "t-chat", output_modalities: ["text"] };

    check("an image-output model is not a chat model", isChatModel(gen) === false);
    check("a vision chat model is a chat model", isChatModel(visionChat) === true);
    check("a text-only model is a chat model", isChatModel(textChat) === true);
    check("a missing output_modalities stays chat (permissive)", isChatModel({ id: "x" }) === true);
    check("a non-array output_modalities stays chat", isChatModel({ id: "y", output_modalities: "text" }) === true);

    const built = buildDescriptors([gen, visionChat, textChat], { baseUrl: BASE_URL });
    check("buildDescriptors skips image-generation models",
      built.length === 2 && JSON.stringify(built.map((d) => d.id)) === JSON.stringify(["v-chat", "t-chat"]));

    const roster = rosterOf([gen, visionChat, textChat]);
    check("rosterOf skips image-generation models",
      JSON.stringify(roster.map((r) => r.id)) === JSON.stringify(["v-chat", "t-chat"]));

    const summary = summarizeCatalog([gen, visionChat, textChat]);
    check("summarizeCatalog counts only chat models", summary.modelCount === 2, String(summary.modelCount));
    check("summarizeCatalog vision ids cover only offered models",
      JSON.stringify(summary.visionIds) === JSON.stringify(["v-chat"]));

    // A stale allow-list id for an image-generation model matches nothing.
    const allowlisted = buildDescriptors([gen, textChat], { baseUrl: BASE_URL, enabledIds: ["u-gen", "t-chat"] });
    check("an allow-listed image-generation id offers nothing",
      JSON.stringify(allowlisted.map((d) => d.id)) === JSON.stringify(["t-chat"]));
  } catch (error) {
    fail("chat-model filtering", error);
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

// --- 5.5 filterByEnabled: empty list means "no filter" ---------------------
// A fresh install has curated nothing and must still be offered every model.
// Once non-empty the list is a strict allow-list; a stale id simply matches
// nothing. This is the one pure function in this module with NO coverage
// elsewhere — it had never been asserted directly.
{
  try {
    const entries = [
      { id: "a" },
      { id: "b" },
      { id: "c" }
    ];
    check("absent enabledIds offers every entry", filterByEnabled(entries).length === 3);
    check("an empty enabledIds is the same as absent",
      filterByEnabled(entries, []).length === 3);
    check("a non-array enabledIds behaves as absent",
      filterByEnabled(entries, "a").length === 3);
    check("a non-empty list is a strict allow-list",
      JSON.stringify(filterByEnabled(entries, ["a", "c"]).map((e) => e.id)) === JSON.stringify(["a", "c"]));
    check("a stale id matches nothing rather than throwing",
      filterByEnabled(entries, ["zzz"]).length === 0);
    check("a non-array entries list reads as no entries",
      filterByEnabled(null).length === 0);
    // The allow-list composes with the dedup pass in buildDescriptors.
    const built = buildDescriptors(entries, { baseUrl: BASE_URL, enabledIds: ["a", "c"] });
    check("buildDescriptors honours the enabledIds allow-list",
      built.map((d) => d.id).join(",") === "a,c", built.map((d) => d.id).join(","));
  } catch (error) {
    fail("filterByEnabled allow-list semantics", error);
  }
}

// --- 5.6 the "hide everything" sentinel and the panel roster projection -----
// An empty allow-list already means "no filter", so "the user unticked every
// model" needs a second spelling. HIDE_ALL_MODELS is that spelling: it is not a
// model, so it matches nothing and offers nothing — while staying distinct
// from "nothing curated yet". Without it the picker could not express
// "temporarily push no models" at all.
{
  try {
    const entries = [
      { id: "a", name: "Model A" },
      { id: "b", name: "Model B", input_modalities: ["text", "image"] },
      { id: "c", name: "Model C" }
    ];
    // The sentinel must be a string no real id can be.
    check("the sentinel is a non-empty string", typeof HIDE_ALL_MODELS === "string" && HIDE_ALL_MODELS !== "", String(HIDE_ALL_MODELS));
    check("a sentinel-only allow-list offers nothing",
      filterByEnabled(entries, [HIDE_ALL_MODELS]).length === 0);
    check("the sentinel filters a mixed list down to nothing",
      filterByEnabled(entries, [HIDE_ALL_MODELS, "a"]).map((e) => e.id).join(",") === "a");
    check("an empty list still means 'no filter' (not 'nothing')",
      filterByEnabled(entries, []).length === 3);
    // The predicate agrees with filterByEnabled for all three states.
    check("isModelEnabled: empty list offers everything",
      isModelEnabled([], "a") === true && isModelEnabled(undefined, "a") === true);
    check("isModelEnabled: a non-empty list is strict",
      isModelEnabled(["a"], "a") === true && isModelEnabled(["a"], "b") === false);
    check("isModelEnabled: the sentinel offers nothing",
      isModelEnabled([HIDE_ALL_MODELS], "a") === false);
    check("isModelEnabled: a junk list reads as no filter",
      isModelEnabled("a", "b") === true);
    // The store keeps the sentinel: curation survives a persist round trip.
    check("normalizeEnabledIds keeps the sentinel",
      JSON.stringify(normalizeEnabledIds([HIDE_ALL_MODELS, "a"])) === JSON.stringify([HIDE_ALL_MODELS, "a"]));
    check("normalizeEnabledIds still drops junk",
      JSON.stringify(normalizeEnabledIds([HIDE_ALL_MODELS, "", null, "a", "a"])) === JSON.stringify([HIDE_ALL_MODELS, "a"]));
    check("normalizeEnabledIds on a non-array reads as no filter",
      JSON.stringify(normalizeEnabledIds("nope")) === JSON.stringify([]));
  } catch (error) {
    fail("the hide-all sentinel", error);
  }
}

// --- 5.6b rosterOf: what the panel shows as tickable rows -------------------
// rosterOf is the only thing standing between the raw catalogue and the
// checkboxes: it must project just id/name/vision, drop junk, dedupe by id, and
// reach the SAME vision verdict the registered descriptors use — otherwise the
// panel would advertise a model the provider never registered.
{
  try {
    const roster = rosterOf([
      { id: "a", name: "Model A" },
      { id: "b", name: "Model B", input_modalities: ["text", "image"], opaque_field: "must not leak" },
      { name: "no id" },
      { id: "a", name: "Model A prime" },
      null,
      { id: "c" }
    ]);
    check("rosterOf drops id-less entries and junk",
      roster.map((r) => r.id).join(",") === "a,b,c", roster.map((r) => r.id).join(","));
    check("rosterOf keeps only id, name and vision",
      JSON.stringify(Object.keys(roster[0]).sort()) === JSON.stringify(["id", "name", "vision"]));
    check("a missing name falls back to the id", roster[2].name === "c");
    check("rosterOf dedupes the same way buildDescriptors does (last wins)",
      roster[0].name === "Model A prime", roster[0].name);
    check("rosterOf reaches the same vision verdict as the descriptors",
      JSON.stringify(roster.map((r) => r.vision)) === JSON.stringify([false, true, false]) &&
      JSON.stringify(rosterOf([{ id: "plain" }]).map((r) => r.vision)) === JSON.stringify([false]));
    check("rosterOf on a non-array returns nothing", rosterOf(undefined).length === 0);
    // Cross-checked against the Host's own descriptor builder: the ids the
    // panel can tick must be the ids the provider would register.
    const described = buildDescriptors([
      { id: "a" }, { id: "b", input_modalities: ["text", "image"] }
    ], { baseUrl: BASE_URL });
    check("rosterOf and buildDescriptors agree on which ids exist",
      JSON.stringify(rosterOf([{ id: "a" }, { id: "b" }]).map((r) => r.id)) ===
        JSON.stringify(described.map((d) => d.id)));
  } catch (error) {
    fail("rosterOf projection", error);
  }
}

// --- 5.6c the browser bundle must carry the same sentinel -------------------
// client.js cannot import this module (the browser loader only resolves
// packages), so the literal is spelled twice. If the two diverge, the Host
// would apply a filter the panel believes is "everything on" — silently
// un-curating the whole catalogue. Materializing the shipped bundle is what
// catches that.
{
  try {
    check("client and host spell the same hide-all sentinel",
      clientSurface.helpers.HIDE_ALL_MODELS === HIDE_ALL_MODELS,
      `${clientSurface.helpers.HIDE_ALL_MODELS} !== ${HIDE_ALL_MODELS}`);
    // The picker's own predicate must agree with the Host's filter.
    const entries = [{ id: "a" }, { id: "b" }, { id: "c" }];
    for (const allow of [[], ["a", "c"], [HIDE_ALL_MODELS]]) {
      const hostIds = filterByEnabled(entries, allow).map((e) => e.id);
      const panelIds = entries.map((e) => e.id).filter((id) => clientSurface.helpers.modelIsOn(allow, id));
      check(`client modelIsOn agrees with filterByEnabled for ${JSON.stringify(allow)}`,
        JSON.stringify(panelIds) === JSON.stringify(hostIds),
        `${JSON.stringify(panelIds)} vs ${JSON.stringify(hostIds)}`);
    }
    // Ticking one model off must produce a complete allow-list, not a diff.
    check("toggleModelIn: unticking one leaves the rest on",
      JSON.stringify(clientSurface.helpers.toggleModelIn([], ["a", "b", "c"], "b")) === JSON.stringify(["a", "c"]));
    check("toggleModelIn: unticking the last one collapses to the sentinel",
      JSON.stringify(clientSurface.helpers.toggleModelIn(["a"], ["a"], "a")) === JSON.stringify([HIDE_ALL_MODELS]));
    check("toggleModelIn: ticking back on drops the sentinel",
      JSON.stringify(clientSurface.helpers.toggleModelIn([HIDE_ALL_MODELS], ["a", "b"], "b")) === JSON.stringify(["b"]));
    check("toggleModelIn: ticking everything back on collapses to an empty list",
      JSON.stringify(clientSurface.helpers.toggleModelIn(["b"], ["a", "b"], "a")) === JSON.stringify([]));
    check("toggleModelIn: ordering follows the roster, not the old list",
      JSON.stringify(clientSurface.helpers.toggleModelIn(["c", "a"], ["a", "c", "b", "d"], "b")) === JSON.stringify(["a", "c", "b"]));
    check("toggleModelIn: ticking the last unticked model collapses to the empty spelling",
      JSON.stringify(clientSurface.helpers.toggleModelIn(["c", "a"], ["a", "c", "b"], "b")) === JSON.stringify([]));
    // Bulk operations share the same extreme spellings.
    check("setAllModelsIn: tick all is the empty-list spelling",
      JSON.stringify(clientSurface.helpers.setAllModelsIn(["a", "b"], true)) === JSON.stringify([]));
    check("setAllModelsIn: untick all is the sentinel spelling",
      JSON.stringify(clientSurface.helpers.setAllModelsIn(["a", "b"], false)) === JSON.stringify([HIDE_ALL_MODELS]));
    // A bulk edit applies to the VISIBLE rows only, but the result stays a
    // complete allow-list: the rows outside the current view keep whatever the
    // Host already offers. The last case is the regression that turned the
    // picker's "tick all" into a save that hid every model, when the caller
    // handed {id} objects to a helper that wants id strings.
    check("bulkModelsIn: ticking a visible row joins the allow-list",
      JSON.stringify(clientSurface.helpers.bulkModelsIn(["b"], ["a", "b", "c"], ["c"], true)) === JSON.stringify(["b", "c"]));
    check("bulkModelsIn: ticking from the sentinel restores the picked row only",
      JSON.stringify(clientSurface.helpers.bulkModelsIn([HIDE_ALL_MODELS], ["a", "b", "c"], ["a"], true)) === JSON.stringify(["a"]));
    check("bulkModelsIn: unticking one leaves the rest offered",
      JSON.stringify(clientSurface.helpers.bulkModelsIn([], ["a", "b", "c"], ["b"], false)) === JSON.stringify(["a", "c"]));
    check("bulkModelsIn: unticking the filtered view keeps the unseen rows",
      JSON.stringify(clientSurface.helpers.bulkModelsIn([], ["a", "b", "c"], ["a"], false)) === JSON.stringify(["b", "c"]));
    check("bulkModelsIn: unticking everything is the sentinel spelling",
      JSON.stringify(clientSurface.helpers.bulkModelsIn([], ["a", "b"], ["a", "b"], false)) === JSON.stringify([HIDE_ALL_MODELS]));
    // allowListFor is the funnel: every spelling it emits is one the Host reads
    // the way the picker shows it.
    check("allowListFor: a partial set is emitted in roster order",
      JSON.stringify(clientSurface.helpers.allowListFor(new Set(["c", "a"]), ["a", "c", "b"])) === JSON.stringify(["a", "c"]));
    check("allowListFor: an unknown id can never enter the list",
      JSON.stringify(clientSurface.helpers.allowListFor(new Set(["zzz"]), ["a", "b"])) === JSON.stringify([HIDE_ALL_MODELS]));
    check("allowListFor: a junk roster reads as no models",
      JSON.stringify(clientSurface.helpers.allowListFor(new Set(["a"]), undefined)) === JSON.stringify([HIDE_ALL_MODELS]));
    // And the emitted list really offers what it was asked to offer.
    const emitted = clientSurface.helpers.allowListFor(new Set(["a", "c"]), ["a", "c", "b"]);
    check("an emitted allow-list offers exactly the requested ids",
      JSON.stringify(filterByEnabled(entries, emitted).map((e) => e.id)) === JSON.stringify(["a", "c"]));
  } catch (error) {
    fail("client/host curation parity", error);
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

// --- 10. provider switch store: the panel value beats the config default ---
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  try {
    const dir = join(process.env.DSH_HOME, "state", "dsh-connect-sensenova-token-plan");
    const file = join(dir, "provider.json");
    const store = createFileProviderStore({ dir });

    check("an untouched switch reads as unset",
      (await store.enabled()) === null && (await store.isSet()) === false);

    await store.save(true);
    check("save(true) persists a boolean",
      (await store.enabled()) === true && (await store.isSet()) === true);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    check("the payload carries the format version",
      persisted.version === PROVIDER_VERSION && persisted.enabled === true);

    const reopened = createFileProviderStore({ dir });
    check("a fresh store reads the persisted switch", (await reopened.enabled()) === true);

    await reopened.save(false);
    check("save(false) flips the switch", (await reopened.enabled()) === false);

    writeFileSync(file, "{ this is not json", "utf8");
    const corrupted = createFileProviderStore({ dir });
    check("a corrupted file reads as unset (never true by accident)",
      (await corrupted.enabled()) === null);

    writeFileSync(file, JSON.stringify({ version: 999, enabled: true }), "utf8");
    const foreign = createFileProviderStore({ dir });
    check("a foreign format version reads as unset", (await foreign.enabled()) === null);

    writeFileSync(file, JSON.stringify({ version: PROVIDER_VERSION, enabled: "yes" }), "utf8");
    const junk = createFileProviderStore({ dir });
    check("a non-boolean enabled reads as unset", (await junk.enabled()) === null);

    try {
      await store.save("yes");
      check("save refuses non-boolean input", false);
    } catch {
      check("save refuses non-boolean input", true);
    }

    await reopened.forget();
    check("forget returns to the config default",
      (await reopened.enabled()) === null && (await reopened.isSet()) === false);
  } catch (error) {
    fail("provider switch store", error);
  } finally {
    restoreHome();
    restoreEnv();
  }
}

// --- 11. api key store: env fallback with no service ------------------------
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

// --- 14. redactSecrets: a credential never reaches the panel or a log ------
// The LLM route's `providerState.error` and `ctx.logger.warn` both pass
// through `redactSecrets`, because an HTTP error object's `message` often
// embeds the request headers it was built from. Pin the patterns it must
// catch, and the texts it must leave alone.
{
  try {
    check("a bare sk- key is redacted",
      redactSecrets("cannot build: sk-a1b2c3d4e5f6g7h8") === "cannot build: sk-[REDACTED]",
      redactSecrets("cannot build: sk-a1b2c3d4e5f6g7h8"));
    check("a Bearer token is redacted",
      redactSecrets("Authorization: Bearer abc.def.ghi.jkl") === "Authorization: Bearer [REDACTED]",
      redactSecrets("Authorization: Bearer abc.def.ghi.jkl"));
    check("an Authorization header value is redacted",
      redactSecrets('request failed with "authorization": "sk-xxx123456"')
        === 'request failed with "authorization": "[REDACTED]"',
      redactSecrets('request failed with "authorization": "sk-xxx123456"'));
    check("a JSON api_key pair is redacted",
      redactSecrets('{"api_key":"sk-live-123456789"}') === '{"api_key":"[REDACTED]"}',
      redactSecrets('{"api_key":"sk-live-123456789"}'));
    // Non-secret text passes through unchanged — the gate must not eat
    // diagnostic detail that has nothing to do with credentials.
    check("a credential-free error message passes through",
      redactSecrets("the llm peer packages ship with the Host")
        === "the llm peer packages ship with the Host");
    check("non-string input reads as empty", redactSecrets(undefined) === "" && redactSecrets(null) === "");
  } catch (error) {
    fail("redactSecrets strips credentials", error);
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
