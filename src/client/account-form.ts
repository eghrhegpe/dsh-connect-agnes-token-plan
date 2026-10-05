/**
 * The setup form shown when no account is configured.
 *
 * This is the whole point of the account route: the user types a username
 * and a password once, and the Host signs in, stores the account in the
 * DSH credentials, and renews the token from then on. No `.env` editing,
 * no restart, and the password is never sent anywhere but this Host.
 *
 * `bare` strips the inner card and title: the account section card that
 * embeds this form (when a token already works) supplies both itself.
 *
 * Hook-based, so the Node render suite does not mount this form; its
 * secret-free halves are covered via `ProviderStatus` and the route tests.
 */
import { ACCOUNT_PATH, AGNES_SIGNUP_URL } from "./const.ts";
import { format } from "./format.ts";
import { postJson } from "./http.ts";
import { h, useCallback, useEffect, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { CLIENT_CODE, COOLDOWN_TEXT, REFUSAL_TEXT, servedWaitUntil } from "./snapshot.ts";
import { S } from "./styles.ts";
import type { AuthData } from "./wire.ts";

export function AccountForm({ auth, onDone, tt, bare, hasSnapshot }: {
  auth?: AuthData | null;
  onDone?: () => void;
  tt: Tt;
  bare?: boolean;
  /**
   * Whether the panel this form sits in already has a snapshot to render.
   *
   * It gates ONE line: the post-save "saved and signed in, reading the
   * quota…". That sentence is a progress claim, and it was never resolved —
   * `saved` is only cleared by "clear the saved account", so once a reader
   * signed in, the card underneath a fully rendered quota kept announcing
   * that it was still reading it. Same shape as a stale `auth.error`: a
   * transient state that outlives the moment it describes.
   *
   * The standalone form (no snapshot yet) still needs it — there the reader
   * really is waiting. Inside the panel the numbers arriving ARE the
   * confirmation, and `auth.saved` below still states the durable half.
   */
  hasSnapshot?: boolean;
}): unknown {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // The user must be able to see what they actually typed: a browser
  // autofill or an IME full-width character looks identical to a real
  // password behind the dots, and every failed guess burns a lockout
  // attempt on the platform.
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // The platform's own words for a classified refusal, shown beneath the
  // canned line: the canned text translates, the prose carries the lockout
  // policy and anything else the platform wanted to say.
  const [formDetail, setFormDetail] = useState<string | null>(null);
  // `saved` means a sign-in was stored. It is NOT a generic "the request
  // worked" flag — forgetting the account is a different outcome with a
  // different sentence, and reusing this one made the "clear the saved
  // account" button announce "saved and signed in, reading quota…".
  const [saved, setSaved] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  // Epoch millis until which the platform asked us not to retry. While
  // this is in the future the submit button stays disabled, because a
  // retry inside the window is what extends a lockout.
  //
  // Seeded from the HOST's throttle, not only from this component's own
  // history: the throttle file is shared across profiles and processes
  // (`throttle-store.ts`), so a lockout taken elsewhere is real here too, and
  // the very first render after a page refresh used to show an enabled button
  // inside a window the Host was still serving. `servedWaitUntil` is the
  // single source for that (and returns 0 for a parked refusal, which has no
  // deadline to count down and is spoken about in words instead).
  const [cooldownUntil, setCooldownUntil] = useState(() => servedWaitUntil(auth ?? null, Date.now()));
  const [now, setNow] = useState(() => Date.now());

  // Adopt a window the Host started serving after this form mounted (another
  // process parked a refusal, or the account route answered a different
  // profile's throttle).
  //
  // DEPENDENCY SHAPE IS LOAD-BEARING. This must depend on `[auth]` ALONE, and
  // must NOT read `cooldownUntil` — it used to, and that was an infinite loop:
  // the effect writes the state it also depends on, and the value it writes is
  // computed from `Date.now()`. While the served window is live, `auth` is
  // frozen between polls (a 30s cadence) while the wall clock keeps moving, so
  // `now + remaining` grew past the previous value on every single commit —
  // re-armed, re-ran, re-armed. Commit time is 0ms in no real browser. The
  // visible damage was worse than the bug this commit fixed: the countdown
  // interval below was torn down and rebuilt on every re-arm, so the ticking
  // clock never ticked, `coolingMinutes` froze at its initial value, and the
  // button stayed disabled FOREVER — "window" had become "never".
  //
  // A functional update hands the comparison to React without making the
  // current value a dependency, so the effect cannot observe its own write.
  // The guard is still monotonic (a shorter remaining window must not re-arm
  // one the reader is already inside), it just stops being self-feeding.
  useEffect(() => {
    const until = servedWaitUntil(auth ?? null, Date.now());
    if (until <= 0) return;
    setCooldownUntil((previous) => (until > previous ? until : previous));
  }, [auth]);

  // One ticking clock drives the countdown; it stops when the wait ends.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= cooldownUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  const cooling = now < cooldownUntil;
  const coolingMinutes = Math.max(1, Math.ceil((cooldownUntil - now) / 60_000));

  const setCooldown = useCallback((ms: number) => {
    setCooldownUntil(Date.now() + ms);
    setNow(Date.now());
  }, []);

  const submit = useCallback(async (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    // Refuse to fire inside the platform's own wait window.
    if (cooling) return;
    if (username.trim() === "" || password === "") {
      setFormError(tt("auth.empty"));
      return;
    }
    setBusy(true);
    setFormError(null);
    setFormDetail(null);
    try {
      const body = await postJson(ACCOUNT_PATH, { username: username.trim(), password });
      if (body && body.ok === true) {
        // Clear the password from component state the moment it is no
        // longer needed: it lives on in the Host's credentials, not here.
        setPassword("");
        setSaved(true);
        // A fresh sign-in supersedes any earlier "account cleared" note.
        setForgotten(false);
        onDone?.();
        return;
      }
      const code = body?.code;
      // The Host's own backoff is authoritative: retrying inside it is what
      // turns a bad password into a locked account, so surface the wait
      // instead of a plain refusal.
      //
      // A PARKED refusal wins over the window, and the window is honoured only
      // when the refusal is NOT parked. They can both arrive: the account
      // route copies the platform's stated window into the body
      // (`routes/account.ts`) while the snapshot's `needsUserAction` is
      // computed from the throttle's own `parked` flag — and a captcha that the
      // platform answers with `Retry-After: 7200` yields `parked: true` AND a
      // two-hour window. Counting that down is the same lie `servedWaitUntil`
      // refuses to tell: the clock reaches zero and nothing retries, because
      // waiting cannot satisfy a captcha. The sentence below then says so in
      // words instead, and the button stays usable — retyping IS the fix.
      const parked = body?.needsUserAction === true;
      const waitMs = !parked && typeof body?.retryAfterMs === "number" ? body.retryAfterMs : null;
      if (waitMs !== null && waitMs > 0) {
        setCooldown(waitMs);
        // Same guard the refusal lookup below uses: an absent code must not be
        // used as an index. `COOLDOWN_TEXT[undefined]` happens to read as
        // `undefined` at runtime and land on the same line, but the two
        // adjacent lookups spelling that rule differently is exactly what let
        // `tsc` sit red on this file with no gate watching.
        setFormError(tt(code !== undefined ? COOLDOWN_TEXT[code] ?? "auth.rateLimited" : "auth.rateLimited"));
        return;
      }
      // Only say "wrong password" when the platform said so. Every other
      // refusal gets its own line, and anything unrecognised shows the
      // platform's own words rather than a guess.
      if (code !== undefined && typeof REFUSAL_TEXT[code] === "string") {
        setFormError(tt(REFUSAL_TEXT[code]));
        setFormDetail(typeof body?.detail === "string" && body.detail !== "" ? body.detail : null);
        return;
      }
      setFormError(code === CLIENT_CODE.LOGIN_FAILED
        ? format(tt("auth.failed"), { reason: body?.error ?? "" })
        : (body?.error ?? tt("auth.network")));
    } catch {
      setFormError(tt("auth.network"));
    } finally {
      setBusy(false);
    }
  }, [username, password, onDone, tt, cooling, setCooldown]);

  const forget = useCallback(async () => {
    setBusy(true);
    setFormError(null);
    setFormDetail(null);
    try {
      const body = await postJson(ACCOUNT_PATH, { forget: true });
      if (body?.ok !== true) {
        setFormError(body?.error ?? tt("auth.network"));
        return;
      }
      // Not `setSaved`: that flag means a sign-in was stored, and its
      // sentence claims one. Clearing the account is its own outcome.
      setForgotten(true);
      setSaved(false);
      setUsername("");
      setPassword("");
      onDone?.();
    } catch {
      setFormError(tt("auth.network"));
    } finally {
      setBusy(false);
    }
  }, [onDone, tt]);

  return h(
    "div",
    { style: bare ? {} : { ...S.card, maxWidth: 420 } },
    // `bare` drops the inner card and title: the caller (the account
    // section card) already supplies both.
    bare ? null : h("div", { style: S.sectionTitle }, tt("auth.title")),
    // The official entry, visible in BOTH states: no account yet → the
    // sign-up page; account present → quota management / API keys.
    // Shown in both standalone and bare embed forms.
    h("a", {
      href: AGNES_SIGNUP_URL,
      target: "_blank",
      rel: "noreferrer",
      // The one link skin every form shares — `styles.ts`, so a reskin
      // lands everywhere at once instead of here.
      style: S.externalLink
    }, tt(auth?.hasAccount ? "auth.portalHint" : "auth.registerHint")),
    h(
      "form",
      { onSubmit: submit },
      h(
        "label",
        { style: S.field },
        h("span", { style: S.fieldLabel }, tt("auth.username")),
        h("input", {
          style: S.input,
          value: username,
          autoComplete: "username",
          placeholder: tt("auth.placeholderUser"),
          disabled: busy,
          onChange: (event: { target: { value: string } }) => setUsername(event.target.value)
        })
      ),
      h(
        "label",
        { style: S.field },
        h("span", { style: S.fieldLabel }, tt("auth.password")),
        h(
          "div",
          { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("input", {
            style: { ...S.input, flex: 1 },
            type: showPassword ? "text" : "password",
            value: password,
            autoComplete: "current-password",
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setPassword(event.target.value)
          }),
          h(
            "button",
            {
              type: "button",
              style: { ...S.button, flex: "none" },
              disabled: busy,
              onClick: () => setShowPassword((shown) => !shown)
            },
            showPassword ? tt("auth.hide") : tt("auth.show")
          )
        )
      ),
      h(
        "div",
        { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
        h(
          "button",
          {
            type: "submit",
            style: { ...S.primary, ...(busy || cooling ? S.primaryBusy : {}) },
            disabled: busy || cooling
          },
          busy ? tt("auth.submitting") : tt("auth.submit")
        ),
        auth?.hasAccount
          ? h(
              "button",
              { type: "button", style: S.button, disabled: busy, onClick: forget },
              tt("auth.forget")
            )
          : null
      ),
      // Two different outcomes, two different sentences: "the account was
      // cleared" must never read as "saved and signed in".
      forgotten
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("auth.forgotten"))
        : saved && hasSnapshot !== true
          ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("auth.working"))
          : null,
      formError ? h("p", { style: S.formError, role: "alert" }, formError) : null,
      formError && formDetail ? h("p", { style: S.formNote }, formDetail) : null,
      // A refusal no clock can fix (a wrong password, a captcha) is PARKED:
      // the Host stops retrying and says so, rather than showing a countdown
      // that would tick down into another attempt that can only fail. Served
      // as `auth.needsUserAction` with no countdown, and readable after a
      // refresh or from another profile — the throttle is shared, so a lockout
      // taken on one profile is a lockout on both. Distinct from
      // `auth.locked` (the platform says the account itself is locked) and
      // from `formError` (one attempt's own refusal, which does have a
      // countdown above).
      auth?.needsUserAction === true
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("auth.parked"))
        : null,
      // the button is greyed out is never a mystery.
      cooling
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } },
            format(tt("auth.retryAfter"), { minutes: coolingMinutes }))
        : null,
      h("p", { style: S.formNote }, auth?.ephemeral === true ? tt("auth.ephemeral") : tt("auth.saved")),
      // The auto-recovery readiness is a boolean from the Host (`state()`):
      // whether the environment carries `AGNES_PASSWORD`. The value
      // itself never reaches the bundle; the line only tells the user
      // whether a dead refresh token re-signs in by itself or asks again.
      h("p", { style: S.formNote },
        auth?.autoRecoverArmed === true ? tt("auth.autoRecoverOn") : tt("auth.autoRecoverOff"))
    )
  );
}
