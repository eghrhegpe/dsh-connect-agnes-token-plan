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
  const { useState, useEffect, useCallback, useRef } = React;

  /** Dictionary namespace this plugin owns. */
  const NS = "dsh-connect-sensenova-token-plan";
  /** Shared id: the sidebar row id and the `main` slot key are the same string. */
  const PANEL_ID = "dsh-connect-sensenova-token-plan";
  /** The Host snapshot route. Relative, same-origin. */
  const SNAPSHOT_PATH = "/api/dsh-connect-sensenova-token-plan/snapshot";
  /** The account route: lets the panel configure itself, no `.env` editing. */
  const ACCOUNT_PATH = "/api/dsh-connect-sensenova-token-plan/account";
  /** The inference API-key route: saves the `sk-` key the provider uses. */
  const API_KEY_PATH = "/api/dsh-connect-sensenova-token-plan/api-key";
  /** The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md). */
  const PROVIDER_PATH = "/api/dsh-connect-sensenova-token-plan/provider";
  /** The model-roster route: which of this key's models get pushed to DSH. */
  const MODELS_PATH = "/api/dsh-connect-sensenova-token-plan/models";

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
    "panel.consoleTransient": "商汤控制台暂时无法读取，通常下一次自动刷新即可恢复；若持续出现，请检查网络后稍再重试。",
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
    "auth.saved": "账号与登录令牌已保存在 DSH 凭据中；密码不落盘，refresh 令牌失效后需重新输入一次。",
    "auth.ephemeral": "注意：当前 Host 没有凭据服务，账号只保存在内存中，重启后需要重新登录。",
    "auth.autoRecoverOn": "自动恢复：已开启，refresh 失效后将自动重登",
    "auth.autoRecoverOff": "自动恢复：未开启，refresh 失效后需手动重登",
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
    "pool.exhausted": "已耗尽",
    "pool.exhaustedNotice": "部分积分池已耗尽（剩余 0），最早于 {time} 重置；所属模型在额度恢复前暂不可选。",
    "pool.reset": "重置 {time}",
    "pool.grant": "返赠余额 {balance}",
    "pool.grantExpiry": "最近返赠到期 {time}（{balance} 分）",
    "pool.models": "模型",
    "pool.dedicated": "专属池",
    "pool.default": "通用池",
    "pool.callable": "可调用",
    "pool.details": "模型与返赠详情",
    "pool.locked": "需开通 +{count} 个",
    "pool.lockedTitle": "套餐覆盖但当前 Key 无权限",
    "pool.uncounted": "不计入积分池：{models}",
    "pool.vision": "可看图：{models}",
    "pool.visionInferred": "（按模型名推断，平台未声明）",
    "shape.api": "接口",
    "shape.missing": "缺少字段",
    "section.trend": "每模型消耗（近 {hours} 小时）",
    "section.collapse": "收起",
    "section.expand": "展开",
    "trend.model": "模型",
    "trend.credits": "积分",
    "trend.none": "该区间内没有消耗记录。",
    "auth.selfRenew": "令牌自动续期中",
    "auth.needsLogin": "需要重新登录",
    "llm.title": "模型接入（API Key）",
    "llm.placeholder": "粘贴 sk- 开头的 API Key",
    "llm.save": "保存 API Key",
    "llm.saving": "保存中…",
    "llm.forget": "清除已保存的 API Key",
    "llm.saved": "API Key 已保存在 DSH 凭据中；下次轮询自动拉取模型目录。",
    "llm.forgotten": "已清除面板保存的 API Key（环境变量 SENSENOVA_API_KEY 不受影响）。",
    "llm.empty": "请输入 sk- 开头的 API Key",
    "llm.footnote": "Key 只保存在 DSH 凭据中，不会写入插件目录或日志；请求时按次读取。",
    "llm.ephemeral": "注意：当前 Host 没有凭据服务，Key 只保存在内存中，重启后失效。",
    "llm.keyPresent": "已配置 API Key（来源：{source}）",
    "llm.noKey": "尚未配置 API Key；保存后即可调模型。",
    "llm.src.credentials": "DSH 凭据",
    "llm.src.env": "环境变量",
    "llm.src.memory": "本机内存",
    "llm.off": "未向 DSH 注册 SenseNova 提供方——勾选下方开关即可开启（立即生效，无需重启）。",
    "llm.registered": "已向 DSH 注册提供方 {id}：共 {models} 个模型，其中 {vision} 个支持图片输入。",
    "llm.noService": "registerProvider 已开启，但当前 Host 没有提供 LLM 注册服务。",
    "llm.error": "提供方注册失败：{error}",
    "llm.id": "提供方 ID：{id}（勾选开关后生效）",
    "llm.switch": "向 DSH 注册 SenseNova 提供方（立即生效，无需重启）",
    "llm.switchBusy": "切换中…",
    "llm.switchError": "切换失败：{error}",
    "llm.roster": "推送到 DSH 的模型",
    "llm.rosterHint": "勾选后保存：未勾选的模型不会出现在 DSH 模型列表里。目录里后来新增的模型默认也不推送，需要手动勾选。",
    "llm.rosterEmpty": "当前 Key 还没有可推送的模型——先保存一次 API Key。",
    "llm.rosterSearchPlaceholder": "搜索模型名或 ID",
    "llm.rosterCount": "已勾选 {selected} / 共 {total}",
    "llm.rosterAll": "全部勾选",
    "llm.rosterNone": "全部取消",
    "llm.rosterSave": "保存",
    "llm.rosterSaving": "保存中…",
    "llm.rosterDiscard": "撤销",
    "llm.rosterSaved": "已保存，模型列表已更新。",
    "llm.rosterUnsaved": "有未保存的改动",
    "llm.rosterError": "保存失败：{error}",
    "llm.rosterNoMatch": "没有匹配的模型。",
    "llm.rosterVision": "可看图",
    "llm.rosterText": "纯文本",
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
    "panel.consoleTransient": "The SenseNova console could not be read just now. This usually clears on the next automatic refresh; if it persists, check your network and try again shortly.",
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
    "auth.saved": "Account and login token stored in the DSH credentials; the password is never written to disk — you'll be asked to sign in again once the refresh token dies.",
    "auth.ephemeral": "Note: this Host has no credentials service, so the account lives in memory only and must be entered again after a restart.",
    "auth.autoRecoverOn": "Auto-recover: on (a dead refresh token re-signs in automatically)",
    "auth.autoRecoverOff": "Auto-recover: off (a dead refresh token means signing in again manually)",
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
    "pool.exhausted": "Exhausted",
    "pool.exhaustedNotice": "Some credit pools are exhausted (0 remaining); the earliest resets at {time}. Models in those pools are unavailable until quota recovers.",
    "pool.reset": "resets {time}",
    "pool.grant": "Grant balance {balance}",
    "pool.grantExpiry": "Next grant expiry {time} ({balance} cr)",
    "pool.models": "Models",
    "pool.dedicated": "dedicated",
    "pool.default": "default",
    "pool.callable": "Callable",
    "pool.details": "Models & grant details",
    "pool.locked": "+{count} need activation",
    "pool.lockedTitle": "In the plan but this key has no permission",
    "pool.uncounted": "Not billed to credit pools: {models}",
    "pool.vision": "Vision-capable: {models}",
    "pool.visionInferred": "(inferred from model names; not declared by the platform)",
    "shape.api": "endpoint",
    "shape.missing": "missing field",
    "section.trend": "Per-model consumption (last {hours} h)",
    "section.collapse": "Collapse",
    "section.expand": "Expand",
    "trend.model": "Model",
    "trend.credits": "Credits",
    "trend.none": "No consumption in this range.",
    "auth.selfRenew": "Token renews itself",
    "auth.needsLogin": "Sign-in required",
    "llm.title": "Model access (API key)",
    "llm.placeholder": "Paste your sk- API key",
    "llm.save": "Save API key",
    "llm.saving": "Saving…",
    "llm.forget": "Forget the saved API key",
    "llm.saved": "API key stored in the DSH credentials; the next poll fetches the model catalog.",
    "llm.forgotten": "Panel-saved API key cleared (an SENSENOVA_API_KEY environment value is left untouched).",
    "llm.empty": "Enter an API key starting with sk-",
    "llm.footnote": "The key is kept only in the DSH credentials, never in this plugin's folder or logs; it is read per request.",
    "llm.ephemeral": "Note: this Host has no credentials service, so the key lives in memory only and is lost on restart.",
    "llm.keyPresent": "API key configured (source: {source})",
    "llm.noKey": "No API key yet; save one to start calling models.",
    "llm.src.credentials": "DSH credentials",
    "llm.src.env": "environment",
    "llm.src.memory": "memory",
    "llm.off": "SenseNova is not registered with DSH — tick the switch below to enable (takes effect immediately, no restart).",
    "llm.registered": "Provider {id} registered with DSH: {models} model(s), {vision} accepting image input.",
    "llm.noService": "registerProvider is on, but this Host exposes no LLM registration service.",
    "llm.error": "Provider registration failed: {error}",
    "llm.id": "Provider id: {id} (takes effect once the switch is ticked)",
    "llm.switch": "Register SenseNova with DSH (takes effect immediately, no restart)",
    "llm.switchBusy": "Switching…",
    "llm.switchError": "Switch failed: {error}",
    "llm.roster": "Models pushed to DSH",
    "llm.rosterHint": "Tick the ones to push and save: unticked models do not appear in DSH's model list. Models the catalogue gains later are not pushed by default, tick them in by hand.",
    "llm.rosterEmpty": "This key has no models to push yet - save an API key first.",
    "llm.rosterSearchPlaceholder": "Search a model name or id",
    "llm.rosterCount": "{selected} ticked / {total} total",
    "llm.rosterAll": "Tick all",
    "llm.rosterNone": "Untick all",
    "llm.rosterSave": "Save",
    "llm.rosterSaving": "Saving…",
    "llm.rosterDiscard": "Discard",
    "llm.rosterSaved": "Saved - the model list has been updated.",
    "llm.rosterUnsaved": "Unsaved changes",
    "llm.rosterError": "Save failed: {error}",
    "llm.rosterNoMatch": "No model matches.",
    "llm.rosterVision": "vision",
    "llm.rosterText": "text only",
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
      // Content sections are workbuddy-style collapsible cards: a bordered
      // card whose header is a full-width button (title + rotating chevron).
      // `PanelPage` starts both sections expanded; the reader can tuck one
      // away to focus on the other.
      sectionCard: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden", marginTop: 22 },
      sectionHead: { display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" },
      sectionHeadTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      chevron: { display: "inline-flex", flex: "none", transition: "transform 0.15s ease", color: "var(--dsw-alias-label-secondary)" },
      chevronOpen: { transform: "rotate(180deg)" },
      sectionBody: { borderTop: "1px solid var(--dsw-alias-border-l1)", margin: "0 16px", padding: "12px 0 16px" },
      // Pool cards live in the responsive `poolsGrid` (gap owns the spacing),
      // so the card itself carries no bottom margin.
      card: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, padding: 16 },
      // Responsive deck of pool cards: each column is at least 320px and the
      // row reflows on narrow panels instead of overflowing.
      poolsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 12, alignItems: "start" },
      cardHead: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      poolName: { fontSize: 15, fontWeight: 600 },
      chip: { display: "inline-flex", alignItems: "center", height: 22, padding: "0 8px", borderRadius: 999, fontSize: 12, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)" },
      // The grant balance is money the user can still spend, so it earns a
      // chip in the card head; its expiry detail rides in the folded section.
      grantChip: { display: "inline-flex", alignItems: "center", height: 22, padding: "0 8px", borderRadius: 999, fontSize: 12, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums" },
      // The two quota windows sit side by side as twin sub-cards, stacking
      // when the card gets narrower than ~2*170px (170 leaves room for the
      // longest "used x / limit" caption beside the headline figures).
      quotas: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 10, marginTop: 14 },
      quota: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)" },
      // `flexWrap` because the reset stamp can grow to `MM-DD HH:mm`: in a narrow
      // twin column the label and the date no longer share a row, and the date is
      // the one part of the line that must never be clipped.
      quotaTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
      quotaLabel: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
      quotaReset: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
      quotaFigures: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8 },
      // Remaining credits are the headline number — that is what the reader
      // opens the panel for. Tabular figures keep it still while polling.
      quotaRemaining: { fontSize: 24, lineHeight: "28px", fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" },
      quotaRemainLabel: { fontSize: 11, marginTop: 1, color: "var(--dsw-alias-label-secondary)" },
      quotaPct: { fontSize: 15, lineHeight: "20px", fontWeight: 600, textAlign: "right", fontVariantNumeric: "tabular-nums" },
      // used/limit is a single quiet caption under the bar (its own full row,
      // so the figures row never wraps on a narrow twin card).
      quotaUsed: { fontSize: 11, lineHeight: "15px", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
      bar: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" },
      barFill: { height: "100%", borderRadius: 3, background: "var(--dsw-alias-brand-primary)" },
      barFillWarn: { background: "var(--dsw-alias-state-warn-primary)" },
      barFillError: { background: "var(--dsw-alias-state-error-primary)" },
      // Secondary bookkeeping (grant expiry, model coverage) folds away so a
      // card's open state is just its name, the twin quotas, and nothing else.
      details: { marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--dsw-alias-border-l1)" },
      detailsSummary: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", cursor: "pointer", userSelect: "none" },
      detailsBody: { display: "flex", flexDirection: "column", gap: 10, marginTop: 10 },
      grant: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
      models: { display: "flex", flexWrap: "wrap", gap: 6 },
      modelTag: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 11, padding: "2px 6px", borderRadius: 6, background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l1)" },
      // The per-model consumption card: a label row over one horizontal-bar
      // row per model. The bar is relative to the LARGEST consumer — the
      // chart answers "which model is burning credits" — so the top model
      // fills the track and the rest shrink proportionally; the absolute
      // number stays right-aligned beside the model name.
      trendHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, paddingBottom: 6, borderBottom: "1px solid var(--dsw-alias-border-l1)" },
      trendHeadLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontWeight: 500 },
      trendRow: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
      trendRowHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, minWidth: 0 },
      trendModel: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      trendCredits: { fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
      // The trend card sits on layer-1 like the pool cards, so its bar track
      // must be layer-2 (the quota bars invert this: layer-1 inside layer-2).
      trendBar: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" },
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
      formNote: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, margin: "10px 0 0" },
      // The model picker: a search box and a all/none row over one row per
      // model, each row a checkbox, the name, and a modality badge. Rows sit
      // in their own card so the list can grow past a screen without pushing
      // the rest of the panel out of view.
      rosterTools: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 },
      rosterCount: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums", marginLeft: "auto" },
      modelList: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
      modelRow: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)" },
      modelRowOff: { opacity: 0.55 },
      modelCheck: { flex: "none", width: 15, height: 15, cursor: "pointer", accentColor: "var(--dsw-alias-brand-primary)", margin: 0 },
      modelName: { flex: "1 1 auto", minWidth: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      modelBadge: { flex: "none", fontSize: 11, padding: "1px 7px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-secondary)" },
      rosterFoot: { display: "flex", gap: 8, alignItems: "center", marginTop: 10 }
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

    /**
     * A date-aware reset clock: `HH:MM` when the instant lands on today's local
     * date, `MM-DD HH:mm` once it crosses into another day.
     *
     * Why this exists: `clock` was the one shared formatter, so the weekly
     * (`window_7d`) reset — an absolute instant days away — read as "重置 18:10"
     * and looked like it fired later TODAY. A bare time is honest only for the
     * 5-hour window; a reset that crosses midnight must carry its day.
     */
    function when(epoch) {
      if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
      const date = new Date(epoch * 1000);
      const now = new Date();
      const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
      return sameDay ? clock(epoch) : clockLong(epoch);
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

    /**
     * The allow-list spelling for "nothing is offered".
     *
     * An empty list already means "no filter", so "the filter matched
     * nothing" needs its own spelling: one entry naming an id no real model
     * can carry. The Host carries the SAME literal (`llm-models.js`
     * `HIDE_ALL_MODELS`) — the browser bundle cannot import that module, so
     * `test/provider.test.mjs` compares the two and a rename on either side
     * goes red instead of silently un-curating every model.
     */
    const HIDE_ALL_MODELS = "__hide_all__";

    /** The model ids a roster advertises, junk entries dropped. */
    function rosterIds(roster) {
      return (Array.isArray(roster) ? roster : []).filter((model) => typeof model === "string" && model !== "");
    }

    /**
     * Whether one model id is offered by an allow-list.
     *
     * Mirrors the Host's `filterByEnabled`: an empty list offers everything,
     * a non-empty one is a strict allow-list, and `HIDE_ALL_MODELS` alone
     * offers nothing.
     * @param {string[]} enabledIds - the allow-list.
     * @param {string} id - the model id to ask about.
     * @returns {boolean}
     */
    function modelIsOn(enabledIds, id) {
      const list = Array.isArray(enabledIds) ? enabledIds : [];
      return list.length === 0 ? true : list.includes(id);
    }

    /**
     * The allow-list that offers exactly the ids in `on`.
     *
     * Every mutation funnels through here, so the two extreme spellings are
     * emitted consistently: an empty list (nothing curated, every model
     * offered) and `HIDE_ALL_MODELS` alone (nothing offered). No caller can
     * post a list the Host would read differently than the picker shows.
     * @param {Set<string>} on - the ids that should be offered.
     * @param {string[]} roster - the whole roster, the ordering reference.
     * @returns {string[]} the allow-list to post.
     */
    function allowListFor(on, roster) {
      const all = rosterIds(roster);
      const kept = all.filter((model) => on.has(model));
      if (kept.length === 0) return [HIDE_ALL_MODELS];
      if (kept.length === all.length) return [];
      return kept;
    }

    /**
     * The next allow-list after ticking or unticking one model.
     *
     * The result is computed against the WHOLE roster, not the current
     * list: the saved value is a complete allow-list rather than a diff, so
     * a curated catalogue stays curated when the catalogue later grows —
     * new models start unticked instead of slipping into DSH on their own.
     */
    function toggleModelIn(enabledIds, roster, id) {
      const on = new Set(rosterIds(roster).filter((model) => modelIsOn(enabledIds, model)));
      if (on.has(id)) on.delete(id);
      else on.add(id);
      return allowListFor(on, roster);
    }

    /** The allow-list for a bulk "tick all" / "untick all". */
    function setAllModelsIn(roster, allOn) {
      return allowListFor(new Set(allOn ? rosterIds(roster) : []), roster);
    }

    /**
     * The next allow-list after a bulk "tick all" / "untick all" over one set
     * of targets, computed against the WHOLE roster.
     *
     * The targets are the ids the reader is looking at right now (a filtered
     * view); the rows outside them keep whatever the Host already offers, so
     * the result stays a complete allow-list rather than a diff. Both id lists
     * must be STRINGS — `rosterIds` drops anything that is not one, so a roster
     * of `{id}` rows would filter to nothing and the whole call would collapse
     * to the hide-all sentinel no matter which way the button was pressed.
     */
    function bulkModelsIn(enabledIds, roster, targets, allOn) {
      const on = new Set(rosterIds(roster).filter((model) => modelIsOn(enabledIds, model)));
      for (const id of targets) if (allOn) on.add(id);
      else on.delete(id);
      return allowListFor(on, roster);
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

    /**
     * One quota window as a compact sub-card: the REMAINING balance is the
     * headline number (the panel is opened to see how much is left), the
     * percentage sits beside it in a usage tone, and used/limit is a single
     * quiet caption under the bar.
     */
    function QuotaCard({ label, window, tt }) {
      const { limit, used, remaining, resetAt } = window;
      const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
      const tone = pct >= 90 ? S.barFillError : pct >= 70 ? S.barFillWarn : S.barFill;
      const pctColor = pct >= 90
        ? "var(--dsw-alias-state-error-primary)"
        : pct >= 70
          ? "var(--dsw-alias-state-warn-primary)"
          : "var(--dsw-alias-label-secondary)";
      return h(
        "div",
        { style: S.quota },
        h(
          "div",
          { style: S.quotaTop },
          h("span", { style: S.quotaLabel }, label),
          remaining <= 0
            ? h("span", { style: { ...S.chip, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" } }, tt("pool.exhausted"))
            // `when` not `clock`: the weekly reset can land on another day, and
            // a bare HH:MM reads as "later today" — wrong and alarming.
            : h("span", { style: S.quotaReset }, resetAt ? format(tt("pool.reset"), { time: when(resetAt) }) : "")
        ),
        h(
          "div",
          { style: S.quotaFigures },
          h(
            "div",
            { style: { minWidth: 0 } },
            h("div", { style: S.quotaRemaining }, count(remaining)),
            h("div", { style: S.quotaRemainLabel }, tt("pool.remaining"))
          ),
          // The right column mirrors the left: percentage over the quiet
          // used/limit caption. `minWidth:0` lets it shrink instead of
          // pushing the headline number off the card when columns get tight.
          h(
            "div",
            { style: { minWidth: 0, textAlign: "right" } },
            h("div", { style: { ...S.quotaPct, color: pctColor } }, `${pct.toFixed(1)}%`),
            h("div", { style: S.quotaUsed }, `${tt("pool.used")} ${count(used)} / ${count(limit)}`)
          )
        ),
        h(
          "div",
          { style: S.bar, role: "progressbar", "aria-label": `${label} ${pct.toFixed(1)}%`, "aria-valuenow": pct.toFixed(1), "aria-valuemin": 0, "aria-valuemax": 100 },
          h("div", { style: { ...tone, width: `${pct}%` } })
        )
      );
    }

    /**
     * One pool card. The open state is intentionally tiny: name, type chip,
     * spendable grant balance, and the twin quota sub-cards. Everything
     * explanatory (grant expiry, the model coverage lists) folds into one
     * `<details>` row so the deck stays scannable on wide screens.
     */
    function PoolCard({ pool, tt }) {
      const callable = pool.callableModels || pool.modelIds || [];
      const locked = pool.lockedModels || [];
      const hasDetails = pool.nearestGrantExpiry || callable.length > 0 || locked.length > 0;
      return h(
        "div",
        { style: S.card },
        h(
          "div",
          { style: S.cardHead },
          h("span", { style: S.poolName }, pool.name),
          h("span", { style: S.chip }, pool.poolType === "dedicated" ? tt("pool.dedicated") : tt("pool.default")),
          h("span", { style: S.spacer }),
          // Spendable grant money belongs up with the headline, not buried.
          pool.grantBalance > 0
            ? h("span", { style: S.grantChip, title: format(tt("pool.grant"), { balance: count(pool.grantBalance) }) }, format(tt("pool.grant"), { balance: count(pool.grantBalance) }))
            : null
        ),
        h(
          "div",
          { style: S.quotas },
          h(QuotaCard, { label: tt("pool.window5h"), window: pool.window5h, tt }),
          h(QuotaCard, { label: tt("pool.window7d"), window: pool.window7d, tt })
        ),
        hasDetails
          ? h(
              "details",
              { style: S.details },
              h("summary", { style: S.detailsSummary }, tt("pool.details")),
              h(
                "div",
                { style: S.detailsBody },
                pool.nearestGrantExpiry
                  ? h("div", { style: S.grant }, format(tt("pool.grantExpiry"), { time: clockLong(pool.nearestGrantExpiry), balance: count(pool.nearestGrantExpiringBalance) }))
                  : null,
                callable.length > 0
                  ? h(
                      "div",
                      { style: S.models },
                      h("span", { style: { ...S.muted, fontSize: 12, marginRight: 2 } }, `${tt("pool.callable")}:`),
                      callable.map((model) => h("span", { key: model, style: S.modelTag }, model))
                    )
                  : null,
                locked.length > 0
                  ? h(
                      "div",
                      { style: { ...S.models, ...S.muted }, title: locked.join(", ") },
                      h("span", { style: { fontSize: 12, marginRight: 2 } }, format(tt("pool.locked"), { count: locked.length }))
                    )
                  : null
              )
            )
          : null
      );
    }

    /**
     * A top-of-section notice for the "transient exhaustion" case: when one or
     * more credit pools have hit zero, the picker (host side) drops those pools'
     * models, so the reader sees models vanish with no explanation. This line
     * says WHY they vanished and WHEN they are expected back — the earliest
     * `resetAt` among the exhausted windows — so a zeroed pool reads as
     * "recovers at HH:MM", never as a mystery.
     *
     * Hook-free: it only reads the snapshot's `pools` array, so the render suite
     * drives the exact component the browser draws. Returns null when nothing is
     * exhausted (the common case stays silent). It does not guess whether a zero
     * came from a true quota drain or a rate-limit blip — the panel never sees
     * the 429 class — it only reports the pool's own reset clock, which is the
     * one honest recovery signal available here.
     * @param {{pools?: Array<object>}} props
     * @param {(key: string) => string} props.tt
     */
    function PoolExhaustionNotice({ pools, tt }) {
      const list = Array.isArray(pools?.pools) ? pools.pools : [];
      let earliest = 0;
      let anyExhausted = false;
      for (const pool of list) {
        for (const key of ["window5h", "window7d"]) {
          const win = pool?.[key];
          if (win && Number(win.remaining) <= 0) {
            anyExhausted = true;
            const reset = Number(win.resetAt) || 0;
            if (reset > 0 && (earliest === 0 || reset < earliest)) earliest = reset;
          }
        }
      }
      if (!anyExhausted) return null;
      // `when`, not `clock`: the earliest reset may belong to the weekly window
      // and sit days out, and a bare HH:MM would promise recovery in hours.
      const time = earliest > 0 ? when(earliest) : "—";
      return h(
        "div",
        {
          style: { ...S.formNote, color: "var(--dsw-alias-state-error-primary)", marginTop: 4, marginBottom: 10 },
          role: "status"
        },
        format(tt("pool.exhaustedNotice"), { time })
      );
    }

    /**
     * Per-model credit consumption, drawn as a mini bar chart so the eye
     * lands on WHICH model is burning credits: each row carries a bar
     * relative to the largest consumer (the top model fills the track), with
     * the absolute number right-aligned beside the model name. The whole
     * block sits in a card like the quota cards instead of floating as a
     * bare table.
     */
    function TrendTable({ trend, tt }) {
      if (!trend || trend.models.length === 0) return h("div", { style: S.card }, h("div", { style: S.empty }, tt("trend.none")));
      const max = Math.max(0, ...trend.models.map((row) => Math.max(0, Number(row.credits) || 0)));
      return h(
        "div",
        { style: S.card },
        h(
          "div",
          { style: S.trendHead },
          h("span", { style: S.trendHeadLabel }, tt("trend.model")),
          h("span", { style: { ...S.trendHeadLabel, textAlign: "right" } }, tt("trend.credits"))
        ),
        trend.models.map((row) => {
          const credits = Math.max(0, Number(row.credits) || 0);
          const pct = max > 0 ? (credits / max) * 100 : 0;
          return h(
            "div",
            { key: row.model, style: S.trendRow },
            h(
              "div",
              { style: S.trendRowHead },
              // Long model ids truncate; the full name is one hover away.
              h("span", { style: S.trendModel, title: row.model }, row.model),
              h("span", { style: S.trendCredits }, count(credits))
            ),
            h(
              "div",
              { style: S.trendBar, role: "progressbar", "aria-label": `${row.model} ${Math.round(pct)}%`, "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 },
              h("div", { style: { ...S.barFill, width: `${pct}%` } })
            )
          );
        })
      );
    }

    /**
     * One content section as a workbuddy-style collapsible card: a full-width
     * header button (title + rotating chevron) over a bordered card body.
     * Auto-expanded by default in `PanelPage`; the reader can tuck a section
     * away to focus on the other. Hook-free on purpose — `open` and `onToggle`
     * arrive as props, so the render tests exercise the toggle without faking
     * React state (children travel as a regular `children` prop, as in React).
     */
    function SectionCard({ title, open, onToggle, children, tt }) {
      return h(
        "div",
        { style: S.sectionCard },
        h(
          "button",
          {
            type: "button",
            style: S.sectionHead,
            "aria-expanded": open,
            "aria-label": `${tt(open ? "section.collapse" : "section.expand")}: ${title}`,
            onClick: onToggle
          },
          h("span", { style: S.sectionHeadTitle }, title),
          h(
            "svg",
            { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", style: open ? { ...S.chevron, ...S.chevronOpen } : S.chevron },
            h("path", { d: "M3 6l5 5 5-5" })
          )
        ),
        h("div", { style: S.sectionBody, hidden: !open }, open ? children : null)
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
     * The failure a non-2xx snapshot response becomes.
     *
     * A non-2xx carries no body, so the status is the only clue. 401/403 mean
     * the token is gone — the same story as the Host's own `jwt_expired`, and
     * the only reading that keeps the sign-in form on screen instead of leaving
     * the reader with a bare status code. Anything else is a plain transport
     * string, which keeps the form reachable too.
     *
     * Named and module-scoped for the same reason as `interpretSnapshot`: the
     * Node-side tests drive this mapping instead of a copy of it.
     * @param {number} status - the HTTP status code.
     * @returns {{message: string, code: string, auth: null}|string}
     */
    function errorOfStatus(status) {
      if (status === 401 || status === 403) return { message: `HTTP ${status}`, code: "jwt_expired", auth: null };
      return `HTTP ${status}`;
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
      config_error: "panel.configError",
      // The console did not answer. `FORM_EXCLUDED_CODES` already keeps the
      // login form away from this code, so the guidance line is the whole
      // explanation — and it must say the failure is expected to pass.
      console_error: "panel.consoleTransient"
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
     *
     * `bare` strips the inner card and title: the account section card that
     * embeds this form (when a token already works) supplies both itself.
     */
    function AccountForm({ auth, onDone, tt, bare }) {
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
        { style: bare ? {} : { ...S.card, maxWidth: 420 } },
        // `bare` drops the inner card and title: the caller (the account
        // section card) already supplies both.
        bare ? null : h("div", { style: S.sectionTitle }, tt("auth.title")),
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
            ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("auth.forgotten"))
            : saved
              ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("auth.working"))
              : null,
          formError ? h("p", { style: S.formError, role: "alert" }, formError) : null,
          formError && formDetail ? h("p", { style: S.formNote }, formDetail) : null,
          // The wait is stated with the platform's own number, so the reason
          // the button is greyed out is never a mystery.
          cooling
            ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } },
                format(tt("auth.retryAfter"), { minutes: coolingMinutes }))
            : null,
          h("p", { style: S.formNote }, auth?.ephemeral === true ? tt("auth.ephemeral") : tt("auth.saved")),
          // The auto-recovery readiness is a boolean from the Host (`state()`):
          // whether the environment carries `SENSENOVA_PASSWORD`. The value
          // itself never reaches the bundle; the line only tells the user
          // whether a dead refresh token re-signs in by itself or asks again.
          h("p", { style: S.formNote },
            auth?.autoRecoverArmed === true ? tt("auth.autoRecoverOn") : tt("auth.autoRecoverOff"))
        )
      );
    }

    /**
     * The secret-free registration status, step three.
     *
     * Hook-free on purpose: like the pool cards, it is exercised by the Node
     * render suite, so a reworded or dropped status line fails a check. It
     * renders ONLY from the snapshot's `llm` block, which never carries the
     * key itself — booleans, a source tag, counts, and an optional error.
     */
    function ProviderStatus({ llm, tt }) {
      if (!llm || typeof llm !== "object") return null;
      const rows = [];
      // Where the key came from. `memory` and `env` are both real answers;
      // an unknown source degrades to the raw tag rather than a blank line.
      const sourceText = llm.hasApiKey === true
        ? format(tt("llm.keyPresent"), { source: tt(`llm.src.${String(llm.keySource ?? "")}`) || String(llm.keySource ?? "") })
        : tt("llm.noKey");
      rows.push(h("div", { style: { ...S.muted, fontSize: 12 } }, sourceText));
      if (llm.ephemeral === true) {
        rows.push(h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("llm.ephemeral")));
      }
      // The registration line is the one the section title promises.
      if (llm.registerProvider === true && llm.providerRegistered === true) {
        rows.push(h("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-success-primary)" }, role: "status" },
          format(tt("llm.registered"), {
            id: String(llm.providerId ?? ""),
            models: count(llm.modelCount),
            vision: count(llm.visionCount)
          })));
      } else if (llm.registerProvider === true && llm.llmAvailable !== true) {
        rows.push(h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("llm.noService")));
      } else if (llm.registerProvider === true && typeof llm.providerError === "string" && llm.providerError !== "") {
        rows.push(h("div", { style: S.formError, role: "alert" }, format(tt("llm.error"), { error: llm.providerError })));
      } else {
        rows.push(h("div", { style: S.formNote }, tt("llm.off")));
      }
      if (typeof llm.providerId === "string" && llm.providerId !== "") {
        rows.push(h("div", { style: { ...S.muted, fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" } },
          format(tt("llm.id"), { id: llm.providerId })));
      }
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 } }, ...rows);
    }

    /**
     * The live provider-registration switch (docs/PROVIDER-HOT-RELOAD.md).
     *
     * Posts `{ enabled }` to the plugin's own `/provider` route; the Host
     * persists the value in its state file and republishes the adapter pair
     * on the same request, so the flip lands without a config edit or a
     * restart. Hook-based like `ApiKeyForm`, so the render suite (which
     * cannot mount hooks) exercises the secret-free status lines instead;
     * the route itself is covered by `routes.test.mjs`. The state shown is
     * the SNAPSHOT's effective value, never local optimism — the poll after
     * `onDone` repaints whatever the Host actually reports.
     */
    function ProviderSwitch({ llm, onDone, tt }) {
      const [busy, setBusy] = useState(false);
      const [switchError, setSwitchError] = useState(null);
      const enabled = llm?.registerProvider === true;
      const toggle = useCallback(async () => {
        setBusy(true);
        setSwitchError(null);
        try {
          const response = await fetch(PROVIDER_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            cache: "no-store",
            body: JSON.stringify({ enabled: !enabled })
          });
          const payload = await response.json().catch(() => null);
          if (payload?.ok !== true) {
            throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
          }
          onDone?.();
        } catch (error) {
          setSwitchError(format(tt("llm.switchError"), { error: error instanceof Error ? error.message : String(error) }));
        } finally {
          setBusy(false);
        }
      }, [enabled, onDone, tt]);
      return h(
        "label",
        { style: { display: "flex", gap: 8, alignItems: "center", margin: "0 0 12px", cursor: busy ? "wait" : "pointer" } },
        h("input", { type: "checkbox", checked: enabled, disabled: busy, onChange: toggle }),
        h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, busy ? tt("llm.switchBusy") : tt("llm.switch")),
        switchError ? h("span", { style: S.formError, role: "alert" }, switchError) : null
      );
    }

    /**
     * The model picker's row list - hook-free, so the Node render suite
     * drives the very rows the browser draws.
     *
     * Each row is a checkbox, the model name, and a modality badge. The rows
     * come only from the Host's roster, so a curated id that no longer exists
     * can never become a checkbox: curation is a filter over the catalogue,
     * never a catalogue of its own.
     * @param {object} props
     * @param {{id: string, name: string, vision: boolean}[]} props.models
     * @param {string[]} props.enabledIds - the allow-list; empty = every row on.
     * @param {boolean} props.busy - while saving, the checkboxes are inert.
     * @param {(id: string) => void} props.onToggle - the checkbox handler; the roster stays
     *        hook-free, so the picker hands its draft edit in.
     * @param {(key: string) => string} props.tt
     */
    function ModelRoster({ models, enabledIds, busy, tt, onToggle }) {
      const list = Array.isArray(models) ? models : [];
      return h(
        "ul",
        { style: S.modelList, role: "list" },
        list.map((model) => {
          const id = String(model?.id ?? "");
          const label = String(model?.name ?? id);
          const on = modelIsOn(enabledIds, id);
          return h(
            "li",
            { key: id, style: { ...S.modelRow, ...(on ? {} : S.modelRowOff) } },
            h(
              "label",
              {
                style: {
                  display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto",
                  minWidth: 0, cursor: busy ? "default" : "pointer"
                }
              },
              h("input", {
                type: "checkbox",
                checked: on,
                disabled: busy === true,
                style: S.modelCheck,
                "aria-label": label,
                // The roster is hook-free, so the handler is handed in from the
                // picker. Without it this box is display-only and the allow-list
                // cannot be edited by a single row at all.
                onChange: onToggle ? () => onToggle(id) : undefined
              }),
              h("span", { style: S.modelName, title: id }, label)
            ),
            h("span", { style: S.modelBadge, title: id }, model?.vision === true ? tt("llm.rosterVision") : tt("llm.rosterText"))
          );
        })
      );
    }

    /**
     * The curated model allow-list: which of this key's models get pushed to
     * DSH's model list.
     *
     * Hook-based like `ApiKeyForm`, so the render suite exercises the secret-
     * free half it draws - `ModelRoster` and the counts - instead of this
     * state machine. The edit is local until saved: the picker holds a draft
     * of the allow-list, the "unsaved" state is DERIVED by comparing it with
     * the Host's current value, and the "saved" state is the same comparison
     * after a poll echoes the write. Both therefore cannot lie: a save that
     * never reached the Host keeps showing the edits, and an edit that ends
     * up identical to the Host's value shows neither button.
     */
    function ModelPicker({ llm, onDone, tt }) {
      const models = Array.isArray(llm?.models) ? llm.models : [];
      const hostIds = Array.isArray(llm?.enabledModelIds) ? llm.enabledModelIds : [];
      const [ids, setIds] = useState(() => hostIds.slice());
      const [busy, setBusy] = useState(false);
      const [query, setQuery] = useState("");
      const [savedKey, setSavedKey] = useState(null);
      const [notice, setNotice] = useState(null);

      const hostKey = JSON.stringify(hostIds);
      const dirty = JSON.stringify(ids) !== hostKey;
      const justSaved = savedKey !== null && savedKey === hostKey;

      // Follow the Host while the picker is untouched, so a catalogue refresh
      // reaches the list and a save from another client clears the draft.
      // `dirty` in the guard keeps an edit in flight from being clobbered.
      useEffect(() => {
        if (dirty === false) setIds(hostIds);
        setSavedKey(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [hostKey]);

      const save = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setNotice(null);
        const posted = JSON.stringify(ids);
        try {
          const response = await fetch(MODELS_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            cache: "no-store",
            body: JSON.stringify({ enabledModelIds: ids })
          });
          const payload = await response.json().catch(() => null);
          if (payload?.ok !== true) {
            throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
          }
          // Matches hostKey as soon as the poll after onDone() echoes it.
          setSavedKey(posted);
          onDone?.();
        } catch (error) {
          setNotice(format(tt("llm.rosterError"), { error: error instanceof Error ? error.message : String(error) }));
        } finally {
          setBusy(false);
        }
      }, [busy, ids, onDone, tt]);

      const needle = query.trim().toLowerCase();
      const visible = models.filter((model) => {
        if (needle === "") return true;
        return String(model?.id ?? "").toLowerCase().includes(needle)
          || String(model?.name ?? "").toLowerCase().includes(needle);
      });
      const tickedCount = visible.filter((model) => modelIsOn(ids, String(model?.id ?? ""))).length;

      /** Apply "tick all" / "untick all" to the VISIBLE rows only. */
      const bulk = useCallback((allOn) => {
        // Strings, never the `{id, name, vision}` rows: the allow-list is
        // compared against a roster of ids, and an object roster would filter to
        // nothing — "tick all" would have posted the hide-all sentinel.
        const roster = models.map((model) => String(model?.id ?? ""));
        const targets = visible.map((model) => String(model?.id ?? ""));
        setIds(bulkModelsIn(ids, roster, targets, allOn));
        setNotice(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [JSON.stringify(visible.map((model) => model?.id)), JSON.stringify(models), JSON.stringify(ids)]);

      return h(
        "div",
        { style: { marginBottom: 14 } },
        h("p", { style: { ...S.muted, fontSize: 12, margin: "0 0 10px" } }, tt("llm.rosterHint")),
        models.length === 0
          ? h("p", { style: S.empty }, tt("llm.rosterEmpty"))
          : h(
              "div",
              null,
              h(
                "div",
                { style: S.rosterTools },
                h("input", {
                  type: "search",
                  style: { ...S.input, flex: "1 1 200px", width: "auto" },
                  value: query,
                  placeholder: tt("llm.rosterSearchPlaceholder"),
                  "aria-label": tt("llm.rosterSearchPlaceholder"),
                  disabled: busy,
                  onChange: (event) => setQuery(event.target.value)
                }),
                h("button", {
                  type: "button",
                  style: S.button,
                  disabled: busy === true || visible.length === 0,
                  onClick: () => bulk(true)
                }, tt("llm.rosterAll")),
                h("button", {
                  type: "button",
                  style: S.button,
                  disabled: busy === true || visible.length === 0,
                  onClick: () => bulk(false)
                }, tt("llm.rosterNone")),
                h("span", {
                  style: S.rosterCount,
                  title: format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length })
                }, format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length }))
              ),
              visible.length === 0
                ? h("p", { style: S.empty }, tt("llm.rosterNoMatch"))
                : h(ModelRoster, {
                    models: visible,
                    enabledIds: ids,
                    busy,
                    tt,
                    // One row is toggled against the WHOLE roster, not the
                    // filtered view, so an edit survives a later change of the
                    // search box.
                    onToggle: (id) => {
                      setIds(toggleModelIn(ids, models.map((model) => String(model?.id ?? "")), id));
                      setNotice(null);
                    }
                  }),
              dirty
                ? h(
                    "div",
                    { style: S.rosterFoot },
                    h("button", {
                      type: "button",
                      style: S.primary,
                      disabled: busy === true,
                      onClick: () => void save()
                    }, busy ? tt("llm.rosterSaving") : tt("llm.rosterSave")),
                    h("button", {
                      type: "button",
                      style: S.button,
                      disabled: busy === true,
                      onClick: () => {
                        setIds(hostIds);
                        setNotice(null);
                      }
                    }, tt("llm.rosterDiscard")),
                    h("span", { style: { ...S.muted, fontSize: 12 } }, tt("llm.rosterUnsaved"))
                  )
                : justSaved
                  ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("llm.rosterSaved"))
                  : null,
              notice !== null ? h("p", { style: S.formError, role: "alert" }, notice) : null
            )
      );
    }

    /**
     * The inference API-key editor (`sk-…`).
     *
     * Same security shape as `AccountForm`: show/hide, save/forget, busy and
     * outcome notes, and the value leaves component state the moment it is
     * saved. It is hook-based, so like AccountForm the render suite does not
     * mount it; the secret-free half it displays IS covered, via
     * `ProviderStatus`. The key is NEVER populated from the snapshot — the
     * Host only reports whether one exists.
     */
    function ApiKeyForm({ llm, onDone, tt }) {
      const [apiKey, setApiKey] = useState("");
      const [showKey, setShowKey] = useState(false);
      const [busy, setBusy] = useState(false);
      const [formError, setFormError] = useState(null);
      const [saved, setSaved] = useState(false);
      const [forgotten, setForgotten] = useState(false);

      const post = useCallback(async (payload) => {
        const response = await fetch(API_KEY_PATH, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          cache: "no-store",
          body: JSON.stringify(payload)
        });
        return response.json().catch(() => null);
      }, []);

      const submit = useCallback(async (event) => {
        event?.preventDefault?.();
        // A whitespace check, not a prefix check: the platform owns the key
        // format, and rejecting a shape it later changes would lock users out.
        if (apiKey.trim() === "") {
          setFormError(tt("llm.empty"));
          return;
        }
        setBusy(true);
        setFormError(null);
        try {
          const body = await post({ apiKey });
          if (body && body.ok === true) {
            setApiKey("");
            setSaved(true);
            setForgotten(false);
            onDone?.();
            return;
          }
          setFormError(body?.error ?? tt("auth.network"));
        } catch {
          setFormError(tt("auth.network"));
        } finally {
          setBusy(false);
        }
      }, [apiKey, post, onDone, tt]);

      const forget = useCallback(async () => {
        setBusy(true);
        setFormError(null);
        try {
          const body = await post({ forget: true });
          if (body?.ok !== true) {
            setFormError(body?.error ?? tt("auth.network"));
            return;
          }
          setForgotten(true);
          setSaved(false);
          setApiKey("");
          onDone?.();
        } catch {
          setFormError(tt("auth.network"));
        } finally {
          setBusy(false);
        }
      }, [post, onDone, tt]);

      // Only a REFERENCE the panel stored can be forgotten: an environment
      // value has no panel-saved copy to clear, so the button would mislead.
      const canForget = llm?.hasApiKey === true && llm?.keySource === "credentials";
      return h(
        "form",
        { onSubmit: submit },
        h(ProviderStatus, { llm, tt }),
        h(ProviderSwitch, { llm, onDone, tt }),
        h(ModelPicker, { llm, onDone, tt }),
        h(
          "label",
          { style: S.field },
          h("span", { style: S.fieldLabel }, tt("llm.title")),
          h(
            "div",
            { style: { display: "flex", gap: 6, alignItems: "center" } },
            h("input", {
              style: { ...S.input, flex: 1 },
              type: showKey ? "text" : "password",
              value: apiKey,
              autoComplete: "off",
              placeholder: tt("llm.placeholder"),
              disabled: busy,
              onChange: (event) => setApiKey(event.target.value)
            }),
            h(
              "button",
              { type: "button", style: { ...S.button, flex: "none" }, disabled: busy, onClick: () => setShowKey((shown) => !shown) },
              showKey ? tt("auth.hide") : tt("auth.show")
            )
          )
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
          h(
            "button",
            { type: "submit", style: { ...S.primary, ...(busy ? S.primaryBusy : {}) }, disabled: busy },
            busy ? tt("llm.saving") : tt("llm.save")
          ),
          canForget
            ? h("button", { type: "button", style: S.button, disabled: busy, onClick: forget }, tt("llm.forget"))
            : null
        ),
        forgotten
          ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("llm.forgotten"))
          : saved
            ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("llm.saved"))
            : null,
        formError ? h("p", { style: S.formError, role: "alert" }, formError) : null,
        h("p", { style: S.formNote }, tt("llm.footnote"))
      );
    }

    /** The `main`-slot page. Mounted only while this panel is selected. */
    function PanelPage({ onClose, tt, localeSubscribe }) {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [updatedAt, setUpdatedAt] = useState(0);
      const [, setLocaleRevision] = useState(0);
      // The content sections start expanded — the panel opens showing
      // everything — while the account editor starts collapsed: it is a
      // maintenance action, one click away. Remounting on a page switch
      // restores these defaults.
      const [openSections, setOpenSections] = useState({ pools: true, trend: true, account: false, llm: false });

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

      // A snapshot only writes if it is still the newest one: the interval can
      // start a second load before the first returns, and without this the
      // slower response lands last, replacing fresh numbers with a stale
      // snapshot — the usage bar visibly moves backwards. The generation is
      // bumped when a load STARTS, which is also what lets a manual refresh
      // supersede the scheduled one that is already on its way.
      const generation = useRef(0);
      const inFlight = useRef(null);

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
          if (inFlight.current === controller) inFlight.current = null;
        }
      }, []);

      const toggleSection = useCallback((key) => {
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
        let timer = null;
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
                    h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message }))
                  )
            )
        : h(
            "div",
            null,
            shapeWarnings.length > 0
              ? h("div", { style: S.formError, role: "status" },
                  format(tt("panel.shapeDrift"), {
                    detail: shapeWarnings.map((entry) => `${tt("shape.api")} ${entry.api} ${tt("shape.missing")} ${entry.missing}`).join("; ")
                  }))
              : null,
            // Both content sections are collapsible card headers, auto-expanded
            // by default: the panel opens showing everything, and the reader
            // can tuck the chart or the pools away to focus on the other.
            h(
              SectionCard,
              { title: tt("section.pools"), open: openSections.pools, onToggle: () => toggleSection("pools"), tt },
              pools && pools.plan.name
                ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } }, pools.plan.name)
                : null,
              h(PoolExhaustionNotice, { pools, tt }),
              h(
                "div",
                { style: S.poolsGrid },
                (pools?.pools || []).map((pool) => h(PoolCard, { key: pool.id, pool, tt }))
              ),
              data.uncountedModels && data.uncountedModels.length > 0
                ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 4 } },
                    format(tt("pool.uncounted"), { models: data.uncountedModels.join(" · ") }))
                : null,
              // Step one of the vision plan: which of THIS key's models take
              // image input. Only shown when the Host actually had a catalog to
              // ask (no API key → the field is absent → no claim either way).
              data.visionModels && data.visionModels.length > 0
                ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 4 } },
                    format(tt("pool.vision"), {
                      models: data.visionModels.map((entry) => entry.id).join(" · ") + (data.visionModels.every((entry) => entry.source === "name") ? tt("pool.visionInferred") : "")
                    }))
                : null
            ),
            h(
              SectionCard,
              { title: format(tt("section.trend"), { hours: trend?.hours ?? 24 }), open: openSections.trend, onToggle: () => toggleSection("trend"), tt },
              h(TrendTable, { trend, tt })
            ),
            // Step three: save the inference `sk-` key here (DSH credentials
            // reference, env fallback) and see the direct provider
            // registration status. Collapsed by default — it is setup, like
            // the account editor; shown whenever a snapshot exists, since the
            // key is independent of the console login.
            h(
              SectionCard,
              { title: tt("llm.title"), open: openSections.llm, onToggle: () => toggleSection("llm"), tt },
              h(ApiKeyForm, { llm: data?.llm ?? null, onDone: () => void load(), tt, bare: true })
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
      errorOfStatus,
      dictionaries: Object.freeze({ zh, en }),
      tables: Object.freeze({ GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES, REFUSAL_TEXT }),
      styles: S,
      helpers: Object.freeze({
        clock,
        clockLong,
        when,
        count,
        format,
        HIDE_ALL_MODELS,
        modelIsOn,
        allowListFor,
        toggleModelIn,
        setAllModelsIn,
        bulkModelsIn
      }),
      components: Object.freeze({
        QuotaCard,
        PoolCard,
        PoolExhaustionNotice,
        TrendTable,
        SectionCard,
        AccountForm,
        ApiKeyForm,
        ProviderStatus,
        ProviderSwitch,
        ModelRoster,
        ModelPicker,
        PanelPage
      })
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
