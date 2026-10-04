/**
 * publish-core 的离线检查 —— 共享控制面自己的契约钉子。
 *
 * 这两个 publisher 此前各写一份，靠「一个文件里的注释指着另一个」保持一致；
 * 一旦某一边漏了半句（`!llmAvailable` 分支没清 `state.built`），坏的是**回滚
 * 路径**：它只在别处已经出错时才跑，所以是发现分叉的最坏时机（PITFALLS §18/§19）。
 * 收敛成一份之后，语义必须就地钉住，而不是靠两个 publisher 各自的套件间接覆盖
 * —— 间接覆盖的问题正是：两边都绿，共享层里那半句仍可能谁都没测到。
 *
 * 本套件钉四组：
 *   1. 队列（串行、慢者不再赢、被拒的链节不毒后续）
 *   2. 释放与注销（幂等、容忍抛错、**`built` 必须一起清**）
 *   3. 注册与回滚（单点 registerPair、失败还原上一对、domain 字段交回调还原）
 *   4. 构建失败的描述与告警（脱敏、ERR_MODULE_NOT_FOUND 的补救提示）
 */
import { installNetworkGuard } from "./peer-roots.mjs";
import { name as pluginName } from "../src/host/host-config.ts";
import {
  ADAPTERS_UPDATED_EVENT,
  NO_LLM_SERVICE_ERROR,
  BAD_FACTORY_SHAPE_ERROR,
  createPublishQueue,
  createPairReleaser,
  registerProviderPair,
  createAdapterFactoryResolver,
  isBuiltAdapter,
  describeBuildFailure,
  warnBuildFailure,
  resolveRegistrationService,
  unregister,
  swapRegistration,
  emitAdaptersUpdated
} from "../src/host/publish-core.ts";
import { createProviderPublisher, catalogSignature } from "../src/host/provider-publish.ts";
import { createAgnescodePublisher } from "../src/host/agnescode-publish.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}
function section(label) {
  results.push({ name: `— ${label} —`, pass: true, detail: "", banner: true });
}

installNetworkGuard();

/** One tick of the event loop — enough for every microtask behind it to run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A publisher state with exactly the shared slice, nothing domain-specific. */
const makeState = (over = {}) => ({
  llmAvailable: false,
  registered: false,
  error: null,
  releaseAdapter: null,
  releaseDirectory: null,
  built: null,
  ...over
});

/** A fake `llm` registration service that records every call it receives. */
const makeLlm = () => {
  const calls = [];
  return {
    calls,
    registerAdapter(ids, adapter) {
      calls.push(["adapter", ...ids]);
      return () => calls.push(["release-adapter", adapter]);
    },
    registerConfigurableProviders(rows) {
      calls.push(["directory", rows[0].provider]);
      return () => calls.push(["release-directory"]);
    }
  };
};

// ── 1. 队列：串行、慢者不再赢、被拒的链节不毒后续 ──────────────────────────
{
  section("publish queue");
  const queue = createPublishQueue();
  const order = [];
  let openFirst;
  const gate = new Promise((resolve) => { openFirst = resolve; });

  const first = queue.enqueue(async () => {
    order.push("first:start");
    await gate;
    order.push("first:end");
    return "first";
  });
  const second = queue.enqueue(async () => {
    order.push("second:start");
    return "second";
  });

  await settle();
  check("a queued publish does not start while one is in flight",
    order.join(",") === "first:start", order.join(","));

  openFirst();
  check("the in-flight publish resolves with its own value", (await first) === "first");
  check("the queued publish runs only after the first settles", (await second) === "second");
  check("the queue really serialised them (no interleaving)",
    order.join(",") === "first:start,first:end,second:start", order.join(","));

  // A rejected link must not poison the ones behind it: the queue's own chain
  // is healed by the `.then(ok, err)` swing, so the next publish still runs.
  const rejecting = createPublishQueue();
  let seen = "";
  const boom = rejecting.enqueue(async () => { throw new Error("boom"); });
  const after = rejecting.enqueue(async () => "after");
  await boom.catch((error) => { seen = error.message; });
  check("a rejected publish rejects its own promise", seen === "boom", seen);
  check("a rejected publish does not poison the next one", (await after) === "after");

  check("a fresh queue is not disposed", rejecting.isDisposed() === false);
  rejecting.dispose();
  check("dispose flips the gate", rejecting.isDisposed() === true);
}

// ── 2. 释放与注销 ──────────────────────────────────────────────────────────
{
  section("release + unregister");
  const state = makeState();
  const log = [];
  state.releaseAdapter = () => log.push("adapter");
  state.releaseDirectory = () => log.push("directory");
  const release = createPairReleaser(state);
  release();
  check("both release functions ran", log.join(",") === "adapter,directory", log.join(","));
  check("the release slots were cleared",
    state.releaseAdapter === null && state.releaseDirectory === null);
  release();
  check("release is idempotent (a second call re-releases nothing)",
    log.join(",") === "adapter,directory", log.join(","));

  // A throwing release must not swallow the one behind it.
  const throwing = makeState();
  const survived = [];
  throwing.releaseAdapter = () => { throw new Error("already gone"); };
  throwing.releaseDirectory = () => survived.push("directory");
  createPairReleaser(throwing)();
  check("a throwing release does not abort the next one",
    survived.join(",") === "directory", survived.join(","));

  const target = makeState({
    registered: true,
    built: { providerIds: ["p"], adapter: {} },
    releaseAdapter: () => {}
  });
  const outcome = unregister({ state: target, release: () => {}, error: "not_configured" });
  check("unregister clears registered + built and records the reason",
    target.registered === false && target.built === null && target.error === "not_configured");
  check("unregister reports a skipped publish", outcome.ok === true && outcome.skipped === true);

  const quiet = makeState({ registered: true, built: { providerIds: ["p"], adapter: {} } });
  unregister({ state: quiet, release: () => {} });
  check("unregister defaults the reason to null (the wanted absence)",
    quiet.error === null && quiet.built === null);
}

// ── 2b. `built` 必须随注销一起清 —— 这正是收敛修掉的那处 ──────────────────
// 一个残留的 `built` 会成为下一次 publish 的回滚目标，于是「回滚」把一只
// 释放函数已经被调用过的适配器重新注册上去。三处「必须没有注册」的分支
// 都要经过 unregister，包括 resolveRegistrationService 里「Host 没有 llm」那处。
{
  section("stale `built` is not left standing");
  const state = makeState({
    registered: true,
    built: { providerIds: ["p"], adapter: { v: 1 } },
    releaseAdapter: () => {}
  });
  const released = [];
  const llm = resolveRegistrationService({
    state,
    getLlm: () => null,
    release: () => released.push("released")
  });
  check("no llm service resolves to null", llm === null);
  check("the pair was released rather than left registered",
    released.length === 1 && state.registered === false, JSON.stringify({ released, registered: state.registered }));
  check("the reason is the shared constant", state.error === NO_LLM_SERVICE_ERROR, String(state.error));
  check("the stale built adapter was cleared (no dead rollback target)",
    state.built === null, JSON.stringify(state.built));
}

// ── 3. 注册与回滚 ──────────────────────────────────────────────────────────
{
  section("registerProviderPair");
  const llm = makeLlm();
  const target = makeState();
  const built = { providerIds: ["agnes-token-plan"], adapter: { fake: true } };
  registerProviderPair(llm, built, target, { providerId: "agnes-token-plan", displayName: "Agnes Token Plan" });
  check("the adapter pair is registered under its provider ids",
    llm.calls[0]?.[0] === "adapter" && llm.calls[0]?.[1] === "agnes-token-plan",
    JSON.stringify(llm.calls));
  check("the directory row is registered for this provider",
    llm.calls[1]?.[0] === "directory" && llm.calls[1]?.[1] === "agnes-token-plan",
    JSON.stringify(llm.calls));
  check("both release functions land on the target",
    typeof target.releaseAdapter === "function" && typeof target.releaseDirectory === "function");

  // An older runtime without the directory API still gets models.
  const bare = { calls: [], registerAdapter: () => () => {} };
  const bareTarget = makeState();
  registerProviderPair(bare, built, bareTarget, { providerId: "p", displayName: "P" });
  check("a runtime without registerConfigurableProviders still registers the adapter",
    typeof bareTarget.releaseAdapter === "function" && bareTarget.releaseDirectory === null);
}

{
  section("swapRegistration");
  const llm = makeLlm();
  const state = makeState();
  const built = { providerIds: ["p"], adapter: { v: 2 } };
  const events = [];
  const ok = swapRegistration({
    llm,
    built,
    previousBuilt: null,
    state,
    release: createPairReleaser(state),
    registerPair: (l, b, t) => registerProviderPair(l, b, t, { providerId: "p", displayName: "P" }),
    emit: (event) => events.push(event)
  });
  check("a successful swap records built + registered and clears the error",
    ok.ok === true && state.built === built && state.registered === true && state.error === null);
  check("a successful swap emits the adapters-updated event",
    events.join(",") === ADAPTERS_UPDATED_EVENT, events.join(","));

  // The rollback: the new registration throws AFTER the old pair was released.
  // The FIRST call is the swap under test (it fails); the SECOND is the
  // rollback putting the previous pair back (it must succeed).
  const rollbackLlm = makeLlm();
  let attempt = 0;
  rollbackLlm.registerAdapter = (ids, adapter) => {
    attempt += 1;
    rollbackLlm.calls.push(["adapter", ...ids, `attempt:${attempt}`]);
    if (attempt === 1) throw new Error("register failed: sk-abcdefgh12345678");
    return () => rollbackLlm.calls.push(["release-adapter"]);
  };
  const previous = { providerIds: ["p"], adapter: { v: 1 } };
  const restored = [];
  const rollbackState = makeState({
    registered: true,
    built: previous,
    releaseAdapter: () => {}
  });
  const failed = swapRegistration({
    llm: rollbackLlm,
    built: { providerIds: ["p"], adapter: { v: 2 } },
    previousBuilt: previous,
    state: rollbackState,
    release: createPairReleaser(rollbackState),
    registerPair: (l, b, t) => registerProviderPair(l, b, t, { providerId: "p", displayName: "P" }),
    emit: () => {},
    onRollback: () => restored.push("domain")
  });
  check("a failed swap reports the failure", failed.ok === false);
  check("a failed swap restores the pair that was serving",
    rollbackState.built === previous && rollbackState.registered === true && attempt === 2,
    JSON.stringify({ registered: rollbackState.registered, built: rollbackState.built, attempt }));
  check("a failed swap restores the domain fields through the callback",
    restored.join(",") === "domain", restored.join(","));
  check("a failed swap records a redacted reason",
    typeof rollbackState.error === "string"
      && rollbackState.error.includes("sk-[REDACTED]")
      && rollbackState.error.includes("abcdefgh") === false,
    String(rollbackState.error));

  // Nothing was serving: the failed swap must leave nothing registered.
  const emptyState = makeState();
  const emptyFail = swapRegistration({
    llm: { registerAdapter: () => { throw new Error("nope"); } },
    built: { providerIds: ["p"], adapter: {} },
    previousBuilt: null,
    state: emptyState,
    release: createPairReleaser(emptyState),
    registerPair: (l, b, t) => registerProviderPair(l, b, t, { providerId: "p", displayName: "P" }),
    emit: () => {}
  });
  check("a failed first swap leaves nothing registered",
    emptyFail.ok === false && emptyState.registered === false && emptyState.built === null);

  // The old pair cannot be put back either: fail closed, not half-open.
  const doomedState = makeState({ registered: true, built: { providerIds: ["p"], adapter: { v: 1 } } });
  let doomedAttempt = 0;
  const doomedFail = swapRegistration({
    llm: {
      registerAdapter: () => { doomedAttempt += 1; throw new Error("always fails"); },
      registerConfigurableProviders: () => () => {}
    },
    built: { providerIds: ["p"], adapter: { v: 2 } },
    previousBuilt: { providerIds: ["p"], adapter: { v: 1 } },
    state: doomedState,
    release: createPairReleaser(doomedState),
    registerPair: (l, b, t) => registerProviderPair(l, b, t, { providerId: "p", displayName: "P" }),
    emit: () => {}
  });
  check("when even the rollback fails, nothing is claimed to be registered",
    doomedFail.ok === false && doomedState.registered === false && doomedState.built === null,
    JSON.stringify({ registered: doomedState.registered, built: doomedState.built }));

  // A Host that refuses the event still has the registration.
  const emitState = makeState();
  const swallowed = swapRegistration({
    llm: makeLlm(),
    built: { providerIds: ["p"], adapter: {} },
    previousBuilt: null,
    state: emitState,
    release: createPairReleaser(emitState),
    registerPair: (l, b, t) => registerProviderPair(l, b, t, { providerId: "p", displayName: "P" }),
    emit: () => { throw new Error("no listeners"); }
  });
  check("a refusing emit does not fail the publish", swallowed.ok === true && emitState.registered === true);

  let emitThrew = false;
  try { emitAdaptersUpdated(() => { throw new Error("no listeners"); }); } catch { emitThrew = true; }
  check("emitAdaptersUpdated swallows a refusing emitter", emitThrew === false);
}

// ── 5. 两个 publisher 薄壳：同一份身份回滚清单 ─────────────────────────────
// `swapRegistration`'s own comment says the identity "must not keep pointing at
// a set we failed to publish" — and that promise is only kept on the ONE path
// its `onRollback` runs on. A BUILD failure returns before the swap is even
// attempted, so for years both publishers advanced their identity early and
// left it there: the previous adapter kept serving while the snapshot quoted a
// catalogue the Host had never been handed (PITFALLS §42).
//
// Both thin shells get the SAME list, because the bug was a copy that drifted
// — the assertion that would have caught it existed on neither side, and the
// one rollback assertion that did exist published identical inputs twice, so
// "restored" and "left advanced" were indistinguishable. Each case below
// therefore publishes a DIFFERENT second payload and reads the identity back.
{
  section("both publishers: a failed build restores the identity (not just the pair)");

  /** The two publishers differ in payload shape; this is the only adapter. */
  const SHELLS = [
    {
      label: "Token Plan",
      create: (deps) => createProviderPublisher({
        settings: { registerProvider: true, apiBase: "https://api.agnes-ai.cn/v1" },
        ...deps
      }),
      first: [[{ id: "agnes-3.0-flash", vision: false }], []],
      second: [[{ id: "agnes-2.5-pro", vision: true }], ["agnes-2.5-pro"]],
      identityOf: (s) => ({ a: s.entries, b: s.enabledIds })
    },
    {
      label: "AgnesCode",
      create: (deps) => createAgnescodePublisher(deps),
      first: [[{ id: "agnes-3.0-flash" }], "https://bff-one.agnes-ai.cn/v1"],
      second: [[{ id: "agnes-2.5-pro" }], "https://bff-two.agnes-ai.cn/v1"],
      identityOf: (s) => ({ a: s.rows, b: s.bffBase })
    }
  ];

  for (const shell of SHELLS) {
    const calls = [];
    const llm = {
      registerAdapter(ids, adapter) { calls.push(["adapter", ...ids]); return () => calls.push(["release-adapter"]); },
      registerConfigurableProviders(list) { calls.push(["directory", list[0].provider]); return () => calls.push(["release-directory"]); }
    };
    const publisher = shell.create({
      panelSwitch: async () => true,
      getLlm: () => llm,
      resolveApiKey: async () => "sk-test",
      resolveToken: async () => "token",
      loadAdapterModule: async () => ({
        createAgnesAdapter: async () => {
          if ((calls.length === 0) === false && shell.__armed) throw new Error("boom");
          shell.__armed = true;
          return { adapter: { v: 1 }, providerIds: ["p"] };
        },
        createAgnescodeAdapter: async () => {
          if (shell.__armed) throw new Error("boom");
          shell.__armed = true;
          return { adapter: { v: 1 }, providerIds: ["p"] };
        }
      })
    });
    await publisher.publish(...shell.first);
    const served = shell.identityOf(publisher.state);
    check(`${shell.label}: the first publish is the one serving`,
      publisher.state.registered === true && publisher.state.built?.adapter?.v === 1,
      JSON.stringify({ registered: publisher.state.registered }));

    const failed = await publisher.publish(...shell.second);
    const after = shell.identityOf(publisher.state);
    check(`${shell.label}: a failed build keeps the previous pair live`,
      failed.ok === false && publisher.state.registered === true && publisher.state.built?.adapter?.v === 1,
      JSON.stringify({ ok: failed.ok, error: publisher.state.error }));
    check(`${shell.label}: a failed build restores the identity too`,
      after.a === served.a && after.b === served.b,
      JSON.stringify({ payloadRestored: after.a === served.a, baseRestored: after.b === served.b, now: after.b }));
    check(`${shell.label}: the restored identity is the SERVING one, not the failed one`,
      !JSON.stringify(after.a).includes("agnes-2.5-pro"),
      JSON.stringify({ ids: JSON.stringify(after.a).slice(0, 90) }));
  }
}

{
  section("factory + shape + failure description");
  let loads = 0;
  const resolver = createAdapterFactoryResolver(async () => {
    loads += 1;
    return { createThing: async () => "built" };
  }, "createThing");
  const a = await resolver();
  const b = await resolver();
  check("the factory is resolved off the named export", typeof a === "function");
  check("the module is loaded once, then memoized", loads === 1, `loads=${loads}`);
  check("every resolve returns the same factory", a === b);

  check("a well-formed adapter passes the shape check",
    isBuiltAdapter({ providerIds: ["p"], adapter: {} }) === true);
  check("a promise is not an adapter",
    isBuiltAdapter(Promise.resolve({ providerIds: ["p"], adapter: {} })) === false);
  for (const bad of [null, undefined, "adapter", { providerIds: ["p"] }, { adapter: {} }, { providerIds: "p", adapter: {} }]) {
    check(`a shape violation is rejected: ${JSON.stringify(bad) ?? String(bad)}`,
      isBuiltAdapter(bad) === false);
  }

  const keyed = describeBuildFailure(new Error("cannot build: sk-abcdefgh12345678"));
  check("the failure note is redacted",
    keyed.note.includes("sk-[REDACTED]") && keyed.note.includes("abcdefgh") === false, keyed.note);
  check("a non-module failure carries no remedy hint", keyed.hint === "", keyed.hint);
  check("the original error travels back for re-raising",
    keyed.error instanceof Error && keyed.error.message.includes("sk-abcdefgh12345678"));

  const missing = Object.assign(new Error("Cannot find module 'dsh-llm-pi-ai'"), { code: "ERR_MODULE_NOT_FOUND" });
  const described = describeBuildFailure(missing);
  check("ERR_MODULE_NOT_FOUND gains the remedy hint",
    described.hint.includes("install this plugin where they resolve") && described.hint.startsWith(" — "),
    described.hint);
  check("a non-Error thrown value is still described",
    describeBuildFailure("plain string").note === "plain string");

  const lines = [];
  warnBuildFailure({ warn: (message) => lines.push(message) }, "Agnes", described);
  check("the warning names the plugin, the upstream and the remedy",
    lines.length === 1
      && lines[0].includes(pluginName)
      && lines[0].includes("cannot build the Agnes adapter")
      && lines[0].includes(described.note) && lines[0].includes(described.hint),
    lines[0]);
  let safe = true;
  try { warnBuildFailure(undefined, "Agnes", described); } catch { safe = false; }
  check("an absent logger is tolerated", safe === true);

  check("the shape-check message is the shared constant",
    BAD_FACTORY_SHAPE_ERROR === "the adapter factory did not return { adapter, providerIds }");
}

// --- the catalogue signature must see the OFFER, price included -------------
// The multiplier rides in the descriptor's display name (`Name · xNN.NN`),
// because pi-ai's descriptor has no billing channel for it. So a repriced model
// has to rebuild the registration — otherwise the picker keeps advertising the
// old factor. The pre-2026-10-04 signature was `id:vision` only, under which
// `glm-5.2` moving 1.85 → 9.99 produced an IDENTICAL string (measured), so the
// picker would have kept showing 1.85 forever. This is not hypothetical: the
// platform reprices on promotion boundaries (`glm-5.2` carries
// `display_label: "限时七折"`).
{
  section("catalogSignature sees the price (a reprice must rebuild)");
  const priced = (multiplier) => [
    { id: "glm-5.2", vision: false, multiplier },
    { id: "kimi-k3", vision: false, multiplier: 5.3 }
  ];
  check("a reprice changes the signature (so the registration rebuilds)",
    catalogSignature(priced(1.85), []) !== catalogSignature(priced(9.99), []),
    `${catalogSignature(priced(1.85), [])} vs ${catalogSignature(priced(9.99), [])}`);
  check("an unchanged price keeps the signature stable (no needless rebuild)",
    catalogSignature(priced(1.85), []) === catalogSignature(priced(1.85), []));
  // `0` is a published price (free); absent means the platform said nothing.
  // They must not collapse, or a model becoming free would look unchanged.
  check("a multiplier of 0 is distinct from an absent multiplier",
    catalogSignature([{ id: "m", vision: false, multiplier: 0 }], [])
      !== catalogSignature([{ id: "m", vision: false }], []));
  // Vision is NOT read from a bare `vision` field — `visionOf` resolves it via
  // `identifyVisionModel` (the structured `input_modalities` array, or a name
  // pattern) and falls back to the `PROBED_VISION` id table. So the flip is
  // exercised through the real contract field.
  check("a vision flip still changes the signature",
    catalogSignature([{ id: "m", multiplier: 1, input_modalities: ["text"] }], [])
      !== catalogSignature([{ id: "m", multiplier: 1, input_modalities: ["text", "image"] }], []));
  check("the allow-list still rides the signature",
    catalogSignature([{ id: "m", vision: false }], ["m"])
      !== catalogSignature([{ id: "m", vision: false }], []));
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
