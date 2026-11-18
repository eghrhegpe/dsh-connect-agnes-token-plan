/**
 * ADR-021 — the INTL row's seams (peer-free, zero-network, clean-checkout-safe).
 *
 * The two-site shape: `agnes-token-plan` (CN, untouched) and
 * `agnes-token-plan-intl` (INTL) are two CO-EXISTING provider rows inside one
 * plugin — the sibling plugins' "a site is a namespace" ruling. This suite
 * drives every seam the second row added:
 *
 *   - the three patch keys (`registerProviderIntl` / `consoleBaseIntl` /
 *     `apiBaseIntl`) resolve, stay strict, and default to the 2026-11-18
 *     probed values;
 *   - the provider identity flows from the publisher to the adapter factory
 *     and into the directory row (the CN row keeps calling the factory with
 *     NO `provider` key, byte-compatible with the pre-ADR-021 call);
 *   - the two rows' state files never touch each other (catalog / throttle);
 *   - the two rows' key references never cross (`AGNES_TOKEN_PLAN_API_KEY`
 *     vs `AGNES_TOKEN_PLAN_INTL_API_KEY`);
 *   - the two rows' grants live under two record ids on ONE credentials
 *     service (`agnes-console` vs `agnes-console-intl`) with two account
 *     reference pairs;
 *   - the snapshot's `intl` block is present exactly when the Host assembled
 *     the INTL row, and a fatal INTL failure degrades to its absence
 *     (the CN body stays byte-identical);
 *   - the client's third pill gate is still spelled in (a text pin, the same
 *     family as `contract.test.mjs` §11c's value pin).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installNetworkGuard } from "./peer-roots.mjs";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();

import { resolveSettings, credentialKey, CONFIG_DEFAULTS } from "../src/host/index.ts";
import { LLM_PROVIDER_ID, LLM_PROVIDER_ID_INTL, LLM_DISPLAY_NAME, LLM_DISPLAY_NAME_INTL, toPiDescriptor } from "../src/host/llm-models.ts";
import { createProviderPublisher } from "../src/host/provider-publish.ts";
import { createFileCatalogStore } from "../src/host/catalog-store.ts";
import { createApiKeyStore, API_KEY_REF, API_KEY_REF_INTL } from "../src/host/api-key-store.ts";
import { createFileThrottleStore } from "../src/host/throttle-store.ts";
import { createTokenStore } from "../src/host/token-store.ts";
import { createMemoryThrottleStore } from "../src/host/throttle-store.ts";
import { createCatalogEffects } from "../src/host/catalog-refresh.ts";
import { createMemoryCatalogStore } from "../src/host/catalog-store.ts";
import { buildSnapshotBody } from "../src/host/snapshot-aggregate.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

// --- 1. the three INTL patch keys ----------------------------------------
{
  const { settings, configError } = resolveSettings({});
  check("no config error on an empty config", configError === null, String(configError));
  check("consoleBaseIntl defaults to the 2026-11-18 probed INTL console origin",
    settings.consoleBaseIntl === "https://platform-backend.agnes-ai.com", settings.consoleBaseIntl);
  check("apiBaseIntl defaults to the probed INTL gateway origin + /v1",
    settings.apiBaseIntl === "https://apihub.agnes-ai.com/v1", settings.apiBaseIntl);
  check("registerProviderIntl defaults to OFF (the whole INTL half stays inert)",
    settings.registerProviderIntl === false, String(settings.registerProviderIntl));

  const on = resolveSettings({ registerProviderIntl: true });
  check("registerProviderIntl: true resolves", on.settings.registerProviderIntl === true);
  check("registerProviderIntl is a strict boolean (a string is OFF)",
    resolveSettings({ registerProviderIntl: "true" }).settings.registerProviderIntl === false);

  const trimmed = resolveSettings({
    consoleBaseIntl: "https://platform-backend.agnes-ai.com/",
    apiBaseIntl: "https://apihub.agnes-ai.com/v1/"
  });
  check("the INTL bases get the trailing-slash discipline the CN ones have",
    trimmed.settings.consoleBaseIntl === "https://platform-backend.agnes-ai.com"
      && trimmed.settings.apiBaseIntl === "https://apihub.agnes-ai.com/v1",
    `${trimmed.settings.consoleBaseIntl} / ${trimmed.settings.apiBaseIntl}`);

  // The fallback branch must carry the same three fields (a broken row must
  // not hand a settings consumer an INTL half it cannot read).
  const broken = resolveSettings({ auth: { loginPath: "/x" } });
  check("the fallback branch still carries the three INTL keys",
    broken.settings.consoleBaseIntl === CONFIG_DEFAULTS.consoleBaseIntl
      && broken.settings.apiBaseIntl === CONFIG_DEFAULTS.apiBaseIntl
      && broken.settings.registerProviderIntl === CONFIG_DEFAULTS.registerProviderIntl);
}

// --- 2. the two provider ids ----------------------------------------------
{
  check("the INTL provider id is the slug the picker shows",
    LLM_PROVIDER_ID_INTL === "agnes-token-plan-intl", LLM_PROVIDER_ID_INTL);
  check("the two rows are distinct namespaces",
    LLM_PROVIDER_ID_INTL !== LLM_PROVIDER_ID, `${LLM_PROVIDER_ID} vs ${LLM_PROVIDER_ID_INTL}`);
  check("the INTL display name names the site",
    LLM_DISPLAY_NAME_INTL === "Agnes Token Plan (Intl)", LLM_DISPLAY_NAME_INTL);

  // The descriptor builder's default row stays CN: a pre-ADR-021 call
  // cannot start tagging models for the INTL row.
  const entry = { id: "m1", name: "m1" };
  const cn = toPiDescriptor(entry);
  const intl = toPiDescriptor(entry, { providerId: LLM_PROVIDER_ID_INTL });
  check("toPiDescriptor defaults to the CN row", cn.provider === LLM_PROVIDER_ID, cn.provider);
  check("toPiDescriptor tags the INTL row when asked", intl.provider === LLM_PROVIDER_ID_INTL, intl.provider);
  check("the two rows differ ONLY in the provider tag",
    JSON.stringify({ ...cn, provider: undefined }) === JSON.stringify({ ...intl, provider: undefined }));
}

// --- 3. the publisher carries its row identity to the factory -------------
// A recording factory + a recording llm service: the seam is the shape of
// the calls, not the peer. The CN control proves the pre-ADR-021 factory
// call is unchanged (no `provider` key at all, not `provider: undefined`).
{
  const entry = { id: "m1", name: "m1" };
  const makeLlm = () => {
    const calls = { adapters: [], directoryRows: null };
    return {
      calls,
      registerAdapter: (ids, adapter) => {
        calls.adapters.push(ids);
        return () => {};
      },
      registerConfigurableProviders: (rows) => {
        calls.directoryRows = rows;
        return () => {};
      }
    };
  };
  const intlFactoryCalls = [];
  const cnFactoryCalls = [];
  const intlLlm = makeLlm();
  const cnLlm = makeLlm();

  const intlPublisher = createProviderPublisher({
    settings: { registerProvider: true, apiBase: "https://apihub.agnes-ai.com/v1" },
    panelSwitch: () => Promise.resolve(null),
    loadAdapterModule: async () => ({
      createAgnesAdapter: (args) => {
        intlFactoryCalls.push(args);
        return { adapter: { fake: "intl" }, providerIds: [args.provider?.id ?? LLM_PROVIDER_ID] };
      }
    }),
    // One STABLE service object: the publisher reads the service through the
    // resolver on every publish, and the recorder only means anything when
    // the same object outlives all the reads.
    getLlm: () => intlLlm,
    resolveApiKey: async () => "intl-key",
    provider: { id: LLM_PROVIDER_ID_INTL, name: LLM_DISPLAY_NAME_INTL }
  });
  const intlResult = await intlPublisher.publish([entry], []);
  check("the INTL row registers", intlResult.ok === true, JSON.stringify(intlResult));
  check("the factory received the INTL row identity",
    intlFactoryCalls.length === 1 && intlFactoryCalls[0]?.provider?.id === LLM_PROVIDER_ID_INTL,
    JSON.stringify(intlFactoryCalls.map((c) => c?.provider ?? null)));
  check("the INTL adapter registered under the INTL id",
    intlLlm.calls.adapters.length === 1 && intlLlm.calls.adapters[0][0] === LLM_PROVIDER_ID_INTL,
    JSON.stringify(intlLlm.calls.adapters));
  check("the INTL directory row is the INTL row",
    Array.isArray(intlLlm.calls.directoryRows)
      && intlLlm.calls.directoryRows.some((row) => row.provider === LLM_PROVIDER_ID_INTL),
    JSON.stringify(intlLlm.calls.directoryRows));

  // The CN control: no `provider` dep → the factory call carries no
  // `provider` key (the pre-ADR-021 call, byte-compatible).
  const cnPublisher = createProviderPublisher({
    settings: { registerProvider: true, apiBase: "https://api.agnes-ai.cn/v1" },
    panelSwitch: () => Promise.resolve(null),
    loadAdapterModule: async () => ({
      createAgnesAdapter: (args) => {
        cnFactoryCalls.push(args);
        return { adapter: { fake: "cn" }, providerIds: [LLM_PROVIDER_ID] };
      }
    }),
    getLlm: () => cnLlm,
    resolveApiKey: async () => "cn-key"
  });
  const cnResult = await cnPublisher.publish([entry], []);
  check("the CN row still registers", cnResult.ok === true, JSON.stringify(cnResult));
  check("the CN factory call has NO provider key",
    cnFactoryCalls.length === 1 && "provider" in cnFactoryCalls[0] === false,
    JSON.stringify(Object.keys(cnFactoryCalls[0] ?? {})));
  check("the CN adapter registered under the CN id",
    cnLlm.calls.adapters.length === 1 && cnLlm.calls.adapters[0][0] === LLM_PROVIDER_ID,
    JSON.stringify(cnLlm.calls.adapters));

  // The gate: an off row registers nothing, whatever the catalog says.
  const offLlm = makeLlm();
  const offPublisher = createProviderPublisher({
    settings: { registerProvider: false, apiBase: "https://apihub.agnes-ai.com/v1" },
    panelSwitch: () => Promise.resolve(null),
    loadAdapterModule: async () => ({
      createAgnesAdapter: () => {
        throw new Error("an off row must never build an adapter");
      }
    }),
    getLlm: () => offLlm,
    resolveApiKey: async () => "intl-key",
    provider: { id: LLM_PROVIDER_ID_INTL, name: LLM_DISPLAY_NAME_INTL }
  });
  const offResult = await offPublisher.publish([entry], []);
  // An off row is the "skipped" publish: nothing is built (the factory never
  // runs) and no registration is released or made — the row simply stays
  // absent, which is the whole point of a second row that is off.
  check("an off INTL row is a skipped no-op (no build, no registration)",
    offResult.ok === true && offResult.skipped === true && offLlm.calls.adapters.length === 0,
    JSON.stringify(offResult));
}

// --- 4. the two catalog files ---------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "agnes-intl-catalog-"));
  try {
    const cn = createFileCatalogStore({ dir });
    const intl = createFileCatalogStore({ dir, file: "catalog.intl.json" });

    await cn.replace([{ id: "cn-model" }], []);
    check("the CN row writes catalog.json",
      existsSync(join(dir, "catalog.json")), JSON.stringify(await cn.list()));
    check("the INTL row has not leaked into the CN file",
      JSON.stringify(await cn.list()) === JSON.stringify([{ id: "cn-model" }]));

    await intl.replace([{ id: "intl-model" }], []);
    check("the INTL row writes catalog.intl.json",
      existsSync(join(dir, "catalog.intl.json")), JSON.stringify(await intl.list()));
    check("the INTL file stayed out of the CN file",
      JSON.stringify(await cn.list()) === JSON.stringify([{ id: "cn-model" }]));
    check("the two rows list independently",
      JSON.stringify(await intl.list()) === JSON.stringify([{ id: "intl-model" }]));

    // The CN clear must not reach the INTL record and vice versa.
    await cn.clear();
    check("a CN clear leaves the INTL record",
      JSON.stringify(await intl.list()) === JSON.stringify([{ id: "intl-model" }]));
    await intl.clear();
    check("an INTL clear leaves the (already cleared) CN record absent",
      JSON.stringify(await cn.list()) === "[]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- 5. the two key references ---------------------------------------------
{
  const env = {
    [API_KEY_REF]: "cn-key",
    [API_KEY_REF_INTL]: "intl-key"
  };
  const cn = createApiKeyStore({ credentials: null, env });
  const intl = createApiKeyStore({ credentials: null, env, ref: API_KEY_REF_INTL });

  const cnResolved = await cn.resolve();
  check("the CN row reads its own reference",
    cnResolved.value === "cn-key" && cnResolved.source === "env", JSON.stringify(cnResolved));
  const intlResolved = await intl.resolve();
  check("the INTL row reads its own reference",
    intlResolved.value === "intl-key" && intlResolved.source === "env", JSON.stringify(intlResolved));

  // A save on the INTL row (no credentials service: the memory vault) must
  // not shadow the CN row's stored value or read the CN reference.
  await intl.save("intl-rotated");
  check("an INTL save shadows the INTL env value only",
    (await intl.resolve()).value === "intl-rotated" && (await cn.resolve()).value === "cn-key");

  await intl.forget();
  check("an INTL forget falls back to the INTL env reference",
    (await intl.resolve()).value === "intl-key" && (await cn.resolve()).value === "cn-key");
}

// --- 6. the two throttle files ----------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "agnes-intl-throttle-"));
  try {
    const cn = createFileThrottleStore({ dir });
    const intl = createFileThrottleStore({ dir, file: "throttle.intl.json" });

    check("a fresh shared directory reads no throttle for either row",
      (await cn.read()) === null && (await intl.read()) === null);

    const until = Date.now() + 60_000;
    await intl.write({ code: "account_locked", parked: false, until, attempt: 1 });
    check("the INTL write lands in its own file",
      existsSync(join(dir, "throttle.intl.json")) && !existsSync(join(dir, "throttle.json")));
    const intlRead = await intl.read();
    check("the INTL row reads back its own deadline",
      intlRead !== null && intlRead.until === until, JSON.stringify(intlRead));
    check("the CN row is UNAWARE of the INTL lockout",
      (await cn.read()) === null, JSON.stringify(await cn.read()));

    await cn.write({ code: "rate_limited", parked: false, until: Date.now() + 30_000, attempt: 1 });
    check("the two deadlines coexist in two files",
      (await cn.read()) !== null && (await intl.read()) !== null);

    await intl.clear();
    check("an INTL clear touches only the INTL file",
      (await intl.read()) === null && (await cn.read()) !== null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- 7. two grants on one credentials service --------------------------------
// ONE fake service (a shared credentials service is the production shape),
// TWO stores pointed at it with different record ids and account references:
// the CN login must land under the CN key only, and the INTL login under the
// INTL key only — the whole of PITFALLS §29 expressed as record addresses.
{
  const SCOPE = "dsh-connect-agnes-token-plan";
  const CN_KEY = credentialKey(SCOPE, "agnes-console");
  const INTL_KEY = credentialKey(SCOPE, "agnes-console-intl");

  const records = new Map();
  const refs = new Map();
  const fakeService = {
    records,
    async readRecord(k) { return records.get(k); },
    async modifyRecord(k, mutate) {
      const next = await mutate(records.get(k));
      if (next !== undefined) records.set(k, next);
      return records.get(k);
    },
    async deleteRecord(k) { records.delete(k); },
    async resolve(ref) {
      const value = refs.get(ref);
      return typeof value === "string" && value.length > 0 ? { value, source: "memory" } : undefined;
    },
    async set(ref, value) { refs.set(ref, value); },
    async unset(ref) { refs.delete(ref); }
  };

  const jwt = (site, minutes = 60) =>
    `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + minutes * 60 })).toString("base64url")}.sig-${site}`;
  const authStub = (site) => ({
    login: async () => ({ accessToken: jwt(site), refreshToken: "", expiresIn: 3600 }),
    refresh: async () => { throw new Error("no refresh endpoint (Agnes one-hop)"); }
  });

  // ONE shared environment carrying BOTH sites' names: the reference NAME is
  // the only thing that keeps the two rows apart, so a store that reaches
  // across the name would show up in its `state()` here.
  const sharedEnv = {
    AGNES_USERNAME: "cn-user",
    AGNES_PASSWORD: "cn-pass",
    AGNES_USERNAME_INTL: "intl-user",
    AGNES_PASSWORD_INTL: "intl-pass"
  };
  const cnStore = createTokenStore({
    credentials: fakeService,
    auth: authStub("cn"),
    env: sharedEnv,
    credentialKey,
    throttleStore: createMemoryThrottleStore()
  });
  const intlStore = createTokenStore({
    credentials: fakeService,
    auth: authStub("intl"),
    env: sharedEnv,
    credentialKey,
    throttleStore: createMemoryThrottleStore(),
    recordId: "agnes-console-intl",
    throttleId: "agnes-console-intl-throttle",
    usernameRef: "AGNES_USERNAME_INTL",
    passwordRef: "AGNES_PASSWORD_INTL"
  });

  const cnToken = await cnStore.getToken();
  check("the CN env-bootstrap login lands under the CN record",
    typeof cnToken === "string" && records.get(CN_KEY) !== undefined, JSON.stringify(cnToken));
  check("the CN login did not touch the INTL record",
    records.get(INTL_KEY) === undefined);

  const intlToken = await intlStore.getToken();
  check("the INTL env-bootstrap login lands under the INTL record",
    typeof intlToken === "string" && records.get(INTL_KEY) !== undefined, JSON.stringify(intlToken));
  check("the two grants carry different tokens (per-site logins)",
    records.get(CN_KEY)?.payload?.accessToken !== records.get(INTL_KEY)?.payload?.accessToken);
  check("the INTL login did not rotate or read the CN grant",
    records.get(CN_KEY)?.payload?.accessToken === cnToken);

  // Each row's account view is its own: with one shared env carrying both
  // sites' names, the CN store must report CN facts and the INTL store INTL
  // facts — the reference name is what the isolation rests on.
  const cnState = await cnStore.state();
  const intlState = await intlStore.state();
  check("the CN row reports its own account facts (hasAccount + auto-recover armed from the CN names)",
    cnState.hasAccount === true && cnState.autoRecoverArmed === true, JSON.stringify(cnState));
  check("the INTL row reports ITS OWN facts (armed only from the _INTL password name)",
    intlState.hasAccount === true && intlState.autoRecoverArmed === true, JSON.stringify(intlState));
  check("neither row is in the needs-account state once its own env names are present",
    cnState.needsAccount === false && intlState.needsAccount === false);

  // Forgetting the INTL account clears only the INTL references (the red
  // line's env values are not touched by `forgetAccount` — it sweeps the
  // persisted ones only).
  await fakeService.set("AGNES_USERNAME_INTL", "intl-persisted");
  await fakeService.set("AGNES_USERNAME", "cn-persisted");
  await intlStore.forgetAccount();
  check("an INTL forgetAccount clears only the INTL username reference",
    refs.get("AGNES_USERNAME_INTL") === undefined && refs.get("AGNES_USERNAME") === "cn-persisted");
}

// --- 8. the snapshot's intl block --------------------------------------------
// Every seam faked: no console account, no key, no llm service. The CN body
// is the pre-ADR-021 shape plus (and only plus) the `intl` block when the
// INTL row was assembled — and a CN-only call carries no `intl` key at all.
{
  const { settings } = resolveSettings({ registerProviderIntl: true });
  const cache = new Map();
  const inflight = new Map();

  const fakeLlm = () => ({
    registerAdapter: () => () => {},
    registerConfigurableProviders: () => () => {}
  });
  const noopKey = async () => "";
  const cnAuth = { login: async () => { throw new Error("unreachable in this suite"); } };
  // A COMPLETE-but-empty credentials service: every method the store may call
  // exists and answers "nothing". A method that is merely ABSENT makes
  // `readUsername` reject (calling `undefined`), which turns the auth block
  // into a swallowed `null` — indistinguishable from a Host without a
  // service, and exactly the shape this suite must not manufacture.
  const emptyService = () => ({
    async readRecord() { return undefined; },
    async modifyRecord(_k, mutate) { return mutate(undefined); },
    async deleteRecord() {},
    async resolve() { return undefined; },
    async set() {},
    async unset() {}
  });

  const cnTokenStore = createTokenStore({
    credentials: emptyService(),
    auth: cnAuth,
    env: {},
    credentialKey,
    throttleStore: createMemoryThrottleStore()
  });
  const cnApiKeyStore = createApiKeyStore({ credentials: null, env: {} });
  const cnCatalogStore = createMemoryCatalogStore();
  const cnPublisher = createProviderPublisher({
    settings,
    panelSwitch: () => Promise.resolve(null),
    loadAdapterModule: async () => { throw new Error("no adapter build in this suite"); },
    getLlm: fakeLlm,
    resolveApiKey: noopKey
  });
  const cnCatalogEffects = createCatalogEffects({
    settings,
    cache,
    inflight,
    apiKeyStore: cnApiKeyStore,
    catalogStore: cnCatalogStore,
    publisher: cnPublisher,
    fetchCatalog: async () => null
  });

  // The INTL row's stores, the same shape pointed at the INTL identities.
  const intlTokenStore = createTokenStore({
    credentials: emptyService(),
    auth: cnAuth,
    env: {},
    credentialKey,
    throttleStore: createMemoryThrottleStore(),
    recordId: "agnes-console-intl",
    throttleId: "agnes-console-intl-throttle",
    usernameRef: "AGNES_USERNAME_INTL",
    passwordRef: "AGNES_PASSWORD_INTL"
  });
  const intlApiKeyStore = createApiKeyStore({ credentials: null, env: {} });
  const intlCatalogStore = createMemoryCatalogStore();
  const intlPublisher = createProviderPublisher({
    settings: { ...settings, apiBase: settings.apiBaseIntl },
    panelSwitch: () => Promise.resolve(null),
    loadAdapterModule: async () => { throw new Error("no adapter build in this suite"); },
    getLlm: fakeLlm,
    resolveApiKey: noopKey,
    provider: { id: LLM_PROVIDER_ID_INTL, name: LLM_DISPLAY_NAME_INTL }
  });
  const intlCatalogEffects = createCatalogEffects({
    settings: { ...settings, apiBase: settings.apiBaseIntl },
    cache,
    inflight,
    apiKeyStore: intlApiKeyStore,
    catalogStore: intlCatalogStore,
    publisher: intlPublisher,
    fetchCatalog: async () => null
  });

  const panelSwitch = () => Promise.resolve(null);

  const withIntl = await buildSnapshotBody({
    settings,
    cache,
    inflight,
    tokenStore: cnTokenStore,
    apiKeyStore: cnApiKeyStore,
    publisher: cnPublisher,
    catalogStore: cnCatalogStore,
    catalogEffects: cnCatalogEffects,
    panelSwitch,
    intl: {
      tokenStore: intlTokenStore,
      apiKeyStore: intlApiKeyStore,
      publisher: intlPublisher,
      catalogStore: intlCatalogStore,
      catalogEffects: intlCatalogEffects
    }
  });
  check("an assembled INTL row adds the intl block",
    withIntl.intl !== undefined, JSON.stringify(Object.keys(withIntl)));
  check("the intl block names its own site base",
    withIntl.intl?.consoleBase === settings.consoleBaseIntl, String(withIntl.intl?.consoleBase));
  check("the intl quota block degrades soft, like the CN one (no account, no network)",
    withIntl.intl?.quota?.consoleConnected === false
      && withIntl.quota?.consoleConnected === false,
    JSON.stringify({ cn: withIntl.quota?.consoleConnected, intl: withIntl.intl?.quota?.consoleConnected }));
  check("the intl auth block is the INTL row's own login state",
    withIntl.intl?.auth?.hasAccount === false && withIntl.intl?.auth?.configured === false,
    JSON.stringify(withIntl.intl?.auth));
  check("the intl llm block carries the INTL row identity",
    withIntl.intl?.llm?.providerId === LLM_PROVIDER_ID_INTL
      && withIntl.intl?.llm?.providerRegistered === false,
    JSON.stringify(withIntl.intl?.llm));
  check("the CN llm block is untouched by the INTL row",
    withIntl.llm?.providerId === LLM_PROVIDER_ID, JSON.stringify(withIntl.llm?.providerId));

  // The CN-only call: the pre-ADR-021 byte shape (no `intl` key at all).
  const cnOnly = await buildSnapshotBody({
    settings,
    cache,
    inflight,
    tokenStore: cnTokenStore,
    apiKeyStore: cnApiKeyStore,
    publisher: cnPublisher,
    catalogStore: cnCatalogStore,
    catalogEffects: cnCatalogEffects,
    panelSwitch
  });
  check("a CN-only snapshot carries NO intl key (pre-ADR-021 byte-compat)",
    "intl" in cnOnly === false, JSON.stringify(Object.keys(cnOnly)));
  check("the CN-only body still degrades every console source softly",
    cnOnly.ok === true && cnOnly.quota?.consoleConnected === false);
}

// --- 9. the client's third pill gate is spelled in ---------------------------
{
  const pillSrc = readFileSync(join(ROOT, "src", "client", "composer-usage-pill.ts"), "utf8");
  check("the pill imports the INTL gate constant",
    /import\s*{[^}]*PROVIDER_ID_INTL[^}]*}\s*from\s*"\.\/const\.ts"/.test(pillSrc));
  check("the pill gates a mount on the INTL provider id",
    /provider === PROVIDER_ID_INTL/.test(pillSrc));
  check("the pill reads the INTL row through the snapshot's intl block",
    /reading\.data\?\.intl\?\.quota/.test(pillSrc));
  check("the INTL reading is rendered with its own prefix key",
    pillSrc.includes("composer.planPrefixIntl"));

  const i18nSrc = readFileSync(join(ROOT, "src", "client", "i18n.ts"), "utf8");
  const zhBlock = i18nSrc.slice(0, i18nSrc.indexOf("export const en"));
  check("the zh and en dictionaries both carry the prefix (key-set mirror)",
    zhBlock.includes('"composer.planPrefixIntl"') && i18nSrc.includes('"composer.planPrefixIntl": "Intl Token Plan"'));
}

// --- 10. the refresh gate and the switch-gated batch (the "off is inert" half)
// Round two of ADR-021: the row is always ASSEMBLED and the switch is what
// keeps it quiet. Two seams make that true: the catalogue writer's `gate`
// dep (an off tick does nothing at all) and the snapshot batch, which runs
// only for a resolved-ON row — an off row's block reports `quota: null`, a
// missing number with a reason, while its `llm` half still says where the
// switch came from.
{
  const { settings } = resolveSettings({ registerProviderIntl: false });
  const cache = new Map();
  const inflight = new Map();

  const fakeLlm = () => ({
    registerAdapter: () => () => {},
    registerConfigurableProviders: () => () => {}
  });
  const noopKey = async () => "";
  const cnAuth = { login: async () => { throw new Error("unreachable in this suite"); } };
  const emptyService = () => ({
    async readRecord() { return undefined; },
    async modifyRecord(_k, mutate) { return mutate(undefined); },
    async deleteRecord() {},
    async resolve() { return undefined; },
    async set() {},
    async unset() {}
  });
  const cnTokenStore = createTokenStore({
    credentials: emptyService(),
    auth: cnAuth,
    env: {},
    credentialKey,
    throttleStore: createMemoryThrottleStore()
  });
  const cnApiKeyStore = createApiKeyStore({ credentials: null, env: {} });
  const cnCatalogStore = createMemoryCatalogStore();
  const cnPublisher = createProviderPublisher({
    settings,
    panelSwitch: () => Promise.resolve(null),
    loadAdapterModule: async () => { throw new Error("no adapter build in this suite"); },
    getLlm: fakeLlm,
    resolveApiKey: noopKey
  });
  const cnCatalogEffects = createCatalogEffects({
    settings, cache, inflight,
    apiKeyStore: cnApiKeyStore,
    catalogStore: cnCatalogStore,
    publisher: cnPublisher,
    fetchCatalog: async () => null
  });

  // The INTL row's own stores, with a CALLING fetch so the gate is measurable.
  let fetchCalls = 0;
  const intlTokenStore = createTokenStore({
    credentials: emptyService(),
    auth: cnAuth,
    env: {},
    credentialKey,
    throttleStore: createMemoryThrottleStore(),
    recordId: "agnes-console-intl",
    throttleId: "agnes-console-intl-throttle",
    usernameRef: "AGNES_USERNAME_INTL",
    passwordRef: "AGNES_PASSWORD_INTL"
  });
  const intlApiKeyStore = createApiKeyStore({ credentials: null, env: {}, ref: API_KEY_REF_INTL });
  const intlCatalogStore = createMemoryCatalogStore({ file: "catalog.intl.json" });
  const intlPublisher = createProviderPublisher({
    settings: { ...settings, apiBase: settings.apiBaseIntl },
    panelSwitch: () => Promise.resolve(null),
    loadAdapterModule: async () => { throw new Error("no adapter build in this suite"); },
    getLlm: fakeLlm,
    resolveApiKey: noopKey,
    provider: { id: LLM_PROVIDER_ID_INTL, name: LLM_DISPLAY_NAME_INTL }
  });
  const offGate = createCatalogEffects({
    settings: { ...settings, apiBase: settings.apiBaseIntl },
    cache, inflight,
    apiKeyStore: intlApiKeyStore,
    catalogStore: intlCatalogStore,
    publisher: intlPublisher,
    fetchCatalog: async () => { fetchCalls += 1; return null; },
    gate: async () => false
  });
  // A key the row CAN resolve, so a passing gate must reach the fetch: the
  // gate question and the key question are different exits of `refresh`.
  const keyedApiKeyStore = createApiKeyStore({
    credentials: null,
    env: {},
    ref: API_KEY_REF_INTL
  });
  // A SAVED key through the store's own seam: without one `resolve()` answers
  // "" and the no-key exit swallows the fetch even with a passing gate, which
  // would make this check test the key path, not the gate. Awaited — the
  // refresh below must not race the save settling.
  await keyedApiKeyStore.save("sk-intl-gate-check");

  const onGate = createCatalogEffects({
    settings: { ...settings, apiBase: settings.apiBaseIntl },
    cache, inflight,
    apiKeyStore: keyedApiKeyStore,
    catalogStore: intlCatalogStore,
    publisher: intlPublisher,
    fetchCatalog: async () => { fetchCalls += 1; return null; },
    gate: async () => true
  });

  await offGate.refresh();
  check("a gated-off refresh performs no catalogue fetch at all",
    fetchCalls === 0, `fetchCalls=${fetchCalls}`);
  await onGate.refresh();
  check("a gated-on refresh with a resolvable key reaches the fetch",
    fetchCalls === 1, `fetchCalls=${fetchCalls}`);

  // The snapshot batch: an off row's block reports `quota: null` (no batch
  // ran) while its `llm` half still carries the switch's source; an on row
  // runs the batch and degrades its four sources softly, exactly like CN.
  const batchBase = {
    settings,
    cache,
    inflight,
    tokenStore: cnTokenStore,
    apiKeyStore: cnApiKeyStore,
    publisher: cnPublisher,
    catalogStore: cnCatalogStore,
    catalogEffects: cnCatalogEffects,
    panelSwitch: () => Promise.resolve(null)
  };
  const offBody = await buildSnapshotBody({
    ...batchBase,
    intl: {
      tokenStore: intlTokenStore,
      apiKeyStore: intlApiKeyStore,
      publisher: intlPublisher,
      catalogStore: intlCatalogStore,
      catalogEffects: offGate,
      providerStore: { enabled: () => Promise.resolve(false) }
    }
  });
  check("an off row's intl block reports quota: null, not a zero block",
    offBody.intl !== undefined && offBody.intl.quota === null,
    JSON.stringify(offBody.intl?.quota));
  check("an off row's llm half says the switch is panel-saved-off",
    offBody.intl?.llm?.registerProvider === false && offBody.intl?.llm?.registerSource === "panel",
    JSON.stringify(offBody.intl?.llm));
  check("an off row's auth block is still the row's own login state",
    offBody.intl?.auth?.configured === false, JSON.stringify(offBody.intl?.auth));

  const onBody = await buildSnapshotBody({
    ...batchBase,
    intl: {
      tokenStore: intlTokenStore,
      apiKeyStore: intlApiKeyStore,
      publisher: intlPublisher,
      catalogStore: intlCatalogStore,
      catalogEffects: offGate,
      providerStore: { enabled: () => Promise.resolve(true) }
    }
  });
  check("an on row runs its batch and degrades it softly",
    onBody.intl?.quota !== null && onBody.intl?.quota?.consoleConnected === false,
    JSON.stringify(onBody.intl?.quota));
  check("an on row's llm half says the switch is panel-saved-on",
    onBody.intl?.llm?.registerProvider === true && onBody.intl?.llm?.registerSource === "panel",
    JSON.stringify(onBody.intl?.llm));
}

releaseNetworkGuard();
console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} intl-provider check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} intl-provider checks passed`);
