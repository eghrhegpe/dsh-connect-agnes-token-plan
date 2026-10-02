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
import { postJson, postJsonOrThrow } from "./http.ts";import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";

/** One model row as the /agnescode route reports it. */
interface AgnescodeModel {
  id?: string;
  name?: string;
  vision?: boolean;
  memberOnly?: boolean;
  contextWindow?: number;
  maxOutputLength?: number;
}

/** One harvest-diagnosis row: a tier code and shape facts, never a value. */
interface AgnescodeHarvestAttempt {
  file?: string | null;
  tier?: string;
  detail?: string;
}

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
interface AgnescodeState {
  ok?: boolean;
  enabled?: boolean;
  switchSource?: string;
  loggedIn?: boolean;
  nickname?: string;
  bffBase?: string;
  expiresAtMs?: number | null;
  balance?: {
    totalBalance?: number;
    timeSensitiveBalance?: number;
    permanentBalance?: number;
  } | null;
  models?: AgnescodeModel[];
  providerRegistered?: boolean;
  providerError?: string;
  harvest?: { ok?: boolean; attempts?: AgnescodeHarvestAttempt[] };
  error?: string;
}

/** The cadence the tab polls at while open (balance + roster drift slowly). */
const AGNESCODE_POLL_MS = 60_000;

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
  const [, setLoading] = useState(true);
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

  const load = useCallback(async () => {
    try {
      const response = await fetch(AGNESCODE_PATH, { headers: { accept: "application/json" }, cache: "no-store" });
      // A route that ANSWERS with a failure is not "no local login state".
      // Returning here silently left `state === null` AND `error === null`, and
      // the credential card then rendered「未关联——请先在桌面端登录」— an
      // accusation this tab has no evidence for. A broken Host route looked
      // exactly like a signed-out desktop App. Name the status instead.
      if (!response.ok) {
        if (alive.current) {
          setError(`HTTP ${response.status}`);
          setLoading(false);
        }
        return;
      }
      if (!alive.current) return;
      const body = (await response.json().catch(() => null)) as AgnescodeState | null;
      if (!alive.current) return;
      if (body === null || body.ok === false) {
        setError(typeof body?.error === "string" && body.error !== "" ? body.error : "no answer");
        return;
      }
      setState(body);
      setError(null);
      setUpdatedAt(Date.now());
    } catch {
      if (alive.current) setError("unable to reach the Host");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  // One loop owns the tab's polling: an immediate load on entry, then the
  // cadence; the timer stops on unmount (the tab may close at any time).
  useEffect(() => {
    alive.current = true;
    load();
    const timer = setInterval(() => {
      if (alive.current) void load();
    }, AGNESCODE_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
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
        const attempts: AgnescodeHarvestAttempt[] = Array.isArray((harvestBlock as { attempts?: unknown })?.attempts)
          ? (harvestBlock as { attempts: AgnescodeHarvestAttempt[] }).attempts
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

  const logout = useCallback(async () => {
    setNote(null);
    try {
      await postJsonOrThrow(AGNESCODE_PATH, { action: "logout" });
      if (alive.current) void load();
    } catch (why) {
      if (alive.current) setNote(format(tt("agnescode.error"), { error: why instanceof Error ? why.message : String(why) }));
    }
  }, [load, tt]);

  const enabled = state?.enabled === true;
  const loggedIn = state?.loggedIn === true;
  const models = Array.isArray(state?.models) ? state.models : [];
  const attempts = Array.isArray(state?.harvest?.attempts) ? state.harvest.attempts : [];
  const balance = state?.balance ?? null;

  return h(
    "div",
    null,
    h(
      "div",
      { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", marginBottom: 12 } },
      tt("agnescode.desc")
    ),
    // A route that did not answer is named FIRST. This state used to be set and
    // never rendered, so a failed read left `state === null` and the tab below
    // accused the reader's desktop App of not being signed in — the one
    // reading the panel had no evidence for.
    error !== null
      ? h("div", { style: S.formError, role: "alert" }, format(tt("agnescode.error"), { error }))
      : null,
    // The provider switch (opt-in, default off). It decides whether the
    // AgnesCode models are registered with DSH at all.
    h(
      "label",
      { style: { display: "flex", gap: 8, alignItems: "center", margin: "0 0 12px", cursor: harvestBusy ? "wait" : "pointer" } },
      h("input", { type: "checkbox", checked: enabled, disabled: harvestBusy, onChange: () => void toggle(!enabled) }),
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, tt("agnescode.switch"))
    ),
    // Registration status: the switch says "wants", the roster header pill
    // says "is" (小浣 shape). Only the NON-registered states stay as text
    // lines here — a successful registration needs no sentence of its own
    // competing with the roster it describes.
    //
    // `not_configured` is the publish gate's word for "switch ON, no token
    // yet" — the EXPECTED state between ticking the switch and running the
    // harvest. Rendered raw it looked like a failure that appeared and then
    // vanished ("开关一下启用又消失"), so: before linking it is suppressed —
    // the awaiting-harvest line below already says exactly that; after
    // linking it becomes one quiet instruction, not a red alert.
    state !== null
      ? state.providerError === "not_configured" && loggedIn
        ? h("div", { style: { ...S.muted, fontSize: 12 }, role: "status" }, tt("agnescode.errNotConfigured"))
        : state.providerError !== undefined && state.providerError !== "" && state.providerError !== "not_configured"
          ? h("div", { style: S.formError, role: "alert" }, state.providerError)
          : enabled && !loggedIn
            ? h("div", { style: { ...S.muted, fontSize: 12 } }, tt("agnescode.awaitingHarvest"))
            : state.providerRegistered === true
              ? null
              : h("div", { style: { ...S.muted, fontSize: 12 } }, tt("agnescode.unregistered"))
      : null,
    // The credential half: the linked account (or the harvest affordance).
    // Withheld while a failed read leaves us knowing NOTHING: `state` is null,
    // so `loggedIn` is false, and the unlinked copy below would accuse the
    // reader's desktop App of not being signed in — a claim this tab has no
    // evidence for. The `agnescode.error` line above is the honest statement.
    state === null && error !== null
      ? null
      : h(
          "div",
          { style: { ...S.card, marginTop: 4 } },
          loggedIn
            ? h(
                "div",
                null,
                // The 小浣 shape: state left, actions right, ONE row — the
                // account line, the base URL and the JWT expiry are three
                // stacked rows today and the buttons drift below them, so a
                // linked card spends four lines to say "you are in".
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
                  h("div", { style: { fontSize: 13 }, role: "status" },
                    format(tt("agnescode.loggedIn"), { nick: String(state?.nickname ?? "") })),
                  h("span", { style: S.spacer }),
                  h("button", { type: "button", style: S.button, onClick: () => void harvest(), disabled: harvestBusy },
                    harvestBusy ? tt("agnescode.harvesting") : tt("agnescode.harvest")),
                  h("button", { type: "button", style: S.button, onClick: () => void logout() }, tt("agnescode.logout"))
                ),
                // Shape facts the user may need ("is my token the dead one?") —
                // both from the route secret-free, quiet lines under the row.
                state?.bffBase !== undefined && state?.bffBase !== ""
                  ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 6, wordBreak: "break-all" } },
                      format(tt("agnescode.bffBase"), { base: state.bffBase }))
                  : null,
                typeof state?.expiresAtMs === "number" && state.expiresAtMs > 0
                  ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 2 } },
                      format(tt("agnescode.expiresAt"), { time: clockLong(state.expiresAtMs) }))
                  : null
              )
            : h(
                "div",
                null,
                h("div", { style: { fontSize: 13 } }, tt("agnescode.notLogged")),
                h("button", {
                  type: "button",
                  style: { ...S.button, marginTop: 8 },
                  onClick: () => void harvest(),
                  disabled: harvestBusy
                }, harvestBusy ? tt("agnescode.harvesting") : tt("agnescode.harvest"))
              )
        ),
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
              { key: `${String(attempt?.file ?? index)}-${index}`, role: "listitem", style: { marginBottom: 2 } },
              h("span", { style: { color: attempt?.tier === "ok" ? "inherit" : "var(--dsw-alias-label-secondary)" } },
                `[${tt(`agnescode.tier.${attempt?.tier}`)}] ${String(attempt?.file ?? "")}${attempt?.detail ? ` — ${attempt.detail}` : ""}`)
            )
          )
        )
      : null,
    note !== null
      ? h("div", { style: { ...S.formNote, fontSize: 12, marginTop: 8 }, role: "status" }, note)
      : null,
    // The credit pool and the roster the adapter offers. The pool is a
    // subscription pool: total, then the platform's own split, then the JWT
    // expiry — ONE quiet line, the way the 小浣 card does it (the old two
    // stacked lines read as two separate facts about two things). A pool the
    // route could not read (`balance === null`) draws NOTHING — a rendered
    // zero would present an unread figure as a measurement.
    loggedIn
      ? h(
          "div",
          { style: { marginTop: 12 } },
          balance !== null
            ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 8 } },
                format(tt("agnescode.balanceLine"), {
                  balance: count(balance.totalBalance ?? 0),
                  timeSensitive: count(balance.timeSensitiveBalance ?? 0),
                  permanent: count(balance.permanentBalance ?? 0)
                }))
            : null,
          models.length > 0
            ? h(AgnescodeRoster, { models, registered: state?.providerRegistered === true, tt })
            : null
        )
      : null,
    // The PERMANENT footer: whatever the link state, the desktop App is the
    // thing this whole tab rides on — it needs renewing by reopening (the
    // JWT has no refresh), and the platform hands new users limited-time
    // credits for installing. One quiet line at the bottom, same public-URL
    // discipline as the API tab's official-site link.
    h(
      "a",
      {
        href: AGNESCODE_SITE_URL,
        target: "_blank",
        rel: "noreferrer",
        style: { display: "inline-block", marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--dsw-alias-border-l1)", fontSize: 12, color: "var(--dsw-alias-label-secondary)", textDecoration: "underline", cursor: "pointer" }
      },
      tt("agnescode.downloadCta")
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
 * parameter line), sharing `S.modelRow`'s contract. What it carries instead
 * of a rate chip is the `memberOnly` badge — the platform-declared
 * gating fact this provider HAS; no multiplier chip exists here because the
 * upstream declares no per-model rate (billing is the credit pool), and
 * inventing one would libel the roster.
 * @param {object} props
 * @param {AgnescodeModel[]} props.models - the rows the route reported.
 * @param {import("./runtime.ts").Tt} props.tt - the dictionary.
 * @returns {unknown} the roster list element.
 */
export function AgnescodeRoster({ models, registered, tt }: { models: AgnescodeModel[]; registered?: boolean; tt: Tt }): unknown {
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
        ? h("span", { role: "status", style: { ...S.modelBadge, color: "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))" } }, tt("agnescode.registeredPill"))
        : null
    ),
    h(
      "ul",
      { style: S.modelList, role: "list" },
      rows.map((row) => {
        const id = String(row?.id ?? "");
        const label = String(row?.name ?? id);
        const ctx = typeof row?.contextWindow === "number" && row.contextWindow > 0
          ? format(tt("llm.contextBadge"), { ctx: tokenSize(row.contextWindow) })
          : null;
        const out = typeof row?.maxOutputLength === "number" && row.maxOutputLength > 0
          ? format(tt("llm.metaOutput"), { out: tokenSize(row.maxOutputLength) })
          : null;
        const meta = [ctx, out].filter(Boolean).join(" · ");
        return h(
          "li",
          { key: id, style: S.modelRow },
          h(
            "div",
            { style: S.modelRowHead },
            h("span", { style: S.modelName, title: id }, label),
            h("span", { style: S.spacer }),
            row.memberOnly === true ? h("span", { style: S.modelBadge }, tt("agnescode.memberOnly")) : null
          ),
          meta === "" ? null : h("div", { style: S.modelMeta }, meta)
        );
      })
    )
  );
}
