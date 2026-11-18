/**
 * The third panel tab: the AgnesCode（爱思编程）provider — the desktop-app
 * upstream (ROADMAP §6.3).
 *
 * It is a SEPARATE data source from the Token Plan snapshot: this tab owns a
 * small, self-managed poll loop over the plugin's
 * own `/agnescode` route (stop when the tab leaves, one refresh on entry), and
 * renders one card with, in order: the provider switch (opt-in, default off),
 * the credential state (linked account + per-account base + expiry, or the
 * harvest walk whose per-file diagnosis rows are the workbuddy five-tier
 * discipline), the credit pool, and the model roster the adapter offers.
 * Nothing here touches the Token Plan semantics — the tabs are
 * deliberately independent.
 *
 * Two in-panel sign-in paths, one decision: the harvest walk「检测本机登录态」
 * (Windows only — it reads the desktop App's os_crypt session file) and the
 * scan-to-sign-in button「扫码登录」(cross-platform — the Host opens the
 * device-flow login URL in the system browser, `docs/AGNESCODE-SCAN-LOGIN.md`,
 * no desktop App needed). A failed walk renders one line per probed file with
 * its tier — "no App", "unreadable", "key unavailable", "decryption failed"
 * want different user advice and never share a sentence.
 *
 * Hook-based like the quota tab. The tab's own frame is unreachable from the
 * render suite (its data is internal state, so it always renders the
 * unlinked view); the roster it draws is therefore split into the hook-free
 * {@link AgnescodeRoster}, which the suite CAN mount and pin, and this tab's
 * route is covered by `test/agnescode.test.mjs`.
 */
import { AGNESCODE_PATH, AGNESCODE_SITE_URL } from "./const.ts";import { clockLong, count, format, tokenSize } from "./format.ts";
import { postJson, postJsonOrThrow } from "./http.ts";
import { modelIsOn } from "./models.ts";
import { SiteTabs, siteTone } from "./site-tabs.ts";
import type { Site } from "./site-tabs.ts";
import { useRosterDraft } from "./roster-draft.ts";
import { RosterCheckbox, RosterTools } from "./roster-shared.ts";
import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { Switch } from "./switch.ts";
import { S } from "./styles.ts";
import {
  AGNESCODE_ERROR_NOT_CONFIGURED,
  AGNESCODE_TIER_OK,
  type AgnescodeModelData,
  type AgnescodeStateData
} from "./wire.ts";

/**
 * The freshness + reload a tab hands to the shell's pinned bar.
 *
 * The bar is a shell: it shows whichever tab is on screen. The quota and API
 * tabs both read the shared snapshot, so `PanelPage` derives their half itself;
 * this tab reads its OWN route on its own cadence (60 s), so it is the one that
 * has to publish. `refresh` exists because the bar's refresh button used to
 * reload the snapshot no matter which tab was open — on this tab that meant
 * "reload the data behind the tab you are NOT looking at".
 */
export interface TabStatus {
  /** Epoch ms of last successful read; 0 = never. */
  updatedAt: number;
  /** Reload THIS tab's data. */
  refresh: () => void;
}

/** The secret-free state the /agnescode route answers. */
type AgnescodeState = AgnescodeStateData;

/**
 * The cadence this tab polls at while open (balance + roster drift slowly).
 *
 * Exported because the composer pill reads the SAME route on the same schedule:
 * the route states no `pollSeconds` of its own, so this constant is the one
 * spelling of that rate — a second literal in the pill would be two answers to
 * "how fresh is the balance".
 */
export const AGNESCODE_POLL_MS = 60_000;

/**
 * Which AgnesCode site the tab is showing (ADR-023).
 *
 * The two sites are separate registrations with separate credentials, so the
 * tab is a SITE SELECTOR over two independent rows — NOT one row with a
 * "which account" dropdown. The site is carried on every read and every write
 * (`domain` in the query / the body), so a flip re-reads the other site's
 * state instead of reusing this site's.
 *
 * An ALIAS of the shared {@link Site}, not a second spelling: the same two keys
 * ride the quota and API cards, and a local re-declaration would let one tab
 * rename a site the others still call by the old name.
 */
export type AgnescodeSite = Site;

/**
 * The tab's route for one site: the CN row is the bare path, the international
 * row adds the `domain` query the Host reads to pick its store, switch and
 * publisher.
 * @param {AgnescodeSite} site - the site.
 * @returns {string} the route path.
 */
export function agnescodeRouteFor(site: AgnescodeSite) {
  return site === "intl" ? `${AGNESCODE_PATH}?domain=intl` : AGNESCODE_PATH;
}

/**
 * The tab's rendering decisions, lifted out of the JSX so they can be nailed.
 *
 * Three decisions here were each a REAL repair, and each is explained in a
 * comment at its old site — but none of them had a test, so the next person to
 * "simplify" the JSX could undo any of them silently. Same shape as `barPlan`
 * in `panel-page.ts`: the decision is a pure function of (state, error), so the
 * suite drives it directly instead of scraping a layout.
 *
 * The three, in the order they were learned:
 *
 *  1. `showError` — a route that ANSWERS with a failure is not "no local login
 *     state". Naming the status is what stops a broken Host route from looking
 *     exactly like a signed-out desktop App.
 *  2. `credentialCard` — withheld ONLY while a failed read leaves us knowing
 *     NOTHING (`state === null`). Then `linked` is false and the unlinked copy
 *     would accuse the reader's desktop App of not being signed in — a claim
 *     this tab has no evidence for. Once ANY reading has landed, the card stays
 *     up through a later failed poll: the honest statement is the error line
 *     plus the LAST KNOWN account, not a blank. (`load` therefore never calls
 *     `setState(null)` — clearing on failure is exactly the regression this
 *     pins.)
 *  3. `linked` — reads `loggedIn` off the state, never inferred from the
 *     absence of an error.
 *  4. `pending` — NOTHING has ever been read for the site on screen (its first
 *     read is in flight). This is the FOURTH member, added with ADR-024's site
 *     selector and for exactly the reason #2 exists: switching sites briefly
 *     left `state === null` with no error, which rendered the unlinked copy —
 *     「未关联——请先在桌面端登录」— as a claim about an account nobody had
 *     asked yet. A switching frame is not evidence of a signed-out desktop App,
 *     so it says "reading" and nothing else. `linked` is false either way; the
 *     UI branches on `pending` BEFORE it can print the accusation.
 *
 * @param {AgnescodeState|null} state - the last body the route answered, if any.
 * @param {string|null} error - the last read failure, if any.
 * @param {boolean} [pending] - true when this site has no reading yet.
 * @returns {{showError: boolean, credentialCard: boolean, linked: boolean, pending: boolean}}
 */
export function agnescodeView(
  state: AgnescodeState | null,
  error: string | null,
  pending = false
): { showError: boolean; credentialCard: boolean; linked: boolean; pending: boolean } {
  // A pending frame with an error is a FAILED first read, which is what #1
  // names — the error line wins and the card is withheld, as before.
  const waiting = pending && error === null;
  return {
    showError: error !== null,
    credentialCard: !(state === null && error !== null),
    linked: state?.loggedIn === true,
    pending: waiting
  };
}

/**
 * The harvest-tier reasons the desktop view can answer with (ADR-020): the
 * SAME nine tier codes the panel's diagnosis rows already translate, so they
 * reuse the tab's own `agnescode.tier.*` dictionary — "the button says X and
 * the switch row says Y" is impossible by construction. The three view-only
 * reasons have their own keys; an unknown code (a reason added Host-side
 * without its dictionary entry) prints itself rather than a missing key.
 * @param {string} reason - a `desktopSourceReason` value from the route.
 * @param {Tt} tt - the dictionary.
 * @returns {string} the translated reason.
 */
export function agnescodeDesktopSourceReasonText(reason: string, tt: Tt): string {
  const tierReasons = [
    "file_missing", "format_drift", "unreadable", "no_key", "decrypt_failed",
    "malformed", "no_token", "untrusted_base", "unsupported_platform"
  ];
  if (tierReasons.includes(reason)) return tt(`agnescode.tier.${reason}`);
  if (reason === "no_expiry" || reason === "expired" || reason === "read_failed") {
    return tt(`agnescode.desktopReason.${reason}`);
  }
  return reason;
}

/**
 * The two muted lines that follow the credit-pool cards.
 *
 * Split out of {@link AgnescodeTab} for the same reason the rosters are: the
 * tab's data is internal state, so the render suite can only reach the
 * UNLINKED frame — and both lines sit behind `loggedIn`, which is `false`
 * there. Hook-free, they can be mounted directly with a sample balance and a
 * sample rate-limit record.
 *
 * What each line is FOR, so the wording never drifts:
 *   - `usageLine` (FIRST of the group): this plugin's OWN traffic — request
 *     count and token totals today. It answers "what did MY calls spend", the
 *     question the reader actually brings. It is per-client and labelled so
 *     (desktop app invisible), never the account total — that is the ledger's
 *     job. An all-zero day draws NOTHING (unrecorded ≠ a recorded zero).
 *   - `grantLine`: the platform's GRANTS (daily free / subscription / effect),
 *     answers "is there a hidden daily free quota I am about to hit". A free
 *     account's answer is all four 0 — a SETTLED fact; re-asserting it every
 *     poll is the same permanent-zero clutter that demoted the rate-limit
 *     line. All-zero (or all-absent) grants therefore draw NOTHING, while any
 *     non-zero grant (a subscription account) renders the line, zeros and
 *     all, with the platform's published numbers.
 *   - `ledgerLine`: the account's real SPEND, aggregated by the Host from the
 *     platform's credits ledger (today and 30-day in/out). Unlike the usage
 *     line it counts the WHOLE account (desktop app included). When
 *     `covered30d` is false the 30-day out total is a LOWER BOUND, so it is
 *     pre-composed with the "at least" prefix before it reaches the template.
 *   - `rateLimitLine` (LAST of the group): this plugin's OWN rate-limit hits.
 *     The RPM ceiling is unpublished and untested, so the panel reports the
 *     symptom (hits today / 30 days, last hit) rather than inventing a
 *     threshold. A 0 is a measurement, not a missing value — but it is a
 *     measurement that reads 0 almost always on a free account, so it was
 *     demoted below the usage figure rather than leading the group.
 * @param {object|null} balance - the pool the route reported; `null` draws nothing.
 * @param {object|null} rateLimit - the windowed counts the Host aggregated; `null` draws nothing.
 * @param {object|null} ledger - the windowed credits-ledger aggregate; `null` draws nothing.
 * @param {object|null} usage - this plugin's OWN per-client usage roll; `null` draws nothing.
 * @param {Tt} tt - the dictionary.
 * @returns {Array<unknown|null>} the status lines.
 */
export function agnescodeUsageText(usage: any, tt: Tt): string | null {
  if (usage === null || usage === undefined) return null;
  const requests = typeof usage.todayRequests === "number" ? usage.todayRequests : 0;
  const total = typeof usage.todayTotal === "number" ? usage.todayTotal : 0;
  const cacheRead = typeof usage.todayCacheRead === "number" ? usage.todayCacheRead : 0;
  // Unrecorded is not a recorded zero: a day with no plugin traffic draws no
  // line at all (same discipline as `balance === null` and the ledger row).
  if (requests === 0 && total === 0) return null;
  return format(tt("agnescode.usageLine"), {
    requests: count(requests),
    tokens: tokenSize(total) || count(total),
    cacheRead: tokenSize(cacheRead) || count(cacheRead)
  });
}

export function agnescodePoolNotes(balance: any, rateLimit: any, ledger: any, usage: any, tt: Tt) {
  const debits30 = ledger !== null
    ? (ledger.covered30d === false && (ledger.last30dDebits ?? 0) > 0
        ? tt("agnescode.ledgerAtLeast") + " " + count(ledger.last30dDebits ?? 0)
        : count(ledger.last30dDebits ?? 0))
    : "";
  const usageText = agnescodeUsageText(usage, tt);
  // The grant line answers "will an invisible quota limit me". The all-four
  // ZERO (or all-absent) set of a free account is a settled fact, so
  // re-displaying it every poll is the same permanent-zero clutter that
  // demoted the rate-limit line: only a NON-ZERO grant — a subscription
  // account's figures — earns the line.
  const grantsVisible = balance !== null && [
    balance.dailyFreeCredits,
    balance.subscriptionCredits,
    balance.dailyEffectQuota,
    balance.effectQuotaBalance
  ].some((value) => typeof value === "number" && value > 0);
  return [
    // The per-client usage roll leads the diagnostic lines: it is the one fact
    // of this group the reader acts on ("what did MY calls spend"). The
    // rate-limit record is demoted to LAST — a free account almost always
    // reads 0, and a permanent zero line is the clutter the glance card was
    // simplified for. It stays visible (it is a measurement, not a missing
    // value) but no longer competes with the usage figure for attention.
    usageText !== null
      ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 8 }, role: "status", title: tt("agnescode.usageHint") },
          usageText)
      : null,
    grantsVisible
      ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 8 }, role: "status", title: tt("agnescode.grantHint") },
          format(tt("agnescode.grantLine"), {
            dailyFree: count(balance.dailyFreeCredits ?? 0),
            sub: count(balance.subscriptionCredits ?? 0),
            dailyEffect: count(balance.dailyEffectQuota ?? 0),
            effect: count(balance.effectQuotaBalance ?? 0)
          }))
      : null,
    ledger !== null
      ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 8 }, role: "status", title: tt("agnescode.ledgerHint") },
          format(tt("agnescode.ledgerLine"), {
            creditsToday: count(ledger.todayCredits ?? 0),
            debitsToday: count(ledger.todayDebits ?? 0),
            debits30,
            // `lastDebitAt` is epoch MS (the Host's ledger walk normalizes
            // `created_at` to ms); clockLong eats SECONDS.
            lastDebit: ledger.lastDebitAt ? clockLong(ledger.lastDebitAt / 1000) : tt("agnescode.ledgerLastNever")
          }))
      : null,
    rateLimit !== null
      ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 8 }, role: "status", title: tt("agnescode.rateLimitHint") },
          format(tt("agnescode.rateLimitLine"), {
            today: count(rateLimit.today ?? 0),
            last30d: count(rateLimit.last30d ?? 0),
            // `lastAt` is epoch MS (the stats store's `at.getTime()`); clockLong
            // eats SECONDS — feeding ms straight in prints a date ~58 000 years out.
            last: rateLimit.lastAt ? clockLong(rateLimit.lastAt / 1000) : tt("agnescode.rateLimitNever")
          }))
      : null
  ];
}

/**
 * The AgnesCode tab body.
 * @param {object} props
 * @param {Tt} props.tt - the dictionary.
 * @param {(status: TabStatus) => void} [props.onStatus] - hands the shell's
 *   pinned bar this tab's own freshness and reload (it owns both).
 * @returns {unknown} the tab's card tree.
 */
export function AgnescodeTab({ tt, onStatus }: { tt: Tt; onStatus?: (status: TabStatus) => void }): unknown {
  // WHICH SITE this tab is showing (ADR-023). The two AgnesCode rows are
  // independent registrations with independent credentials, so the tab shows
  // one at a time and the site rides on every read and every write.
  const [site, setSite] = useState<AgnescodeSite>("cn");
  /**
   * ONE CACHE PER SITE, not one slot.
   *
   * This started as a single `state` that got CLEARED on a site switch, which
   * produced a false accusation: the cleared frame is `state === null` with no
   * error, and the unlinked copy then rendered「未关联——请先在 AgnesCode 桌面端
   * 登录」about an account the tab had simply not asked yet — the exact
   * regression `agnescodeView`'s comment #2 exists to prevent, reintroduced by
   * the switch. Three things fix it at once:
   *
   *   - the frame after a switch reads `pending` (see `agnescodeView`) and says
   *     "reading", never "not linked";
   *   - switching BACK shows the other site immediately, from its cache, with
   *     no blank frame at all;
   *   - each site's DOT can report the truth instead of a guess: a site with a
   *     cached answer gets its real tone, and one never visited gets `unknown`
   *     (an honest "not measured"), never a fabricated「未启用」.
   */
  const [states, setStates] = useState<{ cn: AgnescodeState | null; intl: AgnescodeState | null }>({ cn: null, intl: null });
  const state = states[site];
  /** Write one site's reading without disturbing the other's. */
  const putState = (target: AgnescodeSite, body: AgnescodeState | null) => {
    setStates((current) => ({ ...current, [target]: body }));
  };
  const [error, setError] = useState<string | null>(null);
  // When this tab last read its route successfully. The bar quotes it instead
  // of the snapshot's stamp: two different routes, two different cadences.
  const [updatedAt, setUpdatedAt] = useState(0);
  // The in-flight harvest walk: the button goes to a "reading" state and the
  // diagnosis rows land in `state.harvest` (also on failure — the walk's
  // answer IS the diagnosis).
  const [harvestBusy, setHarvestBusy] = useState(false);
  // The in-flight scan-to-sign-in: the button goes to a "waiting" state while
  // the Host's device-flow login runs (it can take the callback timeout — the
  // user has to scan in the browser).
  const [loginBusy, setLoginBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  // The same two guards `panel-page` uses, for the same reason — an `alive`
  // flag alone cannot tell a LIVE read from a SUPERSEDED one. This tab is
  // remounted every time the user opens it, and the effect sets `alive` back to
  // `true`, so a request issued before the close can return after the reopen
  // and be treated as current: the panel then shows an account state from a
  // read taken before the tab was even opened. The generation counter is
  // bumped when a load STARTS, so only the newest read may write state; the
  // abort cancels the superseded one instead of leaving it on the wire.
  const generation = useRef(0);
  const inFlight = useRef<{ abort?: () => void } | null>(null);
  // The AbortController behind the login button's "cancel" escape: a scan can
  // run the full callback timeout, and a user who started it by accident must
  // not be locked into it for minutes (the only other way out was reloading
  // the whole panel). Aborting stops the CLIENT's wait; the Host's device flow
  // keeps running and still persists a credential if the scan completes —
  // cancelling the wait is not cancelling the login.
  const loginAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    const isCurrent = () => generation.current === mine && alive.current;
    inFlight.current?.abort?.();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    inFlight.current = controller;
    // The site THIS read was issued for, captured now: the answer must be filed
    // under the site it was asked about, never under whichever site happens to
    // be on screen when it lands (`site` is a dependency, so a switch rebuilds
    // this callback — but the generation guard is what actually decides).
    const forSite = site;
    try {
      const response = await fetch(agnescodeRouteFor(forSite), {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller ? controller.signal : null
      });
      // A route that ANSWERS with a failure is not "no local login state".
      // Returning here silently left `state === null` AND `error === null`, and
      // the credential card then rendered「未关联——请先在桌面端登录」— an
      // accusation this tab has no evidence for. A broken Host route looked
      // exactly like a signed-out desktop App. Name the status instead.
      if (!isCurrent()) return;
      if (!response.ok) {
        setError(format(tt("agnescode.error"), { error: `HTTP ${response.status}` }));
        return;
      }
      const body = (await response.json().catch(() => null)) as AgnescodeState | null;
      if (!isCurrent()) return;
      if (body === null || body.ok === false) {
        setError(typeof body?.error === "string" && body.error !== "" ? body.error : tt("agnescode.loadErrorDetail"));
        return;
      }
      putState(forSite, body);
      setError(null);
      setUpdatedAt(Date.now());
    } catch {
      // An aborted read is this loop superseding itself, not a failure to
      // report: without this the tab would paint an unreachable-Host error
      // every time the user refreshes.
      if (!isCurrent()) return;
      setError(tt("agnescode.hostUnreachable"));
    }
  }, [tt, site]);

  // Retire the in-flight GET before a POST's post-write state is applied: that
  // GET's snapshot was taken BEFORE the write, and letting it land afterwards
  // would overwrite the fresh state for up to one poll tick — the same shape
  // `panel-page.ts`'s echo path retires (bump the token, abort the request, no
  // new state). `load`'s catch above already treats a generation-mismatched
  // abort as "superseded, not failed", so the retired GET stays silent.
  const retireInFlight = () => {
    generation.current += 1;
    inFlight.current?.abort?.();
  };

  // One loop owns the tab's polling: an immediate load on entry, then the
  // cadence; the timer stops on unmount (the tab may close at any time).
  //
  // The timer ALSO stops while the document is hidden, matching `PanelPage`'s
  // interval (which has done this since it was written, with the reasoning
  // "nobody is watching the screen, and every poll keeps a Host connection
  // open"). This tab used to poll on regardless: minimising the window or
  // switching browser tabs left it issuing two upstream reads (balance +
  // catalogue) every 60 s for as long as the panel stayed open — indefinitely,
  // and invisibly, since this tab keeps its own timer rather than riding the
  // shell's cadence. Nothing here is inference (both reads are read-only and
  // spend no quota), so this was waste rather than damage; it is fixed for
  // parity with the sibling tab as much as for the traffic.
  //
  // A returning tab reloads once before resuming, so the "更新于" line cannot
  // greet the user with a figure that aged while the window was in the
  // background — the same handoff `PanelPage` makes.
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (alive.current) void load();
    };
    const start = () => {
      if (timer === null) timer = setInterval(run, AGNESCODE_POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    load();
    start();
    const onVisibility = () => {
      if (!alive.current) return;
      if (document.visibilityState === "hidden") stop();
      else {
        run();
        start();
      }
    };
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      alive.current = false;
      // Bump once more so an in-flight read that resolves after the unmount
      // cannot pass a later remount's generation check.
      generation.current += 1;
      inFlight.current?.abort?.();
      stop();
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [load]);

  // Hand the pinned bar this tab's own freshness and reload. Fires on real
  // changes only: `load` is a stable `useCallback` and `onStatus` is stable on
  // the shell's side, so a publish cannot feed itself.
  useEffect(() => {
    onStatus?.({ updatedAt, refresh: () => void load() });
  }, [onStatus, updatedAt, load]);

  const toggle = useCallback(async (enabled: boolean) => {
    setNote(null);
    try {
      const body = await postJsonOrThrow(AGNESCODE_PATH, { action: "switch", enabled, domain: site });
      // The POST answer is the Host's FULL post-write state (the route's
      // `answer()` spreads `agnescodeState()` under every POST branch, see
      // `routes/agnescode.ts`) — apply it whole: a two-field patch would
      // leave the balance/roster the write just re-published stale, and a
      // patch-onto-null would be a no-op on a tab whose first GET failed.
      if (alive.current) {
        retireInFlight();
        putState(site, body as unknown as AgnescodeState);
      }
    } catch (why) {
      if (alive.current) setNote(format(tt("agnescode.switchError"), { error: why instanceof Error ? why.message : String(why) }));
    }
  }, [tt, site]);

  // The desktop-source flip (ADR-020): same discipline as `toggle` — the POST
  // answer is the full post-write state (the flip re-published through the
  // store-aware publish), so it lands whole. The note face names the switch
  // it failed, not the provider one.
  const toggleDesktopSource = useCallback(async (enabled: boolean) => {
    setNote(null);
    try {
      const body = await postJsonOrThrow(AGNESCODE_PATH, { action: "desktop-source", enabled, domain: site });
      if (alive.current) {
        retireInFlight();
        putState(site, body as unknown as AgnescodeState);
      }
    } catch (why) {
      if (alive.current) setNote(format(tt("agnescode.desktopSourceError"), { error: why instanceof Error ? why.message : String(why) }));
    }
  }, [tt, site]);

  const harvest = useCallback(async () => {
    setHarvestBusy(true);
    setNote(null);
    try {
      // `postJson`, NOT `postJsonOrThrow`: a failed walk answers `ok:false`
      // WITH the diagnosis rows — the rows ARE the message, and the throw
      // face would reduce them to a bare "HTTP 200". The branch below reads
      // the refusal payload the same way the Host writes it.
      const body = await postJson(AGNESCODE_PATH, { action: "harvest", domain: site });
      if (alive.current) {
        // The same full post-write state — its `harvest` block carries the
        // walk's diagnosis rows, so a successful walk flips the credential
        // card right here and the tab no longer queues a second GET (the one
        // that can hold the upstream's 30 s timeout) to learn what the POST
        // just answered. The 60 s poll re-syncs on its own.
        retireInFlight();
        if (body !== null) putState(site, body as unknown as AgnescodeState);
        if (body?.ok === true) {
          setNote(tt("agnescode.harvestOk"));
        } else {
          setNote(tt("agnescode.harvestFail"));
        }
      }
    } catch (why) {
      if (alive.current) setNote(format(tt("agnescode.error"), { error: why instanceof Error ? why.message : String(why) }));
    } finally {
      if (alive.current) setHarvestBusy(false);
    }
  }, [tt, site]);

  // The curation write: persist the allow-list. The POST answer is the full
  // post-write state, so the picker's `hostIds` echo lands from the response
  // itself rather than a reload through the upstream-holding GET.
  const saveModels = useCallback(async (ids: string[]) => {
    const body = await postJsonOrThrow(AGNESCODE_PATH, { action: "saveModels", enabledModelIds: ids, domain: site });
    if (alive.current) {
      retireInFlight();
      putState(site, body as unknown as AgnescodeState);
    }
  }, [site]);

  // The scan-to-sign-in POST. The Host's login branch is a single-flight
  // device flow (opens the browser, waits for the callback, exchanges the
  // code) that can take the full callback timeout, so the button stays in a
  // "waiting" state for the duration and the two sign-in buttons disable each
  // other. `postJson`, NOT `postJsonOrThrow`: a refused login answers
  // `ok:false` WITH the Host's error text (domain / exchange / callback
  // timeout), and the throw face would reduce it to a bare HTTP status.
  const login = useCallback(async () => {
    const controller = new AbortController();
    loginAbort.current = controller;
    setLoginBusy(true);
    setNote(null);
    try {
      const body = await postJson(AGNESCODE_PATH, { action: "login", domain: site }, controller.signal);
      if (alive.current) {
        retireInFlight();
        if (body !== null) putState(site, body as unknown as AgnescodeState);
        if (body?.ok === true) {
          setNote(tt("agnescode.loginOk"));
        } else {
          setNote(format(tt("agnescode.loginFail"), {
            error: typeof body?.error === "string" && body.error !== "" ? body.error : tt("agnescode.loadErrorDetail")
          }));
        }
      }
    } catch (why) {
      if (alive.current) {
        // A user-initiated abort is a deliberate stop, not a failure — say so
        // instead of showing the fetch's AbortError as an error.
        if (loginAbort.current === controller && controller.signal.aborted) {
          setNote(tt("agnescode.loginCancelled"));
        } else {
          setNote(format(tt("agnescode.error"), { error: why instanceof Error ? why.message : String(why) }));
        }
      }
    } finally {
      if (loginAbort.current === controller) loginAbort.current = null;
      if (alive.current) setLoginBusy(false);
    }
  }, [tt, site]);

  const cancelLogin = useCallback(() => {
    loginAbort.current?.abort();
    if (alive.current) setLoginBusy(false);
  }, []);

  const loginDisabled = harvestBusy || loginBusy;

  const enabled = state?.enabled === true;
  // The desktop source (ADR-020): the second switch row and its status line.
  // `hasDesktopSource` is false when the route predates the view (the three
  // `desktopSource*` keys are absent) — a switch the Host cannot honour must
  // never be offered, so the whole row hides on an older Host.
  const hasDesktopSource = state !== null && state.desktopSourceEnabled !== undefined;
  const desktopSourceEnabled = state?.desktopSourceEnabled === true;
  const desktopSourceServing = state?.desktopSourceServing === true;
  const desktopSourceReason = typeof state?.desktopSourceReason === "string" && state?.desktopSourceReason !== ""
    ? state?.desktopSourceReason
    : null;
  const view = agnescodeView(state, error, state === null);
  const loggedIn = view.linked;
  const models = Array.isArray(state?.models) ? state.models : [];
  const attempts = Array.isArray(state?.harvest?.attempts) ? state.harvest.attempts : [];
  const balance = state?.balance ?? null;
  const rateLimit = state?.rateLimit ?? null;
  // The windowed credits-ledger aggregate (today / 30-day totals, the "covered"
  // flag, last debit). `null` until the route's background prime settles, so
  // the ledger line simply does not render yet — the other lines do.
  const ledger = state?.ledger ?? null;
  // This plugin's OWN per-client usage roll (requests + tokens today). `null`
  // until the first recorded turn, so the usage line does not render yet — the
  // other lines do. Per-client, never the account total (that is `ledger`).
  const usage = state?.usage ?? null;
  // WHICH roster `models` is. The fallback's rates are FROZEN at probe time —
  // the multiplier chip on a fallback row is a captured snapshot, not a live
  // price, and the picker must say so instead of presenting it as today's.
  const modelsSource = state?.modelsSource === "fallback" ? "fallback" : "live";
  const modelsAsOf = typeof state?.modelsAsOf === "string" ? state.modelsAsOf : "";

  return h(
    "div",
    null,
    // A route that did not answer is named FIRST. This state used to be set and
    // never rendered, so a failed read left `state === null` and the tab below
    // accused the reader's desktop App of not being signed in — the one
    // reading the panel had no evidence for.
    view.showError
      ? h("div", { style: S.formError, role: "alert" }, format(tt("agnescode.error"), { error }))
      : null,
    // The SITE selector (ADR-023), the SAME control every tab uses
    // (`site-tabs.ts`) with the same dot semantics.
    //
    // Each segment's dot reports the truth for ITS OWN site, from that site's
    // cached reading. A site this tab has never read gets `unknown` — an honest
    // "not measured yet" — because the two rows answer through different
    // stores: filling in `off` would print「未启用」over an account that is
    // registered and signed in, which is exactly the kind of unearned claim the
    // credential card has already been repaired for twice. (Verified by probe:
    // the first version did print「未启用」on the CN dot while the CN row was
    // logged in.)
    h(SiteTabs, {
      active: site,
      onSelect: (next) => {
        if (next === site) return;
        // Retire the in-flight read BEFORE the flip: it was issued against the
        // previous site's route, and letting it land would paint the CN
        // account's balance under the international site's name. Its answer is
        // dropped by the generation guard, so `states` keeps the last reading
        // each site actually produced.
        retireInFlight();
        setError(null);
        setNote(null);
        // NOT `setStates` — the previous site's reading stays cached, so
        // switching back is instant and the frame after a switch is a
        // `pending` "reading" frame rather than a blank one (see `states`).
        setSite(next);
      },
      options: (["cn", "intl"] as AgnescodeSite[]).map((candidate) => {
        const cached = states[candidate];
        return {
          site: candidate,
          label: tt(candidate === "intl" ? "site.intl" : "site.cn"),
          tone: cached === null
            // Never read: no claim. `unknown` is a TONE, not a hole — omitting
            // the dot would make the segment look like a different control.
            ? ("unknown" as const)
            : siteTone(cached.enabled === true, cached.loggedIn === true)
        };
      }),
      tt
    }),
    // The provider switch and the credential card are ONE card now. They used
    // to be two separate things — the switch floated alone at the top of the
    // tab and the linked account sat in its own card below — so a reader saw
    // two rectangles for what is really one decision: is AgnesCode active, and
    // am I signed in. Qoder does the same: the enable toggle lives inside the
    // account card, not above it.
    //
    // The switch (opt-in, default off) decides whether AgnesCode models are
    // registered with DSH at all; the credential card is the desktop App's
    // login state. Two facts, one card.
    view.credentialCard
      ? h(
          "div",
          { style: { ...S.card, marginTop: 4 } },
          // A PENDING frame — this site's first read has not landed yet — says
          // so and nothing else. Without this branch the click that switches
          // sites landed on the unlinked copy below, which printed「未关联——请
          // 先在桌面端登录」about an account nobody had asked about yet; that is
          // the same false accusation the error line and the withheld card were
          // each added to stop, arriving by a third route. No buttons either:
          // they act on the site's credential, and there is no reading yet.
          view.pending
            ? h("div", { style: { ...S.muted, fontSize: 13 }, role: "status" }, tt("agnescode.readingSite"))
            : loggedIn
            ? h(
                "div",
                null,
                // The 小浣 shape: state left, actions right, ONE row — the
                // account line and the buttons share it, and the base URL and
                // the JWT expiry share a caption row beneath (the old three
                // stacked rows spent four lines to say "you are in").
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
                  h("div", { style: { fontSize: 13 }, role: "status" },
                    format(tt("agnescode.loggedIn"), { nick: String(state?.nickname ?? "") })),
                  h("span", { style: S.spacer }),
                  h("button", { type: "button", style: S.button, onClick: () => void harvest(), disabled: loginDisabled },
                    harvestBusy ? tt("agnescode.harvesting") : tt("agnescode.harvest")),
                  h("button", {
                    type: "button",
                    style: S.button,
                    onClick: () => void (loginBusy ? cancelLogin() : login()),
                    // The cancel escape stays clickable while a login runs —
                    // only the OTHER button (harvest) is disabled by the login.
                    disabled: !loginBusy && loginDisabled
                  }, loginBusy ? tt("agnescode.cancelLogin") : tt("agnescode.login"))
                  // NO logout button. The old one did two things the other
                  // controls already do: `harvest` overwrites the stored JWT
                  // from the desktop App (so a stale credential is refreshed,
                  // not logged out) and the switch OFF deregisters the provider.
                  // The only unique effect was deleting the stored JWT from
                  // disk, which is a "forget the credential" privacy action,
                  // not a routine logout — naming it 解除关联 made it read as a
                  // normal operation. The desktop App's own login state is
                  // untouched either way: it lives in the App, not in this
                  // plugin's store.
                ),
                // Shape facts the user may need ("is my token the dead one?") —
                // both from the route secret-free, ONE quiet caption row under
                // the header instead of two stacked lines: the base URL and the
                // expiry are two properties of the same credential, so they
                // read together, and they share the row the way the quota card
                // shares counts-left / reset-right (`S.quotaFoot`). The URL
                // wraps when the row is too narrow for both.
                state?.bffBase !== undefined && state?.bffBase !== ""
                  || typeof state?.expiresAtMs === "number" && state.expiresAtMs > 0
                  ? h(
                      "div",
                      null,
                      h(
                        "div",
                        { style: { ...S.quotaFoot, marginTop: 8, color: "var(--dsw-alias-label-secondary)" } },
                        state?.bffBase !== undefined && state?.bffBase !== ""
                          ? h("span", { style: { ...S.quotaUsed, wordBreak: "break-all" } },
                              format(tt("agnescode.bffBase"), { base: state.bffBase }))
                          : null,
                        typeof state?.expiresAtMs === "number" && state.expiresAtMs > 0
                          ? h("span", {
                            style: {
                              ...S.quotaUsed,
                              whiteSpace: "nowrap",
                              ...(state?.expired === true
                                ? { color: "var(--dsw-alias-state-warn-primary)" }
                                : {})
                            }
                          },
                            // `expiresAtMs` is epoch MS (readJwtExpiry decodes the JWT
                            // `exp` in milliseconds); clockLong eats SECONDS.
                            format(tt(state?.expired === true ? "agnescode.expiresAtExpired" : "agnescode.expiresAt"),
                              { time: clockLong(state.expiresAtMs / 1000) }))
                          : null
                      ),
                      // The date alone used to be the whole story: a credential
                      // that expired last week rendered exactly like a fresh one
                      // (same grey caption, just a past date), and the only
                      // symptom was a 401 inside a conversation. The Host says
                      // `expired`; this line says what to do about it.
                      state?.expired === true
                        ? h("div", {
                          style: {
                            ...S.formNote,
                            fontSize: 12,
                            marginTop: 6,
                            color: "var(--dsw-alias-state-warn-primary)"
                          },
                          role: "status"
                        }, tt("agnescode.expiresAtRemedy"))
                        : null
                    )
                  : null
              )
            : h(
                "div",
                null,
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
                  h("div", { style: { fontSize: 13 } }, tt("agnescode.notLogged")),
                  h("span", { style: S.spacer }),
                  h("button", {
                    type: "button",
                    style: S.button,
                    onClick: () => void harvest(),
                    disabled: loginDisabled
                  }, harvestBusy ? tt("agnescode.harvesting") : tt("agnescode.harvest")),
                  h("button", {
                    type: "button",
                    style: S.button,
                    onClick: () => void (loginBusy ? cancelLogin() : login()),
                    disabled: !loginBusy && loginDisabled
                  }, loginBusy ? tt("agnescode.cancelLogin") : tt("agnescode.login"))
                ),
                // The Windows-only boundary, stated BEFORE the click: the
                // harvest's own tier rows say it too (`unsupported_platform`),
                // but only after the reader has pressed the button and waited
                // for nothing to happen. One quiet caption under the action it
                // constrains — the reader on macOS/Linux needs it up front, the
                // reader on Windows can skip right past.
                h("div", { style: { ...S.muted, fontSize: 12, marginTop: 6 } }, tt("agnescode.harvestWindowsOnly")),
                // The scan-to-sign-in path has NO such platform boundary —
                // state it as the cross-platform alternative to the caption
                // above, so a macOS/Linux reader sees both half of the pair.
                h("div", { style: { ...S.muted, fontSize: 12, marginTop: 2 } }, tt("agnescode.loginHint"))
              ),
          // The switch, a labeled row inside the card rather than a floating
          // line above it. It is deliberately a checkbox (the repo draws no
          // custom toggle): native, keyboard-focusable, and announced by a
          // real `input` to assistive tech, not by a painted pill.
          // The provider switch is the shared `Switch` pill (see `switch.ts`):
          // a native checkbox drawn as a track + thumb, `title` carries the
          // long consequence so the row reads short.
          h(Switch, {
            checked: enabled,
            disabled: loginDisabled,
            onChange: () => void toggle(!enabled),
            label: tt("agnescode.switch"),
            title: tt("agnescode.switchTip"),
            rowStyle: { marginTop: 10 }
          }),
          // The desktop source (ADR-020): the raccoon §6.1.11 twin — a
          // second switch row governing WHICH credential every read asks
          // first (the App's session file, or the stored login state).
          hasDesktopSource
            ? h(Switch, {
              checked: desktopSourceEnabled,
              disabled: loginDisabled,
              onChange: () => void toggleDesktopSource(!desktopSourceEnabled),
              label: tt("agnescode.desktopSource"),
              title: tt("agnescode.desktopSourceTip"),
              rowStyle: { marginTop: 4 }
            })
            : null,
          // Its status line: what the switch is achieving RIGHT NOW —
          // serving from the App's file, or on-but-idle with the Host's
          // own reason (the view's closed set, never a path or shape
          // excerpt). An off switch draws no sentence.
          hasDesktopSource && desktopSourceEnabled && desktopSourceServing
            ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 2 }, role: "status" },
                tt("agnescode.desktopLive"))
            : null,
          hasDesktopSource && desktopSourceEnabled && !desktopSourceServing && desktopSourceReason !== null
            ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 2 }, role: "status" },
                format(tt("agnescode.desktopIdle"), { reason: agnescodeDesktopSourceReasonText(desktopSourceReason, tt) }))
            : null,
          // Registration status: the switch says "wants", the roster header pill
          // says "is" (小浣 shape). Only the NON-registered states stay as text
          // lines here — a successful registration needs no sentence of its own
          // competing with the roster it describes.
          //
          // `AGNESCODE_ERROR_NOT_CONFIGURED` is the publish gate's word for
          // "switch ON, no token yet" — the EXPECTED state between ticking the
          // switch and running the harvest. Rendered raw it looked like a failure
          // that appeared and then vanished ("开关一下启用又消失"), so: before
          // linking it is suppressed — the awaiting-harvest line below already says
          // exactly that; after linking it becomes one quiet instruction, not a red
          // alert.
          state !== null
            ? state.providerError === AGNESCODE_ERROR_NOT_CONFIGURED && loggedIn
              ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4 }, role: "status" }, tt("agnescode.errNotConfigured"))
              : state.providerError !== undefined && state.providerError !== "" && state.providerError !== AGNESCODE_ERROR_NOT_CONFIGURED
                ? h("div", { style: { ...S.formError, marginTop: 4 }, role: "alert" }, state.providerError)
                : enabled && !loggedIn
                  ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4 } }, tt("agnescode.awaitingHarvest"))
                  : state.providerRegistered === true
                    ? null
                    : h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4 } }, tt("agnescode.unregistered"))
            : null
        )
      : null,
    // The last harvest walk's diagnosis rows: one line per probed file, tier
    // first (it is the advice), then the path (it is the evidence). Rendered
    // whenever a walk has run — also after a SUCCESS, so a user who ran it
    // twice sees which file won.
    attempts.length > 0
      ? h(
          "div",
          { style: { ...S.muted, fontSize: 12, marginTop: 8 }, role: "list" },
          attempts.map((attempt, index) =>
            h(
              "div",
              { key: `${String(attempt?.file ?? index)}-${index}`, role: "listitem", style: S.diagRow },
              h("span", { style: { color: attempt?.tier === AGNESCODE_TIER_OK ? "inherit" : "var(--dsw-alias-state-warn-primary)" } },
                `[${tt(`agnescode.tier.${attempt?.tier}`)}] ${String(attempt?.file ?? "")}${attempt?.detail ? ` — ${attempt.detail}` : ""}`)
            )
          )
        )
      : null,
    note !== null
      ? h("div", { style: { ...S.formNote, fontSize: 12, marginTop: 8 }, role: "status" }, note)
      : null,
    // The credit pool is THREE compact cards, not one wide card: the panel is
    // ~860px wide and a single left-aligned balance card left two thirds of it
    // empty, and each figure is a fact of a different kind (the total, the
    // expiring part, the permanent part). Each card is a FIXED 120px chip
    // (`flex: 0 0 120px`, no grow, no cap): the border hugs the figure — the
    // previous grow-basis row stretched a card alone on a wrapped line to the
    // whole row (a full-width border around one digit), and even a 50%-width
    // cap still read half a panel wide. Chips wrap at 3×120+2×8 = 376px of
    // row width; below that two sit on line one and the third drops alone,
    // still 120px. The number keeps the `S.quotaRemaining` weight — it is
    // the fact the reader came to see. A pool the route could not read
    // (`balance === null`) draws NOTHING: a rendered zero would present an
    // unread figure as a measurement.
    loggedIn
      ? h("div", { style: { marginTop: 12 } },
          balance !== null
            ? h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 } },
                h("div", { style: { ...S.pool, flex: "0 0 120px" } },
                  h("div", { style: S.cardHead },
                    h("span", { style: S.poolHead }, tt("agnescode.balanceLabel"))),
                  h("div", { style: { ...S.quotaRemaining, marginTop: 4 } },
                    count(balance.totalBalance ?? 0))),
                h("div", { style: { ...S.pool, flex: "0 0 120px" } },
                  h("div", { style: S.cardHead },
                    h("span", { style: S.poolHead }, tt("agnescode.balanceTimeLabel"))),
                  h("div", { style: { ...S.quotaRemaining, marginTop: 4 } },
                    count(balance.timeSensitiveBalance ?? 0))),
                h("div", { style: { ...S.pool, flex: "0 0 120px" } },
                  h("div", { style: S.cardHead },
                    h("span", { style: S.poolHead }, tt("agnescode.balancePermanentLabel"))),
                  h("div", { style: { ...S.quotaRemaining, marginTop: 4 } },
                    count(balance.permanentBalance ?? 0))))
            : null,
          // The cards carry the SPENDABLE pool; these three muted lines carry the facts
          // that answer "will an invisible quota limit me": the platform's
          // GRANTS (a free account reads 每日免费 0 · 订阅 0, which is the honest
          // answer — there is no hidden daily free quota to hit), this
          // plugin's own rate-limit record (the SYMPTOM of a cap the platform
          // never publishes a number for, so the panel says "you hit it N
          // times" instead of inventing a threshold), and the account's real
          // SPEND aggregated from the platform's credits ledger (whole account,
          // desktop included; "at least" when the 30-day window was not fully
          // fetched). All three are hook-free via
          // {@link agnescodePoolNotes} so the render suite can reach them.
          ...agnescodePoolNotes(balance, rateLimit, ledger, usage, tt),
          models.length > 0
            ? h("div", null,
                // One quiet line ABOVE the picker when the roster is the
                // built-in fallback: the rates it shows were captured at probe
                // time, and a `×1.85` chip the reader cannot date is a price
                // presented as live. Same register as the harvest diagnosis
                // rows (informational, not an alert) — the picker still works,
                // it is just showing a snapshot.
                modelsSource === "fallback"
                  ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 6 }, role: "status" },
                      format(tt("agnescode.fallbackRoster"), { asOf: modelsAsOf === "" ? "?" : modelsAsOf }))
                  : null,
                h(AgnescodeModelPicker, { models, hostIds: state?.enabledModelIds, registered: state?.providerRegistered === true, tt, onSave: saveModels }))
            : null
        )
      : null,
    // The PERMANENT footer: whatever the link state, the desktop App is the
    // thing this whole tab rides on — it needs renewing by reopening (the
    // JWT has no refresh), and the platform hands new users limited-time
    // credits for installing. One quiet line at the bottom, same public-URL
    // discipline as the API tab's official-site link.
    h(
      "div",
      { style: { marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--dsw-alias-border-l1)" } },
      // What this tab IS, at the FOOT rather than the head. At the top it
      // pushed the switch and the credential card below the fold, and every
      // visit began by re-reading sentences the reader had already accepted
      // when they turned the tab on. A reader who needs the explanation (what
      // the plugin touches, why the credentials sit apart from the quota) now
      // finds it here — after the state they came to check, sharing the one
      // divider this tab's closing block already draws.
      h(
        "div",
        { style: { ...S.note, marginTop: 0 } },
        tt("agnescode.desc")
      ),
      h(
        "a",
        {
          href: AGNESCODE_SITE_URL,
          target: "_blank",
          rel: "noreferrer",
          style: { display: "inline-block", marginTop: 8, fontSize: 12, color: "var(--dsw-alias-label-secondary)", textDecoration: "underline", cursor: "pointer" }
        },
        tt("agnescode.downloadCta")
      )
    )
  );
}

/**
 * The model roster the AgnesCode adapter offers, as a hook-free component.
 *
 * Split out of {@link AgnescodeTab} for the same reason the other rosters are:
 * the tab's data is internal state, so the render suite can only ever reach
 * the unlinked frame — a roster inlined there is unassertable. The row is the
 * SAME two-line shape as the sibling rosters (head line over an indented
 * parameter line), sharing `S.modelRow`'s contract — and, since the panel can
 * now curate this provider, the SAME checkbox.
 *
 * The head line's tail carries three platform-declared facts, in this order:
 * a PROMOTION tag (`displayLabel`, tinted like the desktop App's own chip), the
 * credit rate (`multiplier`, as `×N`), and the gating badge (`memberOnly`).
 * All three come from the live `/v2/models` catalogue — none is inferred, and
 * an absent field draws nothing rather than a placeholder.
 *
 * The checkbox is hook-free like the sibling rows: `onToggle` is handed in, so
 * without it the box is display-only and the roster cannot be edited at all.
 * @param {object} props
 * @param {AgnescodeModelData[]} props.models - the rows the route reported.
 * @param {boolean} [props.registered] - whether the provider is registered.
 * @param {unknown} [props.enabledIds] - the curated ids (empty = all on).
 * @param {boolean} [props.busy] - disable the rows while a save is in flight.
 * @param {string} [props.hint] - one quiet rule line under the header.
 * @param {unknown} [props.tools] - the search / bulk row the picker owns.
 * @param {string} [props.emptyNote] - the note shown when nothing is visible.
 * @param {(id: string) => void} [props.onToggle] - the toggle handler.
 * @param {import("./runtime.ts").Tt} props.tt - the dictionary.
 * @returns {unknown} the roster list element.
 */
export function AgnescodeRoster({ models, registered, enabledIds, busy, hint, tools, emptyNote, tt, onToggle }: {
  models: AgnescodeModelData[];
  registered?: boolean;
  enabledIds?: unknown;
  busy?: boolean;
  hint?: string;
  tools?: unknown;
  emptyNote?: string;
  tt: Tt;
  onToggle?: (id: string) => void;
}): unknown {
  const rows = Array.isArray(models) ? models : [];
  return h(
    "div",
    { style: S.modelPanel },
    // The 小浣 header: title left, registration pill right — the state of the
    // roster rides ON the roster instead of being a sentence somewhere above.
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 } },
      h("div", { style: { ...S.muted, fontSize: 12, fontWeight: 600 } }, format(tt("agnescode.models"), { count: count(rows.length) })),
      h("span", { style: S.spacer }),
      registered === true
        ? h("span", { style: { ...S.modelBadge, color: "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))" } }, tt("agnescode.registeredPill"))
        : null
    ),
    // The one rule the rows live by — a quiet line under the header, so the
    // checkboxes explain themselves without a sentence on every row.
    typeof hint === "string" && hint !== ""
      ? h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 6 } }, hint)
      : null,
    tools !== undefined ? tools : null,
    rows.length === 0 && typeof emptyNote === "string" && emptyNote !== ""
      ? h("p", { style: S.empty }, emptyNote)
      : h(
          "ul",
          { style: S.modelList, role: "list" },
          rows.map((row) => {
        const id = String(row?.id ?? "");
        const label = String(row?.name ?? id);
        const on = modelIsOn(enabledIds, id);
        const ctx = typeof row?.contextWindow === "number" && row.contextWindow > 0
          ? format(tt("llm.contextBadge"), { ctx: tokenSize(row.contextWindow) })
          : null;
        const out = typeof row?.maxOutputLength === "number" && row.maxOutputLength > 0
          ? format(tt("llm.metaOutput"), { out: tokenSize(row.maxOutputLength) })
          : null;
        const meta = [ctx, out].filter(Boolean).join(" · ");
        // The platform's own credit multiplier ("Credits per call"). `0` is a
        // PUBLISHED PRICE (free), so it renders `×0.00` rather than vanishing —
        // only an ABSENT field draws nothing. Same rule as the descriptor's
        // display name on the Host side, so picker and panel cannot disagree.
        const rate = typeof row?.multiplier === "number" ? row.multiplier : null;
        // A promotional tag the platform publishes ("限时七折"). Empty means no
        // tag: the key is present on every row, so a presence check would draw
        // eight blank chips.
        const promo = typeof row?.displayLabel === "string" && row.displayLabel !== "" ? row.displayLabel : null;
        return h(
          "li",
          { key: id, style: { ...S.modelRow, ...(on ? {} : S.modelRowOff) } },
          h(
            "div",
            { style: S.modelRowHead },
            RosterCheckbox({ id, label, on, busy, onToggle }),
            h("span", { style: S.spacer }),
            promo === null ? null : h("span", { style: S.modelPromo }, promo),
            rate === null
              ? null
              : h("span", { style: S.modelRate, title: tt("agnescode.rateTitle") }, `×${rate}`),
            row?.vision === true
              ? h("span", {
                style: S.modelBadge,
                // A proven capability reads as the plain chip; the default-on
                // "assumed" row says it is unverified and names the denylist a
                // blind result belongs in, so a model that cannot see the image
                // is never advertised as if it could.
                title: row?.visionSource === "assumed" ? tt("agnescode.visionAssumedTitle") : undefined
              }, row?.visionSource === "assumed" ? tt("agnescode.visionAssumed") : tt("llm.rosterVision"))
              : null,
            row.memberOnly === true ? h("span", { style: S.modelBadge }, tt("agnescode.memberOnly")) : null
          ),
          meta === "" ? null : h("div", { style: S.modelMeta }, meta)
        );
      })
    )
  );
}

/**
 * The AgnesCode model allow-list: which roster rows get pushed to DSH.
 *
 * Hook-based like `ModelPicker`, so the render suite exercises the secret-free
 * half it draws — {@link AgnescodeRoster} and the counts — instead of this
 * state machine. The edit is local until saved: a draft of the allow-list,
 * an "unsaved" state DERIVED by comparing it with the Host's value, and a
 * "saved" state that is the same comparison after the write echoes back.
 *
 * 完整版: the SAME search + tick-all/untick-all + count affordances as the
 * sibling rosters, riding the shared `llm.roster*` dictionary rather than a
 * second copy of the wording. The draft/derived/saved machinery is the same
 * shape as `ModelPicker`, and the row contract is unchanged — the search is a
 * filter over what is rendered, never over what is saved.
 * @param {object} props
 * @param {AgnescodeModelData[]} props.models - the rows the route reported.
 * @param {unknown} [props.hostIds] - the Host's curated ids.
 * @param {boolean} [props.registered] - whether the provider is registered.
 * @param {Tt} props.tt - the dictionary.
 * @param {(ids: string[]) => Promise<void>} [props.onSave] - the save action.
 * @returns {unknown} the roster card plus its edit affordances.
 */
export function AgnescodeModelPicker({ models, hostIds, registered, tt, onSave }: {
  models: AgnescodeModelData[];
  hostIds?: unknown;
  registered?: boolean;
  tt: Tt;
  onSave?: (ids: string[]) => Promise<void>;
}): unknown {
  const rows = Array.isArray(models) ? models : [];
  // Normalised HERE rather than inside the hook: `ModelPicker` passes its
  // snapshot array as-is, and folding the two together would change one of
  // them. See `roster-draft.ts`.
  const host = Array.isArray(hostIds) ? hostIds.filter((id): id is string => typeof id === "string") : [];
  const {
    ids, busy: saving, setBusy: setSaving, query, setQuery, setSavedKey, notice, setNotice,
    idsKey, dirty, justSaved, visible, tickedCount, bulk, toggle, discard
  } = useRosterDraft(rows, host);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setNotice(null);
    try {
      await onSave?.(ids.slice());
      setSavedKey(idsKey);
    } catch (error) {
      setNotice(format(tt("agnescode.rosterError"), { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSaving(false);
    }
  };

  const tools = RosterTools({
    query, setQuery,
    // The `name` is the one per-roster bit: without `autocomplete="off"` and a
    // `name`, this is the only text input on the tab and the browser's password
    // manager would type a saved console ACCOUNT into it — the same hazard the
    // sibling picker names in full.
    name: "agnescode-model-search",
    busy: saving,
    tickedCount,
    visible,
    bulk,
    tt
  });

  return h(
    "div",
    null,
    h(AgnescodeRoster, {
      models: visible,
      registered,
      enabledIds: ids,
      busy: saving,
      hint: tt("agnescode.rosterHint"),
      tools,
      emptyNote: tt("llm.rosterNoMatch"),
      tt,
      // One row is toggled against the WHOLE roster, so an edit survives a
      // later change of the roster the Host reports.
      onToggle: toggle
    }),
    dirty
      ? h(
          "div",
          { style: S.rosterFoot },
          h("button", {
            type: "button",
            style: S.primary,
            disabled: saving === true,
            onClick: () => void save()
          }, saving ? tt("agnescode.rosterSaving") : tt("agnescode.rosterSave")),
          h("button", {
            type: "button",
            style: S.button,
            disabled: saving === true,
            onClick: discard
          }, tt("agnescode.rosterDiscard")),
          h("span", { style: { ...S.muted, fontSize: 12 } }, tt("agnescode.rosterUnsaved"))
        )
      : justSaved
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("agnescode.rosterSaved"))
        : null,
    notice !== null ? h("p", { style: S.formError, role: "alert" }, notice) : null
  );
}
