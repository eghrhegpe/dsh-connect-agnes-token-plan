var dsh_connect_sensenova_token_plan_client = (function() {

//#region \0rolldown/runtime.js
	var __esmMin = (fn, res, err) => () => {
		if (err) throw err[0];
		try {
			return fn && (res = fn(fn = 0)), res;
		} catch (e) {
			throw err = [e], e;
		}
	};
	var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);

//#endregion
//#region src/client/const.ts
	var NS, PANEL_ID, SNAPSHOT_PATH, ACCOUNT_PATH, API_KEY_PATH, PROVIDER_PATH, MODELS_PATH, DRAW_PATH;
	var init_const = __esmMin((() => {
		NS = "dsh-connect-sensenova-token-plan";
		PANEL_ID = "dsh-connect-sensenova-token-plan";
		SNAPSHOT_PATH = "/api/dsh-connect-sensenova-token-plan/snapshot";
		ACCOUNT_PATH = "/api/dsh-connect-sensenova-token-plan/account";
		API_KEY_PATH = "/api/dsh-connect-sensenova-token-plan/api-key";
		PROVIDER_PATH = "/api/dsh-connect-sensenova-token-plan/provider";
		MODELS_PATH = "/api/dsh-connect-sensenova-token-plan/models";
		DRAW_PATH = "/api/dsh-connect-sensenova-token-plan/draw";
	}));

//#endregion
//#region src/client/format.ts
/** Time and number formatters, verbatim from the pre-split `client.js`. */
	/** `HH:MM` for one epoch second. */
	function clock(epoch) {
		if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
		const pad = (value) => String(value).padStart(2, "0");
		return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
	/** `MM-DD HH:mm` for one epoch second. */
	function clockLong(epoch) {
		if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
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
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
		const now = /* @__PURE__ */ new Date();
		return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate() ? clock(epoch) : clockLong(epoch);
	}
	/**
	* A credit figure as text: 2-decimal precision under 10 000, whole with
	* thousands separators at or above it. The switch is deliberate — a pool
	* limit of 60 000 reads as "60,000", a live balance of 47.5 as "47.5".
	*/
	function count(value) {
		const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
		if (number >= 1e4) return Math.round(number).toLocaleString();
		return String(Math.round(number * 100) / 100);
	}
	/** Fill a `{token}` template from a dictionary entry. */
	function format(template, vars) {
		let text = template;
		for (const [key, value] of Object.entries(vars || {})) text = text.split(`{${key}}`).join(String(value));
		return text;
	}
	var init_format = __esmMin((() => {}));

//#endregion
//#region src/client/runtime.ts
/** Hand the loader-provided React to the rest of the client. One-shot. */
	function provideClientReact(value) {
		if (typeof value !== "object" || value === null) throw new Error("client: the loader did not hand over a react module");
		api = value;
	}
	function reactApi() {
		if (api === null) throw new Error("client: react used before clientFactory ran");
		return api;
	}
	var api, h, useState, useEffect, useCallback, useMemo, useRef;
	var init_runtime = __esmMin((() => {
		api = null;
		h = (type, props, ...children) => reactApi().createElement(type, props, ...children);
		useState = (initial) => reactApi().useState(initial);
		useEffect = (effect, deps) => reactApi().useEffect(effect, deps);
		useCallback = (callback, deps) => reactApi().useCallback(callback, deps);
		useMemo = (factory, deps) => reactApi().useMemo(factory, deps);
		useRef = (initial) => reactApi().useRef(initial);
	}));

//#endregion
//#region src/client/styles.ts
	var S;
	var init_styles = __esmMin((() => {
		S = {
			page: {
				flex: "1 1 auto",
				height: "100%",
				minHeight: 0,
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
				color: "var(--dsw-alias-label-primary)",
				fontSize: 14,
				lineHeight: "22px"
			},
			headerBar: {
				flex: "none",
				background: "var(--dsw-alias-bg-base)",
				position: "relative",
				zIndex: 1
			},
			header: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				maxWidth: 1040,
				margin: "0 auto",
				padding: "16px 32px 12px"
			},
			scroll: {
				flex: 1,
				minHeight: 0,
				overflowY: "auto",
				overflowX: "hidden"
			},
			content: {
				padding: "6px 32px 56px",
				maxWidth: 1040,
				margin: "0 auto"
			},
			title: {
				margin: 0,
				fontSize: 20,
				fontWeight: 600,
				lineHeight: "28px"
			},
			updated: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12
			},
			spacer: { flex: 1 },
			button: {
				height: 30,
				padding: "0 12px",
				borderRadius: 8,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-primary)",
				fontSize: 13,
				cursor: "pointer"
			},
			sectionTitle: {
				margin: "22px 0 10px",
				fontSize: 13,
				fontWeight: 600,
				color: "var(--dsw-alias-label-secondary)"
			},
			sectionCard: {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-1)",
				overflow: "hidden",
				marginTop: 22
			},
			sectionHead: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				width: "100%",
				padding: "12px 16px",
				background: "none",
				border: "none",
				cursor: "pointer",
				textAlign: "left"
			},
			sectionHeadTitle: {
				flex: 1,
				minWidth: 0,
				fontSize: 15,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			chevron: {
				display: "inline-flex",
				flex: "none",
				transition: "transform 0.15s ease",
				color: "var(--dsw-alias-label-secondary)"
			},
			chevronOpen: { transform: "rotate(180deg)" },
			sectionBody: {
				borderTop: "1px solid var(--dsw-alias-border-l1)",
				margin: "0 16px",
				padding: "12px 0 16px"
			},
			card: {
				background: "var(--dsw-alias-bg-layer-1)",
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				padding: 16
			},
			poolsGrid: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
				gap: 12,
				alignItems: "start"
			},
			cardHead: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flexWrap: "wrap"
			},
			poolName: {
				fontSize: 15,
				fontWeight: 600
			},
			chip: {
				display: "inline-flex",
				alignItems: "center",
				height: 22,
				padding: "0 8px",
				borderRadius: 999,
				fontSize: 12,
				border: "1px solid var(--dsw-alias-border-l1)",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)"
			},
			grantChip: {
				display: "inline-flex",
				alignItems: "center",
				fontSize: 13,
				color: "var(--dsw-alias-label-primary)",
				fontVariantNumeric: "tabular-nums"
			},
			quotas: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))",
				gap: 10,
				marginTop: 14
			},
			quota: {
				display: "flex",
				flexDirection: "column",
				gap: 8,
				minWidth: 0,
				padding: "12px 14px",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-2)"
			},
			quotaTop: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 8,
				flexWrap: "wrap"
			},
			quotaLabel: {
				fontSize: 12,
				fontWeight: 500,
				color: "var(--dsw-alias-label-secondary)"
			},
			quotaReset: {
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)"
			},
			quotaFigures: {
				display: "flex",
				alignItems: "flex-end",
				justifyContent: "space-between",
				gap: 8
			},
			quotaRemaining: {
				fontSize: 24,
				lineHeight: "28px",
				fontWeight: 650,
				letterSpacing: "-0.02em",
				fontVariantNumeric: "tabular-nums"
			},
			quotaRemainLabel: {
				fontSize: 11,
				marginTop: 1,
				color: "var(--dsw-alias-label-secondary)"
			},
			quotaPct: {
				fontSize: 15,
				lineHeight: "20px",
				fontWeight: 600,
				textAlign: "right",
				fontVariantNumeric: "tabular-nums"
			},
			quotaUsed: {
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			bar: {
				height: 6,
				borderRadius: 3,
				background: "var(--dsw-alias-bg-layer-1)",
				overflow: "hidden"
			},
			barFill: {
				height: "100%",
				borderRadius: 3,
				background: "var(--dsw-alias-brand-primary)"
			},
			barFillWarn: { background: "var(--dsw-alias-state-warn-primary)" },
			barFillError: { background: "var(--dsw-alias-state-error-primary)" },
			details: {
				marginTop: 12,
				paddingTop: 10,
				borderTop: "1px solid var(--dsw-alias-border-l1)"
			},
			detailsSummary: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
				userSelect: "none"
			},
			detailsBody: {
				display: "flex",
				flexDirection: "column",
				gap: 10,
				marginTop: 10
			},
			grant: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			models: {
				display: "flex",
				flexWrap: "wrap",
				gap: 6
			},
			modelTag: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 11,
				padding: "2px 6px",
				borderRadius: 6,
				background: "var(--dsw-alias-bg-layer-2)",
				border: "1px solid var(--dsw-alias-border-l1)"
			},
			trendHead: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: 12,
				paddingBottom: 6,
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			trendHeadLabel: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				fontWeight: 500
			},
			trendRow: {
				display: "flex",
				flexDirection: "column",
				gap: 8,
				padding: "10px 0",
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			trendRowHead: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: 12,
				minWidth: 0
			},
			trendModel: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			trendCredits: {
				fontSize: 13,
				fontWeight: 600,
				fontVariantNumeric: "tabular-nums"
			},
			trendBar: {
				height: 6,
				borderRadius: 3,
				background: "var(--dsw-alias-bg-layer-2)",
				overflow: "hidden"
			},
			trendLegend: {
				marginTop: 10,
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-secondary)"
			},
			muted: { color: "var(--dsw-alias-label-secondary)" },
			error: { color: "var(--dsw-alias-state-error-primary)" },
			note: {
				marginTop: 24,
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12,
				lineHeight: "18px"
			},
			empty: {
				color: "var(--dsw-alias-label-secondary)",
				padding: "18px 0"
			},
			field: {
				display: "flex",
				flexDirection: "column",
				gap: 6,
				marginBottom: 12
			},
			fieldLabel: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			input: {
				height: 32,
				padding: "0 10px",
				borderRadius: 8,
				fontSize: 13,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)"
			},
			/** Real shell tokens — replaces the color-mix hack that faked "on-primary". */
			primary: {
				height: 32,
				padding: "0 16px",
				borderRadius: 8,
				fontSize: 13,
				fontWeight: 500,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-button-primary-fill)",
				color: "var(--dsw-alias-label-primary-foreground)",
				cursor: "pointer"
			},
			primaryHover: { background: "var(--dsw-alias-button-primary-hover)" },
			primaryBusy: {
				opacity: .6,
				cursor: "default"
			},
			formError: {
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: 12,
				margin: "10px 0 0"
			},
			formNote: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12,
				margin: "10px 0 0"
			},
			rosterTools: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				flexWrap: "wrap",
				marginBottom: 10
			},
			rosterCount: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums",
				marginLeft: "auto"
			},
			modelList: {
				display: "flex",
				flexDirection: "column",
				gap: 6,
				margin: 0,
				padding: 0,
				listStyle: "none"
			},
			modelRow: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				padding: "8px 12px",
				borderRadius: 10,
				border: "1px solid var(--dsw-alias-border-l1)",
				background: "var(--dsw-alias-bg-layer-2)"
			},
			modelRowOff: { opacity: .55 },
			modelCheck: {
				flex: "none",
				width: 15,
				height: 15,
				cursor: "pointer",
				accentColor: "var(--dsw-alias-brand-primary)",
				margin: 0
			},
			modelName: {
				flex: "1 1 auto",
				minWidth: 0,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			modelBadge: {
				flex: "none",
				fontSize: 11,
				padding: "1px 7px",
				borderRadius: 999,
				border: "1px solid var(--dsw-alias-border-l1)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-secondary)"
			},
			rosterFoot: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				marginTop: 10
			}
		};
	}));

//#endregion
//#region src/client/cards.ts
/** The sidebar row glyph: the shell owns the button, this draws the coin. */
	function PanelIcon({ size }) {
		return h("svg", {
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
		}, h("circle", {
			cx: 8,
			cy: 8,
			r: 6
		}), h("path", { d: "M8 5.2v5.6M6.2 6.6h3.6M6.2 9.4h3.6" }));
	}
	/** The bar fill and figure tone for a usage percentage: 70 warn / 90 danger. */
	function usageTone(pct) {
		if (pct >= 90) return {
			fill: S.barFillError,
			color: "var(--dsw-alias-state-error-primary)"
		};
		if (pct >= 70) return {
			fill: S.barFillWarn,
			color: "var(--dsw-alias-state-warn-primary)"
		};
		return {
			fill: S.barFill,
			color: "var(--dsw-alias-label-secondary)"
		};
	}
	/**
	* One quota window as a compact sub-card: the REMAINING balance is the
	* headline number (the panel is opened to see how much is left), the
	* percentage sits beside it in a usage tone, and used/limit is a single
	* quiet caption under the bar.
	*
	* A window that is not an object at all (a pool row the Host flagged as
	* shape-drifted, or a window field simply absent) renders NOTHING instead
	* of throwing: one malformed pool must not blank the whole panel — the
	* shape warning above already says what is wrong.
	*/
	function QuotaCard({ label, window, tt }) {
		if (window === null || typeof window !== "object") return null;
		const { limit, used, remaining, resetAt } = window;
		const pct = limit > 0 ? Math.min(100, used / limit * 100) : 0;
		const tone = usageTone(pct);
		const pctColor = tone.color;
		return h("div", { style: S.quota }, h("div", { style: S.quotaTop }, h("span", { style: S.quotaLabel }, label), remaining <= 0 ? h("span", { style: {
			...S.chip,
			color: "var(--dsw-alias-state-error-primary)",
			borderColor: "var(--dsw-alias-state-error-primary)"
		} }, tt("pool.exhausted")) : h("span", { style: S.quotaReset }, resetAt ? format(tt("pool.reset"), { time: when(resetAt) }) : "")), h("div", { style: S.quotaFigures }, h("div", { style: { minWidth: 0 } }, h("div", { style: S.quotaRemaining }, count(remaining)), h("div", { style: S.quotaRemainLabel }, tt("pool.remaining"))), h("div", { style: {
			minWidth: 0,
			textAlign: "right"
		} }, h("div", { style: {
			...S.quotaPct,
			color: pctColor
		} }, `${pct.toFixed(1)}%`), h("div", { style: S.quotaUsed }, `${tt("pool.used")} ${count(used)} / ${count(limit)}`))), h("div", {
			style: S.bar,
			role: "progressbar",
			"aria-label": `${label} ${pct.toFixed(1)}%`,
			"aria-valuenow": pct.toFixed(1),
			"aria-valuemin": 0,
			"aria-valuemax": 100
		}, h("div", { style: {
			...tone.fill,
			width: `${pct}%`
		} })));
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
		return h("div", { style: S.card }, h("div", { style: S.cardHead }, h("span", { style: S.poolName }, pool.name), h("span", { style: S.chip }, pool.poolType === "dedicated" ? tt("pool.dedicated") : tt("pool.default")), h("span", { style: S.spacer }), pool.grantBalance > 0 ? h("span", {
			style: S.grantChip,
			title: format(tt("pool.grant"), { balance: count(pool.grantBalance) })
		}, format(tt("pool.grant"), { balance: count(pool.grantBalance) })) : null), h("div", { style: S.quotas }, h(QuotaCard, {
			label: tt("pool.window5h"),
			window: pool.window5h,
			tt
		}), h(QuotaCard, {
			label: tt("pool.window7d"),
			window: pool.window7d,
			tt
		})), hasDetails ? h("details", { style: S.details }, h("summary", { style: S.detailsSummary }, tt("pool.details")), h("div", { style: S.detailsBody }, pool.nearestGrantExpiry ? h("div", { style: S.grant }, format(tt("pool.grantExpiry"), {
			time: clockLong(pool.nearestGrantExpiry),
			balance: count(pool.nearestGrantExpiringBalance)
		})) : null, callable.length > 0 ? h("div", { style: S.models }, h("span", { style: {
			...S.muted,
			fontSize: 12,
			marginRight: 2
		} }, `${tt("pool.callable")}:`), callable.map((model) => h("span", {
			key: model,
			style: S.modelTag
		}, model))) : null, locked.length > 0 ? h("div", {
			style: {
				...S.models,
				...S.muted
			},
			title: locked.join(", ")
		}, h("span", { style: {
			fontSize: 12,
			marginRight: 2
		} }, format(tt("pool.locked"), { count: locked.length }))) : null)) : null);
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
	*/
	function PoolExhaustionNotice({ pools, tt }) {
		const list = Array.isArray(pools?.pools) ? pools.pools : [];
		let earliest = 0;
		let anyExhausted = false;
		for (const pool of list) for (const key of ["window5h", "window7d"]) {
			const win = pool?.[key];
			if (win && Number(win.remaining) <= 0) {
				anyExhausted = true;
				const reset = Number(win.resetAt) || 0;
				if (reset > 0 && (earliest === 0 || reset < earliest)) earliest = reset;
			}
		}
		if (!anyExhausted) return null;
		const time = earliest > 0 ? when(earliest) : "—";
		return h("div", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-error-primary)",
				marginTop: 4,
				marginBottom: 10
			},
			role: "status"
		}, format(tt("pool.exhaustedNotice"), { time }));
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
		if (!trend || !Array.isArray(trend.models) || trend.models.length === 0) return h("div", { style: S.card }, h("div", { style: S.empty }, tt("trend.none")));
		const max = Math.max(0, ...trend.models.map((row) => Math.max(0, Number(row.credits) || 0)));
		return h("div", { style: S.card }, h("div", { style: S.trendHead }, h("span", { style: S.trendHeadLabel }, tt("trend.model")), h("span", { style: {
			...S.trendHeadLabel,
			textAlign: "right"
		} }, tt("trend.credits"))), trend.models.map((row) => {
			const credits = Math.max(0, Number(row.credits) || 0);
			const pct = max > 0 ? credits / max * 100 : 0;
			return h("div", {
				key: row.model,
				style: S.trendRow
			}, h("div", { style: S.trendRowHead }, h("span", {
				style: S.trendModel,
				title: row.model
			}, row.model), h("span", { style: S.trendCredits }, count(credits))), h("div", {
				style: S.trendBar,
				role: "progressbar",
				"aria-label": `${row.model} ${Math.round(pct)}%`,
				"aria-valuenow": Math.round(pct),
				"aria-valuemin": 0,
				"aria-valuemax": 100
			}, h("div", { style: {
				...S.barFill,
				width: `${pct}%`
			} })));
		}), h("div", { style: S.trendLegend }, tt("trend.legend")));
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
		return h("div", { style: S.sectionCard }, h("button", {
			type: "button",
			style: S.sectionHead,
			"aria-expanded": open,
			"aria-label": `${tt(open ? "section.collapse" : "section.expand")}: ${title}`,
			onClick: onToggle
		}, h("span", { style: S.sectionHeadTitle }, title), h("svg", {
			viewBox: "0 0 16 16",
			width: 14,
			height: 14,
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "1.5",
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			style: open ? {
				...S.chevron,
				...S.chevronOpen
			} : S.chevron
		}, h("path", { d: "M3 6l5 5 5-5" }))), h("div", {
			style: S.sectionBody,
			hidden: !open
		}, open ? children : null));
	}
	var init_cards = __esmMin((() => {
		init_const();
		init_format();
		init_runtime();
		init_styles();
	}));

//#endregion
//#region src/client/i18n.ts
	var zh, en;
	var init_i18n = __esmMin((() => {
		zh = {
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
			"trend.legend": "柱长按最高消耗相对显示，非占总额度比例。",
			"auth.selfRenew": "令牌自动续期中",
			"auth.needsLogin": "需要重新登录",
			"llm.title": "模型接入（API Key）",
			"llm.keyField": "API Key",
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
			"draw.title": "出图工具",
			"draw.switch": "注册出图工具 sensenova_draw_image（立即生效，无需重启）",
			"draw.switchBusy": "切换中…",
			"draw.switchError": "切换失败：{error}",
			"draw.on": "出图工具已注册：agent 可用 {model} 生成图片。",
			"draw.off": "出图工具未注册——勾选下方开关即可开启。",
			"draw.noTools": "drawEnabled 已开启，但当前 Host 没有提供 agent tools 注册服务，工具静默缺席。",
			"draw.needsKey": "尚未配置 API Key；保存后即可出图。",
			"note": "数据来自商汤控制台 API（pool-usage / credit-usage-trend），Host 侧缓存 {cache} 秒；控制台令牌约 3 小时过期，由 Host 用 refresh_token 静默续期。"
		};
		en = {
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
			"trend.legend": "Bars are scaled relative to the top consumer, not to the total quota.",
			"auth.selfRenew": "Token renews itself",
			"auth.needsLogin": "Sign-in required",
			"llm.title": "Model access (API key)",
			"llm.keyField": "API key",
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
			"draw.title": "Draw tool",
			"draw.switch": "Register the sensenova_draw_image tool (takes effect immediately, no restart)",
			"draw.switchBusy": "Switching…",
			"draw.switchError": "Switch failed: {error}",
			"draw.on": "Draw tool registered: the agent can generate images with {model}.",
			"draw.off": "Draw tool not registered — tick the switch below to enable it.",
			"draw.noTools": "drawEnabled is on, but this Host exposes no agent tools service; the tool is silently absent.",
			"draw.needsKey": "No API key yet; save one to start generating images.",
			"note": "Data from the SenseNova console API (pool-usage / credit-usage-trend), cached {cache}s on the Host; the console token lasts ~3h and the Host renews it silently from a refresh token."
		};
	}));

//#endregion
//#region src/client/snapshot.ts
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
	*/
	function interpretSnapshot(body) {
		const payload = body;
		if (payload && payload.ok === false) return {
			data: null,
			error: {
				message: payload.error || "unexpected payload",
				code: payload.code,
				auth: payload.auth ?? null
			}
		};
		if (!payload || payload.ok !== true) return {
			data: null,
			error: "unexpected payload"
		};
		return {
			data: payload,
			error: null
		};
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
	*/
	function errorOfStatus(status) {
		if (status === 401 || status === 403) return {
			message: `HTTP ${status}`,
			code: "jwt_expired",
			auth: null
		};
		return `HTTP ${status}`;
	}
	/**
	* The panel's decision: what this snapshot means for what to show.
	*
	* Deliberately a module-scope pure function in `(data, error, tt)`.
	* `PanelPage` calls it in the browser, and the Node-side tests call the
	* very same function after loading this bundle as a module (see
	* `client-surface.js`): no source text is copied or scraped, so the
	* tested logic and the running logic cannot drift apart.
	*/
	function viewOf(data, error, tt) {
		const failure = error === null || error === void 0 ? null : typeof error === "string" ? {
			message: error,
			code: null,
			auth: null
		} : error;
		const auth = data?.auth ?? failure?.auth ?? null;
		const needsSetup = data === null && !FORM_EXCLUDED_CODES.has(failure?.code ?? null);
		const guidanceKey = failure === null ? null : GUIDANCE_BY_CODE[failure.code] ?? null;
		return {
			failure,
			auth,
			needsSetup,
			guidanceKey,
			guidance: guidanceKey === null ? null : guidanceKey === "panel.configError" ? format(tt(guidanceKey), { error: failure?.message }) : tt(guidanceKey),
			shapeWarnings: Array.isArray(data?.shapeWarnings) ? data.shapeWarnings : []
		};
	}
	var GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES, REFUSAL_TEXT;
	var init_snapshot = __esmMin((() => {
		init_format();
		GUIDANCE_BY_CODE = Object.freeze({
			auth_error: "panel.jwtExpired",
			jwt_expired: "panel.jwtExpired",
			not_configured: "panel.jwtMissing",
			config_error: "panel.configError",
			console_error: "panel.consoleTransient"
		});
		FORM_EXCLUDED_CODES = Object.freeze(/* @__PURE__ */ new Set(["config_error", "console_error"]));
		REFUSAL_TEXT = Object.freeze({
			login_rejected: "auth.badCredentials",
			account_locked: "auth.locked",
			rate_limited: "auth.rateLimited",
			verification_required: "auth.verification"
		});
	}));

//#endregion
//#region src/client/account-form.ts
	function AccountForm({ auth, onDone, tt, bare }) {
		const [username, setUsername] = useState("");
		const [password, setPassword] = useState("");
		const [showPassword, setShowPassword] = useState(false);
		const [busy, setBusy] = useState(false);
		const [formError, setFormError] = useState(null);
		const [formDetail, setFormDetail] = useState(null);
		const [saved, setSaved] = useState(false);
		const [forgotten, setForgotten] = useState(false);
		const [cooldownUntil, setCooldownUntil] = useState(0);
		const [now, setNow] = useState(() => Date.now());
		useEffect(() => {
			if (cooldownUntil <= Date.now()) return void 0;
			const timer = setInterval(() => {
				setNow(Date.now());
				if (Date.now() >= cooldownUntil) clearInterval(timer);
			}, 1e3);
			return () => clearInterval(timer);
		}, [cooldownUntil]);
		const cooling = now < cooldownUntil;
		const coolingMinutes = Math.max(1, Math.ceil((cooldownUntil - now) / 6e4));
		const setCooldown = useCallback((ms) => {
			setCooldownUntil(Date.now() + ms);
			setNow(Date.now());
		}, []);
		const submit = useCallback(async (event) => {
			event?.preventDefault?.();
			if (cooling) return;
			if (username.trim() === "" || password === "") {
				setFormError(tt("auth.empty"));
				return;
			}
			setBusy(true);
			setFormError(null);
			setFormDetail(null);
			try {
				const body = await (await fetch(ACCOUNT_PATH, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json"
					},
					cache: "no-store",
					body: JSON.stringify({
						username: username.trim(),
						password
					})
				})).json().catch(() => null);
				if (body && body.ok === true) {
					setPassword("");
					setSaved(true);
					setForgotten(false);
					onDone?.();
					return;
				}
				const code = body?.code;
				const waitMs = typeof body?.retryAfterMs === "number" ? body.retryAfterMs : null;
				if (waitMs !== null && waitMs > 0) {
					setCooldown(waitMs);
					setFormError(tt(code === "account_locked" ? "auth.locked" : "auth.rateLimited"));
					return;
				}
				if (typeof REFUSAL_TEXT[code] === "string") {
					setFormError(tt(REFUSAL_TEXT[code]));
					setFormDetail(typeof body?.detail === "string" && body.detail !== "" ? body.detail : null);
					return;
				}
				setFormError(code === "login_failed" ? format(tt("auth.failed"), { reason: body?.error ?? "" }) : body?.error ?? tt("auth.network"));
			} catch {
				setFormError(tt("auth.network"));
			} finally {
				setBusy(false);
			}
		}, [
			username,
			password,
			onDone,
			tt,
			cooling,
			setCooldown
		]);
		const forget = useCallback(async () => {
			setBusy(true);
			setFormError(null);
			setFormDetail(null);
			try {
				const body = await (await fetch(ACCOUNT_PATH, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json"
					},
					cache: "no-store",
					body: JSON.stringify({ forget: true })
				})).json().catch(() => null);
				if (body?.ok !== true) {
					setFormError(body?.error ?? tt("auth.network"));
					return;
				}
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
		return h("div", { style: bare ? {} : {
			...S.card,
			maxWidth: 420
		} }, bare ? null : h("div", { style: S.sectionTitle }, tt("auth.title")), h("form", { onSubmit: submit }, h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("auth.username")), h("input", {
			style: S.input,
			value: username,
			autoComplete: "username",
			placeholder: tt("auth.placeholderUser"),
			disabled: busy,
			onChange: (event) => setUsername(event.target.value)
		})), h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("auth.password")), h("div", { style: {
			display: "flex",
			gap: 6,
			alignItems: "center"
		} }, h("input", {
			style: {
				...S.input,
				flex: 1
			},
			type: showPassword ? "text" : "password",
			value: password,
			autoComplete: "current-password",
			disabled: busy,
			onChange: (event) => setPassword(event.target.value)
		}), h("button", {
			type: "button",
			style: {
				...S.button,
				flex: "none"
			},
			disabled: busy,
			onClick: () => setShowPassword((shown) => !shown)
		}, showPassword ? tt("auth.hide") : tt("auth.show")))), h("div", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			marginTop: 4
		} }, h("button", {
			type: "submit",
			style: {
				...S.primary,
				...busy || cooling ? S.primaryBusy : {}
			},
			disabled: busy || cooling
		}, busy ? tt("auth.submitting") : tt("auth.submit")), auth?.hasAccount ? h("button", {
			type: "button",
			style: S.button,
			disabled: busy,
			onClick: forget
		}, tt("auth.forget")) : null), forgotten ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("auth.forgotten")) : saved ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("auth.working")) : null, formError ? h("p", {
			style: S.formError,
			role: "alert"
		}, formError) : null, formError && formDetail ? h("p", { style: S.formNote }, formDetail) : null, cooling ? h("p", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, format(tt("auth.retryAfter"), { minutes: coolingMinutes })) : null, h("p", { style: S.formNote }, auth?.ephemeral === true ? tt("auth.ephemeral") : tt("auth.saved")), h("p", { style: S.formNote }, auth?.autoRecoverArmed === true ? tt("auth.autoRecoverOn") : tt("auth.autoRecoverOff"))));
	}
	var init_account_form = __esmMin((() => {
		init_const();
		init_format();
		init_runtime();
		init_snapshot();
		init_styles();
	}));

//#endregion
//#region src/client/provider-controls.ts
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
		const sourceText = llm.hasApiKey === true ? format(tt("llm.keyPresent"), { source: tt(`llm.src.${String(llm.keySource ?? "")}`) || String(llm.keySource ?? "") }) : tt("llm.noKey");
		rows.push(h("div", { style: {
			...S.muted,
			fontSize: 12
		} }, sourceText));
		if (llm.ephemeral === true) rows.push(h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("llm.ephemeral")));
		if (llm.registerProvider === true && llm.providerRegistered === true) rows.push(h("div", {
			style: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			role: "status"
		}, format(tt("llm.registered"), {
			id: String(llm.providerId ?? ""),
			models: count(llm.modelCount),
			vision: count(llm.visionCount)
		})));
		else if (llm.registerProvider === true && llm.llmAvailable !== true) rows.push(h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("llm.noService")));
		else if (llm.registerProvider === true && typeof llm.providerError === "string" && llm.providerError !== "") rows.push(h("div", {
			style: S.formError,
			role: "alert"
		}, format(tt("llm.error"), { error: llm.providerError })));
		else rows.push(h("div", { style: S.formNote }, tt("llm.off")));
		if (typeof llm.providerId === "string" && llm.providerId !== "") rows.push(h("div", { style: {
			...S.muted,
			fontSize: 11,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
		} }, format(tt("llm.id"), { id: llm.providerId })));
		return h("div", { style: {
			display: "flex",
			flexDirection: "column",
			gap: 6,
			marginBottom: 12
		} }, ...rows);
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
					headers: {
						"content-type": "application/json",
						accept: "application/json"
					},
					cache: "no-store",
					body: JSON.stringify({ enabled: !enabled })
				});
				const payload = await response.json().catch(() => null);
				if (payload?.ok !== true) throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
				onDone?.();
			} catch (error) {
				setSwitchError(format(tt("llm.switchError"), { error: error instanceof Error ? error.message : String(error) }));
			} finally {
				setBusy(false);
			}
		}, [
			enabled,
			onDone,
			tt
		]);
		return h("label", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			margin: "0 0 12px",
			cursor: busy ? "wait" : "pointer"
		} }, h("input", {
			type: "checkbox",
			checked: enabled,
			disabled: busy,
			onChange: toggle
		}), h("span", { style: {
			fontSize: 12,
			color: "var(--dsw-alias-label-secondary)"
		} }, busy ? tt("llm.switchBusy") : tt("llm.switch")), switchError ? h("span", {
			style: S.formError,
			role: "alert"
		}, switchError) : null);
	}
	/**
	* The live draw-tool switch (docs/PROVIDER-HOT-RELOAD.md, same discipline
	* as `ProviderSwitch`). Posts `{ enabled }` to the plugin's own `/draw`
	* route; the Host persists the value in its state file. The draw tool
	* itself is mounted at `apply` time (lifecycle.js), so a panel flip only
	* becomes visible after the NEXT Host (re)mount — but the switch state,
	* the source, and the snapshot's `llm.drawEnabled` are all live, so the
	* panel shows the effective value immediately. Hook-based like
	* `ProviderSwitch`, so the render suite exercises the status lines
	* instead; the route itself is covered by `routes.test.mjs`.
	*/
	function DrawSwitch({ llm, onDone, tt }) {
		const [busy, setBusy] = useState(false);
		const [switchError, setSwitchError] = useState(null);
		const enabled = llm?.drawEnabled === true;
		const toggle = useCallback(async () => {
			setBusy(true);
			setSwitchError(null);
			try {
				const response = await fetch(DRAW_PATH, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json"
					},
					cache: "no-store",
					body: JSON.stringify({ enabled: !enabled })
				});
				const payload = await response.json().catch(() => null);
				if (payload?.ok !== true) throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
				onDone?.();
			} catch (error) {
				setSwitchError(format(tt("draw.switchError"), { error: error instanceof Error ? error.message : String(error) }));
			} finally {
				setBusy(false);
			}
		}, [
			enabled,
			onDone,
			tt
		]);
		const statusText = enabled ? llm?.hasApiKey === true ? format(tt("draw.on"), { model: String(llm?.drawModelId ?? "") || "the first discovered one" }) : tt("draw.needsKey") : tt("draw.off");
		return h("div", { style: { marginBottom: 12 } }, h("div", { style: S.sectionTitle }, tt("draw.title")), h("label", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			margin: "0 0 6px",
			cursor: busy ? "wait" : "pointer"
		} }, h("input", {
			type: "checkbox",
			checked: enabled,
			disabled: busy,
			onChange: toggle
		}), h("span", { style: {
			fontSize: 12,
			color: "var(--dsw-alias-label-secondary)"
		} }, busy ? tt("draw.switchBusy") : tt("draw.switch"))), h("div", { style: {
			...S.muted,
			fontSize: 12
		} }, statusText), switchError ? h("div", {
			style: S.formError,
			role: "alert"
		}, switchError) : null);
	}
	var init_provider_controls = __esmMin((() => {
		init_const();
		init_format();
		init_runtime();
		init_styles();
	}));

//#endregion
//#region src/client/models.ts
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
	var HIDE_ALL_MODELS;
	var init_models = __esmMin((() => {
		HIDE_ALL_MODELS = "__hide_all__";
	}));

//#endregion
//#region src/client/model-picker.ts
/**
	* The model picker's row list - hook-free, so the Node render suite
	* drives the very rows the browser draws.
	*
	* Each row is a checkbox, the model name, and a modality badge. The rows
	* come only from the Host's roster, so a curated id that no longer exists
	* can never become a checkbox: curation is a filter over the catalogue,
	* never a catalogue of its own.
	*/
	function ModelRoster({ models, enabledIds, busy, tt, onToggle }) {
		const list = Array.isArray(models) ? models : [];
		return h("ul", {
			style: S.modelList,
			role: "list"
		}, list.map((model) => {
			const id = String(model?.id ?? "");
			const label = String(model?.name ?? id);
			const on = modelIsOn(enabledIds, id);
			return h("li", {
				key: id,
				style: {
					...S.modelRow,
					...on ? {} : S.modelRowOff
				}
			}, h("label", { style: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flex: "1 1 auto",
				minWidth: 0,
				cursor: busy ? "default" : "pointer"
			} }, h("input", {
				type: "checkbox",
				checked: on,
				disabled: busy === true,
				style: S.modelCheck,
				"aria-label": label,
				onChange: onToggle ? () => onToggle(id) : void 0
			}), h("span", {
				style: S.modelName,
				title: id
			}, label)), h("span", {
				style: S.modelBadge,
				title: id
			}, model?.vision === true ? tt("llm.rosterVision") : tt("llm.rosterText")));
		}));
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
		const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
		const dirty = useMemo(() => JSON.stringify(ids), [ids]) !== hostKey;
		const justSaved = savedKey !== null && savedKey === hostKey;
		useEffect(() => {
			if (dirty === false) setIds(hostIds);
		}, [hostKey]);
		useEffect(() => {
			if (dirty === true) setSavedKey(null);
		}, [dirty]);
		const save = useCallback(async () => {
			if (busy) return;
			setBusy(true);
			setNotice(null);
			const posted = JSON.stringify(ids);
			try {
				const response = await fetch(MODELS_PATH, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json"
					},
					cache: "no-store",
					body: JSON.stringify({ enabledModelIds: ids })
				});
				const payload = await response.json().catch(() => null);
				if (payload?.ok !== true) throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
				setSavedKey(posted);
				onDone?.();
			} catch (error) {
				setNotice(format(tt("llm.rosterError"), { error: error instanceof Error ? error.message : String(error) }));
			} finally {
				setBusy(false);
			}
		}, [
			busy,
			ids,
			onDone,
			tt
		]);
		const needle = query.trim().toLowerCase();
		const visible = useMemo(() => models.filter((model) => {
			if (needle === "") return true;
			return String(model?.id ?? "").toLowerCase().includes(needle) || String(model?.name ?? "").toLowerCase().includes(needle);
		}), [needle, models]);
		const tickedCount = visible.filter((model) => modelIsOn(ids, String(model?.id ?? ""))).length;
		/** Apply "tick all" / "untick all" to the VISIBLE rows only. */
		const bulk = useCallback((allOn) => {
			const roster = models.map((model) => String(model?.id ?? ""));
			const targets = visible.map((model) => String(model?.id ?? ""));
			setIds(bulkModelsIn(ids, roster, targets, allOn));
			setNotice(null);
		}, [
			models,
			visible,
			ids
		]);
		return h("div", { style: { marginBottom: 14 } }, h("p", { style: {
			...S.muted,
			fontSize: 12,
			margin: "0 0 10px"
		} }, tt("llm.rosterHint")), models.length === 0 ? h("p", { style: S.empty }, tt("llm.rosterEmpty")) : h("div", null, h("div", { style: S.rosterTools }, h("input", {
			type: "search",
			style: {
				...S.input,
				flex: "1 1 200px",
				width: "auto"
			},
			value: query,
			placeholder: tt("llm.rosterSearchPlaceholder"),
			"aria-label": tt("llm.rosterSearchPlaceholder"),
			disabled: busy,
			onChange: (event) => setQuery(event.target.value)
		}), h("button", {
			type: "button",
			style: S.button,
			disabled: busy === true || visible.length === 0,
			onClick: () => bulk(true)
		}, tt("llm.rosterAll")), h("button", {
			type: "button",
			style: S.button,
			disabled: busy === true || visible.length === 0,
			onClick: () => bulk(false)
		}, tt("llm.rosterNone")), h("span", {
			style: S.rosterCount,
			title: format(tt("llm.rosterCount"), {
				selected: tickedCount,
				total: visible.length
			})
		}, format(tt("llm.rosterCount"), {
			selected: tickedCount,
			total: visible.length
		}))), visible.length === 0 ? h("p", { style: S.empty }, tt("llm.rosterNoMatch")) : h(ModelRoster, {
			models: visible,
			enabledIds: ids,
			busy,
			tt,
			onToggle: (id) => {
				setIds(toggleModelIn(ids, models.map((model) => String(model?.id ?? "")), id));
				setNotice(null);
			}
		}), dirty ? h("div", { style: S.rosterFoot }, h("button", {
			type: "button",
			style: S.primary,
			disabled: busy === true,
			onClick: () => void save()
		}, busy ? tt("llm.rosterSaving") : tt("llm.rosterSave")), h("button", {
			type: "button",
			style: S.button,
			disabled: busy === true,
			onClick: () => {
				setIds(hostIds);
				setNotice(null);
			}
		}, tt("llm.rosterDiscard")), h("span", { style: {
			...S.muted,
			fontSize: 12
		} }, tt("llm.rosterUnsaved"))) : justSaved ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("llm.rosterSaved")) : null, notice !== null ? h("p", {
			style: S.formError,
			role: "alert"
		}, notice) : null));
	}
	var init_model_picker = __esmMin((() => {
		init_const();
		init_format();
		init_models();
		init_runtime();
		init_styles();
	}));

//#endregion
//#region src/client/api-key-form.ts
	function ApiKeyForm({ llm, onDone, tt }) {
		const [apiKey, setApiKey] = useState("");
		const [showKey, setShowKey] = useState(false);
		const [busy, setBusy] = useState(false);
		const [formError, setFormError] = useState(null);
		const [saved, setSaved] = useState(false);
		const [forgotten, setForgotten] = useState(false);
		const post = useCallback(async (payload) => {
			return (await fetch(API_KEY_PATH, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				cache: "no-store",
				body: JSON.stringify(payload)
			})).json().catch(() => null);
		}, []);
		const submit = useCallback(async (event) => {
			event?.preventDefault?.();
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
		}, [
			apiKey,
			post,
			onDone,
			tt
		]);
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
		}, [
			post,
			onDone,
			tt
		]);
		const canForget = llm?.hasApiKey === true && llm?.keySource === "credentials";
		return h("form", { onSubmit: submit }, h(ProviderStatus, {
			llm,
			tt
		}), h(ProviderSwitch, {
			llm,
			onDone,
			tt
		}), h(DrawSwitch, {
			llm,
			onDone,
			tt
		}), h(ModelPicker, {
			llm,
			onDone,
			tt
		}), h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("llm.keyField")), h("div", { style: {
			display: "flex",
			gap: 6,
			alignItems: "center"
		} }, h("input", {
			style: {
				...S.input,
				flex: 1
			},
			type: showKey ? "text" : "password",
			value: apiKey,
			autoComplete: "off",
			placeholder: tt("llm.placeholder"),
			disabled: busy,
			onChange: (event) => setApiKey(event.target.value)
		}), h("button", {
			type: "button",
			style: {
				...S.button,
				flex: "none"
			},
			disabled: busy,
			onClick: () => setShowKey((shown) => !shown)
		}, showKey ? tt("auth.hide") : tt("auth.show")))), h("div", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			marginTop: 4
		} }, h("button", {
			type: "submit",
			style: {
				...S.primary,
				...busy ? S.primaryBusy : {}
			},
			disabled: busy
		}, busy ? tt("llm.saving") : tt("llm.save")), canForget ? h("button", {
			type: "button",
			style: S.button,
			disabled: busy,
			onClick: forget
		}, tt("llm.forget")) : null), forgotten ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("llm.forgotten")) : saved ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("llm.saved")) : null, formError ? h("p", {
			style: S.formError,
			role: "alert"
		}, formError) : null, h("p", { style: S.formNote }, tt("llm.footnote")));
	}
	var init_api_key_form = __esmMin((() => {
		init_const();
		init_runtime();
		init_provider_controls();
		init_model_picker();
		init_styles();
	}));

//#endregion
//#region src/client/panel-page.ts
	function PanelPage({ onClose, tt, localeSubscribe }) {
		const [data, setData] = useState(null);
		const [error, setError] = useState(null);
		const [loadedOnce, setLoadedOnce] = useState(false);
		const [updatedAt, setUpdatedAt] = useState(0);
		const [, setLocaleRevision] = useState(0);
		const [openSections, setOpenSections] = useState({
			pools: true,
			trend: true,
			account: false,
			llm: false
		});
		useEffect(() => {
			if (typeof localeSubscribe !== "function") return void 0;
			return localeSubscribe(() => setLocaleRevision((revision) => revision + 1));
		}, [localeSubscribe]);
		const [cadenceMs, setCadenceMs] = useState(3e4);
		const generation = useRef(0);
		const inFlight = useRef(null);
		const load = useCallback(async () => {
			generation.current += 1;
			const mine = generation.current;
			const isCurrent = () => generation.current === mine;
			inFlight.current?.abort?.();
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			inFlight.current = controller;
			try {
				const response = await fetch(SNAPSHOT_PATH, {
					headers: { accept: "application/json" },
					cache: "no-store",
					signal: controller ? controller.signal : void 0
				});
				if (!isCurrent()) return;
				if (!response.ok) {
					setError(errorOfStatus(response.status));
					return;
				}
				const body = await response.json();
				if (!isCurrent()) return;
				const read = interpretSnapshot(body);
				if (read.data === null) {
					setData(null);
					setError(read.error);
					return;
				}
				setData(read.data);
				setError(null);
				setUpdatedAt(Date.now());
				const stated = read.data?.pollSeconds;
				if (typeof stated === "number" && Number.isFinite(stated)) setCadenceMs(Math.min(3600, Math.max(5, Math.floor(stated))) * 1e3);
			} catch (reason) {
				if (!isCurrent()) return;
				setError(reason instanceof Error ? reason.message : String(reason));
			} finally {
				if (isCurrent()) setLoadedOnce(true);
				if (inFlight.current === controller) inFlight.current = null;
			}
		}, []);
		const toggleSection = useCallback((key) => {
			setOpenSections((current) => ({
				...current,
				[key]: !current[key]
			}));
		}, []);
		useEffect(() => {
			let alive = true;
			let timer = null;
			const run = () => {
				if (alive) load();
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
			if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", onVisibility);
			return () => {
				alive = false;
				stop();
				if (typeof document !== "undefined" && document.addEventListener) document.removeEventListener("visibilitychange", onVisibility);
			};
		}, [load, cadenceMs]);
		const pools = data?.pools;
		const trend = data?.trend;
		const { failure, auth, needsSetup, guidance, shapeWarnings } = viewOf(data, error, tt);
		const showSetupForm = needsSetup && loadedOnce;
		const authChip = auth === null ? null : auth.error || !auth.configured ? h("span", {
			style: S.chip,
			title: auth.error ?? ""
		}, tt("auth.needsLogin")) : h("span", { style: S.chip }, tt("auth.selfRenew"));
		const authManage = auth !== null && auth.hasAccount === true;
		const body = !data ? showSetupForm ? h(AccountForm, {
			auth,
			onDone: () => void load(),
			tt
		}) : h("div", { style: S.empty }, failure === null ? tt("panel.loading") : h("div", null, h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message })))) : h("div", null, shapeWarnings.length > 0 ? h("div", {
			style: S.formError,
			role: "status"
		}, format(tt("panel.shapeDrift"), { detail: shapeWarnings.map((entry) => `${tt("shape.api")} ${entry.api} ${tt("shape.missing")} ${entry.missing}`).join("; ") })) : null, h(SectionCard, {
			title: tt("section.pools"),
			open: openSections.pools,
			onToggle: () => toggleSection("pools"),
			tt
		}, pools?.plan?.name ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginBottom: 10
		} }, pools.plan.name) : null, h(PoolExhaustionNotice, {
			pools,
			tt
		}), h("div", { style: S.poolsGrid }, (pools?.pools || []).map((pool) => h(PoolCard, {
			key: pool.id,
			pool,
			tt
		}))), Array.isArray(data.uncountedModels) && data.uncountedModels.length > 0 ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: -4,
			marginBottom: 4
		} }, format(tt("pool.uncounted"), { models: data.uncountedModels.join(" · ") })) : null, Array.isArray(data.visionModels) && data.visionModels.length > 0 ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: -4,
			marginBottom: 4
		} }, format(tt("pool.vision"), { models: data.visionModels.map((entry) => entry.id).join(" · ") + (data.visionModels.every((entry) => entry.source === "name") ? tt("pool.visionInferred") : "") })) : null), h(SectionCard, {
			title: format(tt("section.trend"), { hours: trend?.hours ?? 24 }),
			open: openSections.trend,
			onToggle: () => toggleSection("trend"),
			tt
		}, h(TrendTable, {
			trend,
			tt
		})), h(SectionCard, {
			title: tt("llm.title"),
			open: openSections.llm,
			onToggle: () => toggleSection("llm"),
			tt
		}, h(ApiKeyForm, {
			llm: data?.llm ?? null,
			onDone: () => void load(),
			tt,
			bare: true
		})), h("div", { style: S.note }, format(tt("note"), { cache: data?.cacheSeconds ?? 60 })), authManage ? h(SectionCard, {
			title: tt("auth.title"),
			open: openSections.account,
			onToggle: () => toggleSection("account"),
			tt
		}, h(AccountForm, {
			auth,
			onDone: () => void load(),
			tt,
			bare: true
		})) : null);
		return h("div", {
			style: S.page,
			"data-dsh-plugin": "dsh-connect-sensenova-token-plan"
		}, h("div", { style: S.headerBar }, h("div", { style: S.header }, h("h1", { style: S.title }, tt("panel.title")), h("span", { style: S.updated }, data ? format(tt("panel.updated"), { time: clock(updatedAt / 1e3) }) : ""), authChip, h("span", { style: S.spacer }), failure && data ? h("span", {
			style: S.error,
			role: "status",
			title: failure.message
		}, format(tt("panel.error"), { error: failure.message })) : null, h("button", {
			type: "button",
			style: S.button,
			onClick: () => void load()
		}, tt("panel.refresh")), h("button", {
			type: "button",
			style: S.button,
			onClick: () => onClose?.()
		}, tt("panel.back")))), h("div", { style: S.scroll }, h("div", { style: S.content }, body)));
	}
	var init_panel_page = __esmMin((() => {
		init_account_form();
		init_api_key_form();
		init_const();
		init_format();
		init_snapshot();
		init_runtime();
		init_styles();
		init_cards();
	}));

//#endregion
//#region src/client/apply.ts
/**
	* Register the dictionaries, the sidebar row, and the main-slot page.
	*/
	function apply(ctx) {
		ctx.effect(() => {
			try {
				return ctx.locale.register(NS, {
					zh,
					en
				});
			} catch {
				return () => {};
			}
		}, "dsh-connect-sensenova-token-plan: dictionaries");
		let translate = (key) => key;
		try {
			translate = ctx.locale.bind(NS);
		} catch {}
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
			} catch {}
		};
		const disposers = [];
		try {
			disposers.push(ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				label: () => tt("entry.label")
			}, PanelIcon)));
		} catch (error) {
			console.warn("[dsh-connect-sensenova-token-plan] sidebar row registration failed:", error);
		}
		try {
			disposers.push(ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({
					onClose: close,
					tt,
					localeSubscribe: ctx.locale.subscribe.bind(ctx.locale)
				})
			}, PanelPage)));
		} catch (error) {
			console.warn("[dsh-connect-sensenova-token-plan] panel page registration failed:", error);
		}
		ctx.effect(() => () => {
			for (const dispose of disposers.splice(0)) try {
				dispose();
			} catch {}
		}, "dsh-connect-sensenova-token-plan: ui mounts");
	}
	var inject;
	var init_apply = __esmMin((() => {
		init_cards();
		init_const();
		init_i18n();
		init_panel_page();
		inject = ["slots", "locale"];
	}));

//#endregion
//#region src/client/index.ts
	var require_client = /* @__PURE__ */ __commonJSMin(((exports, module) => {
		init_apply();
		init_snapshot();
		init_models();
		init_format();
		init_runtime();
		init_i18n();
		init_styles();
		init_account_form();
		init_cards();
		init_provider_controls();
		init_api_key_form();
		init_model_picker();
		init_panel_page();
		function clientFactory(loaderRequire) {
			provideClientReact(loaderRequire("react"));
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
				dictionaries: Object.freeze({
					zh,
					en
				}),
				tables: Object.freeze({
					GUIDANCE_BY_CODE,
					FORM_EXCLUDED_CODES,
					REFUSAL_TEXT
				}),
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
					DrawSwitch,
					ModelRoster,
					ModelPicker,
					PanelPage
				})
			});
			return {
				inject,
				apply,
				panel
			};
		}
		/** The registration the Host loads: id plus the factory the Host materializes. */
		const REGISTRATION = {
			id: "dsh-connect-sensenova-token-plan",
			factory: clientFactory
		};
		if (typeof window !== "undefined") {
			const loader = window.__ModuleLoader__;
			if (loader !== void 0) loader.load(REGISTRATION);
		}
		if (typeof module !== "undefined" && module !== null && module.exports !== void 0) module.exports = REGISTRATION;
	}));

//#endregion
return require_client();

})();