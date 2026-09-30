/**
 * The third panel tab: the Raccoon Work（商汤小浣熊）provider — "second
 * upstream provider" (ROADMAP §6.1).
 *
 * It is a SEPARATE data source from the Token Plan snapshot: this tab owns a
 * small, self-managed poll loop over the plugin's own `/raccoon` route (stop
 * when the tab leaves, one refresh on entry), and renders one card with, in
 * order: the provider switch (opt-in, default off), the WeChat-QR login
 * (a code the tab encodes into a QR image locally, so the panel never ships
 * an image dependency), the credit balance, and the model roster the adapter
 * offers. Nothing here touches the Token Plan pool semantics — the two tabs
 * are two providers, deliberately independent.
 *
 * Hook-based like `ApiKeyForm`/`ProviderSwitch`: the render suite (which
 * cannot mount hooks) exercises the secret-free status lines of the other
 * tabs; this tab's route is covered by `test/raccoon.test.mjs`.
 */
import { RACCOON_PATH } from "./const.ts";
import { count, format } from "./format.ts";
import { postJson, postJsonOrThrow } from "./http.ts";
import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { qrDataUrl } from "./qr.ts";
import { S } from "./styles.ts";

/** One model row as the /raccoon route reports it. */
interface RaccoonModel {
  id?: string;
  name?: string;
  vision?: boolean;
  multiplier?: number;
  contextWindow?: number;
  maxOutputLength?: number;
}

/** The secret-free state the /raccoon route answers. */
interface RaccoonState {
  ok?: boolean;
  enabled?: boolean;
  switchSource?: string;
  loggedIn?: boolean;
  nickname?: string;
  balance?: number | null;
  models?: RaccoonModel[];
  providerRegistered?: boolean;
  providerError?: string;
  error?: string;
  /** The in-flight QR scan the route last issued (cleared when it settles). */
  scanUrl?: string;
  scanCode?: string;
}

/** The cadence the tab polls at while open (balance + roster drift slowly). */
const RACCOON_POLL_MS = 60_000;

/**
 * The QR image the login code encodes. The payload is the gateway's own
 * public login page URL (~144 bytes), which fits the v1–10/M capacity the
 * local encoder supports; `buildQrMatrix` throwing is the out-of-range
 * signal, and the tab then falls back to the plain URL text.
 */
function qrImageOf(scanUrl: string | null | undefined): unknown {
  if (typeof scanUrl !== "string" || scanUrl === "") return null;
  try {
    return h("img", {
      src: qrDataUrl(scanUrl, { size: 208 }),
      alt: "WeChat QR",
      width: 208,
      height: 208,
      style: { display: "block", margin: "8px 0", borderRadius: 4 }
    });
  } catch {
    // Out of the supported capacity: the URL itself is still scannable by
    // opening it, so show it as text.
    return h("code", { style: { ...S.muted, fontSize: 12, wordBreak: "break-all" } }, scanUrl);
  }
}

/**
 * The Raccoon tab body.
 * @param {object} props
 * @param {Tt} props.tt - the dictionary.
 * @returns {unknown} the tab's card tree.
 */
export function RaccoonTab({ tt }: { tt: Tt }): unknown {
  const [state, setState] = useState<RaccoonState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The in-flight login walk: the route blocks up to its 5-minute deadline,
  // so the button goes to a "waiting" state and the result lands in `state`.
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const alive = useRef(true);
  const pollMs = useRef(RACCOON_POLL_MS);

  const load = useCallback(async () => {
    const generation = pollMs.current;
    try {
      const response = await fetch(RACCOON_PATH, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok || !alive.current || generation !== pollMs.current) return;
      const body = (await response.json().catch(() => null)) as RaccoonState | null;
      if (!alive.current || generation !== pollMs.current) return;
      if (body === null || body.ok === false) {
        setError(typeof body?.error === "string" && body.error !== "" ? body.error : "no answer");
        return;
      }
      setState(body);
      setError(null);
    } catch {
      if (alive.current && generation === pollMs.current) setError("unable to reach the Host");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  // One loop owns the tab's polling: an immediate load on entry, then the
  // cadence; the timer stops on unmount (the tab may close at any time).
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (alive.current) void load();
    };
    run();
    timer = setInterval(run, pollMs.current);
    return () => {
      alive.current = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [load]);

  const toggle = useCallback(async (enabled: boolean) => {
    setLoginNote(null);
    try {
      const body = await postJsonOrThrow(RACCOON_PATH, { action: "switch", enabled });
      if (alive.current) setState((current) => (current ? { ...current, enabled: body.enabled === true, providerRegistered: body.providerRegistered === true } : current));
    } catch (why) {
      if (alive.current) setLoginNote(format(tt("raccoon.switchError"), { error: why instanceof Error ? why.message : String(why) }));
    }
  }, [tt]);

  const startLogin = useCallback(async () => {
    setLoginBusy(true);
    setLoginNote(null);
    // The scan URL is issued by the POST walk but delivered by the GET: fire
    // ONE immediate fetch so the QR appears within ~100 ms of the click
    // (the 60 s cadence would leave a full minute of "nothing happened"),
    // then keep a fast poll while the walk is waiting, because that GET is
    // also how the tab learns the login has settled early.
    const quick = async () => {
      for (let i = 0; i < 150; i++) {
        await load();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };
    void quick();
    // The route answers only when the walk settles (success / timeout), so
    // the button stays "waiting" the whole time and the result repicks the
    // card from the fresh state.
    try {
      const body = await postJson(RACCOON_PATH, { action: "login" });
      if (alive.current) {
        if (body?.ok === true) {
          setLoginNote(null);
        } else {
          setLoginNote(body?.error ?? tt("raccoon.error").replace("{error}", "login did not finish"));
        }
        void load();
      }
    } catch (why) {
      if (alive.current) setLoginNote(format(tt("raccoon.error"), { error: why instanceof Error ? why.message : String(why) }));
    } finally {
      if (alive.current) setLoginBusy(false);
    }
  }, [load, tt]);

  const logout = useCallback(async () => {
    setLoginNote(null);
    try {
      await postJsonOrThrow(RACCOON_PATH, { action: "logout" });
      if (alive.current) void load();
    } catch (why) {
      if (alive.current) setLoginNote(format(tt("raccoon.error"), { error: why instanceof Error ? why.message : String(why) }));
    }
  }, [load, tt]);

  const enabled = state?.enabled === true;
  const loggedIn = state?.loggedIn === true;
  const models = Array.isArray(state?.models) ? state.models : [];

  return h(
    "div",
    null,
    h(
      "div",
      { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", marginBottom: 12 } },
      tt("raccoon.desc")
    ),
    // The provider switch (opt-in, default off). It decides whether the Raccoon
    // models are registered with DSH at all.
    h(
      "label",
      { style: { display: "flex", gap: 8, alignItems: "center", margin: "0 0 12px", cursor: loginBusy ? "wait" : "pointer" } },
      h("input", { type: "checkbox", checked: enabled, disabled: loginBusy, onChange: () => void toggle(!enabled) }),
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, tt("raccoon.switch"))
    ),
    // Registration status: the switch says "wants", this line says "is".
    // A registration failure stays visible even while the switch is OFF —
    // hiding it behind `enabled` is the same dead-end as the account editor
    // used to be: a failed state with no visible affordance to act on it.
    // When the switch is on but no login exists yet, the unregistered line
    // must say THAT (a "tick the switch" nudge at an already-ticked switch
    // is the same lie `llm.registeredPending` used to tell).
    state !== null
      ? state.providerRegistered === true
        ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" },
            format(tt("raccoon.registered"), { count: count(models.length) }))
        : state.providerError !== undefined && state.providerError !== ""
          ? h("div", { style: S.formError, role: "alert" }, state.providerError)
          : enabled && !loggedIn
            ? h("div", { style: { ...S.muted, fontSize: 12 } }, tt("raccoon.awaitingLogin"))
            : h("div", { style: { ...S.muted, fontSize: 12 } }, tt("raccoon.unregistered"))
      : null,
    // The login half: a WeChat QR the tab encodes locally, or the login
    // result line once the walk settles. While a walk is in flight the QR
    // (from the route's shared in-flight scan) IS the waiting indicator —
    // the button alone already shows the busy state, so there is no second
    // "waiting" line beside it.
    h(
      "div",
      { style: { ...S.card, marginTop: 4 } },
      loggedIn
        ? h(
            "div",
            null,
            h("div", { style: { fontSize: 13 }, role: "status" },
              format(tt("raccoon.loggedIn"), { nick: String(state?.nickname ?? "") })),
            h("button", { type: "button", style: S.button, onClick: () => void logout() }, tt("raccoon.logout"))
          )
        : h(
            "div",
            null,
            h("div", { style: { fontSize: 13 } }, tt("raccoon.notLogged")),
            // The QR encodes the scan URL the route is CURRENTLY waiting on
            // (it re-issues one per login; the tab's poll picks it up in
            // `state.scanUrl`), or the login button when no walk is in flight.
            state?.scanUrl !== undefined && state?.scanUrl !== ""
              ? qrImageOf(state.scanUrl)
              : null,
            h("button", {
              type: "button",
              style: S.button,
              onClick: () => void startLogin(),
              disabled: loginBusy
            }, loginBusy ? tt("raccoon.loggingIn") : tt("raccoon.login"))
          )
    ),
    loginNote !== null
      ? h("div", { style: { ...S.formNote, fontSize: 12, marginTop: 8 }, role: "status" }, loginNote)
      : null,
    // The balance and the roster the adapter offers.
    loggedIn
      ? h(
          "div",
          { style: { marginTop: 12 } },
          h(
            "div",
            { style: { ...S.muted, fontSize: 12, marginBottom: 8 } },
            format(tt("raccoon.balance"), { balance: count(state?.balance ?? 0) })
          ),
          models.length > 0
            ? h(
                "div",
                null,
                h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 6 } }, format(tt("raccoon.models"), { count: count(models.length) })),
                h(
                  "ul",
                  { style: S.modelList },
                  models.map((row) => h(
                    "li",
                    { key: row.id, style: S.modelRow },
                    h("span", { style: S.modelName, title: String(row.id ?? "") }, row.name ?? row.id),
                    h("span", { style: S.modelBadge },
                      (typeof row.multiplier === "number" && row.multiplier !== 0 && row.multiplier !== 1 ? `×${row.multiplier}` : row.multiplier === 0 ? "free" : "×1"),
                      row.vision === true ? " · vision" : ""
                    )
                  ))
                )
              )
            : null
        )
      : null
  );
}
