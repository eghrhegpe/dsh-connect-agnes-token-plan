var dsh_connect_agnes_token_plan_client = (function() {

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
	var PANEL_ID, NS, SNAPSHOT_PATH, ACCOUNT_PATH, API_KEY_PATH, PROVIDER_PATH, MODELS_PATH, DRAW_PATH, VIDEO_PATH, AGNESCODE_PATH, AGNES_SIGNUP_URL, AGNESCODE_SITE_URL;
	var init_const = __esmMin((() => {
		PANEL_ID = "dsh-connect-agnes-token-plan";
		NS = PANEL_ID;
		SNAPSHOT_PATH = `/api/${PANEL_ID}/snapshot`;
		ACCOUNT_PATH = `/api/${PANEL_ID}/account`;
		API_KEY_PATH = `/api/${PANEL_ID}/api-key`;
		PROVIDER_PATH = `/api/${PANEL_ID}/provider`;
		MODELS_PATH = `/api/${PANEL_ID}/models`;
		DRAW_PATH = `/api/${PANEL_ID}/draw`;
		VIDEO_PATH = `/api/${PANEL_ID}/video`;
		AGNESCODE_PATH = `/api/${PANEL_ID}/agnescode`;
		AGNES_SIGNUP_URL = "https://platform.agnes-ai.cn";
		AGNESCODE_SITE_URL = "https://agnes-ai.cn/agnescode";
	}));

//#endregion
//#region src/client/i18n.ts
	var zh, en;
	var init_i18n = __esmMin((() => {
		zh = {
			"panel.back": "返回会话",
			"panel.refresh": "刷新",
			"panel.updated": "更新于 {time}",
			"panel.loading": "加载中…",
			"panel.error": "读取失败：{error}",
			"panel.jwtMissing": "还没有配置控制台账号。",
			"panel.jwtExpired": "控制台令牌已失效。Agnes 不发放 refresh 令牌，Host 会用已保存的账号重新登录一次；若仍失败，请手动重新登录。",
			"panel.configError": "插件配置有误：{error}",
			"panel.consoleTransient": "Agnes 控制台暂时无法读取，通常下一次自动刷新即可恢复；若持续出现，请检查网络后稍再重试。",
			"panel.shapeDrift": "上游返回的结构可能有变：{detail}",
			"auth.title": "连接 Agnes 控制台",
			"auth.registerHint": "还没有账号？前往官网注册，免费开通 Token Plan 额度 →",
			"auth.portalHint": "前往官网管理额度 / 获取 API Key →",
			"auth.username": "邮箱",
			"auth.password": "密码",
			"auth.show": "显示",
			"auth.hide": "隐藏",
			"auth.placeholderUser": "注册 platform.agnes-ai.cn 的邮箱",
			"auth.submit": "登录",
			"auth.submitting": "登录中…",
			"auth.working": "已保存并登录，正在读取额度…",
			"auth.forget": "清除已保存的账号",
			"auth.forgotten": "已清除账号（当前令牌仍可用）",
			"auth.saved": "邮箱与登录令牌已保存在 DSH 凭据中；密码不落盘。Agnes 不发放 refresh 令牌，令牌失效后 Host 会用已保存的邮箱密码重新登录一次。",
			"auth.ephemeral": "注意：当前 Host 没有凭据服务，账号只保存在内存中，重启后需要重新登录。",
			"auth.autoRecoverOn": "自动恢复：已开启，令牌失效后 Host 会用已保存的邮箱密码重新登录",
			"auth.autoRecoverOff": "自动恢复：未开启，令牌失效后需手动重登",
			"auth.badCredentials": "账号或密码不正确",
			"auth.locked": "账号已被锁定。Agnes 会在多次登录失败后锁定账号——请稍后在 Agnes 控制台确认账号状态后再试，期间面板不会自动重试。",
			"auth.retryAfter": "平台要求等待约 {minutes} 分钟后再试；等待期间面板不会自动重试，避免再次触发锁定。",
			"auth.rateLimited": "尝试过于频繁，请稍后再试。",
			"auth.verification": "需要额外验证（短信/图形验证码），自动化登录无法完成，请先在浏览器登录一次。",
			"auth.failed": "登录未完成：{reason}",
			"auth.empty": "请填写账号和密码",
			"auth.network": "无法连接本机 Host",
			"section.quota": "我的额度",
			"section.catalogue": "套餐对比（{count} 档）",
			"section.usage": "我的用量",
			"quota.window": "额度",
			"quota.group.requests": "模型请求",
			"quota.group.media": "多媒体",
			"quota.win.requests5h": "模型请求",
			"quota.win.requestsWeekly": "每周请求",
			"quota.win.imagesDaily": "生图",
			"quota.win.videoDaily": "视频",
			"quota.perHours": "{hours} 小时",
			"quota.perDay": "每日",
			"quota.perWeek": "每周",
			"quota.perMonth": " / 月",
			"quota.perYear": " / 年",
			"quota.cycle.monthly": "按月",
			"quota.cycle.yearly": "按年",
			"quota.unit.requests": "次",
			"quota.unit.images": "张",
			"quota.used": "已用",
			"quota.resetAt": "重置 {time}",
			"quota.resetCountdown": "约 {minutes} 分钟后重置",
			"quota.expires": "到期 {time}",
			"quota.none": "暂无额度数据。",
			"quota.planUnknown": "未能识别当前套餐——控制台没有返回可匹配的套餐信息。下方「套餐对比」是平台公开的套餐目录，不依赖登录。",
			"quota.consoleOffline": "Agnes 控制台未连接，本页的额度与用量都读不到。",
			"quota.consoleOfflineHint": "登录入口在本页下方的「{section}」卡片里。",
			"quota.error": "读取 {source} 失败：{message}",
			"quota.windowNote": "Agnes 按窗口限流：上面的上限是「每 N 小时 / 每天 / 每周」的次数，卡片里的「已用」来自控制台自己的「当前用量」，是平台报出的数字。下方「账号累计用量」覆盖的是另一段时间，不能与上面的窗口上限相减。",
			"quota.accountTotals": "账号累计用量（控制台口径）",
			"quota.total.requests": "模型请求",
			"quota.total.tokens": "文本 Token",
			"quota.total.images": "生图",
			"quota.total.video": "视频秒数",
			"quota.total.activeDays": "活跃天数",
			"quota.usageMissing": "{label}：暂未读到。",
			"usage.none": "该区间内没有用量记录。",
			"usage.period": "近 {days} 天",
			"usage.periodUnknown": "用量区间",
			"usage.requests": "模型请求",
			"usage.perBucket": "按平台返回的分桶",
			"usage.legend": "柱高按区间内最高的一桶相对显示，不是占额度上限的比例。",
			"shape.api": "接口",
			"shape.missing": "缺少字段",
			"section.collapse": "收起",
			"section.expand": "展开",
			"pool.vision": "图片理解：{models}",
			"pool.visionInferred": "（按模型名推断）",
			"llm.contextBadge": "{ctx} 上下文",
			"auth.selfRenew": "令牌自动续期中",
			"auth.needsLogin": "需要重新登录",
			"llm.title": "API Key",
			"llm.providerTitle": "语言模型",
			"llm.keyField": "API Key",
			"llm.placeholder": "粘贴 API Key（免费版 sk- 或 Token Plan cpk-）",
			"llm.save": "保存 API Key",
			"llm.saving": "保存中…",
			"llm.forget": "清除已保存的 API Key",
			"llm.saved": "API Key 已保存在 DSH 凭据中；下次轮询自动拉取模型目录。",
			"llm.forgotten": "已清除面板保存的 API Key（环境变量 AGNES_TOKEN_PLAN_API_KEY 不受影响）。",
			"llm.empty": "请输入 API Key",
			"llm.footnote": "Key 只保存在 DSH 凭据中，不会写入插件目录或日志；请求时按次读取。",
			"llm.keyRegisterHint": "还没有 API Key？前往官网免费获取 →",
			"llm.keyConsoleHint": "前往官网管理额度 →",
			"llm.ephemeral": "注意：当前 Host 没有凭据服务，Key 只保存在内存中，重启后失效。",
			"llm.keyPresent": "已配置（来源：{source}）",
			"llm.noKey": "尚未配置——在上方粘贴 API Key 并保存。",
			"llm.src.credentials": "DSH 凭据",
			"llm.src.env": "环境变量",
			"llm.src.memory": "本机内存",
			"llm.off": "未向 DSH 注册——勾选上方开关即可开启（id：{id}）。",
			"llm.registeredPending": "开关已开但注册尚未生效（id：{id}）——等待下一次自动刷新；若持续未注册，检查 Host 日志。",
			"llm.registered": "已注册 {id}：{models} 个模型，{vision} 个支持图片输入。",
			"llm.noService": "registerProvider 已开启，但当前 Host 没有提供 LLM 注册服务。",
			"llm.error": "提供方注册失败：{error}",
			"llm.switch": "向 DSH 注册（立即生效）",
			"llm.switchBusy": "切换中…",
			"llm.switchError": "切换失败：{error}",
			"llm.roster": "推送到 DSH 的模型",
			"llm.rosterHint": "勾选决定哪些模型推送进 DSH 模型列表；目录新增的模型默认不推送。",
			"llm.rosterEmpty": "还没有可推送的模型——先在「API Key」卡片保存一次 Key 再回来。",
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
			"llm.rosterExhausted": "额度耗尽",
			"llm.rosterRateTitle": "积分消耗伪倍率（自定义对比用，非官方）",
			"llm.metaOutput": "最大输出 {out}",
			"llm.metaLevels": "思考 {levels}",
			"llm.rosterThinkingDefault": "思考强度默认 {level}",
			"rpm.title": "请求速率（RPM）限制",
			"rpm.body": "除订阅配额外的第二层限制，两层同时生效：免费/默认 Key 每分钟 10 次、企业认证 Key 20 次、Token Plan Key 1000 次（官方 FAQ，2026-09-23）。它与配额耗尽是两回事：402 是额度不足，429 多为撞了速率上限（订阅配额用尽也可能回 429），所以撞上 429 先等一分钟重试。",
			"rpm.pool": "限制池按 Key 类型划分：sk- 走免费/默认池，cpk- 走 Token Plan 池；同一类型创建多个 Key 不叠加，换 Key 即换池。",
			"llm.level.off": "关闭",
			"llm.level.minimal": "微量",
			"llm.level.low": "低",
			"llm.level.medium": "中",
			"llm.level.high": "高",
			"llm.level.xhigh": "极高",
			"llm.level.max": "最高",
			"draw.title": "出图工具",
			"draw.switch": "注册出图工具 agnes_draw_image（下次 Host 装载生效）",
			"draw.switchBusy": "切换中…",
			"draw.switchError": "切换失败：{error}",
			"draw.onList": "agent 出图将使用以下模型：",
			"draw.badge": "出图",
			"draw.badgeNone": "暂无可选模型",
			"draw.autoOption": "自动选择（目录第一个出图模型）",
			"draw.effective": "当前生效",
			"draw.off": "未注册——勾选上方开关即可开启。",
			"draw.needsKey": "尚未配置 API Key；保存后即可出图。",
			"draw.noCandidates": "当前 API Key 目录里暂无出图模型；出图不可用。",
			"video.title": "视频工具",
			"video.switch": "注册视频工具 agnes_video_generate（下次 Host 装载生效）",
			"video.switchBusy": "切换中…",
			"video.switchError": "切换失败：{error}",
			"video.onList": "agent 生成视频将使用以下模型：",
			"video.badge": "视频",
			"video.badgeNone": "暂无可选模型",
			"video.autoOption": "自动选择（目录第一个 V2.0 视频模型；无 V2.0 时取第一个 2.5）",
			"video.effective": "当前生效",
			"video.off": "未注册——勾选上方开关即可开启。",
			"video.needsKey": "尚未配置 API Key；保存后即可生成视频。",
			"video.noCandidates": "当前 API Key 目录里暂无视频模型；视频不可用。",
			"video.note25": "其中 {count} 个为 2.5 系列视频模型（{ids}）：走秒数制参数（seconds / size / aspect_ratio），工具已支持并自动换算；选中时按 2.5 体系出片。",
			"note": "数据来自 Agnes 控制台 API（/api/usage/overview、/api/usage/series、/api/cn/user/subscription 与公开的套餐目录），Host 侧缓存 {cache} 秒；令牌失效后 Host 会用已保存的账号自动重新登录一次。",
			"note.noCache": "数据来自 Agnes 控制台 API（/api/usage/overview、/api/usage/series、/api/cn/user/subscription 与公开的套餐目录）；令牌失效后 Host 会用已保存的账号自动重新登录一次。",
			"tab.quota": "积分额度",
			"tab.api": "接入 API",
			"tab.agnescode": "AgnesCode",
			"agnescode.title": "AgnesCode（爱思编程）",
			"agnescode.desc": "读取本机 AgnesCode 桌面端的登录态（微信登录在桌面 App 内完成，本插件不碰你的密码），模型经 DSH 提供方注册后可对话。凭据独立，与积分额度互不影响。",
			"agnescode.switch": "启用 AgnesCode 提供方（向 DSH 注册模型）",
			"agnescode.switchError": "切换失败：{error}",
			"agnescode.harvest": "检测本机登录态",
			"agnescode.harvesting": "正在读取本机登录态…",
			"agnescode.logout": "解除关联",
			"agnescode.loggedIn": "已关联：{nick}",
			"agnescode.bffBase": "接口地址 {base}",
			"agnescode.notLogged": "未关联——请先在 AgnesCode 桌面端登录（微信扫码），再点「检测本机登录态」。",
			"agnescode.downloadCta": "下载 AgnesCode 桌面客户端，领取限时积分 →",
			"agnescode.balanceLine": "积分余额 {balance}（时效 {timeSensitive} · 永久 {permanent}）",
			"agnescode.models": "模型（{count}）",
			"agnescode.memberOnly": "会员",
			"agnescode.registeredPill": "已注册",
			"agnescode.rosterHint": "勾选决定哪些模型推送进 DSH 模型列表，改动即时生效。",
			"agnescode.rosterSave": "保存",
			"agnescode.rosterSaving": "保存中…",
			"agnescode.rosterDiscard": "放弃",
			"agnescode.rosterUnsaved": "有未保存的改动",
			"agnescode.rosterSaved": "已保存。",
			"agnescode.rosterError": "保存失败：{error}",
			"agnescode.unregistered": "未注册——勾选上方开关即可开启。",
			"agnescode.awaitingHarvest": "已启用——检测到本机登录态后即可注册模型。",
			"agnescode.errNotConfigured": "凭据未就绪——点「检测本机登录态」重新采集后再试。",
			"agnescode.expiresAt": "凭据有效期至 {time}",
			"agnescode.error": "AgnesCode 操作失败：{error}",
			"agnescode.harvestOk": "已读取本机登录态。",
			"agnescode.harvestFail": "未能在本机找到可用的 AgnesCode 登录态。探测记录：",
			"agnescode.tier.file_missing": "文件不存在",
			"agnescode.tier.format_drift": "存储格式已变：桌面端在写本插件还不认识的会话文件——升级本插件后再点检测",
			"agnescode.tier.unreadable": "读不了（权限？）",
			"agnescode.tier.malformed": "内容不是预期格式",
			"agnescode.tier.no_key": "加密密钥拿不到（Local State 缺失或形状已变）",
			"agnescode.tier.decrypt_failed": "解密失败（App 的加密方式可能已变更）",
			"agnescode.tier.no_token": "会话里没有令牌（App 未登录？）",
			"agnescode.tier.untrusted_base": "会话的接口地址不在 Agnes 域内（已拒绝）",
			"agnescode.tier.unsupported_platform": "当前平台没有已知的桌面 App 数据目录",
			"agnescode.tier.ok": "成功"
		};
		en = {
			"panel.back": "Back to conversation",
			"panel.refresh": "Refresh",
			"panel.updated": "Updated {time}",
			"panel.loading": "Loading…",
			"panel.error": "Could not read: {error}",
			"panel.jwtMissing": "No Agnes console account is configured yet.",
			"panel.jwtExpired": "The console token is no longer valid. Agnes issues no refresh token, so the Host signs in again with the saved account; if that also fails, sign in manually.",
			"panel.configError": "The plugin is misconfigured: {error}",
			"panel.consoleTransient": "The Agnes console could not be read just now. This usually clears on the next automatic refresh; if it persists, check your network and try again shortly.",
			"panel.shapeDrift": "The upstream payload shape may have changed: {detail}",
			"auth.title": "Connect the Agnes console",
			"auth.registerHint": "No account yet? Register on the official site for a free Token Plan quota →",
			"auth.portalHint": "Manage quota / get API keys on the official site →",
			"auth.username": "Email",
			"auth.password": "Password",
			"auth.show": "Show",
			"auth.hide": "Hide",
			"auth.placeholderUser": "The email you registered on platform.agnes-ai.cn",
			"auth.submit": "Sign in",
			"auth.submitting": "Signing in…",
			"auth.working": "Saved and signed in; reading quota…",
			"auth.forget": "Forget the saved account",
			"auth.forgotten": "Account cleared (the current token still works)",
			"auth.saved": "Email and login token stored in the DSH credentials; the password is never written to disk. Agnes issues no refresh token, so a dead token means the Host signs in again with the saved email and password.",
			"auth.ephemeral": "Note: this Host has no credentials service, so the account lives in memory only and must be entered again after a restart.",
			"auth.autoRecoverOn": "Auto-recover: on (a dead token re-signs in with the saved email and password)",
			"auth.autoRecoverOff": "Auto-recover: off (a dead token means signing in again manually)",
			"auth.badCredentials": "That email or password is not right",
			"auth.locked": "This account is locked. Agnes locks an account after repeated failed sign-ins — check the account in the Agnes console before retrying; the panel will not retry on its own in the meantime.",
			"auth.retryAfter": "The platform asks to wait about {minutes} more minutes. The panel will not retry on its own during that window, so the lock is not extended.",
			"auth.rateLimited": "Too many attempts. Wait a moment and try again.",
			"auth.verification": "This sign-in needs an extra step (SMS or captcha) that automation cannot complete. Sign in once in a browser first.",
			"auth.failed": "Sign-in did not complete: {reason}",
			"auth.empty": "Enter a username and a password",
			"auth.network": "Could not reach the local Host",
			"section.quota": "My quota",
			"section.catalogue": "Plan comparison ({count})",
			"section.usage": "My usage",
			"quota.window": "Quota",
			"quota.group.requests": "Model requests",
			"quota.group.media": "Media",
			"quota.win.requests5h": "Model requests",
			"quota.win.requestsWeekly": "Weekly requests",
			"quota.win.imagesDaily": "Images",
			"quota.win.videoDaily": "Video",
			"quota.perHours": "{hours} hours",
			"quota.perDay": "per day",
			"quota.perWeek": "per week",
			"quota.perMonth": " / mo",
			"quota.perYear": " / yr",
			"quota.cycle.monthly": "monthly",
			"quota.cycle.yearly": "yearly",
			"quota.unit.requests": " times",
			"quota.unit.images": " images",
			"quota.used": "Used",
			"quota.resetAt": "resets {time}",
			"quota.resetCountdown": "resets in ~{minutes} min",
			"quota.expires": "expires {time}",
			"quota.none": "No quota data yet.",
			"quota.planUnknown": "Could not identify the current plan — the console returned nothing matchable. The plan comparison below is the platform's public catalogue and needs no sign-in.",
			"quota.consoleOffline": "The Agnes console is not connected, so the quota and usage on this page could not be read.",
			"quota.consoleOfflineHint": "The sign-in form is in the \"{section}\" card further down this page.",
			"quota.error": "Could not read {source}: {message}",
			"quota.windowNote": "Agnes rate-limits by window: the limits above are counts per N hours / day / week, and the \"used\" on each card is the console's own current-window figure. The account totals below cover a different period and must not be subtracted from the limits above.",
			"quota.accountTotals": "Account totals (as the console reports them)",
			"quota.total.requests": "Model requests",
			"quota.total.tokens": "Text tokens",
			"quota.total.images": "Images",
			"quota.total.video": "Video seconds",
			"quota.total.activeDays": "Active days",
			"quota.usageMissing": "{label}: not read yet.",
			"usage.none": "No usage recorded in this range.",
			"usage.period": "Last {days} days",
			"usage.periodUnknown": "Usage range",
			"usage.requests": "Model requests",
			"usage.perBucket": "as bucketed by the platform",
			"usage.legend": "Bars are scaled relative to the busiest bucket, not to the quota limit.",
			"shape.api": "endpoint",
			"shape.missing": "missing field",
			"section.collapse": "Collapse",
			"section.expand": "Expand",
			"pool.vision": "Image understanding: {models}",
			"pool.visionInferred": "(inferred from model name)",
			"llm.contextBadge": "{ctx} context",
			"auth.selfRenew": "Token renews itself",
			"auth.needsLogin": "Sign-in required",
			"llm.title": "API key",
			"llm.providerTitle": "Language models",
			"llm.keyField": "API key",
			"llm.placeholder": "Paste your API key (free sk- or Token Plan cpk-)",
			"llm.save": "Save API key",
			"llm.saving": "Saving…",
			"llm.forget": "Forget the saved API key",
			"llm.saved": "API key stored in the DSH credentials; the next poll fetches the model catalog.",
			"llm.forgotten": "Panel-saved API key cleared (an AGNES_TOKEN_PLAN_API_KEY environment value is left untouched).",
			"llm.empty": "Enter an API key",
			"llm.footnote": "The key is kept only in the DSH credentials, never in this plugin's folder or logs; it is read per request.",
			"llm.keyRegisterHint": "No API key yet? Get a free one on the official site →",
			"llm.keyConsoleHint": "Manage your quota on the official site →",
			"llm.ephemeral": "Note: this Host has no credentials service, so the key lives in memory only and is lost on restart.",
			"llm.keyPresent": "Configured (source: {source})",
			"llm.noKey": "Not configured — paste an API key above and save.",
			"llm.src.credentials": "DSH credentials",
			"llm.src.env": "environment",
			"llm.src.memory": "memory",
			"llm.off": "Not registered with DSH — tick the switch above (id: {id}).",
			"llm.registeredPending": "Switch is on but registration has not landed yet (id: {id}) — wait for the next automatic refresh; if it persists, check the Host logs.",
			"llm.registered": "Registered {id}: {models} model(s), {vision} with image input.",
			"llm.noService": "registerProvider is on, but this Host exposes no LLM registration service.",
			"llm.error": "Provider registration failed: {error}",
			"llm.switch": "Register with DSH (immediate)",
			"llm.switchBusy": "Switching…",
			"llm.switchError": "Switch failed: {error}",
			"llm.roster": "Models pushed to DSH",
			"llm.rosterHint": "Ticking decides which models are pushed into DSH's model list; models the catalogue gains later are not pushed by default.",
			"llm.rosterEmpty": "No models to push yet - save a key in the API key card first.",
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
			"llm.rosterExhausted": "quota exhausted",
			"llm.rosterRateTitle": "Pseudo credit multiplier (custom comparison aid, not official)",
			"llm.metaOutput": "max output {out}",
			"llm.metaLevels": "thinking {levels}",
			"llm.rosterThinkingDefault": "thinking default {level}",
			"rpm.title": "Request rate (RPM) limits",
			"rpm.body": "A second limit sits beside the subscription quota, and both apply at once: 10 requests/min on a free (default) key, 20 on an enterprise key, 1000 on a Token Plan key (official FAQ, 2026-09-23). It is a different thing from running out of quota: 402 means no quota left, while a 429 is usually the rate cap (an exhausted subscription can also answer 429), so on a 429 wait a minute and retry.",
			"rpm.pool": "Limit pools follow the key type: sk- draws on the free/default pool, cpk- on the Token Plan pool. Extra keys of the same type do not add headroom; switching keys switches pools.",
			"llm.level.off": "off",
			"llm.level.minimal": "minimal",
			"llm.level.low": "low",
			"llm.level.medium": "medium",
			"llm.level.high": "high",
			"llm.level.xhigh": "xhigh",
			"llm.level.max": "max",
			"draw.title": "Draw tool",
			"draw.switch": "Register the agnes_draw_image tool (next Host mount)",
			"draw.switchBusy": "Switching…",
			"draw.switchError": "Switch failed: {error}",
			"draw.onList": "Draw calls will use the model below:",
			"draw.badge": "image",
			"draw.badgeNone": "no model available yet",
			"draw.autoOption": "Auto — first image-capable model in the catalogue",
			"draw.effective": "active",
			"draw.off": "Not registered — tick the switch above.",
			"draw.needsKey": "No API key yet; save one to start generating images.",
			"draw.noCandidates": "This API key's catalogue has no image model; drawing is unavailable.",
			"video.title": "Video tool",
			"video.switch": "Register the agnes_video_generate tool (next Host mount)",
			"video.switchBusy": "Switching…",
			"video.switchError": "Switch failed: {error}",
			"video.onList": "Video calls will use the model below:",
			"video.badge": "video",
			"video.badgeNone": "no model available yet",
			"video.autoOption": "Auto — first V2.0 video model in the catalogue (first 2.5 when the catalogue has no V2.0 one)",
			"video.effective": "active",
			"video.off": "Not registered — tick the switch above.",
			"video.needsKey": "No API key yet; save one to start generating video.",
			"video.noCandidates": "This API key's catalogue has no video model; video is unavailable.",
			"video.note25": "{count} of these are 2.5-series video model(s) ({ids}): they take the whole-second scheme (seconds / size / aspect_ratio); the tool supports them and adapts automatically when one is selected.",
			"note": "Data from the Agnes console API (/api/usage/overview, /api/usage/series, /api/cn/user/subscription, and the public plan catalogue), cached {cache}s on the Host; a dead token makes the Host sign in again with the saved account.",
			"note.noCache": "Data from the Agnes console API (/api/usage/overview, /api/usage/series, /api/cn/user/subscription, and the public plan catalogue); a dead token makes the Host sign in again with the saved account.",
			"tab.quota": "Quota & Usage",
			"tab.api": "API Integration",
			"tab.agnescode": "AgnesCode",
			"agnescode.title": "AgnesCode",
			"agnescode.desc": "Uses the locally signed-in AgnesCode desktop App (the WeChat login happens inside the App — this plugin never touches your password). Models register with DSH as a provider. Credentials stay independent of the quota tab.",
			"agnescode.switch": "Enable the AgnesCode provider (register models with DSH)",
			"agnescode.switchError": "Switch failed: {error}",
			"agnescode.harvest": "Detect local login state",
			"agnescode.harvesting": "Reading the local login state…",
			"agnescode.logout": "Unlink",
			"agnescode.loggedIn": "Linked: {nick}",
			"agnescode.bffBase": "API base {base}",
			"agnescode.notLogged": "Not linked — sign in inside the AgnesCode desktop App (WeChat scan) first, then run the detection.",
			"agnescode.downloadCta": "Download the AgnesCode desktop client and claim your limited-time credits →",
			"agnescode.balanceLine": "Credit balance {balance} (time-limited {timeSensitive} · permanent {permanent})",
			"agnescode.models": "Models ({count})",
			"agnescode.memberOnly": "member",
			"agnescode.registeredPill": "Registered",
			"agnescode.rosterHint": "Ticking decides which models are pushed into DSH's model list; the change takes effect immediately.",
			"agnescode.rosterSave": "Save",
			"agnescode.rosterSaving": "Saving…",
			"agnescode.rosterDiscard": "Discard",
			"agnescode.rosterUnsaved": "Unsaved changes",
			"agnescode.rosterSaved": "Saved.",
			"agnescode.rosterError": "Save failed: {error}",
			"agnescode.unregistered": "Not registered — tick the switch above.",
			"agnescode.awaitingHarvest": "Enabled — runs once a local login state is detected.",
			"agnescode.errNotConfigured": "Credential not ready — run the detection again, then retry.",
			"agnescode.expiresAt": "Credential valid until {time}",
			"agnescode.error": "AgnesCode operation failed: {error}",
			"agnescode.harvestOk": "Local login state read.",
			"agnescode.harvestFail": "No usable AgnesCode login state found on this machine. Probed:",
			"agnescode.tier.file_missing": "file missing",
			"agnescode.tier.format_drift": "storage format changed: the desktop App writes a session file this plugin cannot read yet — update the plugin, then re-detect",
			"agnescode.tier.unreadable": "unreadable (permissions?)",
			"agnescode.tier.malformed": "unexpected content shape",
			"agnescode.tier.no_key": "encryption key unavailable (Local State missing or reshaped)",
			"agnescode.tier.decrypt_failed": "decryption failed (the App's crypto may have changed)",
			"agnescode.tier.no_token": "session carries no token (App not signed in?)",
			"agnescode.tier.untrusted_base": "session's API base is outside the Agnes domains (refused)",
			"agnescode.tier.unsupported_platform": "no known desktop App data directory for this platform",
			"agnescode.tier.ok": "ok"
		};
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
	/**
	* A price as text, from the platform's minor units: `2500` + `cny` -> `¥25.00`.
	*
	* The catalogue quotes prices in cents (`price_minor`), so dividing by 100 is
	* the platform's own convention rather than a guess. An unrecognised currency
	* keeps its code rather than being dressed in the wrong symbol.
	*/
	function money(minor, currency) {
		const amount = typeof minor === "number" && Number.isFinite(minor) ? minor / 100 : 0;
		const code = typeof currency === "string" ? currency.toLowerCase() : "";
		const symbol = code === "cny" || code === "rmb" ? "¥" : code === "usd" ? "$" : "";
		return symbol === "" ? `${amount.toFixed(2)} ${code}`.trim() : `${symbol}${amount.toFixed(2)}`;
	}
	/**
	* A token count the way the platform names it: 1048576 → "1M", 65536 → "64K",
	* 128000 → "128K". Returns "" for a figure that is not a positive number, so
	* an unknown value draws no segment instead of a zero.
	*
	* Why two bases: the catalogue mixes them — windows and ceilings arrive as
	* powers of two (1048576), while the plugin's own 128k fallback is the round
	* decimal 128 000. A flat /1000 rounding once printed "1049k" for the 1M
	* window and it read like a placeholder bug; so figures divisible by 1000 keep
	* the decimal reading they were written with, binary-only figures (262144 →
	* 256K, 65536 → 64K) get the binary one, and anything ≥ 1M goes to M.
	*/
	function tokenSize(value) {
		const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
		if (number <= 0) return "";
		if (number >= 1e6) return `${Math.round(number / 1e5) / 10}M`;
		if (number % 1e3 === 0) return `${number / 1e3}K`;
		if (number % 1024 === 0) return `${number / 1024}K`;
		return `${Math.round(number / 1e3)}K`;
	}
	var init_format = __esmMin((() => {}));

//#endregion
//#region src/client/http.ts
/** One POST with the panel's fixed request shape; the parsed body or null. */
	async function postRaw(path, payload) {
		const response = await fetch(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			cache: "no-store",
			body: JSON.stringify(payload)
		});
		const body = await response.json().catch(() => null);
		return {
			status: response.status,
			body
		};
	}
	/** POST and return the parsed body, or null when the response is not JSON. */
	function postJson(path, payload) {
		return postRaw(path, payload).then(({ body }) => body);
	}
	/** POST and demand `ok:true`; refuse by throwing the Host's own wording. */
	async function postJsonOrThrow(path, payload) {
		const { status, body } = await postRaw(path, payload);
		if (body === null || body.ok !== true) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${status}`);
		return body;
	}
	var init_http = __esmMin((() => {}));

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
//#region src/client/snapshot.ts
/**
	* Whether a body is a DATA snapshot, as opposed to a refusal.
	*
	* The two `ok` checks in `interpretSnapshot` do the real work — this is the
	* name for the fact they establish, so the caller types the payload as data
	* instead of casting through `unknown`. A type predicate still trusts the
	* wire (the Host owns the shape; `wire.ts` documents that types are loaded,
	* never enforced at runtime), but it records that `ok:true` was seen, where
	* `as unknown as` threw that fact away.
	* @param {unknown} value - the body that reached the `ok:true` branch.
	* @returns {boolean} whether the value is a data snapshot.
	*/
	function isSnapshotData(value) {
		return typeof value === "object" && value !== null && value.ok === true;
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
			data: isSnapshotData(payload) ? payload : null,
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
			code: CLIENT_CODE.JWT_EXPIRED,
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
		const code = failure?.code ?? data?.quota?.error?.code ?? null;
		const needsSetup = (data === null || data.quota?.consoleConnected === false) && !FORM_EXCLUDED_CODES.has(code);
		const guidanceKey = code === null ? null : GUIDANCE_BY_CODE[code] ?? null;
		return {
			failure,
			auth,
			needsSetup,
			guidanceKey,
			guidance: guidanceKey === null ? null : guidanceKey === "panel.configError" ? format(tt(guidanceKey), { error: failure?.message ?? data?.quota?.error?.message }) : tt(guidanceKey),
			shapeWarnings: Array.isArray(data?.shapeWarnings) ? data.shapeWarnings : []
		};
	}
	/**
	* Whether to show the account management section.
	*
	* Decision: show the account editor UNCONDITIONALLY whenever the snapshot
	* carries the Host's auth block. Gating on `hasAccount` / `needsAccount` made
	* the "middle state" (grant still alive, saved account cleared) a dead end:
	* the full-screen setup form lives behind `!data`, and the section card
	* vanished with `hasAccount` — the user was locked out of their own account
	* with no re-entry path until the grant died. This is a single-point-of-truth
	* declaration; callers should use `shouldShowAccountManagement(auth)` rather
	* than duplicating `auth !== null`.
	*/
	function shouldShowAccountManagement(auth) {
		return auth !== null;
	}
	var GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES, CLIENT_CODE, COOLDOWN_TEXT, REFUSAL_TEXT;
	var init_snapshot = __esmMin((() => {
		init_format();
		GUIDANCE_BY_CODE = Object.freeze({
			auth_error: "panel.jwtExpired",
			jwt_expired: "panel.jwtExpired",
			no_refresh_token: "panel.jwtExpired",
			refresh_rejected: "panel.jwtExpired",
			not_configured: "panel.jwtMissing",
			missing_credentials: "panel.jwtMissing",
			login_rejected: "auth.badCredentials",
			login_failed: "auth.badCredentials",
			account_locked: "auth.locked",
			rate_limited: "auth.rateLimited",
			verification_required: "auth.verification",
			config_error: "panel.configError",
			console_error: "panel.consoleTransient"
		});
		FORM_EXCLUDED_CODES = Object.freeze(/* @__PURE__ */ new Set(["config_error", "console_error"]));
		CLIENT_CODE = Object.freeze({
			/** A stored token the console refused; the reader's move is to sign in. */
			JWT_EXPIRED: "jwt_expired",
			/** The platform refused without naming a reason this table knows. */
			LOGIN_FAILED: "login_failed",
			/** The platform locked the account after repeated failures. */
			ACCOUNT_LOCKED: "account_locked"
		});
		COOLDOWN_TEXT = Object.freeze({
			[CLIENT_CODE.ACCOUNT_LOCKED]: "auth.locked",
			rate_limited: "auth.rateLimited"
		});
		REFUSAL_TEXT = Object.freeze({
			login_rejected: "auth.badCredentials",
			account_locked: "auth.locked",
			rate_limited: "auth.rateLimited",
			verification_required: "auth.verification"
		});
	}));

//#endregion
//#region src/client/styles.ts
	var BUTTON, S;
	var init_styles = __esmMin((() => {
		BUTTON = {
			height: 30,
			padding: "0 12px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			cursor: "pointer"
		};
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
				padding: "12px 0 10px"
			},
			scroll: {
				flex: 1,
				minHeight: 0,
				overflowY: "auto",
				overflowX: "hidden"
			},
			content: { padding: "6px 0 56px" },
			tabBar: {
				display: "flex",
				gap: 4,
				borderBottom: "1px solid var(--dsw-alias-border-l1)",
				marginBottom: 4
			},
			tab: {
				appearance: "none",
				background: "none",
				border: "none",
				borderBottom: "2px solid transparent",
				padding: "8px 12px",
				fontSize: 13,
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer"
			},
			tabActive: {
				color: "var(--dsw-alias-label-primary)",
				fontWeight: 600,
				borderBottom: "2px solid var(--agnes-brand, #1E40AF)"
			},
			updated: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12
			},
			spacer: { flex: 1 },
			button: BUTTON,
			sectionTitle: {
				margin: "22px 0 10px",
				fontSize: 13,
				fontWeight: 600,
				color: "var(--dsw-alias-label-secondary)"
			},
			externalLink: {
				color: "var(--dsw-alias-label-primary)",
				fontSize: 12,
				marginTop: 10,
				display: "inline-block",
				textDecoration: "underline",
				cursor: "pointer"
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
			pools: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
				gap: 10,
				marginTop: 14
			},
			pool: {
				minWidth: 0,
				padding: "12px 14px",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-1)",
				border: "1px solid var(--dsw-alias-border-l1)"
			},
			poolHead: {
				fontSize: 13,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			quotas: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))",
				gap: 10,
				marginTop: 10
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
			quotaRemaining: {
				fontSize: 18,
				lineHeight: "22px",
				fontWeight: 650,
				letterSpacing: "-0.02em",
				fontVariantNumeric: "tabular-nums"
			},
			quotaFoot: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 8,
				flexWrap: "wrap"
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
				background: "var(--agnes-brand, #1E40AF)"
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
			metricGrid: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 140px), 1fr))",
				gap: 10,
				marginBottom: 14
			},
			metric: {
				display: "flex",
				flexDirection: "column",
				gap: 2,
				minWidth: 0,
				padding: "10px 12px",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-2)"
			},
			metricLabel: {
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)"
			},
			metricValue: {
				fontSize: 17,
				lineHeight: "22px",
				fontWeight: 650,
				letterSpacing: "-0.02em",
				fontVariantNumeric: "tabular-nums"
			},
			usageBars: {
				display: "flex",
				alignItems: "flex-end",
				gap: 2,
				height: 96,
				padding: "0 1px"
			},
			usageBar: {
				flex: 1,
				minWidth: 2,
				height: "100%",
				display: "flex",
				alignItems: "flex-end"
			},
			usageBarFill: {
				width: "100%",
				minHeight: 2,
				borderRadius: 2,
				background: "var(--agnes-brand, #1E40AF)"
			},
			usageAxis: {
				display: "flex",
				justifyContent: "space-between",
				gap: 12,
				marginTop: 6,
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)"
			},
			catalogueRow: {
				display: "flex",
				alignItems: "baseline",
				gap: 8,
				padding: "6px 0",
				borderBottom: "1px solid var(--dsw-alias-border-l1)",
				fontSize: 12
			},
			catalogueName: {
				flex: "0 0 auto",
				fontWeight: 500
			},
			catalogueLimits: {
				marginLeft: "auto",
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums",
				textAlign: "right"
			},
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
			rosterBulk: {
				...BUTTON,
				height: 32
			},
			modelList: {
				display: "flex",
				flexDirection: "column",
				margin: 0,
				padding: 0,
				listStyle: "none"
			},
			modelRow: {
				display: "flex",
				flexDirection: "column",
				gap: 2,
				padding: "8px 4px",
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			modelRowHead: {
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			modelRowOff: { opacity: .55 },
			modelCheck: {
				flex: "none",
				width: 15,
				height: 15,
				cursor: "pointer",
				accentColor: "var(--agnes-brand, #1E40AF)",
				margin: 0
			},
			modelName: {
				flex: "0 1 auto",
				minWidth: 0,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			modelRate: {
				flex: "none",
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			modelBadge: {
				flex: "none",
				fontSize: 11,
				padding: "1px 7px",
				borderRadius: 999,
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)"
			},
			modelMeta: {
				paddingLeft: 25,
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)"
			},
			rosterFoot: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				marginTop: 10
			},
			modelPanel: {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-1)",
				padding: "12px 14px"
			}
		};
	}));

//#endregion
//#region src/client/account-form.ts
	function AccountForm({ auth, onDone, tt, bare, hasSnapshot }) {
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
				const body = await postJson(ACCOUNT_PATH, {
					username: username.trim(),
					password
				});
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
					setFormError(tt(code !== void 0 ? COOLDOWN_TEXT[code] ?? "auth.rateLimited" : "auth.rateLimited"));
					return;
				}
				if (code !== void 0 && typeof REFUSAL_TEXT[code] === "string") {
					setFormError(tt(REFUSAL_TEXT[code]));
					setFormDetail(typeof body?.detail === "string" && body.detail !== "" ? body.detail : null);
					return;
				}
				setFormError(code === CLIENT_CODE.LOGIN_FAILED ? format(tt("auth.failed"), { reason: body?.error ?? "" }) : body?.error ?? tt("auth.network"));
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
				const body = await postJson(ACCOUNT_PATH, { forget: true });
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
		} }, bare ? null : h("div", { style: S.sectionTitle }, tt("auth.title")), h("a", {
			href: AGNES_SIGNUP_URL,
			target: "_blank",
			rel: "noreferrer",
			style: S.externalLink
		}, tt(auth?.hasAccount ? "auth.portalHint" : "auth.registerHint")), h("form", { onSubmit: submit }, h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("auth.username")), h("input", {
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
		}, tt("auth.forgotten")) : saved && hasSnapshot !== true ? h("p", {
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
		init_http();
		init_runtime();
		init_snapshot();
		init_styles();
	}));

//#endregion
//#region src/client/provider-controls.ts
/**
	* The API-key card's status: ONLY key provenance (+ the ephemeral-host
	* warning). Registration state lives in `ProviderRegStatus` on the
	* provider card — after the panel split into one card per concern, a
	* line about registration inside the key card was information flying
	* across card boundaries, repeating what the provider card's own switch
	* and status already say.
	*
	* Hook-free on purpose: like the pool cards, it is exercised by the Node
	* render suite, so a reworded or dropped status line fails a check. It
	* renders ONLY from the snapshot's `llm` block, which never carries the
	* key itself — booleans and a source tag.
	*/
	function ProviderStatus({ llm, tt }) {
		if (!llm || typeof llm !== "object") return null;
		const rows = [];
		const sourceText = llm.hasApiKey === true ? format(tt("llm.keyPresent"), { source: tt(`llm.src.${String(llm.keySource ?? "")}`) || String(llm.keySource ?? "") }) : tt("llm.noKey");
		rows.push(h("div", {
			style: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			role: "status"
		}, sourceText));
		if (llm.ephemeral === true) rows.push(h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("llm.ephemeral")));
		return h("div", { style: {
			display: "flex",
			flexDirection: "column",
			gap: 6,
			marginBottom: 12
		} }, ...rows);
	}
	/**
	* The provider card's registration status, hook-free like `ProviderStatus`
	* so the render suite pins every branch. The card title and the switch
	* below say "registration" already, so this is pure state + counts: the
	* id rides inside whichever line is showing, never as its own row.
	*/
	function ProviderRegStatus({ llm, tt }) {
		if (!llm || typeof llm !== "object") return null;
		if (llm.registerProvider === true && llm.providerRegistered === true) return h("div", {
			style: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			role: "status"
		}, format(tt("llm.registered"), {
			id: String(llm.providerId ?? ""),
			models: count(llm.modelCount),
			vision: count(llm.visionCount)
		}));
		if (llm.registerProvider === true && typeof llm.providerError === "string" && llm.providerError !== "") return h("div", {
			style: S.formError,
			role: "alert"
		}, format(tt("llm.error"), { error: llm.providerError }));
		if (llm.registerProvider === true && llm.llmAvailable !== true) return h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("llm.noService"));
		if (llm.registerProvider === true) return h("div", {
			style: {
				...S.muted,
				fontSize: 12
			},
			role: "status"
		}, format(tt("llm.registeredPending"), { id: String(llm.providerId ?? "") }));
		return h("div", { style: {
			...S.muted,
			fontSize: 12
		} }, format(tt("llm.off"), { id: String(llm.providerId ?? "") }));
	}
	/**
	* The RPM note at the foot of the API tab: the one limit that governs this
	* provider but that the panel can neither measure nor display as live state.
	*
	* WHY AN EXPLANATION AND NOT A COLUMN. `llm-error-fix.ts` already corrects a
	* bare 429 into "this is a rate ceiling, back off" — the panel's retry ladder
	* leans on that. But the platform exposes no per-key RPM reading anywhere
	* (`/v1/models` and the subscription payload both carry only the four
	* SUBSCRIPTION windows, see docs/AGNES-API.md §4.1), so the ceiling cannot be
	* rendered the way `quota.windows` is. What the user is missing is not a
	* number we could poll but the SHAPE of the rule: the ceiling is set by WHICH
	* KIND OF KEY is in the box, and it is a DIFFERENT limit from subscription
	* quota — the official error table gives one 429 code for both, so a reader
	* who cannot tell them apart does not know whether to wait a minute or to stop
	* and check their quota. Both facts are static, so both are said in words.
	*
	* The figures are the official FAQ tables (docs/AGNES-API-docs/4、Token Plan
	* FAQ.md §3–§5, updated 2026-09-23) — transcribed, never recomputed, and
	* pinned against that file by `test/render.test.mjs` so a docs re-sync that
	* changes a number fails a check instead of silently shipping a stale note.
	* Only the three TEXT tiers appear: the image (per-resolution) and video
	* ceilings are many rows and belong with each tool's own selection rules.
	*
	* Hook-free, like the other status lines, so the render suite reaches it.
	*/
	function RpmNote({ tt }) {
		return h("div", { style: {
			marginTop: 12,
			paddingTop: 10,
			borderTop: "1px solid var(--dsw-alias-border-l1)",
			fontSize: 12,
			color: "var(--dsw-alias-label-secondary)"
		} }, h("div", { style: {
			color: "var(--dsw-alias-label-primary)",
			marginBottom: 4
		} }, tt("rpm.title")), h("div", null, tt("rpm.body")), h("div", { style: { marginTop: 4 } }, tt("rpm.pool")));
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
				await postJsonOrThrow(PROVIDER_PATH, { enabled: !enabled });
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
	* The shared body of an agent-tool card (`DrawSwitch`, `VideoSwitch`).
	*
	* Both tools are mounted by the SAME Host ladder (`mountAgentTool` in
	* `lifecycle.ts`) and both routes are served by the SAME handler shape
	* (`registerToolSwitchRoute` in `routes.ts`), so their cards differ only in
	* which route they post to, which `llm.*` fields they read, and which
	* dictionary prefix labels them. Writing the card once is what keeps the two
	* from drifting into different states for the same condition — the failure
	* mode the Host-side refactor was done to prevent.
	*
	* The dictionary suffixes are identical under both prefixes (`switch`,
	* `switchBusy`, `switchError`, `onList`, `off`, `needsKey`, `noCandidates`,
	* `badge`, `badgeNone`, `autoOption`, `effective`, `title`), so `k()` is the
	* only translation step.
	*
	* Mountable: the stand-in React returns `useState`'s initial value and passes
	* `useCallback` through, so `render.test.mjs` pins the picker's row markup —
	* the `modelRowHead` wrap below is that contract.
	*/
	function ToolSwitch({ path, prefix, modelKey, enabled, hasKey, candidates, preferred, effective, extraNote, onDone, tt }) {
		const [busy, setBusy] = useState(false);
		const [switchError, setSwitchError] = useState(null);
		const k = (suffix) => tt(`${prefix}.${suffix}`);
		const toggle = useCallback(async () => {
			setBusy(true);
			setSwitchError(null);
			try {
				await postJsonOrThrow(path, { enabled: !enabled });
				onDone?.();
			} catch (error) {
				setSwitchError(format(k("switchError"), { error: error instanceof Error ? error.message : String(error) }));
			} finally {
				setBusy(false);
			}
		}, [
			path,
			prefix,
			enabled,
			onDone,
			tt
		]);
		const saveModel = useCallback(async (id) => {
			setBusy(true);
			setSwitchError(null);
			try {
				await postJsonOrThrow(path, { [modelKey]: id });
				onDone?.();
			} catch (error) {
				setSwitchError(format(k("switchError"), { error: error instanceof Error ? error.message : String(error) }));
			} finally {
				setBusy(false);
			}
		}, [
			path,
			modelKey,
			prefix,
			onDone,
			tt
		]);
		const statusText = enabled ? hasKey ? k("onList") : k("needsKey") : k("off");
		const radioName = `${prefix}-model`;
		const pickerRows = hasKey && candidates.length > 0 ? h("ul", {
			style: S.modelList,
			role: "radiogroup",
			"aria-label": k("title")
		}, h("li", {
			style: enabled ? S.modelRow : {
				...S.modelRow,
				...S.modelRowOff
			},
			key: "auto"
		}, h("div", { style: S.modelRowHead }, h("label", { style: {
			display: "flex",
			alignItems: "center",
			gap: 10,
			flex: "1 1 auto",
			minWidth: 0,
			cursor: busy ? "default" : "pointer"
		} }, h("input", {
			type: "radio",
			name: radioName,
			checked: preferred === null && enabled,
			disabled: busy || !enabled,
			onChange: () => void saveModel(null),
			style: S.modelCheck
		}), h("span", { style: S.modelName }, k("autoOption"))), h("span", { style: S.modelBadge }, effective !== "" ? `${k("badge")} · ${effective}` : `${k("badge")} · ${k("badgeNone")}`))), ...candidates.map((id) => h("li", {
			style: enabled ? S.modelRow : {
				...S.modelRow,
				...S.modelRowOff
			},
			key: id
		}, h("div", { style: S.modelRowHead }, h("label", { style: {
			display: "flex",
			alignItems: "center",
			gap: 10,
			flex: "1 1 auto",
			minWidth: 0,
			cursor: busy ? "default" : "pointer"
		} }, h("input", {
			type: "radio",
			name: radioName,
			checked: preferred === id && enabled,
			disabled: busy || !enabled,
			onChange: () => void saveModel(id),
			style: S.modelCheck
		}), h("span", {
			style: S.modelName,
			title: id
		}, id)), h("span", { style: S.modelBadge }, effective === id && enabled ? `${k("badge")} · ${k("effective")}` : k("badge")))))) : null;
		const noListHint = hasKey && candidates.length === 0 ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 4
		} }, k("noCandidates")) : null;
		return h("div", { style: { marginBottom: 12 } }, h("label", { style: {
			display: "flex",
			gap: 8,
			alignItems: "baseline",
			cursor: busy ? "wait" : "pointer"
		} }, h("input", {
			type: "checkbox",
			checked: enabled,
			disabled: busy,
			onChange: toggle
		}), h("span", { style: {
			fontSize: 12,
			color: "var(--dsw-alias-label-primary)"
		} }, busy ? k("switchBusy") : k("switch"))), h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 4
		} }, statusText), pickerRows, noListHint, extraNote ?? null, switchError ? h("div", {
			style: S.formError,
			role: "alert"
		}, switchError) : null);
	}
	/** Ids off a snapshot array field, coerced to strings and guarded against `null`. */
	function idList(value) {
		return Array.isArray(value) ? value.map((id) => String(id)) : [];
	}
	/**
	* The live draw-tool switch (docs/PROVIDER-HOT-RELOAD.md, same discipline
	* as `ProviderSwitch`). Posts `{ enabled }` / `{ modelId }` to the plugin's
	* own `/draw` route; the Host persists the value in its state file. The draw
	* tool itself is mounted at `apply` time (lifecycle.ts), so a panel flip only
	* becomes visible after the NEXT Host (re)mount — but the switch state, the
	* source, and the snapshot's `llm.drawEnabled` are all live, so the panel
	* shows the effective value immediately. The route is covered by
	* `routes.test.mjs`.
	*/
	function DrawSwitch({ llm, onDone, tt }) {
		return h(ToolSwitch, {
			path: DRAW_PATH,
			prefix: "draw",
			modelKey: "drawModelId",
			enabled: llm?.drawEnabled === true,
			hasKey: llm?.hasApiKey === true,
			candidates: idList(llm?.drawCandidateIds),
			preferred: llm?.drawPreferredModel != null ? String(llm.drawPreferredModel) : null,
			effective: String(llm?.drawModel ?? ""),
			onDone,
			tt
		});
	}
	/**
	* The live video-tool switch — `DrawSwitch`'s twin, on `/video`.
	*
	* The one thing it says that the draw card does not: the catalogue mixes two
	* video PARAMETER families. `videoCandidateIds` lists ALL of them (the tool
	* drives both), and `video25ModelIds` names the 2.5-series subset, whose body
	* schema (`mode`/`seconds`/`size`/`aspect_ratio`) is disjoint from V2.0's
	* (`width`/`height`/`num_frames`/`frame_rate`). The tool adapts automatically:
	* when a 2.5 model is selected it builds the 2.5 body (whole seconds,
	* resolution tier, aspect whitelist) and translates any frame fields to the
	* nearest whole second. The card's note line says so, rather than leaving a
	* reader wondering why a seconds-based model sits next to a frame-based one.
	*/
	function VideoSwitch({ llm, onDone, tt }) {
		const excluded = idList(llm?.video25ModelIds);
		const extraNote = excluded.length > 0 ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 4
		} }, format(tt("video.note25"), {
			count: count(excluded.length),
			ids: excluded.join(" · ")
		})) : null;
		return h(ToolSwitch, {
			path: VIDEO_PATH,
			prefix: "video",
			modelKey: "videoModelId",
			enabled: llm?.videoEnabled === true,
			hasKey: llm?.hasApiKey === true,
			candidates: idList(llm?.videoCandidateIds),
			preferred: llm?.videoPreferredModel != null ? String(llm.videoPreferredModel) : null,
			effective: String(llm?.videoModel ?? ""),
			extraNote,
			onDone,
			tt
		});
	}
	var init_provider_controls = __esmMin((() => {
		init_const();
		init_format();
		init_http();
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
	/**
	* The roster search filter, shared by both pickers.
	*
	* The rows differ in shape (`ModelData` vs `AgnescodeModelData`) but both
	* carry `id` and `name`, and the match rule is the same — one predicate
	* instead of two copies, so a filter tweaked in one picker cannot silently
	* leave the other searching differently.
	*/
	function rosterMatches(row, needle) {
		if (needle === "") return true;
		return String(row?.id ?? "").toLowerCase().includes(needle) || String(row?.name ?? "").toLowerCase().includes(needle);
	}
	var HIDE_ALL_MODELS;
	var init_models = __esmMin((() => {
		HIDE_ALL_MODELS = "__hide_all__";
	}));

//#endregion
//#region src/client/roster-draft.ts
/**
	* The shared draft machine for a curated model roster.
	*
	* @param rows - the roster rows the route currently reports (already defaulted
	*   to `[]` by the caller, so identity is stable between polls).
	* @param hostIds - the Host's curated ids, already normalised by the caller.
	* @returns the draft, its derived flags, and the row actions.
	*/
	function useRosterDraft(rows, hostIds) {
		const [ids, setIds] = useState(() => hostIds.slice());
		const [busy, setBusy] = useState(false);
		const [query, setQuery] = useState("");
		const [savedKey, setSavedKey] = useState(null);
		const [notice, setNotice] = useState(null);
		const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
		const idsKey = useMemo(() => JSON.stringify(ids), [ids]);
		const dirty = idsKey !== hostKey;
		const justSaved = savedKey !== null && savedKey === hostKey;
		useEffect(() => {
			if (dirty === false) setIds(hostIds);
		}, [hostKey]);
		useEffect(() => {
			if (dirty === true) setSavedKey(null);
		}, [dirty]);
		const needle = query.trim().toLowerCase();
		const visible = useMemo(() => rows.filter((row) => rosterMatches(row, needle)), [needle, rows]);
		return {
			ids,
			setIds,
			busy,
			setBusy,
			query,
			setQuery,
			savedKey,
			setSavedKey,
			notice,
			setNotice,
			idsKey,
			hostKey,
			dirty,
			justSaved,
			visible,
			tickedCount: visible.filter((row) => modelIsOn(ids, String(row?.id ?? ""))).length,
			bulk: useCallback((allOn) => {
				const roster = rows.map((row) => String(row?.id ?? ""));
				const targets = visible.map((row) => String(row?.id ?? ""));
				setIds(bulkModelsIn(ids, roster, targets, allOn));
				setNotice(null);
			}, [
				rows,
				visible,
				ids
			]),
			toggle: useCallback((id) => {
				setIds(toggleModelIn(ids, rows.map((row) => String(row?.id ?? "")), id));
				setNotice(null);
			}, [ids, rows]),
			discard: useCallback(() => {
				setIds(hostIds);
				setNotice(null);
			}, [hostIds])
		};
	}
	var init_roster_draft = __esmMin((() => {
		init_runtime();
		init_models();
	}));

//#endregion
//#region src/client/model-picker.ts
/**
	* The model picker's row list - hook-free, so the Node render suite
	* drives the very rows the browser draws.
	*
	* Each row is two lines in the WorkBuddy shape: a head line (checkbox, the
	* model name, an optional `×N` pseudo rate, badges for NOTABLE states only)
	* and an indented parameter line quoting the figures the platform declares -
	* window, output ceiling, and the thinking levels DSH's selector will really
	* offer for THIS model. A provider-wide constant (the default effort) never
	* repeats per row - it is stated once in the header, because a fact that
	* never varies between rows is noise, not information.
	* The rows come only from the Host's roster, so a curated id that no longer
	* exists can never become a checkbox: curation is a filter over the catalogue,
	* never a catalogue of its own. A default ("text only") earns no badge, and a
	* figure the catalogue does not declare draws no segment - the list quotes
	* facts, never guesses.
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
			const meta = [
				typeof model?.contextWindow === "number" && model.contextWindow > 0 ? format(tt("llm.contextBadge"), { ctx: tokenSize(model.contextWindow) }) : null,
				typeof model?.maxOutputLength === "number" && model.maxOutputLength > 0 ? format(tt("llm.metaOutput"), { out: tokenSize(model.maxOutputLength) }) : null,
				Array.isArray(model?.thinkingLevels) && model.thinkingLevels.length > 0 ? format(tt("llm.metaLevels"), { levels: model.thinkingLevels.map((level) => tt(`llm.level.${level}`)).join("/") }) : null
			].filter(Boolean).join(" · ");
			const rate = typeof model?.multiplier === "number" ? model.multiplier : null;
			return h("li", {
				key: id,
				style: {
					...S.modelRow,
					...on ? {} : S.modelRowOff
				}
			}, h("div", { style: S.modelRowHead }, h("label", { style: {
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
			}, label), rate !== null ? h("span", {
				style: S.modelRate,
				title: tt("llm.rosterRateTitle")
			}, `×${rate}`) : null), model?.vision === true ? h("span", { style: S.modelBadge }, tt("llm.rosterVision")) : null, model?.quotaExhausted === true ? h("span", { style: {
				...S.modelBadge,
				color: "var(--dsw-alias-state-error-primary)"
			} }, tt("llm.rosterExhausted")) : null), meta === "" ? null : h("div", { style: S.modelMeta }, meta));
		}));
	}
	/**
	* The curated model allow-list: which of this key's models get pushed to
	* DSH's model list.
	*
	* Hook-based like `ApiKeyForm`, so the render suite exercises the secret-
	* free half it draws - `ModelRoster` and the counts - instead of this
	* state machine. The draft/dirty/saved machinery now lives in
	* `roster-draft.ts`, shared with `AgnescodeModelPicker`; what stays here is
	* only what this roster does differently — it POSTs to `MODELS_PATH` itself
	* and words its errors with the `llm.roster*` keys.
	*/
	function ModelPicker({ llm, onDone, tt }) {
		const models = Array.isArray(llm?.models) ? llm.models : [];
		const hostIds = Array.isArray(llm?.enabledModelIds) ? llm.enabledModelIds : [];
		const { ids, busy, setBusy, query, setQuery, setSavedKey, notice, setNotice, dirty, justSaved, visible, tickedCount, bulk, toggle, discard } = useRosterDraft(models, hostIds);
		const save = useCallback(async () => {
			if (busy) return;
			setBusy(true);
			setNotice(null);
			const posted = JSON.stringify(ids);
			try {
				await postJsonOrThrow(MODELS_PATH, { enabledModelIds: ids });
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
			tt,
			setBusy,
			setNotice,
			setSavedKey
		]);
		return h("div", { style: { marginBottom: 14 } }, h("p", { style: { margin: "0 0 10px" } }, h("span", { style: S.sectionTitle }, tt("llm.roster"), " — "), h("span", { style: {
			...S.muted,
			fontSize: 12
		} }, tt("llm.rosterHint")), typeof llm?.thinkingDefault === "string" && llm.thinkingDefault !== "" ? h("span", { style: {
			...S.muted,
			fontSize: 12
		} }, ` · ${format(tt("llm.rosterThinkingDefault"), { level: tt(`llm.level.${llm.thinkingDefault}`) })}`) : null), models.length === 0 ? h("p", { style: S.empty }, tt("llm.rosterEmpty")) : h("div", null, h("div", { style: S.rosterTools }, h("input", {
			type: "search",
			style: {
				...S.input,
				flex: "1 1 200px",
				width: "auto"
			},
			value: query,
			placeholder: tt("llm.rosterSearchPlaceholder"),
			"aria-label": tt("llm.rosterSearchPlaceholder"),
			autoComplete: "off",
			name: "model-search",
			disabled: busy,
			onChange: (event) => setQuery(event.target.value)
		}), h("span", {
			style: S.rosterCount,
			title: format(tt("llm.rosterCount"), {
				selected: tickedCount,
				total: visible.length
			})
		}, format(tt("llm.rosterCount"), {
			selected: tickedCount,
			total: visible.length
		})), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busy === true || visible.length === 0,
			onClick: () => bulk(true)
		}, tt("llm.rosterAll")), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busy === true || visible.length === 0,
			onClick: () => bulk(false)
		}, tt("llm.rosterNone"))), visible.length === 0 ? h("p", { style: S.empty }, tt("llm.rosterNoMatch")) : h(ModelRoster, {
			models: visible,
			enabledIds: ids,
			busy,
			tt,
			onToggle: toggle
		}), dirty ? h("div", { style: S.rosterFoot }, h("button", {
			type: "button",
			style: S.primary,
			disabled: busy === true,
			onClick: () => void save()
		}, busy ? tt("llm.rosterSaving") : tt("llm.rosterSave")), h("button", {
			type: "button",
			style: S.button,
			disabled: busy === true,
			onClick: discard
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
		init_http();
		init_models();
		init_roster_draft();
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
		const post = useCallback((payload) => postJson(API_KEY_PATH, payload), []);
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
		const keyEditor = h("div", null, h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("llm.keyField")), h("div", { style: {
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
		}, formError) : null, h("p", { style: S.formNote }, tt("llm.footnote")), h("a", {
			href: AGNES_SIGNUP_URL,
			target: "_blank",
			rel: "noreferrer",
			style: S.externalLink
		}, llm?.hasApiKey === true ? tt("llm.keyConsoleHint") : tt("llm.keyRegisterHint")));
		return h("form", { onSubmit: submit }, keyEditor, h(ProviderStatus, {
			llm,
			tt
		}));
	}
	/**
	* The provider-registration half — the live switch plus its "which models
	* get pushed" roster — as ONE card body. Split from `ApiKeyForm` when the
	* panel grew one SectionCard per concern: key, provider+push, draw are
	* three different functions and no longer share a card.
	*/
	function ProviderForm({ llm, onDone, tt }) {
		return h("div", null, h(ProviderSwitch, {
			llm,
			onDone,
			tt
		}), h(ModelPicker, {
			llm,
			onDone,
			tt
		}), h(ProviderRegStatus, {
			llm,
			tt
		}));
	}
	var init_api_key_form = __esmMin((() => {
		init_const();
		init_http();
		init_runtime();
		init_provider_controls();
		init_model_picker();
		init_styles();
	}));

//#endregion
//#region src/client/cards.ts
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
	* The window's own name, from the key the Host emits.
	*
	* Falls back to the raw key rather than to a generic "quota": an unmapped key
	* means the Host grew a dimension this bundle has never heard of, and showing
	* `requestsMonthly` is more useful to whoever has to fix that than showing
	* four identical "Quota" labels.
	*/
	function windowLabel(key, tt) {
		const name = String(key ?? "");
		return name === "" ? tt("quota.window") : tt(`quota.win.${name}`);
	}
	/** The window's period, phrased the way the platform phrases it. */
	function windowPeriod(hours, tt) {
		const value = Number(hours);
		if (!Number.isFinite(value) || value <= 0) return "";
		if (value === 168) return tt("quota.perWeek");
		if (value === 24) return tt("quota.perDay");
		return format(tt("quota.perHours"), { hours: value });
	}
	/**
	* The unit a dimension is counted in — `""` for video.
	*
	* Video is deliberately unitless. The platform's limit field is
	* `video_daily_limit` while its usage field is `total_video_seconds`, and it
	* never says which one the limit is expressed in, so printing "500 秒" would
	* assert something nobody verified.
	*/
	function unitOf(unit, tt) {
		const name = String(unit ?? "");
		if (name === "requests") return tt("quota.unit.requests");
		if (name === "images") return tt("quota.unit.images");
		return "";
	}
	/** `monthly` / `yearly` as the panel phrases them. */
	function cycleLabel(cycle, tt) {
		const name = String(cycle ?? "");
		if (name === "yearly" || name === "annual") return tt("quota.cycle.yearly");
		if (name === "monthly") return tt("quota.cycle.monthly");
		return name;
	}
	/**
	* One quota window as a compact sub-card.
	*
	* The CONSUMPTION FRACTION is the headline, not the raw limit. When the
	* subscription reports a window's `used` against the plan's `limit`, the big
	* figure is the platform's own fraction as a percentage and the raw
	* `used / limit` counts sit below it — a bare "1500 次" headline reads as
	* available capacity and misleads exactly when the window is exhausted. The
	* limit is still quoted verbatim in the counts line; nothing is subtracted or
	* re-derived. A window with no stated `used` (the video window today: the cap
	* field is `video_daily_limit` while usage counts `video_seconds`) keeps the
	* limit as its headline, because there is no fraction to lead with.
	*
	* A window that is not an object at all (a row the Host flagged as
	* shape-drifted, or a field simply absent) renders NOTHING instead of throwing:
	* one malformed row must not blank the whole panel — the shape warning above
	* already says what is wrong.
	*/
	function QuotaWindowCard({ label, window, tt }) {
		if (window === null || typeof window !== "object") return null;
		const source = window;
		const limit = Number(source.limit) || 0;
		const period = windowPeriod(source.windowHours, tt);
		const unit = unitOf(source.unit, tt);
		const used = typeof source.used === "number" && Number.isFinite(source.used) ? source.used : null;
		const pct = used !== null && limit > 0 ? Math.min(100, used / limit * 100) : null;
		const tone = usageTone(pct ?? 0);
		const resetAt = typeof source.resetAt === "number" && Number.isFinite(source.resetAt) ? source.resetAt : null;
		const resetInSeconds = typeof source.resetInSeconds === "number" && Number.isFinite(source.resetInSeconds) ? source.resetInSeconds : null;
		const resetLine = resetAt !== null ? format(tt("quota.resetAt"), { time: clockLong(resetAt) }) : resetInSeconds !== null ? format(tt("quota.resetCountdown"), { minutes: Math.max(1, Math.round(resetInSeconds / 60)) }) : null;
		return h("div", { style: S.quota }, h("div", { style: S.quotaTop }, h("span", { style: S.quotaLabel }, label), period === "" || period === label ? null : h("span", { style: S.quotaReset }, period)), pct !== null ? h("div", { style: S.quotaRemaining }, `${pct.toFixed(1)}%`) : h("div", { style: S.quotaRemaining }, limit > 0 ? `${count(limit)}${unit === "" ? "" : ` ${unit}`}` : "—"), pct === null ? null : h("div", {
			style: S.bar,
			role: "progressbar",
			"aria-label": `${label} ${tt("quota.used")} ${pct.toFixed(1)}%`,
			"aria-valuenow": pct.toFixed(1),
			"aria-valuemin": 0,
			"aria-valuemax": 100
		}, h("div", { style: {
			...tone.fill,
			width: `${pct}%`
		} })), pct === null && resetLine === null ? null : h("div", { style: S.quotaFoot }, pct === null ? null : h("span", { style: S.quotaUsed }, `${tt("quota.used")} ${count(used)} / ${count(limit)}`), resetLine === null ? null : h("span", { style: {
			...S.muted,
			fontSize: 11
		} }, resetLine)));
	}
	/** One group's windows plus each card's distinguishing head label. */
	function windowGroups(windows, tt) {
		const placed = /* @__PURE__ */ new Set();
		const groups = WINDOW_GROUPS.map((group) => {
			const items = windows.map((window) => ({
				window,
				key: String(window?.key ?? "")
			})).filter(({ key }) => group.keys.includes(key)).map(({ key, window }) => {
				placed.add(key);
				const period = windowPeriod(window?.windowHours, tt);
				return {
					key,
					label: group.headByPeriod && period !== "" ? period : windowLabel(key, tt),
					window
				};
			});
			return {
				label: group.label,
				items
			};
		}).filter((group) => group.items.length > 0);
		const rest = windows.map((window) => ({
			window,
			key: String(window?.key ?? "")
		})).filter(({ key }) => !placed.has(key)).map(({ key, window }) => ({
			key,
			label: windowLabel(key, tt),
			window
		}));
		if (rest.length > 0) groups.push({
			label: "",
			items: rest
		});
		return groups;
	}
	/**
	* The reader's own plan: its identity and the four windows it caps.
	*
	* The plan catalogue (the other tiers) is a separate concern — "what would
	* upgrading buy?" — and lives in its own section below, so the open card is
	* purely about the reader's current plan.
	*/
	function PlanCard({ quota, tt }) {
		const plan = quota?.plan ?? null;
		const windows = Array.isArray(quota?.windows) ? quota.windows : [];
		if (plan === null && windows.length === 0) return h("div", { style: S.empty }, tt("quota.none"));
		return h("div", null, plan === null ? h("div", { style: S.empty }, tt("quota.planUnknown")) : h("div", { style: S.cardHead }, h("span", { style: S.poolName }, plan.displayName || plan.name || tt("quota.planUnknown")), plan.billingCycle ? h("span", { style: S.chip }, cycleLabel(plan.billingCycle, tt)) : null, plan.priceMinor !== void 0 && plan.priceMinor > 0 ? h("span", { style: S.grantChip }, `${money(plan.priceMinor, plan.currency)}${plan.billingCycle === "yearly" ? tt("quota.perYear") : tt("quota.perMonth")}`) : null, h("span", { style: S.spacer }), quota?.expiresAt ? h("span", { style: S.quotaReset }, format(tt("quota.expires"), { time: clockLong(quota.expiresAt) })) : null), windows.length > 0 ? h("div", { style: S.pools }, windowGroups(windows, tt).map((group) => h("div", {
			key: group.label || "_rest",
			style: S.pool
		}, group.label === "" ? null : h("div", { style: S.poolHead }, tt(group.label)), h("div", { style: S.quotas }, group.items.map((item) => h(QuotaWindowCard, {
			key: item.key,
			label: item.label,
			window: item.window,
			tt
		})))))) : null);
	}
	/**
	* The public plan catalogue — what the other tiers would allow.
	*
	* Rendered inside its own section (not folded into the reader's plan card),
	* so the reader's own numbers stay uncluttered and the "is upgrading worth it"
	* question is one click away without crowding the plan identity.
	*
	* Returns `null` when no catalogue arrived, so the section can be hidden
	* entirely rather than showing an empty card.
	*/
	function CatalogueCard({ plans, tt }) {
		const catalogue = Array.isArray(plans) ? plans : [];
		if (catalogue.length === 0) return null;
		return h("div", null, catalogue.map((entry) => {
			const limits = entry.limits ?? {};
			const windowHours = Number(limits.requestsWindowH);
			const parts = [
				limits.requests5h !== void 0 && limits.requests5h > 0 ? `${count(limits.requests5h)}${tt("quota.unit.requests")}${windowHours > 0 ? ` / ${windowHours}h` : ""}` : "",
				limits.requestsWeekly !== void 0 && limits.requestsWeekly > 0 ? `${count(limits.requestsWeekly)}${tt("quota.unit.requests")} / ${tt("quota.perWeek")}` : "",
				limits.imagesDaily !== void 0 && limits.imagesDaily > 0 ? `${count(limits.imagesDaily)}${tt("quota.unit.images")} / ${tt("quota.perDay")}` : ""
			].filter((part) => part !== "");
			return h("div", {
				key: entry.uuid || String(entry.planId),
				style: S.catalogueRow
			}, h("span", { style: S.catalogueName }, entry.displayName || entry.name || ""), h("span", { style: S.muted }, cycleLabel(entry.billingCycle, tt)), entry.priceMinor !== void 0 && entry.priceMinor > 0 ? h("span", { style: S.muted }, money(entry.priceMinor, entry.currency)) : null, h("span", { style: S.catalogueLimits }, parts.join(" · ")));
		}));
	}
	/**
	* The consumption figures for one period, as a row of metric cells.
	*
	* `label` names the period ("account total" vs "last N days") because the two
	* blocks use the SAME figures with different meanings, and an unlabelled row
	* would let the reader take a lifetime total for a window total. `activeDays`
	* is only present on the account row — the series has no such field — and an
	* absent cell is simply not drawn rather than shown as 0.
	*/
	function UsageTotals({ totals, label, tt }) {
		const source = totals ?? null;
		if (source === null) return h("div", { style: S.empty }, format(tt("quota.usageMissing"), { label }));
		const cells = [
			{
				key: "requests",
				label: tt("quota.total.requests"),
				value: source.totalRequests
			},
			{
				key: "tokens",
				label: tt("quota.total.tokens"),
				value: source.totalTokens
			},
			{
				key: "images",
				label: tt("quota.total.images"),
				value: source.totalImages
			},
			{
				key: "video",
				label: tt("quota.total.video"),
				value: source.totalVideoSeconds
			},
			...typeof source.activeDays === "number" ? [{
				key: "days",
				label: tt("quota.total.activeDays"),
				value: source.activeDays
			}] : []
		];
		return h("div", null, h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginBottom: 8
		} }, label), h("div", { style: S.metricGrid }, cells.map((cell) => h("div", {
			key: cell.key,
			style: S.metric
		}, h("span", { style: S.metricLabel }, cell.label), h("span", { style: S.metricValue }, count(cell.value))))));
	}
	/**
	* Per-bucket consumption as a mini bar chart.
	*
	* The x axis is the platform's OWN bucket label, not a date this client
	* re-derives: the series endpoint takes dates and answers with whatever
	* granularity it chose, so re-formatting `bucket` would be the panel asserting
	* a granularity the platform never promised. Only the first and last labels are
	* printed — 30 daily bars cannot each carry a readable date, and every bar
	* carries its own `title` for the one the reader hovers.
	*
	* The bars are scaled to the LARGEST bucket, so the tallest always fills the
	* track; that answers "when was the heavy day", but the eye misreads a full
	* track as "at the limit", so the legend names the convention.
	*/
	function UsageChart({ usage, tt }) {
		const buckets = Array.isArray(usage?.buckets) ? usage.buckets : [];
		if (buckets.length === 0) return h("div", { style: S.empty }, tt("usage.none"));
		const values = buckets.map((bucket) => Math.max(0, Number(bucket?.requestCount) || 0));
		const max = Math.max(0, ...values);
		const first = String(buckets[0]?.bucket ?? "");
		const last = String(buckets[buckets.length - 1]?.bucket ?? "");
		return h("div", null, h("div", { style: S.trendHead }, h("span", { style: S.trendHeadLabel }, tt("usage.requests")), h("span", { style: {
			...S.trendHeadLabel,
			textAlign: "right"
		} }, tt("usage.perBucket"))), h("div", { style: S.usageBars }, buckets.map((bucket, index) => {
			const value = values[index];
			const pct = max > 0 ? (value ?? 0) / max * 100 : 0;
			const label = String(bucket?.bucket ?? "");
			return h("div", {
				key: `${label}-${index}`,
				style: S.usageBar,
				title: `${label}: ${count(value)} ${tt("quota.unit.requests")}`
			}, h("div", {
				style: {
					...S.usageBarFill,
					height: `${pct}%`
				},
				role: "progressbar",
				"aria-label": `${label} ${count(value)}`,
				"aria-valuenow": Math.round(pct),
				"aria-valuemin": 0,
				"aria-valuemax": 100
			}));
		})), h("div", { style: S.usageAxis }, h("span", null, first), h("span", null, last)), h("div", { style: S.trendLegend }, tt("usage.legend")));
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
	var WINDOW_GROUPS;
	var init_cards = __esmMin((() => {
		init_format();
		init_runtime();
		init_styles();
		WINDOW_GROUPS = [{
			label: "quota.group.requests",
			keys: ["requests5h", "requestsWeekly"],
			headByPeriod: true
		}, {
			label: "quota.group.media",
			keys: ["imagesDaily", "videoDaily"],
			headByPeriod: false
		}];
	}));

//#endregion
//#region src/client/wire.ts
	var AGNESCODE_ERROR_NOT_CONFIGURED;
	var init_wire = __esmMin((() => {
		AGNESCODE_ERROR_NOT_CONFIGURED = "not_configured";
	}));

//#endregion
//#region src/client/agnescode-tab.ts
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
	function agnescodeView(state, error) {
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
	function AgnescodeTab({ tt, onStatus }) {
		const [state, setState] = useState(null);
		const [error, setError] = useState(null);
		const [updatedAt, setUpdatedAt] = useState(0);
		const [harvestBusy, setHarvestBusy] = useState(false);
		const [note, setNote] = useState(null);
		const alive = useRef(true);
		const generation = useRef(0);
		const inFlight = useRef(null);
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
				if (!isCurrent()) return;
				if (!response.ok) {
					setError(`HTTP ${response.status}`);
					return;
				}
				const body = await response.json().catch(() => null);
				if (!isCurrent()) return;
				if (body === null || body.ok === false) {
					setError(typeof body?.error === "string" && body.error !== "" ? body.error : "no answer");
					return;
				}
				setState(body);
				setError(null);
				setUpdatedAt(Date.now());
			} catch {
				if (!isCurrent()) return;
				setError("unable to reach the Host");
			}
		}, []);
		useEffect(() => {
			alive.current = true;
			load();
			const timer = setInterval(() => {
				if (alive.current) load();
			}, AGNESCODE_POLL_MS);
			return () => {
				alive.current = false;
				generation.current += 1;
				inFlight.current?.abort?.();
				clearInterval(timer);
			};
		}, [load]);
		useEffect(() => {
			onStatus?.({
				updatedAt,
				refresh: () => void load()
			});
		}, [
			onStatus,
			updatedAt,
			load
		]);
		const toggle = useCallback(async (enabled) => {
			setNote(null);
			try {
				const body = await postJsonOrThrow(AGNESCODE_PATH, {
					action: "switch",
					enabled
				});
				if (alive.current) setState((current) => current ? {
					...current,
					enabled: body.enabled === true,
					providerRegistered: body.providerRegistered === true
				} : current);
			} catch (why) {
				if (alive.current) setNote(format(tt("agnescode.switchError"), { error: why instanceof Error ? why.message : String(why) }));
			}
		}, [tt]);
		const harvest = useCallback(async () => {
			setHarvestBusy(true);
			setNote(null);
			try {
				const body = await postJson(AGNESCODE_PATH, { action: "harvest" });
				if (alive.current) {
					const harvestBlock = body?.harvest;
					const attempts = Array.isArray(harvestBlock?.attempts) ? harvestBlock.attempts : [];
					setState((current) => current ? {
						...current,
						harvest: {
							ok: body?.ok === true,
							attempts
						}
					} : current);
					if (body?.ok === true) setNote(tt("agnescode.harvestOk"));
					else setNote(tt("agnescode.harvestFail"));
					load();
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
				if (alive.current) load();
			} catch (why) {
				if (alive.current) setNote(format(tt("agnescode.error"), { error: why instanceof Error ? why.message : String(why) }));
			}
		}, [load, tt]);
		const saveModels = useCallback(async (ids) => {
			await postJsonOrThrow(AGNESCODE_PATH, {
				action: "saveModels",
				enabledModelIds: ids
			});
			if (alive.current) load();
		}, [load]);
		const enabled = state?.enabled === true;
		const view = agnescodeView(state, error);
		const loggedIn = view.linked;
		const models = Array.isArray(state?.models) ? state.models : [];
		const attempts = Array.isArray(state?.harvest?.attempts) ? state.harvest.attempts : [];
		const balance = state?.balance ?? null;
		return h("div", null, h("div", { style: {
			fontSize: 12,
			color: "var(--dsw-alias-label-secondary)",
			marginBottom: 12
		} }, tt("agnescode.desc")), view.showError ? h("div", {
			style: S.formError,
			role: "alert"
		}, format(tt("agnescode.error"), { error })) : null, h("label", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			margin: "0 0 12px",
			cursor: harvestBusy ? "wait" : "pointer"
		} }, h("input", {
			type: "checkbox",
			checked: enabled,
			disabled: harvestBusy,
			onChange: () => void toggle(!enabled)
		}), h("span", { style: {
			fontSize: 12,
			color: "var(--dsw-alias-label-secondary)"
		} }, tt("agnescode.switch"))), state !== null ? state.providerError === "not_configured" && loggedIn ? h("div", {
			style: {
				...S.muted,
				fontSize: 12
			},
			role: "status"
		}, tt("agnescode.errNotConfigured")) : state.providerError !== void 0 && state.providerError !== "" && state.providerError !== "not_configured" ? h("div", {
			style: S.formError,
			role: "alert"
		}, state.providerError) : enabled && !loggedIn ? h("div", { style: {
			...S.muted,
			fontSize: 12
		} }, tt("agnescode.awaitingHarvest")) : state.providerRegistered === true ? null : h("div", { style: {
			...S.muted,
			fontSize: 12
		} }, tt("agnescode.unregistered")) : null, view.credentialCard ? h("div", { style: {
			...S.card,
			marginTop: 4
		} }, loggedIn ? h("div", null, h("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: 12,
			flexWrap: "wrap"
		} }, h("div", {
			style: { fontSize: 13 },
			role: "status"
		}, format(tt("agnescode.loggedIn"), { nick: String(state?.nickname ?? "") })), h("span", { style: S.spacer }), h("button", {
			type: "button",
			style: S.button,
			onClick: () => void harvest(),
			disabled: harvestBusy
		}, harvestBusy ? tt("agnescode.harvesting") : tt("agnescode.harvest")), h("button", {
			type: "button",
			style: S.button,
			onClick: () => void logout()
		}, tt("agnescode.logout"))), state?.bffBase !== void 0 && state?.bffBase !== "" ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 6,
			wordBreak: "break-all"
		} }, format(tt("agnescode.bffBase"), { base: state.bffBase })) : null, typeof state?.expiresAtMs === "number" && state.expiresAtMs > 0 ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 2
		} }, format(tt("agnescode.expiresAt"), { time: clockLong(state.expiresAtMs) })) : null) : h("div", null, h("div", { style: { fontSize: 13 } }, tt("agnescode.notLogged")), h("button", {
			type: "button",
			style: {
				...S.button,
				marginTop: 8
			},
			onClick: () => void harvest(),
			disabled: harvestBusy
		}, harvestBusy ? tt("agnescode.harvesting") : tt("agnescode.harvest")))) : null, attempts.length > 0 ? h("div", {
			style: {
				...S.muted,
				fontSize: 12,
				marginTop: 8
			},
			role: "list"
		}, attempts.map((attempt, index) => h("div", {
			key: `${String(attempt?.file ?? index)}-${index}`,
			role: "listitem",
			style: { marginBottom: 2 }
		}, h("span", { style: { color: attempt?.tier === "ok" ? "inherit" : "var(--dsw-alias-label-secondary)" } }, `[${tt(`agnescode.tier.${attempt?.tier}`)}] ${String(attempt?.file ?? "")}${attempt?.detail ? ` — ${attempt.detail}` : ""}`)))) : null, note !== null ? h("div", {
			style: {
				...S.formNote,
				fontSize: 12,
				marginTop: 8
			},
			role: "status"
		}, note) : null, loggedIn ? h("div", { style: { marginTop: 12 } }, balance !== null ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginBottom: 8
		} }, format(tt("agnescode.balanceLine"), {
			balance: count(balance.totalBalance ?? 0),
			timeSensitive: count(balance.timeSensitiveBalance ?? 0),
			permanent: count(balance.permanentBalance ?? 0)
		})) : null, models.length > 0 ? h(AgnescodeModelPicker, {
			models,
			hostIds: state?.enabledModelIds,
			registered: state?.providerRegistered === true,
			tt,
			onSave: saveModels
		}) : null) : null, h("a", {
			href: AGNESCODE_SITE_URL,
			target: "_blank",
			rel: "noreferrer",
			style: {
				display: "inline-block",
				marginTop: 12,
				paddingTop: 10,
				borderTop: "1px solid var(--dsw-alias-border-l1)",
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				textDecoration: "underline",
				cursor: "pointer"
			}
		}, tt("agnescode.downloadCta")));
	}
	/**
	* The model roster the AgnesCode adapter offers, as a hook-free component.
	*
	* Split out of {@link AgnescodeTab} for the same reason the other rosters are:
	* the tab's data is internal state, so the render suite can only ever reach
	* the unlinked frame — a roster inlined there is unassertable. The row is the
	* SAME two-line shape as the sibling rosters (head line over an indented
	* parameter line), sharing `S.modelRow`'s contract — and, since the panel can
	* now curate this provider, the SAME checkbox. What it carries instead
	* of a rate chip is the `memberOnly` badge — the platform-declared
	* gating fact this provider HAS; no multiplier chip exists here because the
	* upstream declares no per-model rate (billing is the credit pool), and
	* inventing one would libel the roster.
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
	function AgnescodeRoster({ models, registered, enabledIds, busy, hint, tools, emptyNote, tt, onToggle }) {
		const rows = Array.isArray(models) ? models : [];
		return h("div", { style: S.modelPanel }, h("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: 8,
			flexWrap: "wrap",
			marginBottom: 6
		} }, h("div", { style: {
			...S.muted,
			fontSize: 12,
			fontWeight: 600
		} }, format(tt("agnescode.models"), { count: count(rows.length) })), h("span", { style: S.spacer }), registered === true ? h("span", { style: {
			...S.modelBadge,
			color: "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))"
		} }, tt("agnescode.registeredPill")) : null), typeof hint === "string" && hint !== "" ? h("div", { style: {
			...S.muted,
			fontSize: 11,
			marginBottom: 6
		} }, hint) : null, tools !== void 0 ? tools : null, rows.length === 0 && typeof emptyNote === "string" && emptyNote !== "" ? h("p", { style: S.empty }, emptyNote) : h("ul", {
			style: S.modelList,
			role: "list"
		}, rows.map((row) => {
			const id = String(row?.id ?? "");
			const label = String(row?.name ?? id);
			const on = modelIsOn(enabledIds, id);
			const meta = [typeof row?.contextWindow === "number" && row.contextWindow > 0 ? format(tt("llm.contextBadge"), { ctx: tokenSize(row.contextWindow) }) : null, typeof row?.maxOutputLength === "number" && row.maxOutputLength > 0 ? format(tt("llm.metaOutput"), { out: tokenSize(row.maxOutputLength) }) : null].filter(Boolean).join(" · ");
			return h("li", {
				key: id,
				style: {
					...S.modelRow,
					...on ? {} : S.modelRowOff
				}
			}, h("div", { style: S.modelRowHead }, h("label", { style: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flex: "1 1 auto",
				minWidth: 0,
				cursor: busy === true ? "default" : "pointer"
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
			}, label)), h("span", { style: S.spacer }), row.memberOnly === true ? h("span", { style: S.modelBadge }, tt("agnescode.memberOnly")) : null), meta === "" ? null : h("div", { style: S.modelMeta }, meta));
		})));
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
	function AgnescodeModelPicker({ models, hostIds, registered, tt, onSave }) {
		const rows = Array.isArray(models) ? models : [];
		const host = Array.isArray(hostIds) ? hostIds.filter((id) => typeof id === "string") : [];
		const { ids, busy: saving, setBusy: setSaving, query, setQuery, setSavedKey, notice, setNotice, idsKey, dirty, justSaved, visible, tickedCount, bulk, toggle, discard } = useRosterDraft(rows, host);
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
		const tools = h("div", { style: S.rosterTools }, h("input", {
			type: "search",
			style: {
				...S.input,
				flex: "1 1 200px",
				width: "auto"
			},
			value: query,
			placeholder: tt("llm.rosterSearchPlaceholder"),
			"aria-label": tt("llm.rosterSearchPlaceholder"),
			autoComplete: "off",
			name: "agnescode-model-search",
			disabled: saving,
			onChange: (event) => setQuery(event.target.value)
		}), h("span", {
			style: S.rosterCount,
			title: format(tt("llm.rosterCount"), {
				selected: tickedCount,
				total: visible.length
			})
		}, format(tt("llm.rosterCount"), {
			selected: tickedCount,
			total: visible.length
		})), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: saving === true || visible.length === 0,
			onClick: () => bulk(true)
		}, tt("llm.rosterAll")), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: saving === true || visible.length === 0,
			onClick: () => bulk(false)
		}, tt("llm.rosterNone")));
		return h("div", null, h(AgnescodeRoster, {
			models: visible,
			registered,
			enabledIds: ids,
			busy: saving,
			hint: tt("agnescode.rosterHint"),
			tools,
			emptyNote: tt("llm.rosterNoMatch"),
			tt,
			onToggle: toggle
		}), dirty ? h("div", { style: S.rosterFoot }, h("button", {
			type: "button",
			style: S.primary,
			disabled: saving === true,
			onClick: () => void save()
		}, saving ? tt("agnescode.rosterSaving") : tt("agnescode.rosterSave")), h("button", {
			type: "button",
			style: S.button,
			disabled: saving === true,
			onClick: discard
		}, tt("agnescode.rosterDiscard")), h("span", { style: {
			...S.muted,
			fontSize: 12
		} }, tt("agnescode.rosterUnsaved"))) : justSaved ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("agnescode.rosterSaved")) : null, notice !== null ? h("p", {
			style: S.formError,
			role: "alert"
		}, notice) : null);
	}
	var AGNESCODE_POLL_MS;
	var init_agnescode_tab = __esmMin((() => {
		init_const();
		init_format();
		init_http();
		init_models();
		init_roster_draft();
		init_runtime();
		init_styles();
		init_wire();
		AGNESCODE_POLL_MS = 6e4;
	}));

//#endregion
//#region src/client/panel-page.ts
/**
	* What the pinned bar owes the tab that is on screen.
	*
	* Module scope and pure so the Node-side suite drives the real decision
	* instead of scraping the JSX for it — the same reason `viewOf` lives outside
	* the component.
	*
	* The bar is a SHELL: it owns no page-wide reading. It used to be titled
	* 「积分面板」, stamp every tab with the snapshot's clock, and offer a refresh
	* that reloaded the snapshot no matter which tab was open — so on the
	* AgnesCode tab it claimed a freshness and a reload it never had. What it may
	* say per tab:
	*
	*   quota      the shared snapshot's stamp, the console-token chip, its stale
	*              warning, snapshot reload.
	*   api        the SAME snapshot (its `llm` block is what this tab renders),
	*              so the same stamp and reload — but NOT the chip: that token is
	*              the quota tab's credential, while this tab works off the stored
	*              API key.
	*   agnescode  its own route, its own cadence (60 s), so its own stamp and its
	*              own reload. No chip: this tab's credential is the desktop App's
	*              session JWT, which has NO refresh endpoint — a "token renews
	*              itself" pill here would state the opposite of the truth.
	*/
	function barPlan(tab, hasSnapshot, hasAgnescode) {
		if (tab === "agnescode") return {
			stamp: hasAgnescode ? "agnescode" : null,
			authChip: false,
			staleWarning: false,
			refresh: "agnescode"
		};
		return {
			stamp: hasSnapshot ? "snapshot" : null,
			authChip: tab === "quota",
			staleWarning: hasSnapshot,
			refresh: "snapshot"
		};
	}
	function PanelPage({ onClose, tt, localeSubscribe }) {
		const [data, setData] = useState(null);
		const [error, setError] = useState(null);
		const [loadedOnce, setLoadedOnce] = useState(false);
		const [updatedAt, setUpdatedAt] = useState(0);
		const [, setLocaleRevision] = useState(0);
		const [openSections, setOpenSections] = useState({
			quota: true,
			catalogue: false,
			usage: true,
			account: false,
			provider: true,
			draw: true,
			video: true,
			llm: false
		});
		const [activeTab, setActiveTab] = useState("quota");
		const [tabStatus, setTabStatus] = useState(null);
		const publishTabStatus = useCallback((status) => setTabStatus(status), []);
		useEffect(() => {
			if (typeof localeSubscribe !== "function") return void 0;
			return localeSubscribe(() => setLocaleRevision((revision) => revision + 1));
		}, [localeSubscribe]);
		const [cadenceMs, setCadenceMs] = useState(null);
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
					signal: controller ? controller.signal : null
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
				if (typeof stated === "number" && Number.isFinite(stated) && stated > 0) setCadenceMs(Math.floor(stated) * 1e3);
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
				if (timer === null && cadenceMs !== null) timer = setInterval(run, cadenceMs);
			};
			const stop = () => {
				if (timer !== null) {
					clearInterval(timer);
					timer = null;
				}
			};
			if (cadenceMs === null) {
				run();
				return () => {
					alive = false;
					stop();
				};
			}
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
				if (typeof document !== "undefined" && typeof document.addEventListener === "function") document.removeEventListener("visibilitychange", onVisibility);
			};
		}, [load, cadenceMs]);
		const openedAccountOnce = useRef(false);
		useEffect(() => {
			if (openedAccountOnce.current) return;
			if (data?.quota?.consoleConnected !== false) return;
			openedAccountOnce.current = true;
			setOpenSections((current) => ({
				...current,
				account: true
			}));
		}, [data]);
		const quota = data?.quota;
		const usage = data?.usage;
		const { failure, auth, needsSetup, guidance, shapeWarnings } = viewOf(data, error, tt);
		const showSetupForm = needsSetup && loadedOnce;
		const authChip = auth === null ? null : auth.error || !auth.configured ? h("span", {
			style: S.chip,
			title: auth.error || guidance || ""
		}, tt("auth.needsLogin")) : h("span", { style: S.chip }, tt("auth.selfRenew"));
		const authManage = shouldShowAccountManagement(auth);
		const tabBar = h("div", {
			style: S.tabBar,
			role: "tablist"
		}, h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "quota",
			style: {
				...S.tab,
				...activeTab === "quota" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("quota")
		}, tt("tab.quota")), h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "api",
			style: {
				...S.tab,
				...activeTab === "api" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("api")
		}, tt("tab.api")), h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "agnescode",
			style: {
				...S.tab,
				...activeTab === "agnescode" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("agnescode")
		}, tt("tab.agnescode")));
		const quotaPlaceholder = showSetupForm ? h(AccountForm, {
			auth,
			onDone: () => void load(),
			tt,
			bare: true,
			hasSnapshot: false
		}) : h("div", { style: S.empty }, failure === null ? tt("panel.loading") : h("div", null, h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message }))));
		const body = h("div", null, tabBar, activeTab === "quota" && shapeWarnings.length > 0 ? h("div", {
			style: S.formError,
			role: "status"
		}, format(tt("panel.shapeDrift"), { detail: shapeWarnings.map((entry) => `${tt("shape.api")} ${entry.api} ${tt("shape.missing")} ${entry.missing}`).join("; ") })) : null, activeTab === "quota" ? data === null ? quotaPlaceholder : h("div", null, h(SectionCard, {
			title: tt("section.quota"),
			open: openSections.quota,
			onToggle: () => toggleSection("quota"),
			tt
		}, quota?.consoleConnected === false ? h("div", {
			style: {
				...S.formNote,
				marginTop: 0,
				marginBottom: 12
			},
			role: "status"
		}, h("div", null, guidance ?? tt("quota.consoleOffline")), needsSetup ? h("div", { style: { marginTop: 6 } }, format(tt("quota.consoleOfflineHint"), { section: tt("auth.title") })) : null) : quota?.error ? h("div", {
			style: {
				...S.formNote,
				marginTop: 0,
				marginBottom: 12
			},
			role: "status"
		}, format(tt("quota.error"), {
			source: String(quota.error.source ?? ""),
			message: String(quota.error.message ?? "")
		})) : null, h(PlanCard, {
			quota,
			tt
		}), Array.isArray(data.visionModels) && data.visionModels.length > 0 ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 10
		} }, format(tt("pool.vision"), { models: data.visionModels.map((entry) => entry.id).join(" · ") + (data.visionModels.every((entry) => entry.source === "name") ? tt("pool.visionInferred") : "") })) : null), Array.isArray(quota?.plans) && quota.plans.length > 0 ? h(SectionCard, {
			title: format(tt("section.catalogue"), { count: quota.plans.length }),
			open: openSections.catalogue,
			onToggle: () => toggleSection("catalogue"),
			tt
		}, h(CatalogueCard, {
			plans: quota.plans,
			tt
		})) : null, h(SectionCard, {
			title: tt("section.usage"),
			open: openSections.usage,
			onToggle: () => toggleSection("usage"),
			tt
		}, h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginBottom: 12
		} }, tt("quota.windowNote")), h(UsageTotals, {
			totals: quota?.totals,
			label: tt("quota.accountTotals"),
			tt
		}), h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 16,
			marginBottom: 8
		} }, typeof usage?.days === "number" && usage.days > 0 ? format(tt("usage.period"), { days: usage.days }) : tt("usage.periodUnknown")), h(UsageChart, {
			usage,
			tt
		})), h("div", { style: S.note }, typeof data?.cacheSeconds === "number" ? format(tt("note"), { cache: data.cacheSeconds }) : tt("note.noCache")), authManage ? h(SectionCard, {
			title: tt("auth.title"),
			open: openSections.account,
			onToggle: () => toggleSection("account"),
			tt
		}, h(AccountForm, {
			auth,
			onDone: () => void load(),
			tt,
			bare: true,
			hasSnapshot: true
		})) : null) : activeTab === "agnescode" ? h("div", { style: { marginTop: 22 } }, h(SectionCard, {
			title: tt("agnescode.title"),
			open: true,
			onToggle: () => {},
			tt
		}, h(AgnescodeTab, {
			tt,
			onStatus: publishTabStatus
		}))) : h("div", null, h(SectionCard, {
			title: tt("llm.providerTitle"),
			open: openSections.provider,
			onToggle: () => toggleSection("provider"),
			tt
		}, h(ProviderForm, {
			llm: data?.llm ?? null,
			onDone: () => void load(),
			tt
		})), h(SectionCard, {
			title: tt("draw.title"),
			open: openSections.draw,
			onToggle: () => toggleSection("draw"),
			tt
		}, h(DrawSwitch, {
			llm: data?.llm ?? null,
			onDone: () => void load(),
			tt
		})), h(SectionCard, {
			title: tt("video.title"),
			open: openSections.video,
			onToggle: () => toggleSection("video"),
			tt
		}, h(VideoSwitch, {
			llm: data?.llm ?? null,
			onDone: () => void load(),
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
		})), h(RpmNote, { tt })));
		const plan = barPlan(activeTab, data !== null, tabStatus !== null && tabStatus.updatedAt > 0);
		const stamp = plan.stamp === "snapshot" ? data ? format(tt("panel.updated"), { time: clock(updatedAt / 1e3) }) : "" : plan.stamp === "agnescode" ? format(tt("panel.updated"), { time: clock((tabStatus?.updatedAt ?? 0) / 1e3) }) : "";
		const refresh = plan.refresh === "agnescode" ? tabStatus?.refresh ?? null : () => void load();
		return h("div", {
			style: S.page,
			"data-dsh-plugin": PANEL_ID
		}, h("div", { style: S.headerBar }, h("div", { style: S.header }, h("span", { style: S.updated }, stamp), plan.authChip ? authChip : null, h("span", { style: S.spacer }), plan.staleWarning && failure && data ? h("span", {
			style: S.error,
			role: "status",
			title: failure.message
		}, format(tt("panel.error"), { error: failure.message })) : null, h("button", {
			type: "button",
			style: refresh === null ? {
				...S.button,
				...S.primaryBusy
			} : S.button,
			disabled: refresh === null,
			onClick: () => refresh?.()
		}, tt("panel.refresh")), onClose ? h("button", {
			type: "button",
			style: S.button,
			onClick: () => onClose()
		}, tt("panel.back")) : null)), h("div", { style: S.scroll }, h("div", { style: S.content }, body)));
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
		init_provider_controls();
		init_agnescode_tab();
	}));

//#endregion
//#region src/client/apply.ts
/**
	* Register the dictionaries and the plugin config card.
	*
	* The card is rendered inside the Plugins page by the Host's
	* `renderSlot("plugins.bundle.config", …)` call. No `onClose` is passed —
	* the Plugins page owns navigation; the card has no close button.
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
		}, `${NS}: dictionaries`);
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
		const disposers = [];
		try {
			disposers.push(ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: NS,
				locale: NS,
				inject: () => ({
					tt,
					localeSubscribe: ctx.locale.subscribe.bind(ctx.locale)
				})
			}, PanelPage)));
		} catch (error) {
			console.warn(`[${NS}] config card registration failed:`, error);
		}
		ctx.effect(() => () => {
			for (const dispose of disposers.splice(0)) try {
				dispose();
			} catch {}
		}, `${NS}: ui mounts`);
	}
	var inject;
	var init_apply = __esmMin((() => {
		init_const();
		init_i18n();
		init_panel_page();
		inject = ["slots", "locale"];
	}));

//#endregion
//#region src/client/index.ts
	var require_client = /* @__PURE__ */ __commonJSMin(((exports, module) => {
		init_apply();
		init_const();
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
		init_agnescode_tab();
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
				barPlan,
				agnescodeView,
				dictionaries: Object.freeze({
					zh,
					en
				}),
				tables: Object.freeze({
					GUIDANCE_BY_CODE,
					FORM_EXCLUDED_CODES,
					REFUSAL_TEXT,
					CLIENT_CODE,
					COOLDOWN_TEXT
				}),
				styles: S,
				helpers: Object.freeze({
					clock,
					clockLong,
					count,
					format,
					tokenSize,
					HIDE_ALL_MODELS,
					modelIsOn,
					rosterMatches,
					allowListFor,
					toggleModelIn,
					setAllModelsIn,
					bulkModelsIn
				}),
				components: Object.freeze({
					PlanCard,
					CatalogueCard,
					QuotaWindowCard,
					UsageTotals,
					UsageChart,
					SectionCard,
					AccountForm,
					ApiKeyForm,
					ProviderForm,
					ProviderStatus,
					ProviderRegStatus,
					ProviderSwitch,
					DrawSwitch,
					VideoSwitch,
					RpmNote,
					ModelRoster,
					ModelPicker,
					PanelPage,
					AgnescodeTab,
					AgnescodeRoster,
					AgnescodeModelPicker
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
			id: PANEL_ID,
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