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
import type { SnapshotData, VisionModelData } from "./wire.ts";
import { S } from "./styles.ts";
import { PlanCard, SectionCard, UsageChart, UsageTotals } from "./cards.ts";
import { DrawSwitch } from "./provider-controls.ts";
import { RaccoonTab } from "./raccoon-tab.ts";

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
  //
  // The API tab's two feature cards (provider / draw) start OPEN too: they
  // are the reason someone visits that tab, and a collapsed card hiding its
  // own switch reads as "this does nothing". Only the API key editor stays
  // closed — it holds a secret field, and it is a prerequisite the two
  // cards above point at rather than the thing being configured.
  const [openSections, setOpenSections] = useState({ quota: true, usage: true, account: false, provider: true, draw: true, llm: false });
  // Three fixed perspectives: "quota" is the daily reading (plan, windows,
  // account totals), "api" is the Token Plan wiring (key, provider push,
  // draw), and "raccoon" is the SECOND upstream provider (ROADMAP §6.1) — an
  // independent credential + switch that shares no pool semantics with the
  // first two.
  //
  // The tab bar renders from the FIRST FRAME, whatever the snapshot says. It
  // used to appear only once a body had landed, which meant a console nobody
  // had signed in to replaced the whole page with a form — including the two
  // tabs that never read the console.
  const [activeTab, setActiveTab] = useState<"quota" | "api" | "raccoon">("quota");

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

  // The account editor starts collapsed — it is a maintenance action, one
  // click away. The one case where that is the wrong default is a console that
  // is not connected at all: then signing in IS the next action, and a
  // collapsed card is the dead end the old full-screen form existed to avoid.
  //
  // Opened ONCE, on the first snapshot that says so, and never again — a plain
  // `open: openSections.account || needsSetup` would make the card impossible
  // to collapse while the console is down, since `open` is a controlled prop.
  const openedAccountOnce = useRef(false);
  useEffect(() => {
    if (openedAccountOnce.current) return;
    if (data?.quota?.consoleConnected !== false) return;
    openedAccountOnce.current = true;
    setOpenSections((current) => ({ ...current, account: true }));
  }, [data]);

  const quota = data?.quota;
  const usage = data?.usage;
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
      // A "needs login" chip with a blank tooltip is a dead end: the reader
      // sees "something is wrong" but cannot say what. When the Host gives no
      // reason (a fresh install, nothing configured yet), the tooltip is the
      // guidance line — the same one the setup form would show — so the chip
      // and the form never disagree about why.
      ? h("span", { style: S.chip, title: auth.error || guidance || "" }, tt("auth.needsLogin"))
      : h("span", { style: S.chip }, tt("auth.selfRenew"));
  // The login state and its editor are shown UNCONDITIONALLY (whenever the
  // snapshot carries the Host's auth block): a reader must always be able to
  // see the token state, re-type credentials to re-point a still-valid grant,
  // or clear the saved account. Gating this on `hasAccount` / `needsAccount`
  // made the "middle state" (grant still alive, saved account cleared) a dead
  // end: the full-screen setup form lives behind `!data`, and the section card
  // vanished with `hasAccount` — the user was locked out of their own account
  // with no re-entry path until the grant died.
  const authManage = auth !== null;
  // The tab bar renders UNCONDITIONALLY, and that is the point of this block.
  // It used to live inside the `data` branch, so a console that had never been
  // signed in took all three tabs down with it — two of which do not read the
  // console at all. The API tab works off the stored API key; the Raccoon tab
  // reaches a DIFFERENT upstream with its own credential. Gating them on the
  // quota snapshot blanked three independent modules because one was missing,
  // which is what ARCHITECTURE.md §5 forbids.
  const tabBar = h(
    "div",
    { style: S.tabBar, role: "tablist" },
    h("button", { type: "button", role: "tab", "aria-selected": activeTab === "quota", style: { ...S.tab, ...(activeTab === "quota" ? S.tabActive : {}) }, onClick: () => setActiveTab("quota") }, tt("tab.quota")),
    h("button", { type: "button", role: "tab", "aria-selected": activeTab === "api", style: { ...S.tab, ...(activeTab === "api" ? S.tabActive : {}) }, onClick: () => setActiveTab("api") }, tt("tab.api")),
    h("button", { type: "button", role: "tab", "aria-selected": activeTab === "raccoon", style: { ...S.tab, ...(activeTab === "raccoon" ? S.tabActive : {}) }, onClick: () => setActiveTab("raccoon") }, tt("tab.raccoon"))
  );

  // What the quota tab shows when no snapshot landed at all — a transport
  // failure, or a Host that never answered. The sign-in form still leads when
  // the fix is the account, but it is a TAB's content now rather than the whole
  // page, so the other two stay one click away: that is the difference between
  // "the console is unreachable" and "the plugin is broken". `bare` because the
  // tab body is not itself a card.
  const quotaPlaceholder = showSetupForm
    ? h(AccountForm, { auth, onDone: () => void load(), tt, bare: true, hasSnapshot: false })
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
      );

  const body =
    h(
        "div",
        null,
        tabBar,
        // The shape-drift banner belongs with the daily reading: it warns
        // about the numbers themselves, not about the wiring below.
        activeTab === "quota" && shapeWarnings.length > 0
          ? h("div", { style: S.formError, role: "status" },
              format(tt("panel.shapeDrift"), {
                detail: shapeWarnings.map((entry) => `${tt("shape.api")} ${entry.api} ${tt("shape.missing")} ${entry.missing}`).join("; ")
              }))
          : null,
        activeTab === "quota"
          ? data === null
            ? quotaPlaceholder
            : h(
              "div",
              null,
              // Both content sections are collapsible card headers, auto-expanded
              // by default: the panel opens showing everything, and the reader
              // can tuck the chart or the plan card away to focus on the other.
              h(
                SectionCard,
                { title: tt("section.quota"), open: openSections.quota, onToggle: () => toggleSection("quota"), tt },
                // The console never answered at all — the one case where the
                // absence of numbers is not "not read yet" but "nobody is
                // signed in". Named BEFORE the generic source line and
                // INSTEAD of it: `quota.error` would name "usage-overview" as
                // a failed source, which reads like a transient network fault,
                // and the reader answers a network fault by hitting refresh
                // forever instead of by signing in.
                //
                // The text is `guidance` (viewOf), which already picks the
                // right advice per code — no account, dead token, platform
                // outage, bad endpoint override — so the panel does not
                // re-derive that here. `quota.consoleOffline` is only the
                // fallback for a Host too old to send a code.
                quota?.consoleConnected === false
                  ? h(
                      "div",
                      { style: { ...S.formNote, marginTop: 0, marginBottom: 12 }, role: "status" },
                      h("div", null, guidance ?? tt("quota.consoleOffline")),
                      // Where to fix it — but only when signing in IS the fix.
                      // `needsSetup` is exactly that verdict (viewOf), and it
                      // already auto-expanded the account card below; a
                      // platform outage is a `console_error`, where pointing
                      // at the login form would be wrong advice.
                      needsSetup
                        ? h("div", { style: { marginTop: 6 } }, format(tt("quota.consoleOfflineHint"), { section: tt("auth.title") }))
                        : null
                    )
                  // A source that failed outright (the series, the subscription,
                  // the catalogue) is named here rather than left to read as
                  // "no data yet" — the sources that DID arrive still render.
                  : quota?.error
                    ? h("div", { style: { ...S.formNote, marginTop: 0, marginBottom: 12 }, role: "status" },
                        format(tt("quota.error"), { source: String(quota.error.source ?? ""), message: String(quota.error.message ?? "") }))
                    : null,
                h(PlanCard, { quota, tt }),
                // The one thing the reader would otherwise get wrong: the
                // windows above and the totals below are measured over
                // different periods, so subtracting them would invent a
                // "remaining" figure. Said once, here, rather than on each of
                // the four window cards.
                h("div", { style: { ...S.muted, fontSize: 12, marginTop: 12 } }, tt("quota.windowNote")),
                h(UsageTotals, { totals: quota?.totals, label: tt("quota.accountTotals"), tt }),
                // Step one of the vision plan: which of THIS key's models take
                // image input. Only shown when the Host actually had a catalog to
                // ask (no API key → the field is absent → no claim either way).
                Array.isArray(data.visionModels) && data.visionModels.length > 0
                  ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 10 } },
                      format(tt("pool.vision"), {
                        models: data.visionModels.map((entry: VisionModelData) => entry.id).join(" · ") + (data.visionModels.every((entry: VisionModelData) => entry.source === "name") ? tt("pool.visionInferred") : "")
                      }))
                  : null
              ),
              h(
                SectionCard,
                { title: format(tt("section.usage"), { days: usage?.days ?? 30 }), open: openSections.usage, onToggle: () => toggleSection("usage"), tt },
                h(UsageChart, { usage, tt })
              ),
              // The cache age is quoted from the snapshot, not written down here:
              // a note that says 60 while the Host caches for 300 is a lie the
              // reader has no way to catch.
              h("div", { style: S.note }, format(tt("note"), { cache: data?.cacheSeconds ?? 60 })),
              // The login state stays visible while everything works — and
              // while nothing does: a collapsed section (unlike the content
              // sections) keeps the editor one click away without cluttering
              // the quota view, but the header itself is always on screen.
              authManage
                ? h(
                    SectionCard,
                    { title: tt("auth.title"), open: openSections.account, onToggle: () => toggleSection("account"), tt },
                    h(AccountForm, { auth, onDone: () => void load(), tt, bare: true, hasSnapshot: true })
                  )
                : null
            )
          // One SectionCard per concern, parked on their own tab so the
          // quota view stays the panel's first screen. Key, provider+push,
          // and draw are three different functions; cramming them into one
          // card is what made the block read as a pile of look-alike
          // notices. Order is WHAT THE READER CAME FOR, not dependency
          // order: the two feature cards lead (and open), the key editor
          // trails because it is the prerequisite they point back at.
          : activeTab === "raccoon"
            // The Raccoon provider (ROADMAP §6.1) is a SECOND upstream, with
            // its own credential and its own data source (the /raccoon route
            // this tab polls) — it never touches the Token Plan snapshot, so
            // it renders from its own card, not from `data`.
            ? h(
                "div",
                { style: { marginTop: 22 } },
                h(
                  SectionCard,
                  { title: tt("raccoon.title"), open: true, onToggle: () => {}, tt },
                  h(RaccoonTab, { tt })
                )
              )
            : h(
                "div",
                null,
                h(
                  SectionCard,
                  { title: tt("llm.providerTitle"), open: openSections.provider, onToggle: () => toggleSection("provider"), tt },
                  h(ProviderForm, { llm: data?.llm ?? null, onDone: () => void load(), tt })
                ),
                h(
                  SectionCard,
                  { title: tt("draw.title"), open: openSections.draw, onToggle: () => toggleSection("draw"), tt },
                  h(DrawSwitch, { llm: data?.llm ?? null, onDone: () => void load(), tt })
                ),
                h(
                  SectionCard,
                  { title: tt("llm.title"), open: openSections.llm, onToggle: () => toggleSection("llm"), tt },
                  h(ApiKeyForm, { llm: data?.llm ?? null, onDone: () => void load(), tt, bare: true })
                )
              )
      );

  return h(
    "div",
    { style: S.page, "data-dsh-plugin": "dsh-connect-agnes-token-plan" },
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
        onClose ? h("button", { type: "button", style: S.button, onClick: () => onClose() }, tt("panel.back")) : null
      )
    ),
    h(
      "div",
      { style: S.scroll },
      h("div", { style: S.content }, body)
    )
  );
}
