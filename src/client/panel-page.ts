/**
 * The `main`-slot page: polling, the decision gate, and the whole panel
 * layout. Verbatim logic from the pre-split `client.js`.
 */
import {
  AccountForm
} from "./account-form.ts";
import { ApiKeyForm, ProviderForm } from "./api-key-form.ts";
import { SNAPSHOT_PATH } from "./const.ts";
import { clock, format } from "./format.ts";
import { errorOfStatus, interpretSnapshot, viewOf } from "./snapshot.ts";
import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import type { PoolData, SnapshotData, VisionModelData } from "./wire.ts";
import { S } from "./styles.ts";
import { PoolCard, PoolExhaustionNotice, SectionCard, TrendTable } from "./cards.ts";
import { DrawSwitch } from "./provider-controls.ts";

export function PanelPage({ onClose, tt, localeSubscribe }: {
  onClose?: () => void;
  tt: Tt;
  localeSubscribe?: unknown;
}): unknown {
  const [data, setData] = useState<SnapshotData | null>(null);
  const [error, setError] = useState<string | { message: unknown } | null>(null);
  // Has the FIRST load attempt reached a conclusion? Until it has, the
  // panel must show "loading", not the account form: `viewOf` reads
  // `data === null, error === null` as "nothing says you are configured",
  // and `needsSetup` then renders the sign-in form for a fraction of a
  // second on every mount — including for users who are configured and
  // about to see their pools. That first-frame form was the unreachable
  // `panel.loading` branch: without this gate the loading line was DEAD
  // CODE, because the null/null state always routed to the form.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [, setLocaleRevision] = useState(0);
  // The content sections start expanded — the panel opens showing
  // everything — while the account editor starts collapsed: it is a
  // maintenance action, one click away. Remounting on a page switch
  // restores these defaults.
  const [openSections, setOpenSections] = useState({ pools: true, trend: true, account: false, llm: false, provider: false, draw: false });
  // Two fixed perspectives: "quota" is the daily reading (pools, trend,
  // account), "api" is one-off wiring (key, provider push, draw). The tab
  // bar itself only renders once a snapshot has landed — the loading,
  // error and setup views are full-screen and know no tabs.
  const [activeTab, setActiveTab] = useState<"quota" | "api">("quota");

  // The Host half registers the dictionaries, but a runtime language switch
  // only reaches this page through the locale face's subscribe: without it a
  // mounted panel keeps whatever strings it happened to render first.
  useEffect(() => {
    if (typeof localeSubscribe !== "function") return undefined;
    return (localeSubscribe as (fn: () => void) => () => void)(() => setLocaleRevision((revision) => revision + 1));
  }, [localeSubscribe]);

  // How often to ask again, in ms. The Host states it in every snapshot;
  // this default only covers the first load, before any answer arrives.
  const [cadenceMs, setCadenceMs] = useState(30_000);

  // A snapshot only writes if it is still the newest one: the interval can
  // start a second load before the first returns, and without this the
  // slower response lands last, replacing fresh numbers with a stale
  // snapshot — the usage bar visibly moves backwards. The generation is
  // bumped when a load STARTS, which is also what lets a manual refresh
  // supersede the scheduled one that is already on its way.
  const generation = useRef(0);
  const inFlight = useRef<{ abort?: () => void } | null>(null);

  const load = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    const isCurrent = () => generation.current === mine;
    // Cancel the superseded poll, not just ignore it: a stale request keeps
    // the Host's connection open for nothing.
    inFlight.current?.abort?.();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    inFlight.current = controller;
    try {
      const response = await fetch(SNAPSHOT_PATH, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller ? controller.signal : undefined
      });
      if (!isCurrent()) return;
      if (!response.ok) {
        setError(errorOfStatus(response.status));
        return;
      }
      const body = await response.json();
      if (!isCurrent()) return;
      // The Host answers 200 with `ok:false` for every expected failure, so
      // the code is kept to pick the guidance rather than the message. The
      // reading is a named module-scope function, so the tests exercise
      // exactly what the panel does instead of a copy of it.
      const read = interpretSnapshot(body);
      if (read.data === null) {
        setData(null);
        setError(read.error);
        return;
      }
      setData(read.data);
      setError(null);
      setUpdatedAt(Date.now());
      // Follow the Host's cadence instead of assuming one: the two would
      // otherwise disagree about how fresh this screen is, and the panel
      // would go on polling at the old rate after the operator changed it.
      const stated = read.data?.pollSeconds;
      if (typeof stated === "number" && Number.isFinite(stated)) {
        setCadenceMs(Math.min(3600, Math.max(5, Math.floor(stated))) * 1000);
      }
    } catch (reason) {
      // An abort is our own supersession, not a network failure.
      if (!isCurrent()) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      // The attempt is over one way or another — even where the early
      // `return`s above skipped their state writes (a missing `ok`, a
      // body that failed to parse). Only the CURRENT load gets to say so:
      // an aborted, superseded attempt must not flip the gate while
      // its replacement is still in flight.
      if (isCurrent()) setLoadedOnce(true);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, []);

  const toggleSection = useCallback((key: string) => {
    setOpenSections((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  // One effect owns the whole polling cycle: an immediate load on mount,
  // then the cadence the Host last stated. Re-running on `cadenceMs` is
  // what lets a changed rate take effect without a reload.
  //
  // The interval is stopped while the tab is hidden — nobody is watching
  // the screen, and every poll keeps a Host connection open — and a single
  // load fires on the way back, which also gives a stale "更新于" line
  // something fresh to say.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (alive) void load();
    };
    const start = () => {
      if (timer === null) timer = setInterval(run, cadenceMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    run();
    start();
    const onVisibility = () => {
      if (!alive) return;
      if (document.visibilityState === "hidden") stop();
      else {
        run();
        start();
      }
    };
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      alive = false;
      stop();
      if (typeof document !== "undefined" && document.addEventListener) {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [load, cadenceMs]);

  const pools = data?.pools;
  const trend = data?.trend;
  // The decision is `viewOf`'s (module scope): the Node-side tests invoke
  // this exact function, so there is no second copy that could drift.
  const { failure, auth, needsSetup, guidance, shapeWarnings } = viewOf(data, error, tt);
  // The one gate that turns `panel.loading` from dead code into the real
  // first frame: until an attempt has concluded, nothing may claim the
  // user needs setup.
  const showSetupForm = needsSetup && loadedOnce;
  const authChip = auth === null
    ? null
    : auth.error || !auth.configured
      ? h("span", { style: S.chip, title: auth.error ?? "" }, tt("auth.needsLogin"))
      : h("span", { style: S.chip }, tt("auth.selfRenew"));
  // The account editor is offered whenever a token is working too, so the
  // stored account can be changed or cleared without waiting to fail.
  const authManage = auth !== null && auth.hasAccount === true;
  const body = !data
    ? showSetupForm
      ? h(AccountForm, { auth, onDone: () => void load(), tt })
      : h(
          "div",
          { style: S.empty },
          failure === null
            ? tt("panel.loading")
            : h(
                "div",
                null,
                h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message }))
              )
        )
    : h(
        "div",
        null,
        h(
          "div",
          { style: S.tabBar, role: "tablist" },
          h("button", { type: "button", role: "tab", "aria-selected": activeTab === "quota", style: activeTab === "quota" ? S.tabActive : S.tab, onClick: () => setActiveTab("quota") }, tt("tab.quota")),
          h("button", { type: "button", role: "tab", "aria-selected": activeTab === "api", style: activeTab === "api" ? S.tabActive : S.tab, onClick: () => setActiveTab("api") }, tt("tab.api"))
        ),
        // The shape-drift banner belongs with the daily reading: it warns
        // about the numbers themselves, not about the wiring below.
        activeTab === "quota" && shapeWarnings.length > 0
          ? h("div", { style: S.formError, role: "status" },
              format(tt("panel.shapeDrift"), {
                detail: shapeWarnings.map((entry) => `${tt("shape.api")} ${entry.api} ${tt("shape.missing")} ${entry.missing}`).join("; ")
              }))
          : null,
        activeTab === "quota"
          ? h(
              "div",
              null,
              // Both content sections are collapsible card headers, auto-expanded
              // by default: the panel opens showing everything, and the reader
              // can tuck the chart or the pools away to focus on the other.
              h(
                SectionCard,
                { title: tt("section.pools"), open: openSections.pools, onToggle: () => toggleSection("pools"), tt },
                pools?.plan?.name
                  ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } }, pools.plan.name)
                  : null,
                h(PoolExhaustionNotice, { pools, tt }),
                h(
                  "div",
                  { style: S.poolsGrid },
                  (pools?.pools || []).map((pool: PoolData) => h(PoolCard, { key: pool.id, pool, tt }))
                ),
                Array.isArray(data.uncountedModels) && data.uncountedModels.length > 0
                  ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 4 } },
                      format(tt("pool.uncounted"), { models: data.uncountedModels.join(" · ") }))
                  : null,
                // Step one of the vision plan: which of THIS key's models take
                // image input. Only shown when the Host actually had a catalog to
                // ask (no API key → the field is absent → no claim either way).
                Array.isArray(data.visionModels) && data.visionModels.length > 0
                  ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 4 } },
                      format(tt("pool.vision"), {
                        models: data.visionModels.map((entry: VisionModelData) => entry.id).join(" · ") + (data.visionModels.every((entry: VisionModelData) => entry.source === "name") ? tt("pool.visionInferred") : "")
                      }))
                  : null
              ),
              h(
                SectionCard,
                { title: format(tt("section.trend"), { hours: trend?.hours ?? 24 }), open: openSections.trend, onToggle: () => toggleSection("trend"), tt },
                h(TrendTable, { trend, tt })
              ),
              // The cache age is quoted from the snapshot, not written down here:
              // a note that says 60 while the Host caches for 300 is a lie the
              // reader has no way to catch.
              h("div", { style: S.note }, format(tt("note"), { cache: data?.cacheSeconds ?? 60 })),
              // The stored account stays manageable while everything works:
              // a collapsed section (unlike the content sections) keeps the
              // editor one click away without cluttering the quota view.
              authManage
                ? h(
                    SectionCard,
                    { title: tt("auth.title"), open: openSections.account, onToggle: () => toggleSection("account"), tt },
                    h(AccountForm, { auth, onDone: () => void load(), tt, bare: true })
                  )
                : null
            )
          // One SectionCard per concern, all collapsed by default — these
          // are setup/maintenance, parked on their own tab so the quota
          // view stays the panel's first screen. Key, provider+push, and
          // draw are three different functions; cramming them into one
          // card is what made the block read as a pile of look-alike notices.
          : h(
              "div",
              null,
              h(
                SectionCard,
                { title: tt("llm.title"), open: openSections.llm, onToggle: () => toggleSection("llm"), tt },
                h(ApiKeyForm, { llm: data?.llm ?? null, onDone: () => void load(), tt, bare: true })
              ),
              h(
                SectionCard,
                { title: tt("llm.providerTitle"), open: openSections.provider, onToggle: () => toggleSection("provider"), tt },
                h(ProviderForm, { llm: data?.llm ?? null, onDone: () => void load(), tt })
              ),
              h(
                SectionCard,
                { title: tt("draw.title"), open: openSections.draw, onToggle: () => toggleSection("draw"), tt },
                h(DrawSwitch, { llm: data?.llm ?? null, onDone: () => void load(), tt })
              )
            )
      );

  return h(
    "div",
    { style: S.page, "data-dsh-plugin": "dsh-connect-sensenova-token-plan" },
    // The bar is pinned (flex:none); everything below scrolls inside
    // `S.scroll` instead of being clipped by the shell's center column.
    h(
      "div",
      { style: S.headerBar },
      h(
        "div",
        { style: S.header },
        h("h1", { style: S.title }, tt("panel.title")),
        h("span", { style: S.updated }, data ? format(tt("panel.updated"), { time: clock(updatedAt / 1000) }) : ""),
        authChip,
        h("span", { style: S.spacer }),
        // With data on screen a failure is a stale-data warning, so it rides
        // in the header; without data the body already explains it.
        failure && data
          ? h("span", { style: S.error, role: "status", title: failure.message }, format(tt("panel.error"), { error: failure.message }))
          : null,
        h("button", { type: "button", style: S.button, onClick: () => void load() }, tt("panel.refresh")),
        h("button", { type: "button", style: S.button, onClick: () => onClose?.() }, tt("panel.back"))
      )
    ),
    h(
      "div",
      { style: S.scroll },
      h("div", { style: S.content }, body)
    )
  );
}
