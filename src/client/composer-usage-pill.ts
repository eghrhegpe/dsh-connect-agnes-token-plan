/**
 * The composer usage pill — the `conversation.input.right` seat.
 *
 * Shape: the same "usage capsule" the sibling plugin
 * (`dsh-connect-sensenova-token-plan`) draws — the platform's own consumed
 * share (or, for a balance upstream, its stock), a tier dot, and everything
 * with no room in the body in the tooltip. The body stays short enough for the
 * composer toolbar: `<upstream> · <reading>`.
 *
 * TWO UPSTREAMS, ONE SEAT — and neither renders under the other's name. This
 * plugin has exactly the shape the sibling's capsule was built for: a console
 * quota (`agnes-token-plan`, windows as percentages) and a desktop-app credit
 * pool (`agnescode`, a balance in credits, harvested credentials, its own
 * route). The gate below sends `agnes-token-plan` to the console reader and
 * `agnescode` to the balance reader; any other provider mounts NOTHING. That
 * last part is the load-bearing half: a session pointed at a model from some
 * other plugin must never carry these numbers, and an `agnescode` session must
 * never be shown the console's windows (its quota universe is the desktop
 * gateway's own).
 *
 * WHY THE GATE SITS AT THE COMPONENT BOUNDARY. `useProjection("modelSelection")`
 * is a session-scoped keyed hook the slot system materializes for the component
 * (DSH 0.2.0-rc.1, measured: `dsh-client-ui-session` declares `projection` in
 * its `keyedHooks`, and `dsh-client-ui-renderer`'s `materializeStandardBinding`
 * turns it into a `useProjection` prop with `optional=false` outside the
 * `session-maybe` scope — a missing source throws `SlotAssemblyError`). The
 * outer component only decides which INNER component mounts; the polling hook
 * lives entirely inside that inner component. Calling a hook and then returning
 * early on the gate would break the Rules of Hooks — leaving an owned model
 * would throw "Rendered fewer hooks than expected" and React would drop the
 * component for the rest of the session, which is exactly the bug the sibling
 * plugin's render suite keeps a scenario for. So a session on another provider
 * mounts nothing at all: no read, no timer, no readout.
 *
 * THREE READING RULES (all owned by the panel/route, read here — never
 * re-invented):
 *   - the console percentage is `windowPercent` (`cards.ts`): the platform's
 *     `usagePct` first, `used / limit` only as a fallback, and NEVER clamped — a
 *     window in overage reports >100 and that is a fact, not a rendering bug
 *     (PITFALLS §45);
 *   - severity comes from `usageTier` (90 / 70), the same thresholds the panel's
 *     progress bar uses. A second scale here would be a second answer to "when
 *     is a window in trouble";
 *   - the AgnesCode side draws a STOCK, not a meter: the gateway publishes
 *     credits, not a cap, so there is no honest percentage to draw. Turning the
 *     balance into one would require inventing the limit it is a share of. `0`
 *     is a reading (drained, and it is the alarm); a missing field is NOT a
 *     zero — it is "unreadable", which is what the dash means.
 *
 * SOFT FAILURE (§5 invariant 2). A failed read keeps the last numbers on screen
 * and marks the reading stale; it never blanks the pill and never throws. A
 * failed registration leaves the panel working and this module simply absent.
 *
 * STYLE. No stylesheet is injected (the same ruling as `switch.ts`), so every
 * pixel is an inline style from the `S.pill*` family — sized to the HOST's
 * toolbar (28px tall, 12px text) rather than to this plugin's card scale. The
 * `className` survives as a test selector and as nothing else.
 */
import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import { S } from "./styles.ts";
import { clockSameDay, count, format } from "./format.ts";
import { AGNESCODE_PATH, AGNESCODE_PROVIDER_ID, PROVIDER_ID, SNAPSHOT_PATH } from "./const.ts";
import { interpretSnapshot } from "./snapshot.ts";
import { usageTier, windowPercent } from "./cards.ts";
import { AGNESCODE_POLL_MS } from "./agnescode-tab.ts";
import type { Tt } from "./runtime.ts";
import type { AgnescodeStateData, QuotaWindowData, SnapshotData } from "./wire.ts";

/** The pill's class name: the test selector, and nothing more (no stylesheet). */
const PILL_CLASS = "dsh-agnes-composer-pill";

/** The two console windows the pill reads: the request group's 5-hour / weekly pair. */
const WINDOW_5H = "requests5h";
const WINDOW_WEEKLY = "requestsWeekly";

/** The slice of the `modelSelection` projection this decision needs. */
export interface ModelSelectionLike {
  next?: { provider?: string; model?: string } | null;
  lastUsed?: { provider?: string; model?: string } | null;
}

/** The props the slot hands the component (plus the renderer-injected `useProjection`). */
export interface ComposerPillProps {
  tt: Tt;
  useProjection?: (key: "modelSelection") => ModelSelectionLike | undefined;
}

/**
 * The provider the session is currently pointed at, `next` winning over
 * `lastUsed` — with one repair: an EMPTY `next` (the transient frame right after
 * a picker switch, before it carries the new selection) must not shadow a
 * still-usable `lastUsed`. A bare `next ?? lastUsed` reads a provider off `{}`,
 * finds none, and hides the pill for OWNED models on exactly the frames a switch
 * produces. "Empty" includes the frame where the provider was CLEARED but the
 * field is still present: a candidate without a non-empty `provider` cannot
 * gate a mount — the gate keys on the provider — and all it can do is shadow.
 */
export function selectedProviderOf(projection: ModelSelectionLike | undefined): string | undefined {
  const usable = (candidate: { provider?: string; model?: string } | null | undefined) =>
    candidate !== null && candidate !== undefined
    && typeof candidate.provider === "string" && candidate.provider !== "";
  const p = projection ?? {};
  const candidate = usable(p.next) ? p.next : usable(p.lastUsed) ? p.lastUsed : undefined;
  const provider = candidate?.provider;
  return typeof provider === "string" && provider !== "" ? provider : undefined;
}

/**
 * One window by key, skipping rows that are not objects at all.
 *
 * A shape-drifted row must not throw inside the composer: the panel already
 * reports shape warnings, and a pill that crashes would take the toolbar down
 * with it.
 */
export function windowByKey(windows: unknown[] | undefined, key: string): QuotaWindowData | undefined {
  if (!Array.isArray(windows)) return undefined;
  for (const row of windows) {
    if (row === null || typeof row !== "object") continue;
    if ((row as { key?: unknown }).key === key) return row as QuotaWindowData;
  }
  return undefined;
}

/** The dot's four states: the worst readable tier, or "unknown" when nothing is readable. */
export type PillTier = "error" | "warn" | "ok" | "unknown";

/**
 * The worse of several readings, with "unknown" only when NONE is readable.
 *
 * `null` (no reading) is skipped rather than treated as zero: a window the Host
 * could not measure must not drag the dot down to a healthy-looking grade.
 */
export function worstTier(percentages: Array<number | null>): PillTier {
  const rank: Record<PillTier, number> = { error: 3, warn: 2, ok: 1, unknown: 0 };
  let worst: PillTier = "unknown";
  for (const pct of percentages) {
    if (pct === null) continue;
    const tier = usageTier(pct) as PillTier;
    if (rank[tier] > rank[worst]) worst = tier;
  }
  return worst;
}

/** The dot ink for a tier. One map, so the render and the tests agree by construction. */
const TIER_INK: Record<PillTier, Record<string, unknown>> = {
  error: S.pillTierError,
  warn: S.pillTierWarn,
  ok: S.pillTierOk,
  unknown: S.pillTierUnknown
};

/**
 * A percentage as the pill writes it — the platform's own figure at one decimal,
 * the same precision the window card leads with. `—` is reserved for "no reading",
 * which is a different claim from `0.0%`.
 */
export function percentText(pct: number | null): string {
  return pct === null ? "—" : `${pct.toFixed(1)}%`;
}

/** Everything one route read left behind. */
interface RemoteReading<T> {
  data: T | null;
  /** Epoch ms of the last SUCCESSFUL read, or 0 before one. */
  updatedAt: number;
  /** The cadence being followed (ms), or `null` when nothing has stated one. */
  cadenceMs: number | null;
  loadedOnce: boolean;
  failed: boolean;
}

/**
 * One route, as this hook needs it: where to read, and what a body means.
 *
 * `parse` is PURE and module-scope by construction (see the two route constants
 * below): it runs inside `load`, and a parser holding state here would write
 * state during another hook's callback. It returns `data: null` for anything
 * that is not a reading (a non-2xx, `ok:false`, an unparseable body) — the pill
 * has exactly two outcomes, "a reading" and "not a reading", so the panel's
 * structured failure taxonomy stays where it is used (the panel).
 */
interface RemoteRoute<T> {
  path: string;
  parse: (body: unknown, status: number) => { data: T | null; cadenceMs?: number | null };
}

/**
 * The pill's own route reader.
 *
 * It exists because the pill and the panel are mounted independently: the card
 * is a Plugins-page surface that may never be opened in a given session, while
 * the pill sits in the composer of every conversation whose model is one of this
 * plugin's. Sharing one poller would mean either polling for a card nobody
 * opened or rendering a card from a read the pill happened to pay for.
 *
 * ONE core, TWO routes. The generation guard, the abort, the stated cadence and
 * the hidden-tab pause are identical for both upstreams; only the route, the
 * body reading and the default rate differ. A second copy of this body is
 * exactly what `dup-gate` exists to refuse, and two hand-kept copies would drift
 * the first time one of them is repaired.
 *
 * What it does NOT carry is the panel's policy: the failure taxonomy (guidance
 * lines, the sign-in form gate), the refresh spinner, and the `llm` echo merge
 * all belong to a screen with forms on it. Here a failure is one bit — "this
 * reading is stale" — and the numbers stay.
 *
 * @param route - module-scope stable: a fresh literal per render would rebuild
 *   `load` and restart the poll interval with it.
 * @param initialCadenceMs - the rate to follow before any answer arrives;
 *   `null` means "no timer until something states one" — which installs
 *   NEITHER interval nor visibility wake, so it is only safe for a route
 *   whose first read cannot fail. A route whose first read CAN fail (the
 *   console one: the Host may be busy, or the link may hiccup, at mount)
 *   passes a retry fallback instead, or a failed first read stalls the
 *   reader for the whole session.
 */
function useRemoteRead<T>(route: RemoteRoute<T>, initialCadenceMs: number | null): RemoteReading<T> {
  const [reading, setReading] = useState<RemoteReading<T>>(
    { data: null, updatedAt: 0, cadenceMs: initialCadenceMs, loadedOnce: false, failed: false }
  );
  // The live cadence, mirrored into a ref so `load` can keep it across an answer
  // that states none WITHOUT depending on state: a `load` keyed on the cadence
  // would be rebuilt whenever the rate changes, and the mount effect below would
  // then fire an extra read on exactly that transition.
  const cadenceRef = useRef<number | null>(initialCadenceMs);
  // The mirror runs in an effect, not the render body: a ref write during render
  // is not transactional under concurrent rendering — a discarded-and-replayed
  // render leaves the ref holding a value no committed render produced. Every
  // reader of the ref sits in `load`'s async body, strictly after commit, so an
  // effect mirror is current by the time anything reads it.
  useEffect(() => {
    cadenceRef.current = reading.cadenceMs;
  }, [reading.cadenceMs]);
  // Only the newest read may write state: the interval can start a second read
  // before the first returns, and without this the slower response lands last.
  const generation = useRef(0);
  const inFlight = useRef<{ abort?: () => void } | null>(null);

  const load = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    const isCurrent = () => generation.current === mine;
    // Cancel the superseded read, not merely ignore it: a stale request keeps the
    // Host's connection open for nothing.
    inFlight.current?.abort?.();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    inFlight.current = controller;
    // Every failure path below keeps the numbers already on screen and flips one
    // bit: blanking the pill on a hiccup would read as "you have no quota".
    const fail = () => {
      if (isCurrent()) setReading((current) => ({ ...current, failed: true, loadedOnce: true }));
    };
    try {
      const response = await fetch(route.path, {
        headers: { accept: "application/json" },
        cache: "no-store",
        // Spread rather than `signal: controller?.signal`: this project compiles
        // with `exactOptionalPropertyTypes`, where an explicit `undefined` is not
        // assignable. Same call site shape as the panel's.
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!isCurrent()) return;
      // A non-2xx may still carry a body (the Host's same-origin fence answers
      // 403 with one), but the pill has nothing to say with it: the status is
      // enough to call the reading stale.
      if (!response.ok) {
        fail();
        return;
      }
      const body = await response.json().catch(() => null);
      if (!isCurrent()) return;
      const read = route.parse(body, response.status);
      if (read.data === null) {
        fail();
        return;
      }
      setReading({
        data: read.data,
        updatedAt: Date.now(),
        // `undefined` = this answer states no cadence (keep the one in force);
        // an explicit `null` = it states "none", which really does stop the
        // timer. Collapsing the two would make a Host that stopped reporting
        // `pollSeconds` keep polling at a rate nothing is stating any more.
        cadenceMs: read.cadenceMs !== undefined ? read.cadenceMs : cadenceRef.current,
        loadedOnce: true,
        failed: false
      });
    } catch {
      // A transport failure or our own abort. Either way the last numbers stay
      // and the reading is marked stale; the message itself has no reader here
      // (the panel is where failure TEXT is rendered, with its guidance tables).
      fail();
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, [route]);

  // Mount: exactly one read. `load` is stable while the cadence is (the route is
  // module-scope), so this fires once; the loop below never doubles it.
  useEffect(() => {
    void load();
  }, [load]);

  // The loop: paused while the tab is hidden — nobody is watching, and every
  // poll keeps a Host connection (and on the desktop upstream, two upstream
  // reads) open — and rebuilt when the cadence changes. The wake-up read gives
  // the numbers something fresh to be.
  useEffect(() => {
    const cadenceMs = reading.cadenceMs;
    if (cadenceMs === null) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => { void load(); }, cadenceMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    start();
    const onVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "hidden") stop();
      else {
        void load();
        start();
      }
    };
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      stop();
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [load, reading.cadenceMs]);

  // Unmount ONLY, deliberately separate from the loop's cleanup (which also runs
  // on a cadence rebuild, where this reader is still mounted and its request is
  // perfectly valid). Only a real unmount supersedes an in-flight read.
  useEffect(() => () => {
    generation.current += 1;
    inFlight.current?.abort?.();
  }, []);

  return reading;
}

/**
 * "These are the last numbers we managed to get."
 *
 * Two causes: the last read failed, or the reading has aged past two cadences —
 * expressed as a multiple of the rate being followed, so this file holds no
 * second spelling of any poll interval. Without a cadence there is no expected
 * freshness to judge against, so only a failure can mark it.
 */
function isStale<T>(reading: RemoteReading<T>, now: number): boolean {
  const aged = reading.cadenceMs !== null
    && reading.updatedAt > 0
    && now - reading.updatedAt > reading.cadenceMs * 2;
  return reading.loadedOnce && (reading.failed || aged);
}

/**
 * The console route: the Host's snapshot, read through the panel's own
 * `interpretSnapshot` — one interpretation of that wire, not a second one.
 *
 * Cadence: whatever `pollSeconds` the Host states. Before it states one, the
 * loop runs at the retry fallback below, so a failed first read keeps
 * retrying instead of dead-stalling; no literal here can disagree with the
 * operator's configured rate (the same ruling as `PanelPage`) — the fallback
 * is superseded by the first successful answer, or stopped by one that
 * states none.
 */
const SNAPSHOT_ROUTE: RemoteRoute<SnapshotData> = {
  path: SNAPSHOT_PATH,
  parse: (body, status) => {
    if (status < 200 || status >= 300) return { data: null };
    const read = interpretSnapshot(body);
    if (read.data === null) return { data: null };
    const stated = read.data.pollSeconds;
    return {
      data: read.data,
      cadenceMs: typeof stated === "number" && Number.isFinite(stated) && stated > 0
        ? Math.floor(stated) * 1000
        : null
    };
  }
};

/**
 * The desktop-app route: `/agnescode`'s secret-free state.
 *
 * The route states no cadence of its own, so the rate is the tab's own
 * `AGNESCODE_POLL_MS` — imported rather than spelled again here, because two
 * numbers for one loop is how a poll rate starts disagreeing with itself.
 * Reading it is read-only: the route serves cached store state plus the two
 * gateway reads the tab already performs while open, and its one write
 * (a cooldown-bounded self-heal publish) is bounded per 60 s inside the route.
 */
const AGNESCODE_ROUTE: RemoteRoute<AgnescodeStateData> = {
  path: AGNESCODE_PATH,
  parse: (body, status) => {
    if (status < 200 || status >= 300) return { data: null };
    const state = body as AgnescodeStateData | null;
    if (state === null || typeof state !== "object" || state.ok !== true) return { data: null };
    return { data: state, cadenceMs: AGNESCODE_POLL_MS };
  }
};

/**
 * The retry rate the console reader follows while its FIRST read has failed
 * and the Host has not yet stated a poll rate: with no cadence stated, the
 * loop installs neither interval nor visibility wake, so a failed first read
 * would otherwise sit on a dead "—" for the whole session (the pill has no
 * error text of its own — the panel is where failures are read). A successful
 * answer always supersedes this number with the Host's stated rate — or
 * explicitly stops the timer, which is a Host instruction, not a failure — so
 * it never outlives the first answer. It matches the Host's default
 * `pollSeconds` (30, `CONFIG_DEFAULTS` in `host-config.ts`): the operator's
 * rate is what the reader follows the moment it learns it, and this is only
 * "keep trying until we do".
 */
const SNAPSHOT_RETRY_FALLBACK_MS = 30_000;

/** The console reader (the pill's `/snapshot` loop). */
function useConsoleQuota(): RemoteReading<SnapshotData> {
  return useRemoteRead(SNAPSHOT_ROUTE, SNAPSHOT_RETRY_FALLBACK_MS);
}

/** The desktop-app reader (the pill's `/agnescode` loop). */
function useAgnescodeState(): RemoteReading<AgnescodeStateData> {
  return useRemoteRead(AGNESCODE_ROUTE, AGNESCODE_POLL_MS);
}

/** The shared shell: the tier dot, the upstream prefix, the reading. */
function PillBody(props: {
  tt: Tt;
  /** Which upstream's numbers these are — the reason a bare reading is readable. */
  planLabel: string;
  tier: PillTier;
  stale: boolean;
  title: string;
  children?: unknown;
}) {
  const { tt, planLabel, tier, stale, title, children } = props;
  return h(
    "button",
    {
      type: "button",
      className: PILL_CLASS,
      title,
      "aria-label": title,
      style: S.pillTrigger
    },
    h("span", {
      className: `${PILL_CLASS}-dot`,
      "aria-hidden": "true",
      style: { ...S.pillDot, ...TIER_INK[tier] }
    }),
    // The upstream's name: which quota the numbers beside it belong to. Without
    // it a bare "5 小时 12.0%" cannot say whose allowance is being spent — and
    // this plugin has two upstreams with two unrelated credit universes.
    h("span", { className: `${PILL_CLASS}-plan`, style: S.pillPlan }, `${planLabel} · `),
    h(
      "span",
      {
        className: `${PILL_CLASS}-text`,
        // Only an exhausted window tints the text. Everything else stays in the
        // host's label ink, which is what keeps a healthy pill quiet.
        style: tier === "error" ? S.pillErrorText : undefined
      },
      children,
      stale ? h("span", { style: S.pillStale }, ` · ${tt("composer.stale")}`) : null
    )
  );
}

/** The first of several epoch-second instants that is a usable number, else 0. */
function firstInstant(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/**
 * The console reading: the two request windows and the tooltip that carries what
 * the body has no room for (which plan, which quota, when the window resets, and
 * whether this reading is the last known one).
 */
function ConsoleQuotaPill({ tt }: { tt: Tt }) {
  const reading = useConsoleQuota();
  const quota = reading.data?.quota ?? null;
  const windows = Array.isArray(quota?.windows) ? quota.windows : [];
  const fiveHour = windowByKey(windows, WINDOW_5H);
  const weekly = windowByKey(windows, WINDOW_WEEKLY);
  const p5 = windowPercent(fiveHour);
  const pWeekly = windowPercent(weekly);
  const tier = worstTier([p5, pWeekly]);
  const stale = isStale(reading, Date.now());
  const disconnected = quota !== null && quota.consoleConnected === false;
  const planName = String(quota?.plan?.displayName || quota?.plan?.name || "");
  // The 5-hour window resets soonest and is the one the reader is spending
  // against; the weekly one is the fallback when the platform reported only it.
  const resetAt = firstInstant(fiveHour?.resetAt, weekly?.resetAt);
  const title = [
    tt("composer.pillTitle"),
    planName === "" ? null : planName,
    !reading.loadedOnce ? tt("panel.loading") : disconnected ? tt("composer.notConnected") : null,
    reading.loadedOnce && !disconnected && windows.length === 0 ? tt("composer.noWindows") : null,
    resetAt > 0 ? format(tt("quota.resetAt"), { time: clockSameDay(resetAt) }) : null,
    stale ? tt("composer.stale") : null
  ]
    .filter(Boolean)
    .join(" · ");
  const windowText = (label: string, pct: number | null) => `${label} ${percentText(pct)}`;

  return h(PillBody, {
    tt,
    planLabel: tt("composer.planPrefix"),
    tier,
    stale,
    title,
    children: [
      h("span", { key: WINDOW_5H, style: S.pillReading }, windowText(tt("composer.window5h"), p5)),
      " · ",
      h("span", { key: WINDOW_WEEKLY, style: S.pillReading }, windowText(tt("composer.windowWeekly"), pWeekly))
    ]
  });
}

/**
 * One credit balance as a number, or `null` when the state declared none.
 *
 * The AgnesCode gateway publishes STOCKS: `totalBalance` plus its time-limited
 * and permanent parts. There is no cap in that universe, so the pill draws the
 * balance — never a percentage, which would require inventing the limit it is a
 * share of.
 *
 * `0` is a READING (a drained balance is the alarm, and it must read `0` in the
 * error tier), while a missing or non-finite field is ABSENCE — the grey dash.
 * The panel's own rule for this tab ("a rendered zero would present an unread
 * figure as a measurement") is the same one, applied to a field-level gap the
 * panel never has to face because it renders the block only when it is there.
 */
export function balanceOf(state: AgnescodeStateData | null | undefined): number | null {
  const total = state?.balance?.totalBalance;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

/** One part of the balance (time-limited / permanent), or `null` when unreadable. */
function partOf(state: AgnescodeStateData | null | undefined, key: "timeSensitiveBalance" | "permanentBalance"): number | null {
  const value = state?.balance?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The desktop-app reading: the gateway's own credit balance.
 *
 * It is a STOCK, not a meter — see {@link balanceOf} — so the body carries the
 * figure and the tooltip carries the three facts that have no room there: which
 * account (`nickname`), how the total splits (time-limited / permanent), and —
 * when there is no figure at all — WHICH fact is missing. "The desktop App is
 * not signed in", "the provider switch is off" and "the gateway did not answer
 * this time" are three different problems, and a bare dash beside them left the
 * reader guessing (the same repair the sibling's capsule made for its gateway).
 */
function AgnescodeBalancePill({ tt }: { tt: Tt }) {
  const reading = useAgnescodeState();
  const state = reading.data;
  const balance = balanceOf(state);
  const tier: PillTier = balance === null ? "unknown" : balance <= 0 ? "error" : "ok";
  const stale = isStale(reading, Date.now());
  const pending = !reading.loadedOnce && balance === null;
  // The three ways a figure can be absent, in the order the reader can act on
  // them: the switch is off (nothing is registered), there is no local login
  // state (the desktop App), or the gateway simply did not answer.
  const why = !reading.loadedOnce || balance !== null
    ? null
    : state === null
      ? tt("composer.balanceUnread")
      : state.enabled !== true
        ? tt("agnescode.unregistered")
        : state.loggedIn !== true
          ? tt("agnescode.notLogged")
          : tt("composer.balanceUnread");
  const timeLimited = partOf(state, "timeSensitiveBalance");
  const permanent = partOf(state, "permanentBalance");
  const split = timeLimited === null || permanent === null
    ? null
    : `${tt("agnescode.balanceTimeLabel")} ${count(timeLimited)} · ${tt("agnescode.balancePermanentLabel")} ${count(permanent)}`;
  const title = [
    tt("composer.balanceTitle"),
    state?.loggedIn === true && String(state.nickname ?? "") !== ""
      ? format(tt("agnescode.loggedIn"), { nick: String(state.nickname) })
      : null,
    split,
    why,
    stale ? tt("composer.stale") : null
  ]
    .filter(Boolean)
    .join(" · ");

  return h(PillBody, {
    tt,
    planLabel: tt("composer.balancePrefix"),
    tier,
    stale,
    title,
    children: h(
      "span",
      { style: S.pillReading },
      pending ? "…" : balance === null ? "—" : `${count(balance)} ${tt("composer.balanceUnit")}`
    )
  });
}

/**
 * The composer pill.
 *
 * Renders nothing unless the session's model belongs to this plugin — so no other
 * provider's conversation carries a foreign readout, and no fetch loop runs while
 * it is absent (the inner reader is not mounted). WHICH upstream it belongs to is
 * the same decision as whether one mounts: the console provider reads the
 * snapshot, the desktop-app provider reads its own route, and neither is mounted
 * for the other's models.
 */
export function ComposerUsagePill(props: ComposerPillProps) {
  const { tt, useProjection } = props;
  // The keyed hook call stays at ONE fixed site every render: the host's
  // materialized hook, or the noop when a Node test injects no projection. The
  // gate below only decides whether an INNER component mounts — a legal hook
  // boundary — never how many hooks this component called.
  const projection = (useProjection ?? (() => undefined))("modelSelection");
  const provider = selectedProviderOf(projection);
  if (provider === PROVIDER_ID) return h(ConsoleQuotaPill, { tt });
  if (provider === AGNESCODE_PROVIDER_ID) return h(AgnescodeBalancePill, { tt });
  return null;
}
