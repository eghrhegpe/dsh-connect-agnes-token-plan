/**
 * The fourth panel tab: the AgnesCode（爱思编程）provider — "third upstream
 * provider" (ROADMAP §6.3).
 *
 * It is a SEPARATE data source from the Token Plan snapshot AND from the
 * Raccoon tab: this tab owns a small, self-managed poll loop over the plugin's
 * own `/agnescode` route (stop when the tab leaves, one refresh on entry), and
 * renders one card with, in order: the provider switch (opt-in, default off),
 * the credential state (linked account + per-account base + expiry, or the
 * harvest walk whose per-file diagnosis rows are the workbuddy five-tier
 * discipline), the credit pool, and the model roster the adapter offers.
 * Nothing here touches the Token Plan or Raccoon semantics — the tabs are
 * three providers, deliberately independent.
 *
 * There is NO in-panel login: the WeChat scan happens inside the desktop App,
 * so the login-equivalent is「检测本机登录态」(a harvest walk). A failed walk
 * renders one line per probed file with its tier — "no App", "unreadable",
 * "key unavailable", "decryption failed" want different user advice and never
 * share a sentence.
 *
 * Hook-based like `RaccoonTab`. The tab's own frame is unreachable from the
 * render suite (its data is internal state, so it always renders the
 * unlinked view); the roster it draws is therefore split into the hook-free
 * {@link AgnescodeRoster}, which the suite CAN mount and pin, and this tab's
 * route is covered by `test/agnescode.test.mjs`.
 */
import { AGNESCODE_PATH } from "./const.ts";
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
 * @returns {unknown} the tab's card tree.
 */
export function AgnescodeTab({ tt }: { tt: Tt }): unknown {
  const [state, setState] = useState<AgnescodeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The in-flight harvest walk: the button goes to a "reading" state and the
  // diagnosis rows land in `state.harvest` (also on failure — the walk's
  // answer IS the diagnosis).
  const [harvestBusy, setHarvestBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(AGNESCODE_PATH, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok || !alive.current) return;
      const body = (await response.json().catch(() => null)) as AgnescodeState | null;
      if (!alive.current) return;
      if (body === null || body.ok === false) {
        setError(typeof body?.error === "string" && body.error !== "" ? body.error : "no answer");
        return;
      }
      setState(body);
      setError(null);
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
        const attempts = Array.isArray(body?.harvest?.attempts) ? body.harvest.attempts : [];
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
    // The provider switch (opt-in, default off). It decides whether the
    // AgnesCode models are registered with DSH at all.
    h(
      "label",
      { style: { display: "flex", gap: 8, alignItems: "center", margin: "0 0 12px", cursor: harvestBusy ? "wait" : "pointer" } },
      h("input", { type: "checkbox", checked: enabled, disabled: harvestBusy, onChange: () => void toggle(!enabled) }),
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, tt("agnescode.switch"))
    ),
    // Registration status: the switch says "wants", this line says "is".
    // The same three-way shape as the Raccoon tab — a failed registration
    // stays visible even while the switch is OFF.
    state !== null
      ? state.providerRegistered === true
        ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" },
            format(tt("agnescode.registered"), { count: count(models.length) }))
        : state.providerError !== undefined && state.providerError !== ""
          ? h("div", { style: S.formError, role: "alert" }, state.providerError)
          : enabled && !loggedIn
            ? h("div", { style: { ...S.muted, fontSize: 12 } }, tt("agnescode.awaitingHarvest"))
            : h("div", { style: { ...S.muted, fontSize: 12 } }, tt("agnescode.unregistered"))
      : null,
    // The credential half: the linked account (or the harvest affordance).
    h(
      "div",
      { style: { ...S.card, marginTop: 4 } },
      loggedIn
        ? h(
            "div",
            null,
            h("div", { style: { fontSize: 13 }, role: "status" },
              format(tt("agnescode.loggedIn"), { nick: String(state?.nickname ?? "") })),
            // The per-account base and the JWT expiry are shape facts the
            // user may need ("is my token the dead one?") — both come from
            // the route secret-free.
            state?.bffBase !== undefined && state?.bffBase !== ""
              ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4, wordBreak: "break-all" } },
                  format(tt("agnescode.bffBase"), { base: state.bffBase }))
              : null,
            typeof state?.expiresAtMs === "number" && state.expiresAtMs > 0
              ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4 } },
                  format(tt("agnescode.expiresAt"), { time: clockLong(state.expiresAtMs) }))
              : null,
            h("button", { type: "button", style: { ...S.button, marginTop: 8 }, onClick: () => void harvest(), disabled: harvestBusy },
              harvestBusy ? tt("agnescode.harvesting") : tt("agnescode.harvest")),
            h("button", { type: "button", style: { ...S.button, marginTop: 8, marginLeft: 8 }, onClick: () => void logout() }, tt("agnescode.logout"))
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
    // subscription pool: total, then the platform's own split. A pool the
    // route could not read (`balance === null`) draws NOTHING — a rendered
    // zero would present an unread figure as a measurement.
    loggedIn
      ? h(
          "div",
          { style: { marginTop: 12 } },
          balance !== null
            ? h(
                "div",
                { style: { ...S.muted, fontSize: 12, marginBottom: 2 } },
                format(tt("agnescode.balance"), { balance: count(balance.totalBalance ?? 0) })
              )
            : null,
          balance !== null
            ? h(
                "div",
                { style: { ...S.muted, fontSize: 12, marginBottom: 8 } },
                format(tt("agnescode.balanceDetail"), {
                  timeSensitive: count(balance.timeSensitiveBalance ?? 0),
                  permanent: count(balance.permanentBalance ?? 0)
                })
              )
            : null,
          models.length > 0
            ? h(AgnescodeRoster, { models, tt })
            : null
        )
      : null
  );
}

/**
 * The model roster the AgnesCode adapter offers, as a hook-free component.
 *
 * Split out of {@link AgnescodeTab} for the same reason `RaccoonRoster` is:
 * the tab's data is internal state, so the render suite can only ever reach
 * the unlinked frame — a roster inlined there is unassertable. The row is the
 * SAME two-line shape as the sibling rosters (head line over an indented
 * parameter line), sharing `S.modelRow`'s contract. What it carries instead
 * of the Raccoon rate chip is the `memberOnly` badge — the platform-declared
 * gating fact this provider HAS; no multiplier chip exists here because the
 * upstream declares no per-model rate (billing is the credit pool), and
 * inventing one would libel the roster.
 * @param {object} props
 * @param {AgnescodeModel[]} props.models - the rows the route reported.
 * @param {import("./runtime.ts").Tt} props.tt - the dictionary.
 * @returns {unknown} the roster list element.
 */
export function AgnescodeRoster({ models, tt }: { models: AgnescodeModel[]; tt: Tt }): unknown {
  const rows = Array.isArray(models) ? models : [];
  return h(
    "div",
    { style: S.modelPanel },
    h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 6 } }, format(tt("agnescode.models"), { count: count(rows.length) })),
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
