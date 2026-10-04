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
 * There is NO in-panel login: the WeChat scan happens inside the desktop App,
 * so the login-equivalent is「检测本机登录态」(a harvest walk). A failed walk
 * renders one line per probed file with its tier — "no App", "unreadable",
 * "key unavailable", "decryption failed" want different user advice and never
 * share a sentence.
 *
 * Hook-based like the quota tab. The tab's own frame is unreachable from the
 * render suite (its data is internal state, so it always renders the
 * unlinked view); the roster it draws is therefore split into the hook-free
 * {@link AgnescodeRoster}, which the suite CAN mount and pin, and this tab's
 * route is covered by `test/agnescode.test.mjs`.
 */
import { AGNESCODE_PATH, AGNESCODE_SITE_URL } from "./const.ts";
import { clockLong, count, format, tokenSize } from "./format.ts";
import { postJson, postJsonOrThrow } from "./http.ts";
import { modelIsOn } from "./models.ts";
import { useRosterDraft } from "./roster-draft.ts";
import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { Switch } from "./switch.ts";
import { S } from "./styles.ts";
import {
  AGNESCODE_ERROR_NOT_CONFIGURED,
  AGNESCODE_TIER_OK,
  type AgnescodeHarvestAttemptData,
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

/** The cadence the tab polls at while open (balance + roster drift slowly). */
const AGNESCODE_POLL_MS = 60_000;

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
 *
 * @param {AgnescodeState|null} state - the last body the route answered, if any.
 * @param {string|null} error - the last read failure, if any.
 * @returns {{showError: boolean, credentialCard: boolean, linked: boolean}}
 */
export function agnescodeView(
  state: AgnescodeState | null,
  error: string | null
): { showError: boolean; credentialCard: boolean; linked: boolean } {
  return {
    showError: error !== null,
    credentialCard: !(state === null && error !== null),
    linked: state?.loggedIn === true
  };
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
  const [state, setState] = useState<AgnescodeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When this tab last read its route successfully. The bar quotes it instead
  // of the snapshot's stamp: two different routes, two different cadences.
  const [updatedAt, setUpdatedAt] = useState(0);
  // The in-flight harvest walk: the button goes to a "reading" state and the
  // diagnosis rows land in `state.harvest` (also on failure — the walk's
  // answer IS the diagnosis).
  const [harvestBusy, setHarvestBusy] = useState(false);
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

  const load = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    const isCurrent = () => generation.current === mine && alive.current;
    inFlight.current?.abort?.();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    inFlight.current = controller;
    try {
      const response = await fetch(AGNESCODE_PATH, {
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
        setError(`HTTP ${response.status}`);
        return;
      }
      const body = (await response.json().catch(() => null)) as AgnescodeState | null;
      if (!isCurrent()) return;
      if (body === null || body.ok === false) {
        setError(typeof body?.error === "string" && body.error !== "" ? body.error : "no answer");
        return;
      }
      setState(body);
      setError(null);
      setUpdatedAt(Date.now());
    } catch {
      // An aborted read is this loop superseding itself, not a failure to
      // report: without this the tab would paint "unable to reach the Host"
      // every time the user refreshes.
      if (!isCurrent()) return;
      setError("unable to reach the Host");
    }
  }, []);

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
      const body = await postJsonOrThrow(AGNESCODE_PATH, { action: "switch", enabled });
      if (alive.current) setState((current) => (current ? { ...current, enabled: body.enabled === true, providerRegistered: body.providerRegistered === true } : current));
    } catch (why) {
      if (alive.current) setNote(format(tt("agnescode.switchError"), { error: why instanceof Error ? why.message : String(why) }));
    }
  }, [tt]);

  const harvest = useCallback(async () => {
    setHarvestBusy(true);
    setNote(null);
    try {
      // `postJson`, NOT `postJsonOrThrow`: a failed walk answers `ok:false`
      // WITH the diagnosis rows — the rows ARE the message, and the throw
      // face would reduce them to a bare "HTTP 200". The branch below reads
      // the refusal payload the same way the Host writes it.
      const body = await postJson(AGNESCODE_PATH, { action: "harvest" });
      if (alive.current) {
        const harvestBlock = body?.harvest;
        const attempts: AgnescodeHarvestAttemptData[] = Array.isArray((harvestBlock as { attempts?: unknown })?.attempts)
          ? (harvestBlock as { attempts: AgnescodeHarvestAttemptData[] }).attempts
          : [];
        setState((current) => (current ? { ...current, harvest: { ok: body?.ok === true, attempts } } : current));
        if (body?.ok === true) {
          setNote(tt("agnescode.harvestOk"));
        } else {
          setNote(tt("agnescode.harvestFail"));
        }
        void load();
      }
    } catch (why) {
      if (alive.current) setNote(format(tt("agnescode.error"), { error: why instanceof Error ? why.message : String(why) }));
    } finally {
      if (alive.current) setHarvestBusy(false);
    }
  }, [load, tt]);

  // The curation write: persist the allow-list, then reload so the picker's
  // next echo matches what was saved — the edit is live the moment it lands.
  const saveModels = useCallback(async (ids: string[]) => {
    await postJsonOrThrow(AGNESCODE_PATH, { action: "saveModels", enabledModelIds: ids });
    if (alive.current) void load();
  }, [load]);

  const enabled = state?.enabled === true;
  const view = agnescodeView(state, error);
  const loggedIn = view.linked;
  const models = Array.isArray(state?.models) ? state.models : [];
  const attempts = Array.isArray(state?.harvest?.attempts) ? state.harvest.attempts : [];
  const balance = state?.balance ?? null;

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
          loggedIn
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
                  h("button", { type: "button", style: S.button, onClick: () => void harvest(), disabled: harvestBusy },
                    harvestBusy ? tt("agnescode.harvesting") : tt("agnescode.harvest"))
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
                      { style: { ...S.quotaFoot, marginTop: 8, color: "var(--dsw-alias-label-secondary)" } },
                      state?.bffBase !== undefined && state?.bffBase !== ""
                        ? h("span", { style: { ...S.quotaUsed, wordBreak: "break-all" } },
                            format(tt("agnescode.bffBase"), { base: state.bffBase }))
                        : null,
                      typeof state?.expiresAtMs === "number" && state.expiresAtMs > 0
                        ? h("span", { style: { ...S.quotaUsed, whiteSpace: "nowrap" } },
                            format(tt("agnescode.expiresAt"), { time: clockLong(state.expiresAtMs) }))
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
                    disabled: harvestBusy
                  }, harvestBusy ? tt("agnescode.harvesting") : tt("agnescode.harvest"))
                )
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
            disabled: harvestBusy,
            onChange: () => void toggle(!enabled),
            label: tt("agnescode.switch"),
            title: tt("agnescode.switchTip"),
            rowStyle: { marginTop: 10 }
          }),
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
    // The credit pool is THREE small cards in one row, not one wide card: the
    // panel is ~860px wide and a single left-aligned balance card left two
    // thirds of it empty, and each figure is a fact of a different kind (the
    // total, the expiring part, the permanent part). A min-width + `flex-wrap`
    // row keeps them on one line when there is room and stacks them when the
    // panel is narrow. The number keeps the `S.quotaRemaining` weight — it is
    // the fact the reader came to see. A pool the route could not read
    // (`balance === null`) draws NOTHING: a rendered zero would present an
    // unread figure as a measurement.
    loggedIn
      ? h("div", { style: { marginTop: 12 } },
          balance !== null
            ? h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 } },
                h("div", { style: { ...S.pool, flex: "1 1 160px", minWidth: 120 } },
                  h("div", { style: S.cardHead },
                    h("span", { style: S.poolHead }, tt("agnescode.balanceLabel"))),
                  h("div", { style: { ...S.quotaRemaining, marginTop: 4 } },
                    count(balance.totalBalance ?? 0))),
                h("div", { style: { ...S.pool, flex: "1 1 160px", minWidth: 120 } },
                  h("div", { style: S.cardHead },
                    h("span", { style: S.poolHead }, tt("agnescode.balanceTimeLabel"))),
                  h("div", { style: { ...S.quotaRemaining, marginTop: 4 } },
                    count(balance.timeSensitiveBalance ?? 0))),
                h("div", { style: { ...S.pool, flex: "1 1 160px", minWidth: 120 } },
                  h("div", { style: S.cardHead },
                    h("span", { style: S.poolHead }, tt("agnescode.balancePermanentLabel"))),
                  h("div", { style: { ...S.quotaRemaining, marginTop: 4 } },
                    count(balance.permanentBalance ?? 0))))
            : null,
          models.length > 0
            ? h(AgnescodeModelPicker, { models, hostIds: state?.enabledModelIds, registered: state?.providerRegistered === true, tt, onSave: saveModels })
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
            h(
              "label",
              {
                style: {
                  display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto",
                  minWidth: 0, cursor: busy === true ? "default" : "pointer"
                }
              },
              h("input", {
                type: "checkbox",
                checked: on,
                disabled: busy === true,
                style: S.modelCheck,
                "aria-label": label,
                onChange: onToggle ? () => onToggle(id) : undefined
              }),
              h("span", { style: S.modelName, title: id }, label)
            ),
            h("span", { style: S.spacer }),
            promo === null ? null : h("span", { style: S.modelPromo }, promo),
            rate === null
              ? null
              : h("span", { style: S.modelRate, title: tt("agnescode.rateTitle") }, `×${rate}`),
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

  const tools = h(
    "div",
    { style: S.rosterTools },
    h("input", {
      type: "search",
      style: { ...S.input, flex: "1 1 200px", width: "auto" },
      value: query,
      placeholder: tt("llm.rosterSearchPlaceholder"),
      "aria-label": tt("llm.rosterSearchPlaceholder"),
      // Same Chromium autofill hazard as the sibling picker: this is the only
      // text input on the tab, so without `autocomplete="off"` it would be
      // where the browser's password manager typed a saved console ACCOUNT.
      autoComplete: "off",
      name: "agnescode-model-search",
      disabled: saving,
      onChange: (event: { target: { value: string } }) => setQuery(event.target.value)
    }),
    h("span", {
      style: S.rosterCount,
      title: format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length })
    }, format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length })),
    h("button", {
      type: "button",
      style: S.rosterBulk,
      disabled: saving === true || visible.length === 0,
      onClick: () => bulk(true)
    }, tt("llm.rosterAll")),
    h("button", {
      type: "button",
      style: S.rosterBulk,
      disabled: saving === true || visible.length === 0,
      onClick: () => bulk(false)
    }, tt("llm.rosterNone"))
  );

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
