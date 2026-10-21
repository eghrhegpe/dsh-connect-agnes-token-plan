# 排障入口（按界面原文查）

当手上只有一句话（面板上的一句话、快照里的一个字段、日志里的一行），没有模块名时，从本文件进。

**本文件不解释机制**，只做一件事：把那句话翻译成「属于哪一层、下一步看哪份文档的哪一节」。机制细节的唯一定义处是 [AUTH.md](./AUTH.md)（登录/节流）、[AGNES-API.md](./AGNES-API.md)（接口事实）、[API.md](./API.md)（路由与快照结构）、[PITFALLS.md](./PITFALLS.md)（现象→根因→修法）。这里复制它们的表，只会多出一份会分叉的副本（`docs.test.mjs` 的 `TABLES` 门禁也是这样要求的）。

怎么用：

1. 面板文案是**原文**（取自 `src/client/i18n.ts` 的 `zh` 字典，键集真源；英文界面同一键的值不同，但键一样），方括号里是文案键——按文案键 grep 能直接定位渲染处与判定条件，比按中文句子搜更稳。
2. 先看 §1（面板上的话）；面板整块是空的、或者只有接口没有界面，看 §2。
3. §3 是「看着像坏了、其实是设计」的清单。**这里的东西不要去修**。

---

## 1. 面板上的话 → 下一步

### 1.1 整块读不出来 / 配置类

| 界面原文 | 含义 | 第一动作 | 细节 |
|---|---|---|---|
| 插件配置有误：{error} [`panel.configError` / 快照码 `config_error`] | 挂载期校验失败，几乎只有「端点字段不是合法 http(s) 绝对地址」一种 | 对照 [SETUP.md](./SETUP.md) §3 的配置表检查 `cordis.patch.yml` 的端点类字段，改后重装 / 重载 Host | [SETUP.md](./SETUP.md) §3 |
| 读取失败：{error} [`panel.error`] | 快照路由本身失败，不是上游失败 | 到 **Host 终端 stdout** 与 `$DSH_HOME/logs/` 找同一时刻的堆栈——浏览器 F12 里没有 Host 半边 | [PITFALLS.md](./PITFALLS.md) §42 |
| Agnes 控制台暂时无法读取，通常下一次自动刷新即可恢复… [`panel.consoleTransient` / 快照码 `console_error`] | 传输层瞬时失败，设计上交给下一轮轮询 | 什么都不做，等一轮；连续出现才查网络与平台状态 | [ARCHITECTURE.md](./ARCHITECTURE.md) §5（软失败不变量） |
| Agnes 控制台未连接，本页的额度与用量都读不到。 [`quota.consoleOffline`] | `overview` 源失败（软降级），其余源的数据仍可能在 | 按提示到本页下方卡片登录；不要当成插件坏了 | [ADR.md](./ADR.md) ADR-007 |
| 读取 {source} 失败：{message} [`quota.error`] | **单个**额度源（series / subscription / plans / overview）降级，互不牵连 | 先看 `{message}` 里平台自己的话；只有五个源同时失败才是平台级问题 | [AGNES-API.md](./AGNES-API.md) §2、[ARCHITECTURE.md](./ARCHITECTURE.md) §5 |
| 上游返回的结构可能有变：{detail} [`panel.shapeDrift`] | 控制台响应结构与预期不符（字段改名等）——**接口变更的第一信号** | 对照 [AGNES-API.md](./AGNES-API.md) §2 核字段，别当成「暂无数据」；持续出现记进 PITFALLS | [AGNES-API.md](./AGNES-API.md) §2 |
| 暂无额度数据。 [`quota.none`] | 读到了响应但没有可用窗口，通常是没登录或账号无额度 | 先确认登录态（§1.2），再看控制台网页端是否同样为空 | [AGNES-API.md](./AGNES-API.md) §5 |
| 未能识别当前套餐——控制台没有返回可匹配的套餐信息… [`quota.planUnknown`] | 订阅 payload 里没有可匹配的 uuid / 名称；**这是渲染文案键，不是快照信号字段** | 属正常显示：下方「套餐对比」是平台公开目录，不依赖登录 | [AGNES-API.md](./AGNES-API.md) §5 |

### 1.2 登录与账号类

| 界面原文 | 含义 | 第一动作 | 细节 |
|---|---|---|---|
| 需要重新登录 [`auth.needsLogin`] | 令牌被拒且环境里已无密码可自动重登 | 面板表单填一次账号密码 | [AUTH.md](./AUTH.md) §8 |
| 控制台令牌已失效…Host 会用已保存的账号重新登录一次… [`panel.jwtExpired`] | 一跳重登已触发（Agnes 不发 refresh token） | 等一轮刷新；反复出现按「重登没用」查 | [AUTH.md](./AUTH.md) §5、[PITFALLS.md](./PITFALLS.md) §46 |
| 令牌自动续期中 [`auth.selfRenew`] | 正常状态，不是告警 | 不用处理 | [AUTH.md](./AUTH.md) §5 |
| Host 已停止自动重试：上一次登录被拒… [`auth.parked`] | 凭据型拒绝，或自造退避次数用尽，已**停车**（`needsUserAction`） | 核对账号密码后手动登录；等倒计时不会有结果 | [AUTH.md](./AUTH.md) §7、[PITFALLS.md](./PITFALLS.md) §52 |
| 账号已被锁定。…期间面板不会自动重试。 [`auth.locked`] | 平台锁号；插件刻意不再敲门以免延长锁定 | 去控制台网页端确认账号状态，**别**在面板反复点登录 | [AUTH.md](./AUTH.md) §7 |
| 平台要求等待约 {minutes} 分钟后再试… [`auth.retryAfter`] | 平台声明了等待窗口，照单全收、不截短 | 等满窗口；期间任何手动重试都可能重新触发 | [AUTH.md](./AUTH.md) §7 |
| 需要额外验证（短信/图形验证码）… [`auth.verification`] | 自动化登录无法完成验证码 | 先在浏览器登录一次，再回面板 | [AUTH.md](./AUTH.md) §7 |
| 登录未完成：{reason} [`auth.failed`] | 分类器没认出这句话（兜底 `LOGIN_FAILED`） | 看 `{reason}` 原文与 `$DSH_HOME/logs/` 的 trace；这类形状值得记进 PITFALLS | [AUTH.md](./AUTH.md) §6、§8 |
| 注意：当前 Host 没有凭据服务… [`auth.ephemeral`] | 缺 `@deepseek-ai/dsh-credentials`，账号只在内存 | 接受「重启需重登」，或换带凭据服务的 Host | [SETUP.md](./SETUP.md) §1 |

### 1.3 推理 / 出图 / 视频 / AgnesCode 类

| 界面原文 | 含义 | 第一动作 | 细节 |
|---|---|---|---|
| 模型目录暂时读不到：{error}（额度与聊天不受影响） [`llm.catalogFailed`] | 没有 API Key → 目录没拉（`catalogAvailable: false`）或目录端点失败；**额度面板不受牵连** | 面板「API Key」卡保存 Key（免费版 `sk-` 或 Token Plan `cpk-`），或用户级 env 配 `AGNES_TOKEN_PLAN_API_KEY`；下一轮 poll 自动恢复，无需重启 | [AGNES-API.md](./AGNES-API.md) §7.1 |
| 提供方注册失败：{error} [`llm.error`] | 向 DSH 注册 provider 失败（Host 级动作） | 看 `{error}`；注册三件套与 descriptor 契约见 DSH-LLM-DEVELOP | [DSH-LLM-DEVELOP.md](./DSH-LLM-DEVELOP.md) |
| 额度耗尽 [`llm.rosterExhausted`] | 模型花名册侧标记，不等于 402/429 已发生 | 区分额度不足（402）与速率上限（429），后者等一分钟即可 | [AGNES-API.md](./AGNES-API.md)、[PITFALLS.md](./PITFALLS.md) §45 |
| 当前 API Key 目录里暂无出图模型；出图不可用。 [`draw.noCandidates`] | 目录里没识别出图模型（名称兜底也没命中） | 换有出图权限的 Key，或显式设 `drawModelId` | [SETUP.md](./SETUP.md) §3（`drawEnabled` / `drawModelId`） |
| 当前 API Key 目录里暂无视频模型；视频不可用。 [`video.noCandidates`] | 同上，视频侧 | 显式设 `videoModelId`（V2.0 / 2.5 家族均可） | [SETUP.md](./SETUP.md) §3、[AGNES-API.md](./AGNES-API.md) §7.5 |
| 未关联——请先在 AgnesCode 桌面端登录… [`agnescode.notLogged`] | 本插件不发起登录，只读桌面 App 的会话文件 | 桌面 App 里登录一次，再点「检测本机登录态」 | [SETUP.md](./SETUP.md) §3「AgnesCode 已知限制」 |
| 本机登录态采集目前仅支持 Windows… [`agnescode.harvestWindowsOnly`] | 采集侧只有 DPAPI 一条路 | 非 Windows 用「扫码登录」 | [AGNESCODE-SCAN-LOGIN.md](./AGNESCODE-SCAN-LOGIN.md) |
| 扫码登录失败：{error} [`agnescode.loginFail`] | 设备流换 token 失败 | 看 `{error}`；换 token 端点实测记录在扫码登录文档 | [AGNESCODE-SCAN-LOGIN.md](./AGNESCODE-SCAN-LOGIN.md) |

---

## 2. 快照 / 日志里的信号（没有界面文案）

| 信号 | 含义 | 第一动作 | 细节 |
|---|---|---|---|
| 快照**没有 `auth` 字段**，只有 `totals` / `recent` | 跑的是旧代码（Host 半边只在启动时加载一次） | 完全退出 DSH（**含托盘**）再启动 | [SETUP.md](./SETUP.md) §4 |
| `shapeWarnings` 非空 | 控制台返回结构与预期不符（字段改名等）——**接口变更的第一信号** | 对照接口文档核字段，别当成「暂无数据」 | [AGNES-API.md](./AGNES-API.md) §2 |
| `config_error`（面板顶部） | 挂载期配置错误 | 同 §1.1 第一行 | [SETUP.md](./SETUP.md) §3 |
| Host 日志 `unknown config key(s) ignored: …` | patch 里有拼错的键（**不**升为 `config_error`，刻意如此） | 改掉拼写；遗留键可不理，但别指望它生效 | [SETUP.md](./SETUP.md) §3 |
| 浏览器 F12 里没有任何插件报错 | 两半进程：Host 报错在 `dsh web` 终端 stdout 与 `$DSH_HOME/logs/` | 换地方看，不是「没有日志」 | [PITFALLS.md](./PITFALLS.md) §42 |
| 桌面上看着改了、实际没生效 | 桌面端是安装副本、web 是 symlink；两者还是不同 profile、不同端口 | 先确认你在看哪个进程，再查三层装载 | [PITFALLS.md](./PITFALLS.md) §22、[SETUP.md](./SETUP.md) §4 注记 |

---

## 3. 看着像坏了，其实是设计

先读这一节，能省掉一半的「修」。这些行为都有明确理由，**不要当成缺陷去打补丁**：

- **没有「登出」按钮**：能停的是 provider 开关，不是令牌。「删除已存 JWT」是隐私动作，被刻意移出日常操作；真正吊销只能在桌面 App 里登出 / 改密码。见 [SETUP.md](./SETUP.md) §3。
- **「可看图」清单为空**：Agnes 目录条目**不带** `input_modalities`（实测只有 `id`/`object`/`created`/`owned_by`/`supported_endpoint_types` 五个字段），`identifyVisionModel` 只能读目录 → 恒 false。这是**「读不到」而不是「没有」**——官方文档（`AGNES-API-docs/`）明说 `agnes-3.0-flash` / `agnes-2.5-pro` / `agnes-2.5-flash` 支持「文本 + 图像 URL 输入」，所以空清单不能当作「真没有可看图模型」的证据。见 [AGNES-API.md](./AGNES-API.md) §7.1。
- **「可看图」整行消失**：不是被裁掉，是没有 API Key → 目录没拉 → 视觉清单无从生成。见 §1.3 第一行。
- **改了设置不重启也生效，但工具挂载要等下次启动**：开关与勾选走热生效；agent 工具没有 unregister 语义，挂载 / 缺席只发生在 Host 启动时。见 [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md)。
- **拼错的配置键只记日志、不报错**：老 patch 里的历史键不该把面板打成配置错误。见 [SETUP.md](./SETUP.md) §3。
- **429 与额度耗尽不是一件事**：402 是额度不足，429 多为速率上限（订阅用尽也可能回 429）。见 [AGNES-API.md](./AGNES-API.md)。

---

## 4. 为什么这份文件没有「症状码」

兄弟仓 `dsh-connect-sensenova-token-plan` 的排障入口是按**稳定症状码**组织的（`SYMPTOM` / `SYMPTOM_HINT` + `doctor.report.symptoms`，并由 `test/doctor.test.mjs` 双向钉住文档锚点）。本仓目前只有下半层：`CODE`（平台失败码，进 `body.code`）与 `doctor` 的 scope 事实（`providerPanel` / `drawPanel` / `unreadable` / `writable`），**没有从「用户现象」到「失败码」的映射层**。

所以本文件按**界面原文 + 文案键**索引，不发明一套本仓代码里不存在的码——那种码没有任何东西守着，会静默腐烂（本仓对「文档里的量化断言必须可复现」的纪律见 [CONTRIBUTING.md](./CONTRIBUTING.md)）。要升级成兄弟仓那套，需要同时动 `src/host/codes.ts`（加 `SYMPTOM` / `SYMPTOM_HINT`）、`src/host/doctor.ts`（`report.symptoms`）与 `test/doctor.test.mjs`（锚点双向钉住），属另案。
