/**
 * dsh-connect-sensenova-token-plan — Client half.
 *
 * Registers one global sidebar row (`sidebar.panellist`) whose id addresses
 * the matching root-scoped `main` keyed page, then renders that page: the
 * SenseNova Token Plan quota pools (5h / 7d windows with used/limit/percent)
 * and per-model credit consumption. The data comes from the Host's read-only
 * `/api/dsh-connect-sensenova-token-plan/snapshot` route, polled only while the page is
 * mounted — the Client folds no session events of its own.
 *
 * Styling uses theme tokens only (`--dsw-alias-*`), and the module never
 * imports a Harness Client package: React comes from the browser module table.
 * @module dsh-connect-sensenova-token-plan/client
 */

/**
 * The factory body, shared by the browser and by Node.
 *
 * It is deliberately dependency-free apart from `react` (which the loader hands
 * in): the browser module table resolves package names only, and `client.js`
 * ships unbuilt, so a relative `import` in here would resolve in the browser
 * but nowhere else. The Node-side test suites run this exact factory with a
 * stand-in React (`client-surface.js`), so the definitions it sees — the
 * decision, the tables, the style tokens, the components — are the ones the
 * browser runs, not a copy.
 *
 * @param {Function} require - the loader's require; hands out `react`.
 * @returns {{inject: string[], apply: Function, panel: object}}
 */
function clientFactory(require) {
  const React = require("react");
  const h = React.createElement;
  const { useState, useEffect, useCallback } = React;

  /** Dictionary namespace this plugin owns. */
  const NS = "dsh-connect-sensenova-token-plan";
  /** Shared id: the sidebar row id and the `main` slot key are the same string. */
  const PANEL_ID = "dsh-connect-sensenova-token-plan";
  /** The Host snapshot route. Relative, same-origin. */
  const SNAPSHOT_PATH = "/api/dsh-connect-sensenova-token-plan/snapshot";
  /** The account route: lets the panel configure itself, no `.env` editing. */
  const ACCOUNT_PATH = "/api/dsh-connect-sensenova-token-plan/account";

  /** Simplified Chinese dictionary (the key-set source of truth). */
  const zh = {
    "entry.label": "积分面板",
    "panel.title": "积分面板",
    "panel.back": "返回会话",
    "panel.refresh": "刷新",
    "panel.updated": "更新于 {time}",
    "panel.loading": "加载中…",
    "panel.error": "读取失败：{error}",
    "panel.jwtMissing": "还没有配置控制台账号。",
    "panel.jwtExpired": "控制台令牌已失效，且无法用已保存的 refresh_token 续期。请重新登录一次。",
    "panel.configError": "插件配置有误：{error}",
    "panel.shapeDrift": "上游返回的结构可能有变：{detail}",
    "auth.title": "连接商汤控制台",
    "auth.username": "账号",
    "auth.password": "密码",
    "auth.show": "显示",
    "auth.hide": "隐藏",
    "auth.placeholderUser": "登录 platform.sensenova.cn 的账号",
    "auth.submit": "登录",
    "auth.submitting": "登录中…",
    "auth.working": "已保存并登录，正在读取额度…",
    "auth.forget": "清除已保存的账号",
    "auth.forgotten": "已清除账号（当前令牌仍可用）",
    "auth.saved": "账号已保存在 DSH 凭据中，不会写入插件目录",
    "auth.ephemeral": "注意：当前 Host 没有凭据服务，账号只保存在内存中，重启后需要重新登录。",
    "auth.badCredentials": "账号或密码不正确",
    "auth.locked": "账号已被锁定，请在商汤控制台用手机号验证或联系客服解锁。",
    "auth.retryAfter": "平台要求等待约 {minutes} 分钟后再试；等待期间面板不会自动重试，避免再次触发锁定。",
    "auth.rateLimited": "尝试过于频繁，请稍后再试。",
    "auth.verification": "需要额外验证（短信/图形验证码），自动化登录无法完成，请先在浏览器登录一次。",
    "auth.failed": "登录未完成：{reason}",
    "auth.empty": "请填写账号和密码",
    "auth.network": "无法连接本机 Host",
    "panel.empty": "暂无数据。",
    "section.pools": "积分池",
    "pool.window5h": "5 小时",
    "pool.window7d": "每周",
    "pool.used": "已用",
    "pool.remaining": "剩余",
    "pool.reset": "重置 {time}",
    "pool.grant": "返赠余额 {balance}",
    "pool.grantExpiry": "最近返赠到期 {time}（{balance} 分）",
    "pool.models": "模型",
    "pool.dedicated": "专属池",
    "pool.default": "通用池",
    "pool.callable": "可调用",
    "pool.locked": "需开通 +{count} 个",
    "pool.lockedTitle": "套餐覆盖但当前 Key 无权限",
    "pool.uncounted": "不计入积分池：{models}",
    "shape.api": "接口",
    "shape.missing": "缺少字段",
    "section.trend": "每模型消耗（近 {hours} 小时）",
    "trend.model": "模型",
    "trend.credits": "积分",
    "trend.none": "该区间内没有消耗记录。",
    "auth.selfRenew": "令牌自动续期中",
    "auth.needsLogin": "需要重新登录",
    "note": "数据来自商汤控制台 API（pool-usage / credit-usage-trend），Host 侧缓存 {cache} 秒；控制台令牌约 3 小时过期，由 Host 用 refresh_token 静默续期。"
  };

  /** English dictionary, mirroring every zh key. */
  const en = {
    "entry.label": "Credits",
    "panel.title": "Credits",
    "panel.back": "Back to conversation",
    "panel.refresh": "Refresh",
    "panel.updated": "Updated {time}",
    "panel.loading": "Loading…",
    "panel.error": "Could not read: {error}",
    "panel.jwtMissing": "No SenseNova console account is configured yet.",
    "panel.jwtExpired": "The console token is no longer valid and could not be renewed from the stored refresh_token. Sign in again.",
    "panel.configError": "The plugin is misconfigured: {error}",
    "panel.shapeDrift": "The upstream payload shape may have changed: {detail}",
    "auth.title": "Connect the SenseNova console",
    "auth.username": "Username",
    "auth.password": "Password",
    "auth.show": "Show",
    "auth.hide": "Hide",
    "auth.placeholderUser": "Your platform.sensenova.cn account",
    "auth.submit": "Sign in",
    "auth.submitting": "Signing in…",
    "auth.working": "Saved and signed in; reading quota…",
    "auth.forget": "Forget the saved account",
    "auth.forgotten": "Account cleared (the current token still works)",
    "auth.saved": "Stored in the DSH credentials, not in this plugin's folder",
    "auth.ephemeral": "Note: this Host has no credentials service, so the account lives in memory only and must be entered again after a restart.",
    "auth.badCredentials": "That username or password is not right",
    "auth.locked": "This account is locked. Verify by phone in the SenseNova console or contact support to unlock it.",
    "auth.retryAfter": "The platform asks to wait about {minutes} more minutes. The panel will not retry on its own during that window, so the lock is not extended.",
    "auth.rateLimited": "Too many attempts. Wait a moment and try again.",
    "auth.verification": "This sign-in needs an extra step (SMS or captcha) that automation cannot complete. Sign in once in a browser first.",
    "auth.failed": "Sign-in did not complete: {reason}",
    "auth.empty": "Enter a username and a password",
    "auth.network": "Could not reach the local Host",
    "panel.empty": "No data yet.",
    "section.pools": "Credit pools",
    "pool.window5h": "5 hours",
    "pool.window7d": "Weekly",
    "pool.used": "Used",
    "pool.remaining": "Remaining",
    "pool.reset": "resets {time}",
    "pool.grant": "Grant balance {balance}",
    "pool.grantExpiry": "Next grant expiry {time} ({balance} cr)",
    "pool.models": "Models",
    "pool.dedicated": "dedicated",
    "pool.default": "default",
    "pool.callable": "Callable",
    "pool.locked": "+{count} need activation",
    "pool.lockedTitle": "In the plan but this key has no permission",
    "pool.uncounted": "Not billed to credit pools: {models}",
    "shape.api": "endpoint",
    "shape.missing": "missing field",
    "section.trend": "Per-model consumption (last {hours} h)",
    "trend.model": "Model",
    "trend.credits": "Credits",
    "trend.none": "No consumption in this range.",
    "auth.selfRenew": "Token renews itself",
    "auth.needsLogin": "Sign-in required",
    "note": "Data from the SenseNova console API (pool-usage / credit-usage-trend), cached {cache}s on the Host; the console token lasts ~3h and the Host renews it silently from a refresh token."
  };

  /** Theme-token-only styles; a renamed token degrades looks, never rendering. */
    const S = {
      // The shell's center column is `display:flex; flex-direction:column;
      // overflow:hidden` — it never scrolls itself; every main-slot panel owns
      // its own scroll body. This root fills the column and clips; the pinned
      // header stays flex-none and `scroll` (flex:1, min-height:0) takes the
      // overflow. Without this chain the page grows past the column and the
      // shell silently truncates everything below the fold.
      page: { flex: "1 1 auto", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", color: "var(--dsw-alias-label-primary)", fontSize: 14, lineHeight: "22px" },
      headerBar: { flex: "none", background: "var(--dsw-alias-bg-base)", position: "relative", zIndex: 1 },
      header: { display: "flex", alignItems: "center", gap: 12, maxWidth: 1040, margin: "0 auto", padding: "16px 32px 12px" },
      scroll: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" },
      content: { padding: "6px 32px 56px", maxWidth: 1040, margin: "0 auto" },
      title: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: "28px" },
      updated: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 },
      spacer: { flex: 1 },
      button: { height: 30, padding: "0 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", fontSize: 13, cursor: "pointer" },
      sectionTitle: { margin: "22px 0 10px", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
      card: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, padding: 16, marginBottom: 12 },
      poolHead: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      poolName: { fontSize: 15, fontWeight: 600 },
      chip: { display: "inline-flex", alignItems: "center", height: 22, padding: "0 8px", borderRadius: 999, fontSize: 12, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)" },
      windowRow: { marginTop: 12 },
      windowLabel: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--dsw-alias-label-secondary)", marginBottom: 6 },
      bar: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" },
      barFill: { height: "100%", borderRadius: 3, background: "var(--dsw-alias-brand-primary)" },
      barFillWarn: { background: "var(--dsw-alias-state-warn-primary)" },
      barFillError: { background: "var(--dsw-alias-state-error-primary)" },
      windowMeta: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--dsw-alias-label-secondary)", marginTop: 4 },
      grant: { marginTop: 10, fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
      models: { marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 },
      modelTag: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 11, padding: "2px 6px", borderRadius: 6, background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l1)" },
      table: { width: "100%", borderCollapse: "collapse" },
      th: { textAlign: "left", fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontWeight: 500, padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
      td: { padding: "8px", borderBottom: "1px solid var(--dsw-alias-border-l1)", fontSize: 13 },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12 },
      muted: { color: "var(--dsw-alias-label-secondary)" },
      error: { color: "var(--dsw-alias-state-error-primary)" },
      note: { marginTop: 24, color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" },
      empty: { color: "var(--dsw-alias-label-secondary)", padding: "18px 0" },
      field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
      fieldLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
      input: {
        height: 32, padding: "0 10px", borderRadius: 8, fontSize: 13,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)"
      },
      /** Real shell tokens — replaces the color-mix hack that faked "on-primary". */
      primary: {
        height: 32, padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-button-primary-fill)",
        color: "var(--dsw-alias-label-primary-foreground)", cursor: "pointer"
      },
      primaryHover: { background: "var(--dsw-alias-button-primary-hover)" },
      primaryBusy: { opacity: 0.6, cursor: "default" },
      formError: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, margin: "10px 0 0" },
      formNote: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, margin: "10px 0 0" }
    };

    /** `HH:MM` for one epoch second. */
    function clock(epoch) {
      if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
      const date = new Date(epoch * 1000);
      const pad = (value) => String(value).padStart(2, "0");
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** `MM-DD HH:mm` for one epoch second. */
    function clockLong(epoch) {
      if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
      const date = new Date(epoch * 1000);
      const pad = (value) => String(value).padStart(2, "0");
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** Thousands-separated number, trimmed. */
    function count(value) {
      const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
      if (number >= 10000) return Math.round(number).toLocaleString();
      return String(Math.round(number * 100) / 100);
    }

    /** Fill a `{token}` template from a dictionary entry. */
    function format(template, vars) {
      let text = template;
      for (const [key, value] of Object.entries(vars || {})) {
        text = text.split(`{${key}}`).join(String(value));
      }
      return text;
    }

    /** The sidebar row glyph: the shell owns the button, this draws the coin. */
    function PanelIcon({ size }) {
      return h(
        "svg",
        {
          "data-dsh-panel-entry": PANEL_ID,
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.3",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true"
        },
        h("circle", { cx: 8, cy: 8, r: 6 }),
        h("path", { d: "M8 5.2v5.6M6.2 6.6h3.6M6.2 9.4h3.6" })
      );
    }

    /** One quota window row: label, progress bar, used/limit, reset time. */
    function WindowRow({ label, window, tt }) {
      const { limit, used, remaining, resetAt } = window;
      const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
      const tone = pct >= 90 ? S.barFillError : pct >= 70 ? S.barFillWarn : S.barFill;
      return h(
        "div",
        { style: S.windowRow },
        h(
          "div",
          { style: S.windowLabel },
          h("span", null, label),
          h("span", null, resetAt ? format(tt("pool.reset"), { time: clock(resetAt) }) : "")
        ),
        h(
          "div",
          { style: S.bar, role: "progressbar", "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 },
          h("div", { style: { ...tone, width: `${pct}%` } })
        ),
        h(
          "div",
          { style: S.windowMeta },
          h("span", null, `${tt("pool.used")} ${count(used)}`),
          h("span", null, `${tt("pool.remaining")} ${count(remaining)}`),
          h("span", null, `${pct.toFixed(1)}%`)
        )
      );
    }

    /** One pool card: name, two quota windows, grant balance, model list. */
    function PoolCard({ pool, tt }) {
      const callable = pool.callableModels || pool.modelIds || [];
      const locked = pool.lockedModels || [];
      return h(
        "div",
        { style: S.card },
        h(
          "div",
          { style: S.poolHead },
          h("span", { style: S.poolName }, pool.name),
          h("span", { style: S.chip }, pool.poolType === "dedicated" ? tt("pool.dedicated") : tt("pool.default"))
        ),
        h(WindowRow, { label: tt("pool.window5h"), window: pool.window5h, tt }),
        h(WindowRow, { label: tt("pool.window7d"), window: pool.window7d, tt }),
        pool.grantBalance > 0
          ? h("div", { style: S.grant }, format(tt("pool.grant"), { balance: count(pool.grantBalance) }))
          : null,
        pool.nearestGrantExpiry
          ? h("div", { style: S.grant }, format(tt("pool.grantExpiry"), { time: clockLong(pool.nearestGrantExpiry), balance: count(pool.nearestGrantExpiringBalance) }))
          : null,
        h(
          "div",
          { style: S.models },
          h("span", { style: { ...S.muted, fontSize: 12 } }, `${tt("pool.callable")}:`),
          callable.map((model) => h("span", { key: model, style: S.modelTag }, model))
        ),
        locked.length > 0
          ? h(
              "div",
              { style: { ...S.models, ...S.muted }, title: locked.join(", ") },
              h("span", { style: { fontSize: 12 } }, format(tt("pool.locked"), { count: locked.length }))
            )
          : null
      );
    }

    /** Per-model credit consumption table. */
    function TrendTable({ trend, tt }) {
      if (!trend || trend.models.length === 0) return h("div", { style: S.empty }, tt("trend.none"));
      const cell = (text, mono) => h("td", { style: { ...S.td, ...(mono ? S.mono : {}) } }, text);
      return h(
        "table",
        { style: S.table },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", { style: S.th }, tt("trend.model")),
            h("th", { style: S.th }, tt("trend.credits"))
          )
        ),
        h(
          "tbody",
          null,
          trend.models.map((row) =>
            h(
              "tr",
              { key: row.model },
              cell(row.model, true),
              cell(count(row.credits))
            )
          )
        )
      );
    }

    /**
     * Read one snapshot response into the (data, error) pair the panel renders.
     *
     * The Host answers HTTP 200 for every expected outcome and signals the
     * difference in the body: `ok:true` carries the numbers, `ok:false` carries
     * a code and — crucially — the `auth` block, so a panel that cannot reach
     * the console can still say whether its token will renew by itself.
     *
     * A named function at module scope, not inline branching, so the
     * Node-side tests can drive the panel's REAL reading of a response by
     * loading this bundle as a module (`client-surface.js`) — instead of a
     * hand-written copy that would drift the moment either side is edited.
     *
     * @param {unknown} body - the parsed snapshot response.
     * @returns {{data: object|null, error: object|string|null}}
     *   exactly one of the two is non-null.
     */
    function interpretSnapshot(body) {
      if (body && body.ok === false) {
        // The code is kept to pick the guidance rather than the message.
        return { data: null, error: { message: body.error || "unexpected payload", code: body.code, auth: body.auth ?? null } };
      }
      if (!body || body.ok !== true) return { data: null, error: "unexpected payload" };
      return { data: body, error: null };
    }

    /**
     * The panel's guidance line for a wire code, keyed by `body.code`.
     *
     * This is the ONE deliberate copy of the Host's taxonomy: the browser
     * cannot import `codes.js` (the Client module table resolves package
     * names only, and this bundle ships unbuilt). The copy is therefore
     * pinned, not trusted — `test/panel.test.mjs` asserts every key here
     * exists in `CODE`, so a code renamed on either side fails the suite
     * instead of silently reading as "no guidance".
     */
    const GUIDANCE_BY_CODE = Object.freeze({
      auth_error: "panel.jwtExpired",
      jwt_expired: "panel.jwtExpired",
      not_configured: "panel.jwtMissing",
      config_error: "panel.configError"
    });

    /**
     * Failures the sign-in form must NOT answer, because no login fixes them.
     *
     *   config_error  — a bad endpoint override; the operator must fix it.
     *   console_error — the console did not answer; it usually clears on the
     *                   next poll, and the text must say so.
     *
     * Hiding either behind a login box turns "the console is down" into
     * "please sign in". Pinned to `NO_LOGIN_CODES` in `codes.js` by the same
     * test: this set is the copy, that one is the declaration.
     */
    const FORM_EXCLUDED_CODES = Object.freeze(new Set(["config_error", "console_error"]));

    /**
     * The platform's classified refusals, keyed by wire code, mapped to the
     * dictionary line the form shows beneath the platform's own detail. The
     * canned text translates; the prose (`body.detail`) carries the lockout
     * policy and anything else the platform wanted to say.
     */
    const REFUSAL_TEXT = Object.freeze({
      login_rejected: "auth.badCredentials",
      account_locked: "auth.locked",
      rate_limited: "auth.rateLimited",
      verification_required: "auth.verification"
    });

    /**
     * The panel's decision: what this snapshot means for what to show.
     *
     * Deliberately a module-scope pure function in `(data, error, tt)`.
     * `PanelPage` calls it in the browser, and the Node-side tests call the
     * very same function after loading this bundle as a module (see
     * `client-surface.js`): no source text is copied or scraped, so the
     * tested logic and the running logic cannot drift apart.
     *
     * @param {object|null} data - the snapshot, or null when none was read.
     * @param {object|string|null} error - a transport string or a structured failure.
     * @param {(key: string) => string} tt - the active language's dictionary.
     * @returns {{failure: object|null, auth: object|null, needsSetup: boolean,
     *   guidanceKey: string|null, guidance: string|null, shapeWarnings: object[]}}
     */
    function viewOf(data, error, tt) {
      // `error` is either a string (transport failure) or the Host's structured
      // failure. The auth state travels with both, so a panel that cannot read
      // the console can still say whether the token renews itself.
      const failure = error === null || error === undefined
        ? null
        : typeof error === "string" ? { message: error, code: null, auth: null } : error;
      const auth = data?.auth ?? failure?.auth ?? null;
      // With no data the form is the answer whenever the fix is the ACCOUNT:
      // nothing has been entered yet, or no token can be obtained — except for
      // the codes no login can fix. The first load has neither failure nor
      // data; it has nothing to explain, so it falls to the form as well.
      const needsSetup = data === null && !FORM_EXCLUDED_CODES.has(failure?.code ?? null);
      // The dictionary key, resolved with the caller's `tt`; returned as a key
      // so tests can assert the decision without owning a dictionary.
      const guidanceKey = failure === null ? null : GUIDANCE_BY_CODE[failure.code] ?? null;
      const guidance = guidanceKey === null
        ? null
        : guidanceKey === "panel.configError"
          ? format(tt(guidanceKey), { error: failure.message })
          : tt(guidanceKey);
      // The Host's own contract check: a renamed upstream field would otherwise
      // look identical to "no usage yet".
      const shapeWarnings = Array.isArray(data?.shapeWarnings) ? data.shapeWarnings : [];
      return { failure, auth, needsSetup, guidanceKey, guidance, shapeWarnings };
    }

    /**
     * The setup form shown when no account is configured.
     *
     * This is the whole point of the account route: the user types a username
     * and a password once, and the Host signs in, stores the account in the
     * DSH credentials, and renews the token from then on. No `.env` editing,
     * no restart, and the password is never sent anywhere but this Host.
     */
    function AccountForm({ auth, onDone, tt }) {
      const [username, setUsername] = useState("");
      const [password, setPassword] = useState("");
      // The user must be able to see what they actually typed: a browser
      // autofill or an IME full-width character looks identical to a real
      // password behind the dots, and every failed guess burns a lockout
      // attempt on the platform.
      const [showPassword, setShowPassword] = useState(false);
      const [busy, setBusy] = useState(false);
      const [formError, setFormError] = useState(null);
      // The platform's own words for a classified refusal, shown beneath the
      // canned line: the canned text translates, the prose carries the lockout
      // policy and anything else the platform wanted to say.
      const [formDetail, setFormDetail] = useState(null);
      // `saved` means a sign-in was stored. It is NOT a generic "the request
      // worked" flag — forgetting the account is a different outcome with a
      // different sentence, and reusing this one made the "clear the saved
      // account" button announce "saved and signed in, reading quota…".
      const [saved, setSaved] = useState(false);
      const [forgotten, setForgotten] = useState(false);
      // Epoch millis until which the platform asked us not to retry. While
      // this is in the future the submit button stays disabled, because a
      // retry inside the window is what extends a lockout.
      const [cooldownUntil, setCooldownUntil] = useState(0);
      const [now, setNow] = useState(() => Date.now());

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

      const setCooldown = useCallback((ms) => {
        setCooldownUntil(Date.now() + ms);
        setNow(Date.now());
      }, []);

      const submit = useCallback(async (event) => {
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
          const response = await fetch(ACCOUNT_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            cache: "no-store",
            body: JSON.stringify({ username: username.trim(), password })
          });
          const body = await response.json().catch(() => null);
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
          const waitMs = typeof body?.retryAfterMs === "number" ? body.retryAfterMs : null;
          if (waitMs !== null && waitMs > 0) {
            setCooldown(waitMs);
            setFormError(tt(code === "account_locked" ? "auth.locked" : "auth.rateLimited"));
            return;
          }
          // Only say "wrong password" when the platform said so. Every other
          // refusal gets its own line, and anything unrecognised shows the
          // platform's own words rather than a guess.
          if (typeof REFUSAL_TEXT[code] === "string") {
            setFormError(tt(REFUSAL_TEXT[code]));
            setFormDetail(typeof body?.detail === "string" && body.detail !== "" ? body.detail : null);
            return;
          }
          setFormError(code === "login_failed"
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
          const response = await fetch(ACCOUNT_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            cache: "no-store",
            body: JSON.stringify({ forget: true })
          });
          const body = await response.json().catch(() => null);
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
        { style: { ...S.card, maxWidth: 420 } },
        h("div", { style: S.sectionTitle }, tt("auth.title")),
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
              onChange: (event) => setUsername(event.target.value)
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
                onChange: (event) => setPassword(event.target.value)
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
            ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" } }, tt("auth.forgotten"))
            : saved
              ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" } }, tt("auth.working"))
              : null,
          formError ? h("p", { style: S.formError }, formError) : null,
          formError && formDetail ? h("p", { style: S.formNote }, formDetail) : null,
          // The wait is stated with the platform's own number, so the reason
          // the button is greyed out is never a mystery.
          cooling
            ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } },
                format(tt("auth.retryAfter"), { minutes: coolingMinutes }))
            : null,
          h("p", { style: S.formNote }, auth?.ephemeral === true ? tt("auth.ephemeral") : tt("auth.saved"))
        )
      );
    }

    /** The `main`-slot page. Mounted only while this panel is selected. */
    function PanelPage({ onClose, tt, localeSubscribe }) {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [updatedAt, setUpdatedAt] = useState(0);
      const [managing, setManaging] = useState(false);
      const [, setLocaleRevision] = useState(0);

      // The Host half registers the dictionaries, but a runtime language switch
      // only reaches this page through the locale face's subscribe: without it a
      // mounted panel keeps whatever strings it happened to render first.
      useEffect(() => {
        if (typeof localeSubscribe !== "function") return undefined;
        return localeSubscribe(() => setLocaleRevision((revision) => revision + 1));
      }, [localeSubscribe]);

      // How often to ask again, in ms. The Host states it in every snapshot;
      // this default only covers the first load, before any answer arrives.
      const [cadenceMs, setCadenceMs] = useState(30_000);

      const load = useCallback(async () => {
        try {
          const response = await fetch(SNAPSHOT_PATH, { headers: { accept: "application/json" }, cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
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
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }, []);

      // One effect owns the whole polling cycle: an immediate load on mount,
      // then the cadence the Host last stated. Re-running on `cadenceMs` is
      // what lets a changed rate take effect without a reload.
      useEffect(() => {
        let alive = true;
        const run = () => {
          if (alive) void load();
        };
        run();
        const timer = setInterval(run, cadenceMs);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [load, cadenceMs]);

      const pools = data?.pools;
      const trend = data?.trend;
      // The decision is `viewOf`'s (module scope): the Node-side tests invoke
      // this exact function, so there is no second copy that could drift.
      const { failure, auth, needsSetup, guidance, shapeWarnings } = viewOf(data, error, tt);
      const authChip = auth === null
        ? null
        : auth.error || !auth.configured
          ? h("span", { style: S.chip, title: auth.error ?? "" }, tt("auth.needsLogin"))
          : h("span", { style: S.chip }, tt("auth.selfRenew"));
      // The account editor is offered whenever a token is working too, so the
      // stored account can be changed or cleared without waiting to fail.
      const authManage = auth !== null && auth.hasAccount === true;
      const body = !data
        ? needsSetup
          ? h(AccountForm, { auth, onDone: () => void load(), tt })
          : h(
              "div",
              { style: S.empty },
              failure === null
                ? tt("panel.loading")
                : h(
                    "div",
                    null,
                    h("div", null, guidance ?? format(tt("panel.error"), { error: failure.message }))
                  )
            )
        : h(
            "div",
            null,
            shapeWarnings.length > 0
              ? h("div", { style: S.formError },
                  format(tt("panel.shapeDrift"), {
                    detail: shapeWarnings.map((entry) => `${tt("shape.api")} ${entry.api} ${tt("shape.missing")} ${entry.missing}`).join("; ")
                  }))
              : null,
            h("div", { style: S.sectionTitle }, tt("section.pools")),
            pools && pools.plan.name
              ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } }, pools.plan.name)
              : null,
            (pools?.pools || []).map((pool) => h(PoolCard, { key: pool.id, pool, tt })),
            data.uncountedModels && data.uncountedModels.length > 0
              ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 4 } },
                  format(tt("pool.uncounted"), { models: data.uncountedModels.join(" · ") }))
              : null,
            h("div", { style: S.sectionTitle }, format(tt("section.trend"), { hours: trend?.hours ?? 24 })),
            h(TrendTable, { trend, tt }),
            // The cache age is quoted from the snapshot, not written down here:
            // a note that says 60 while the Host caches for 300 is a lie the
            // reader has no way to catch.
            h("div", { style: S.note }, format(tt("note"), { cache: data?.cacheSeconds ?? 60 })),
            // Re-openable while everything works, so changing the stored
            // account never requires signing out first.
            authManage
              ? h(
                  "div",
                  { style: { marginTop: 18 } },
                  h(
                    "button",
                    { type: "button", style: S.button, onClick: () => setManaging(true) },
                    tt("auth.title")
                  )
                )
              : null,
            managing ? h("div", { style: { marginTop: 12 } }, h(AccountForm, { auth, onDone: () => { setManaging(false); void load(); }, tt })) : null
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
              ? h("span", { style: S.error, title: failure.message }, format(tt("panel.error"), { error: failure.message }))
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

    /** Required services: the slot system, the locale registry, the layout face. */
    const inject = ["slots", "locale"];

    /**
     * Register the dictionaries, the sidebar row, and the main-slot page.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en });
        } catch {
          return () => {};
        }
      }, "dsh-connect-sensenova-token-plan: dictionaries");

      let translate = (key) => key;
      try {
        translate = ctx.locale.bind(NS);
      } catch {
        // A shell without the locale service still renders the keys.
      }
      const tt = (key) => {
        try {
          return translate(key);
        } catch {
          return key;
        }
      };

      const close = () => {
        try {
          ctx.get("layout")?.selectPanel?.(null);
        } catch {
          // A shell without the layout face has nothing to close.
        }
      };

      const disposers = [];
      try {
        disposers.push(
          ctx.slots.inject("sidebar.panellist", () =>
            ctx.slots.register(
              { name: "sidebar.panellist", id: PANEL_ID, label: () => tt("entry.label") },
              PanelIcon
            )
          )
        );
      } catch (error) {
        console.warn("[dsh-connect-sensenova-token-plan] sidebar row registration failed:", error);
      }
      try {
        disposers.push(
          ctx.slots.inject("main", () =>
            ctx.slots.register(
              { name: "main", key: PANEL_ID, locale: NS, inject: () => ({ onClose: close, tt, localeSubscribe: ctx.locale.subscribe.bind(ctx.locale) }) },
              PanelPage
            )
          )
        );
      } catch (error) {
        console.warn("[dsh-connect-sensenova-token-plan] panel page registration failed:", error);
      }

      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch {
            // Already released with its owning declaration.
          }
        }
      }, "dsh-connect-sensenova-token-plan: ui mounts");
    }

    /**
     * The module's test surface.
     *
     * The Host only ever reads `inject`/`apply`; this object exists so the
     * Node-side suites can load the shipped bundle as a module and exercise
     * these REAL definitions — the decision, the dictionaries, the style
     * tokens, the components — instead of scraping the source text for them.
     * Everything here is what the browser itself uses; nothing is defined for
     * the tests' benefit.
     */
    const panel = Object.freeze({
      interpretSnapshot,
      viewOf,
      dictionaries: Object.freeze({ zh, en }),
      tables: Object.freeze({ GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES, REFUSAL_TEXT }),
      styles: S,
      helpers: Object.freeze({ clock, clockLong, count, format }),
      components: Object.freeze({ WindowRow, PoolCard, TrendTable, AccountForm, PanelPage })
    });

    return { inject, apply, panel };
}

/** The registration the Host loads: id plus the factory the Host materializes. */
const REGISTRATION = { id: "dsh-connect-sensenova-token-plan", factory: clientFactory };

// The bundle ships unbuilt, so it must load in three module worlds without a
// build step:
//
// - BROWSER: the DSH client loader calls `window.__ModuleLoader__.load(...)`
//   with this file's text; the registry it gets back is the one the Host
//   materializes with the browser's own module table (real React).
// - NODE CJS: a `require("./client.js")` gets the same registration object on
//   `module.exports`, so the suite can hand a stand-in React to `factory`.
// - NODE ESM: `import("./client.js")` — the file carries no `import`/`export`
//   statements, so it is legal ESM; `module` is undefined there, and
//   `client-surface.js` installs a capturing `window.__ModuleLoader__` BEFORE
//   the import, which is what runs this branch.
//
// In every world the SAME `clientFactory` is what the panel runs, so the Node
// suites exercise the browser's own decision, tables, and components — never a
// copy and never a scrape of this source text.
if (typeof window !== "undefined" && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load(REGISTRATION);
}
if (typeof module !== "undefined" && module !== null && module.exports !== undefined) {
  module.exports = REGISTRATION;
}
