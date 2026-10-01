# 踩坑经历（Pitfalls）

把对接控制台过程中真实踩过的坑记下来，按「现象 → 根因 → 修法」写。多数已写进代码，这里是为了**下次改的时候别再踩一遍**，也方便接手的人理解代码里那些「看起来多此一举」的防御。

> **范围说明**：本插件 2026-10 从商汤 SenseNova 控制台迁到 **Agnes 控制台**，登录线由 OIDC 授权码 + JWE 密码封包换成**一跳账号密码 POST**（见 [AUTH.md](./AUTH.md)）。于是下面分三类：
> - 标了「**商汤时代，代码已删除**」的条目（第 1、2、3、5、14 条）描述的是**已经不存在的文件**。保留它们是为了记住这类坑的**形状**——**不要按字面去找这些函数**。
> - 标了「**商汤时代实测**」的条目（第 20、21 条）是在已退役的推理网关上量的数据；**现行推理契约以 [AGNES-API.md](./AGNES-API.md) §7 为准**。
> - 其余条目（含第 4、6、11、12、13、16–19、22–28 条）对**当前代码全部有效**。

---

## 1. 登录流必须从 console 源站发起，否则 CSRF cookie 取不到（商汤时代，代码已删除）

- **现象**：授权码流走到回调时直接 `No CSRF value available in the session cookie`，流程死。
- **根因**：Hydra 的 CSRF cookie 绑定在**入口 host** 上。如果在 IAM 自己的源站（`iam.sensecoreapi.cn`）发起授权，回调时 cookie 不可达。
- **修法**：`AUTH_ENDPOINT` 强制为 `consoleOrigin + /oauth2/auth`（`https://platform.sensenova.cn/oauth2/auth`），IAM 登录请求才带 `origin`/`referer` 为 console 源站、并复用第 1 步收集到的 CSRF cookie。

---

## 2. 密码封包必须是 RSA-OAEP(SHA-1) + A256GCM（商汤时代，代码已删除）

- **现象**：IAM 拒绝封包，登录失败。
- **根因**：平台用 `alg: RSA-OAEP`（即 OAEP over **SHA-1**）。用更「现代」的 `RSA-OAEP-256` IAM 直接拒。
- **修法**：`importKey` 时 `hash: "SHA-1"`；AAD 用 protected header 的 **base64url 段**（不是整段 JSON 文本），严格按 RFC 7516 §5.1 step 14。每次封包换新 CEK/IV。

---

## 3. 登录失败只读顶层 message，把锁号当密码错（商汤时代；教训已由 `classifyLoginFailure` 承接）

- **现象**：账号被锁、被限频，面板却统一报「账号或密码不正确」，用户反复重试 → 锁死更严重。
- **根因**：IAM 返回 `google.rpc.Status` 信封，真正原因在 `details[].reason`，顶层 `message` 只是泛化的 `InvalidArgument`。
- **修法**：`rejectionCode()` 优先取 `details[].reason` 精确匹配（`invalidAccountOrPassword`/`accountLocked`/`tooManyAttempts`/`verificationRequired`…）， substring 扫描只作兜底，绝不伪造具体原因。**Agnes 侧的同一条纪律由 `classifyLoginFailure()` 承接**：平台原话（`message`）优先于本地猜测，锁定/限频与「密码错」分成两类，前者等窗口、后者绝不自动重试。

---

## 4. 401 不证明 token 过期，只是「被拒」

- **现象**：一次 401 后若直接甩掉 token 重登，会陷入刷新风暴或频繁登录。
- **根因**：401 可能来自并发 poll 各自持不同 token、或 refresh 还没轮换完。
- **修法**：401/403 时 `tokenStore.invalidate(token)` 标记该 token 被拒（有界集合，最多记最近 8 个），然后**只换新 token 重试一次**；重试仍拒才抛 `JWT_EXPIRED`。被拒 token 绝不再下发，避免 replay。

---

## 5. refresh_token 会被轮换，忽略新值下次就死（商汤时代，代码已删除）

- **现象**：连续刷新后某次突然 `refresh_rejected`。
- **根因**：Hydra 每次刷新都发**新 refresh_token**，旧的直接失效。只拿 access_token 不存 refresh_token = 自毁。
- **修法**：每次 `refresh()` 都把返回的新 `refresh_token` 一并落库（`store(..., replacing)` 用 `modifyRecord` 串行化，避免多进程互踢）。

---

## 6. 自动重试把一次错密码变成锁号

- **现象**：面板开着过夜，错密码被每分钟重试，账号被锁。
- **根因**：平台几次失败就锁号；轮询里重发密码等于主动撞锁。
- **修法**：两类拒绝区别对待——
  - **时间型**（锁定/限频/故障）：等窗口；**平台声明窗口照单全收、绝不截断**（哪怕 2 小时），无窗口才本地指数退避 60s→2m→4m… 上限 30 分钟；窗口一到恰好探测一次。
  - **凭据型**（错密码/验证码）：**完全不自动重试**，面板请用户重填，只有用户主动提交才试。
  - 节流曾写进凭据服务（伪装成 `grant` 记录 + marker 字段），但凭据服务只认两种 kind，私有状态寄存在那里一条 typo 就会炸掉整台机器——现已迁到插件自己的状态文件（`throttle-store.ts`，原子写），**跨进程跨重启**生效：另一个 Host 进程不会在等待期继续敲门。旧凭据记录地址仅作一次性迁移读取。

---

## 7. 把 `not_configured` 当拒绝，导致新装就「需用户操作」

- **现象**：全新安装、从未填过账号，面板却如临大敌地要用户「处理」。
- **根因**：`not_configured` 根本不是拒绝——是「还没配过」，从没发过请求，谈不上「避免重复」。
- **修法**：`CREDENTIAL_REFUSALS` 集合**不含** `not_configured`，也不写 throttle 记录；只有真正发过请求被拒才记录节流。

---

## 8. 改 Host 半边不重启，跑的一直是旧代码

- **现象**：改了 `src/host/*.ts` 但没重新构建（或构建了没重启），刷新面板没变化。
- **根因**：Host 半边只在启动时加载一次，`dsh web` 不热重载。
- **修法**：**完全退出 DSH（含托盘）再启动**。自查：`(Invoke-RestMethod .../snapshot).auth` 有 `auth` 字段 = 新代码；没有 = 旧代码。注意桌面版(19387)与 `dsh web`(常 3080) 是不同 profile。
- 只改 `src/client/*.ts` 则 `npm run build:client` 重建 `client.js` 后浏览器刷新即可。

---

## 9. `_asar_extract/` 误入仓库污染提交

- **现象**：`git status` 一长串 `lib/main.js`、`renderer/*`、`welcome/*` 等 DSH 桌面应用内部文件。
- **根因**：有人把 `app.asar` 解包到插件目录并 `git add`，把 Harness 自身源码当插件代码提交了。
- **修法**：`git rm -r --cached _asar_extract` 停止跟踪（已做）。它不是本插件代码，且每次版本升级会产生几十万行 diff。

---

## 10. upstream 不该进本仓库历史 / 明文凭据

- **现象**：上游 Python 工具含 `accounts.json`（明文账号密码）和 `.workbuddy/`。
- **根因**：直接塞进插件仓库会污染历史、泄露凭据。
- **修法**：上游以**被忽略的 `upstream/`** 形式容纳（[shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)，保留其独立 `.git` 与 remote——本地副本若丢 `.git`，`git clone` 该地址恢复），`.gitignore` 加 `/upstream/`，绝不 `git add upstream/`，也不碰它的 `accounts.json`。**此后该容器被沿用为通用参照件区**（AgnesCode 线参照件与本机探测快照都在里面，清单见 [REFERENCES.md](./REFERENCES.md)）；同一个坑在 2026-10-01 以「仓库根下 110M 的 `probe-asar/` 既未跟踪也未忽略」的形式复发过一次——**探针产物一律落进 `upstream/`（或已被忽略的 `tmp/`），绝不留在仓库根的未跟踪区**。

---

## 11. 控制台数值字段是字符串，时间字段是 decimal 秒字符串

- **现象**：`limit`/`used` 直接当数字用得到 NaN；`reset_at` 显示成奇怪的大数。
- **根因**：控制台把数字**当字符串**返回，时间是 **epoch 秒的字符串**（不是毫秒）。
- **修法**：`countOf()` 用 `Number()` 归一、不可解析一律 0（面板显示「缺个数」而不是 `NaN`）；`timestampSeconds()` 接受 epoch 秒 / 毫秒、二者的十进制字符串、以及 ISO-8601，空 / `0` / 非法返回 `null`（避免把「无到期」误判成 1970 年）。Agnes 同样混用两种形态——套餐上限是真 JSON 数字、用量计数器见过字符串——所以这条至今有效。

---

## 12. 形状漂移被读成「暂无数据」

- **现象**：平台改了返回字段，面板永远显示空。
- **根因**：解析器对缺失字段宽容，若顶层 key 改名，解析仍返回「能看懂的」，缺失部分静默消失。
- **修法**：`EXPECTED_SHAPES` 校验顶层 key（现为 `usage-overview` / `usage-series` / `subscription` 三档；`subscription` 故意是**空数组**——它的形状尚未观测到，见 [AGNES-API.md](./AGNES-API.md) §6），缺哪个就在快照里挂 `shapeWarnings`，面板顶部明示「接口缺字段 {api} {missing}」，而不是永远「暂无数据」。

---

## 13. 同源校验少一行，任意网页能往面板塞账号

- **现象**：潜在——任意站点可 POST 账号进用户面板。
- **根因**：snapshot/account 路由若不做 origin 校验，跨站请求可写账号。
- **修法**：`isAdmitted()`——带 `Origin` 的请求必须与 Host 同 host；`origin === "null"` 一律拒；无 `Origin` 的同源 GET 放行。account POST 还要校验 body ≤ 4KB、必须是对象（非数组/非 null）。

---

## 14. JWKS 缓存跨 tenant 复用会封错包（商汤时代，代码已删除）

- **现象**：切到企业镜像/预发后密码封包用错公钥。
- **根因**：JWKS 缓存了上一个租户的密钥，新平台却用不同 key。
- **修法**：JWKS 缓存已从 `sensenova-auth.ts` 迁到 `sensenova-crypto.ts`，且**由调用方持有、非模块级单例**。`createAuth(overrides)` 每次在自带配置里挂一份独立缓存（`cfg.jwksCache = createJwksCache()`），`sealPassword(..., { cache })` 用它——所以两个实例即便指向**同一个** endpoint 也不共享密钥项；缓存内部再按 `jwksEndpoint` URL 分键，一个实例配多镜像也各归各。这一层之前只做了一半：auth 侧已 per-instance，crypto 侧仍是模块级 `Map`，跨实例照样串味，测试只能靠 `import("...?shape=…")` 重载整个模块来强制干净缓存。补全后该 hack 退休，`test/auth.test.mjs` §2b 直接钉住"复用/隔离/分键/两实例各自持有"四条语义。`forgetJwks()` 随模块级缓存一并删除（此前全仓零调用）。

---

## 15. 凭据经错误消息漏进日志或面板

- **现象**：潜在——诊断文件、日志或面板上出现明文密码、token 或 `sk-` Key。
- **根因**：每次登录都写 trace 便于「浏览器能登、面板不能」的对照排查，写不好就泄密；另一头更隐蔽——provider / 桌面端上游 注册失败时，HTTP 错误对象的 `message` 往往**内嵌了它构造时的请求头**（axios / fetch 的错误都这样），而平台 4xx 正文也可能把 `sk-` Key 原样回显。这些字符串会顺着 `providerState.error` 与 `ctx.logger.warn` 出去。
- **修法**（两层，别只做一层）：
  - **登录 trace 靠「不写值」，不靠事后脱敏**：hop 记录只放形状事实（`step` / `status` / `code` / `retryAfterMs` / `tokenLength` / `tokenIsJwt` / `expiresIn`）、平台原话（截 200 字，本身不含凭据）与**掩码后的账号名**（`maskUsername`）；token 只记长度、不记值。落盘权限 `0o600`，仅留最近 20 个。**新增输出点时别改成「先写后脱敏」——这一层没有 sanitize 兜底，纪律就是「值不进 trace」。**
  - **错误文本靠 `redactSecrets()`**（`src/host/util.ts`）：provider / 桌面端上游 / 路由三处的 error message 在进快照或日志前必须过它，覆盖五类形态——`Authorization:` 头、`Bearer` / `Basic`、裸 `sk-…`、带引号的 `{"password":"…"}` 键值对、以及 `password=…` 形式。`test/provider.test.mjs` §14 钉住这套替换。

---

## 16. 插件目录解析不到 Host 的 peer 依赖，provider 静默缺席

- **现象**：`registerProvider: true` 之后面板一直显示 provider 未注册，快照 `llm.providerError` 里是
  `Cannot find package '@earendil-works/pi-ai' imported from …/plugins/dsh-connect-agnes-token-plan/llm-adapter.js`；
  而离线套件（连 `npm test` 全量）**全绿**，因为离线套件通过 `peer-roots.mjs` 从 Host 运行时就地解析 peer，
  走的不是插件自己的解析链。
- **根因**：`llm-adapter.ts` 要 import Host 发行的三个 peer（`@earendil-works/pi-ai`、
  `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`），而 Node 的裸模块解析是从**该文件所在目录**逐级向上找
  `node_modules`。npm 装进 profile 的插件（`profiles/web/node_modules/<name>` 是**真实目录**）会向上走到
  `profiles/node_modules`，那里有 Host 的 peer；开发期的 `~/.dsh/plugins/<name>` 是**符号链接/junction** 进
  profile 的，Node 默认把链接解成 realpath，于是解析链从插件目录向上只剩 `~/.dsh/plugins`、`~/.dsh`、`~`，
  一路都没有这些包。
- **修法**：三个 peer 进 `peerDependencies`（npm 安装时由 profile 侧提供）；开发检出要么用 plugin manager
  以真实目录安装，要么把这三个包链接进插件自己的 `node_modules`（与 `dsh-connect-qoder` 的开发检出做法一致，
  `test/peer-roots.mjs` 头部也记了这条 workaround）。失败时 Host 日志会同时打出 `ERR_MODULE_NOT_FOUND` 与这句
  提示——面板只报「provider 缺席」，日志才说得清是哪一层没解析到。e2e 现在开着 `registerProvider` 真跑一遍注册，
  这条漏洞不会再以「离线全绿」的形式溜过去。

---

## 17. e2e 继承了开发机的 `AGNES_TOKEN_PLAN_API_KEY`，测的不是干净安装

- **现象**：本机（shell 里设了 `AGNES_TOKEN_PLAN_API_KEY`）跑 e2e，「没有 Key 时目录不可用」这类断言失败；
  面板保存 Key 的请求返回 `ok:false`，错误是
  `credentials-local: "AGNES_TOKEN_PLAN_API_KEY" is supplied read-only by the launching environment`。
- **根因**：e2e 用 `{...process.env}` 拉起 Host，开发机环境里的 Key 就成了子进程的环境凭据；凭据服务把
  「来自启动环境」的值视为**只读**，于是插件既提前拿到了 Key（目录不再降级），又写不进新值。
  干净机器上这两条路径都看不见——测试因此只在作者机器上红，属于典型的「只是通常离线」。
- **修法**：`startHost()` 在 spawn 前删掉 `AGNES_TOKEN_PLAN_API_KEY`/`AGNES_USERNAME`/`AGNES_PASSWORD`
  （与离线套件的 `isolateHostEnv` 同一组名字），隔离从「另一个 `$DSH_HOME`」补齐到「另一份环境」。
  注意这也是**真实产品行为**的体现：用户的 Key 若来自启动环境，面板保存会被凭据服务拒绝，面板会照实显示该原因，
  此时清掉环境变量或改用它处提供的值即可——插件不会偷偷绕过只读引用。
---

## 18. 两次 publish 并发，慢的那一次赢

- **现象**：面板显示 N 个模型、provider 已注册，但模型路由里真正可用的是另一份——常是重启后 state 缓存里那份空/旧列表。日志无异常，重试也自愈不了（要等下一次 catalog 变化）。
- **根因**：挂载时从 `catalog.json` 播种的那次发布是 fire-and-forget，可能还在飞；此时首次轮询、开关切换或 Key 清除又各发布一次。每次发布都是「先 `releaseProvider()` 再 `registerAdapter()`」，两次交错时**先发起、后完成**的那次会摘掉对方刚注册的 pair，再把自己那份旧 catalog 注册上去。更糟的是插件已经 dispose 之后，播种那次仍会完成注册——留下一个没人拥有、没人能摘掉的 provider。
- **修法**：`publishProvider` 走 promise 链串行（`publishChain`，与 `token-store.ts` 的 `getToken` 同一手法），seed / 轮询 / 开关 / Key 清除四个入口都进同一临界区；`disposed` 标志在 dispose 时置位，之后的发布直接跳过。注册那一对调用抽成 `registerPair()` 只定义一次——发布路径与回滚路径共用，否则两份迟早漂移（回滚只在已经出错时才跑，是最坏的发现时机）。钉住它的是 `test/wiring.test.mjs` F3：用可控 gate 让第一次 build 停住，断言「最后发起的那次是最终注册的」。
- **注意**：`index.ts` 里 signature 去抖是同步块（赋值与比较之间没有 await），单线程下它自己不会漏；漏的是 `publishProvider` 内部的 await。别以为有 signature 就够了。

---

## 19. adapter 工厂一旦返回 Promise，就会注册一个 undefined adapter

- **现象**：潜在——面板说 provider 已注册，快照 `llm.providerError` 为空，但真正调模型时报完全不像原因的路由错误。
- **根因**：`createAgnesAdapter()` 现在是同步函数，`index.ts` 把它的返回值直接交给 `registerAdapter`。哪天它内部改成动态 import peer 而变成 async，`built` 就是 Promise，`built.adapter` / `built.providerIds` 全为 `undefined`——而 Host 照单注册。故障出现在模型路由，离原因很远。
- **修法**：`await` 工厂的返回值（对同步函数零副作用），并校验形状必须是 `{ adapter, providerIds }`；不符就在发布前抛错，进快照的 `llm.providerError`，而不是注册一个空壳。

---

## 20. 官方接口文档与平台行为不一致，照抄必 400（商汤时代实测）

- **现象**：把商汤官方「SenseNova 6.8 Flash Lite」接口文档里的参数照进代码：`thinking:"disabled"` 想关思考，结果每请求 400；`reasoning_effort:"max"` 想要最强推理，也 400。
- **根因**：官方文档多处与平台实际不符（2026-09-29 对 `token.sensenova.cn/v1` 实测 40+ 个请求）：
  `thinking` **字符串形态**（`"enabled"`/`"disabled"`/`true`/`false`）全线 400——文档当字符串写是错的（object 形态 `{"type":...}` 才有效，见第 21 条）；
  `reasoning_effort:"max"` 在 flash-lite / deepseek-v4-flash 上实测 400（glm-5.2 上有效）——平台报错原文 `field ReasoningEffort invalid, should be one of: low, medium, high, xhigh, none`；
  目录 `supported_sampling_parameters` 只声明 `["temperature","stop"]`，文档表格里列的 `top_p`/`frequency_penalty`/`presence_penalty`/`seed`/`n` 一个都不在声明里（思考模式下 temperature 等本就不生效，送不送得动未验证，别假设支持）。
  另外文档写 `max_tokens` 默认 65535，目录实际 `max_output_length` 是 65536；窗口字段是 `context_length` 不是 `context_window`（曾让 `contextWindowOf` 拿不到真实窗口、全体回退 128k，见 `llm-models.js` 与 `test/provider.test.mjs`）。
- **修法**：与平台行为有关的契约一律以**实测**为准，官方文档只当线索、不当依据——且各模型页面互相矛盾（GLM 页说 `thinking.type:disabled` 会失败、实测可用；DeepSeek 页与 flash-lite 页都列 `max`、实测两处 400）。实测要点：默认即思考开（flash-lite `message.reasoning`、deepseek/glm/kimi 是 `reasoning_content`，每请求多约 26 个 prompt token、慢约 2.9 倍）；`reasoning_effort:"none"` 关思考（思考字段消失、`reasoning_tokens=0`）；`role:"developer"` 是 400（`supportsDeveloperRole:false` 的依据）；流式 `delta` 含 `content`/`reasoning`/`role`。

---

## 21. 同一平台两套思考语义，按模型家族分家（商汤时代实测）

- **现象**：在 flash-lite 上验证过的思考参数搬到 deepseek/glm/kimi 上行为不同：flash-lite 的 `thinking` 字符串 400，deepseek-v4-flash 的 `thinking:{"type":"disabled"}` 却有效；`reasoning_effort:"max"` flash-lite 400、glm-5.2 却 200；返回的思考字段 flash-lite 是 `reasoning`、deepseek/glm/kimi 是 `reasoning_content`。
- **根因**：商汤在 OpenAI 兼容网关背后给不同模型家族做了各自的参数/字段方言（2026-09-29 逐模型实测）：
  思考字段：flash-lite → `message.reasoning`；deepseek-v4-flash/v4-pro/deepseek-flash/glm-5.2/kimi-k3 → `message.reasoning_content`（DeepSeek/GLM 官方文档确认）；
  `thinking` 参数：字符串形态全线 400；object 形态 `{"type":"enabled"/"disabled"}` 在 deepseek-v4-flash / glm-5.2 实测有效（disabled → `reasoning_tokens=0`）；v4.1-flash 文档自述支持（该 Key 套餐 403 未实测）；
  `reasoning_effort`：平台报错列表 `low/medium/high/xhigh/none` 是**并集**；`max` 只有 glm（实测 200）与 v4.1-flash（文档原生）支持，flash-lite / v4-flash 400；`xhigh` 在 v4-flash 实测 200（官方文档称映射到 high）；
  工具链路：DeepSeek 系文档要求带 `tools` 时回传所有历史 `reasoning_content`，否则工具调用链路不完整（不带 tools 时回传也会被忽略）——DSH/pi-ai 若丢弃该字段，deepseek 系多轮工具调用可能断链；
  思考模式采样：DeepSeek 系 temperature / presence_penalty / frequency_penalty 不生效（传入不报错），top_p 思考模式最小 0.95、非思考固定 1.0；GLM top_p 默认 0.95。
- **修法**：按**模型家族**而不是按「平台」记契约（现行逐模型契约见 [AGNES-API.md](./AGNES-API.md) §7）。思考透出不再悬而未决：pi-ai 的 openai-completions 读取 `reasoning_content`/`reasoning`/`reasoning_text` 三种拼写（2026-09 查源码确认），本插件 descriptor 已翻为 `reasoning:true` + `thinkingLevelMap`（`off:"none"` 是平台关思考的拼写，`minimal:null` 不提供，`max` 仅 glm-5.2），profile 默认 `high` 保持平台默认思考开。`isChatModel` 按 `output_modalities` 排除图像生成模型（U 系列对话端点 404），避免把不可聊的模型挂进选择器。

---

## 22. 两个 profile 跑的不是同一份代码，却共用同一份状态文件

- **现象**：web profile 的面板改了配置或模型允许清单，desktop profile 的表现跟着变（或干脆不变）；desktop 侧的行为与源码对不上，像是跑着旧版本。问「这台机器上 Agnes provider 到底是开是关」，翻遍 `cordis.patch.yml` 找不到答案。
- **根因**（2026-09-30 本机实测，三处超出直觉的事实）：
  - **装载面不是 patch，是 bundle**：插件在 profile 的 `package.json#dsh.profile.bundles` 里注册，`cordis.patch.yml` 只是 overlay，**缺省合法**（`cordis.yml` 头注即写明：不要编辑该文件，树由 bundles → patch → overlays 合成）。所以「patch 里没有本插件的行」什么都不证明。
  - **两个 profile 装的不是同一份**：本机 `profiles/web/node_modules/<name>` 是 `symlink → ~/.dsh/plugins/<name>`（跑源码 HEAD），而 `profiles/desktop/node_modules/<name>` 是**真目录**（安装副本，pin 在依赖里声明的版本号）。改了源头，web 立即生效，desktop 停在旧版本。
  - **状态面却是全局的**：`state-store.ts` 的 `$DSH_HOME/state/<name>/`（`catalog.json` / `provider.json` / `throttle.json`）与凭据服务里的同一条 grant 都不按 profile 分段，被两个 Host 进程共写，且载荷除各自的 `version` 外**没有跨版本协商**。
  - 叠加 `provider-publish.ts` 的 `panelValue ?? patch`：没有 patch 行时 `registerProvider` 取默认 `false`，而面板保存的值写在 state 文件里并**压过**默认值——于是「是否注册 provider」在这台机器上唯一的开关，是一个不在 git、不在 patch、CLI 也查不到的 JSON。
- **已做**（2026-09-30）：四个 store 的读缓存统一到 `state-store.ts` 的 `createStateReadCache` —— provider / draw 早有 1s TTL，**catalog 完全没有**（进程内永不失效），同一个共享目录问题修了两个、漏了第三个。现在一个 TTL 三个调用方，只允许在一处调整。钉住这条的是：`test/provider.test.mjs` §8b 用两个共享同一个 dir 的 store 实例模拟两个进程，断言「第二个进程的写入/开关，这边不必重启就看得见」，顺带钉住 `replace` 必须保住磁盘上真实的 allow-list（旧实现里惰性 `held` 会在没读过盘时把别人存好的清单重置成 `[]`）。
- **按期查**（三层按序，别只翻 patch）：**bundles（装载）→ patch overlay（配置）→ `$DSH_HOME/state/<name>/`（运行时热开关）**。改完源头，desktop 一侧需要重装该 bundle 才会跟上（web 的 symlink 自动跟上）。
- **未做**（P0）：`doctor --json`，让「这台机器上 provider 到底是开是关」有处可问（唯一的答案仍在一个 CLI 查不到的 JSON 里）。状态目录的分段**已在第 23 条做掉**。

---

## 23. profile 状态：哪些该分、哪些该共享，以及读 `profileContext` 的两个坑

- **现象**：web 面板改了模型允许清单或 provider 开关，desktop 侧跟着变（或干脆不变）；两个 Host 进程（web = 源码 symlink，desktop = 安装副本，见第 22 条）共写同一份 `catalog.json` / `provider.json` / `draw.json`。更糟的是**版本方向**：老进程读不懂新格式时不会报错——每个 store 的 `parse` 对「版本不认识」一律读作「无记录」，于是它重拉一次、再把**旧格式写回去**，覆盖掉新进程刚写的。
- **根因**：这三份是**配置决策**（「这个 profile 允许哪些模型 / 要不要挂 provider / 要不要出图」），本就该 per-profile；而旧版统一放在 `$DSH_HOME/state/<name>/`，那是按「只做额度面板」的年代设计的。
- **修法**（2026-09-30 已做）：`state-store.ts` 新增 `profileSegment(ctx)` 与 `profileStateDir(name, profile)`；catalog / provider / draw 三个 store 接受 `profile`，目录变成 `$DSH_HOME/state/<profile>/<name>/`。**取不到 profile 名时退回原共享目录**，所以老主机、测试与进程内构造的行为零漂移。
- **取 profile 名的三个坑**（2026-09-30 运行时实证，非推测）：
  1. **只能用 `ctx.get("profileContext")`，不能用属性访问。** Cordis 的 Context 是 Proxy：读一个**没在 `inject` 里声明、Host 也没 provide** 的服务，`ctx.get` 安静返回 `undefined`，而 `ctx.profileContext` **抛错** `cannot get property "profileContext" without inject`（`@deepseek-ai/cordis` `lib/index.js:676`）。本插件首次改动就把这个错炸在 `wiring.test.mjs` 上，堆栈指向的正是属性访问那一行。官方两派用法也印证了这条边界：`dsh-app-boot` / `dsh-shell-env` 用 `ctx.get`，`dsh-settings` 则先 `static inject = ["configEditor","profileContext"]` 才敢用属性。
  2. **不能把 `profileContext` 写进 `inject`。** `inject` 里的是**硬依赖**（缺了插件根本不加载，报错文案就叫 "cannot get required service"），而这个服务是**可选**的——`dshmarket` 的注释直言有 host 会隐藏它，`dsh-better-sidebar` 也为缺席写了分支。写进 `inject`，那些主机上本插件会整个消失（面板、额度、provider 全挂）。
  3. **不要读 `DSH_PROFILE`。** 它在这个 runtime 里是 **OUTPUT 而非输入**：由 `runProfile()` 经 `dsh-shell-env` 派生给子进程，「no runtime module reads it to choose a profile」。手设或陈旧的值会把状态写进一个这台 Host 根本不读的目录。
  - 另外，`profileContext.name` 会变成**路径的一段**，所以按外部输入校验（`isProfileSegment`）：字符集 `[A-Za-z0-9._-]`、不以 `.` 开头（顺带排掉 `.` 与 `..`）、长度 ≤ 64。拒绝的代价只是退回共享目录，所以规则宁严勿宽。
- **故意不分段的两个**（别顺手「统一」掉）：
  - **`throttle.json`**：它答的是「上游要**这台机器**等多久」。若只有吃到 429 的那个 profile 遵守，另一个 profile 会在同一窗口里继续敲门——**静默废掉节流的意义**，而且只在被限流时才看得见。代码里已写明这条意图（`throttle-store.ts` 的目录函数）。
  - **凭据 grant**：它答的是「你是谁」，与 profile 无关；且按红线 1，token 只进凭据服务。
- **迁移**：新目录一开始是空的。读穿透发现「自己的文件不存在」时，从旧共享路径**复制**一次旧值并回填（`createStateReadCache` 的 `inheritFrom`），**只尝试一次**，所以不会变成每个 TTL 周期多读一个文件。用**复制而非移动**，与 `store.test.mjs` §16d 的改名迁移（移动、删旧文件）**故意不同**：老版本进程仍在读旧路径，把文件拿走等于把它的开关静默重置。
- **验证**（三层，缺一层都可能在验证空气）：
  - `test/provider.test.mjs` §8c：名字的接受/拒绝表（含 `..`、`a/b`、`a\b`、超长、非字符串），以及三种 ctx 形状——没有该服务、`get()` **抛错**、普通对象桩——都不得把错误抛穿。
  - 同文件 §8d：分段目录、一次性继承（含「旧文件仍在」这条与 §16d 相反的断言）、**两个 profile 互不干扰**、显式 `dir` 不继承。
  - **`test/e2e.mjs`**：真 Host 用 `--profile web` 启动，断言 catalog 落在 `state/web/<name>/` 且共享目录**没有**新文件。只有真 Host 能回答「这个可选服务对不 inject 它的插件是否真的可见」——单测桩回答不了，而服务不可见时功能会**静默失效**、测试却全绿。
- **未做**：文件级**版本协商**——分段只隔离了「哪个 profile 的配置」，没有解决「哪个版本的格式」。老进程仍可能把新格式覆盖回旧格式（每个 store 的 `parse` 对认不出的版本一律读作「无记录」，随后写回自己那一版）。以及 `doctor --json`（见第 22 条）。

---

## 24. 用 GET 给 REST 端点探活会误判：404 ≠ 端点没了

- **现象**：要给一条推理路由做健康检查，写了 `fetch(url, {method:"GET"})`，拿到 `404 page not found`，于是判定「上游端点已漂移、这个功能死了」。事实上那条路由**活得好好的**。
- **根因**：Go/Gin 一类框架对「路径存在但**方法**未注册」的默认响应就是普普通通的 **404**（纯文本 `404 page not found`），与「路径根本不存在」**逐字节相同**。只有用了正确的方法（这里是 POST），请求才会穿过路由层抵达鉴权中间件，拿到业务信封。
- **实证（2026-10-01，见 `ROADMAP.md` §6.1.2）**：同一台网关同一条路径，两种判读天差地别——

  | 端点 | 方法 | 响应 | 判读 |
  |---|---|---|---|
  | `/api/web/llm/v2/chat/completions` | GET | `404` 纯文本 `404 page not found` | 不足以判死 |
  | `/api/web/llm/v2/chat/completions` | POST | `401` `{"code":200001,"message":"authorization_empty_error"}` | 路由存在，已抵鉴权层 |

- **修法**（探活纪律，按顺序）：① 用**这条端点真实的业务方法**探（推理就该 POST，别偷懒用 GET）；② 看**响应体形态**而不只看状态码——结构化信封（`{"code":…}`）意味着请求已进应用层，纯文本 `404 page not found` 才是没到；③ 探活请求**不带任何凭据**：既无计费可能，又刚好用 `401 authorization_empty` 证明「路由在，只是我没钥匙」。
- **教训的代价**：这条误判曾直接导出一个错误结论——「本插件上游用的正是被自家文档标注 404 的那份 URL 清单」。前缀确实相同，但**端点不同**：`/models` 真 404（那是参考件 `dsh-raccoon-work` 的路径——该上游已随 Agnes 线移除），本插件当年用的 `/model_catalog` 与 `/chat/completions` 都活着。**看个前缀就下结论，和看个状态码就下结论是同一种粗心**——下判断前先核对具体端点，别只看前缀。
- **伴随坑（Windows Git Bash）**：脚本里把 `/api/...` 这样的路径字符串当命令行参数传，会被 MSYS 路径转换吃掉——`/api/web/llm/v2` 变成 `C:/.../PortableGit/.../api/web/llm/v2`，`fetch` 直接 `invalid url`，看起来像网络问题。用 `-e` 内联或先 `export MSYS_NO_PATHCONV=1`。

---

## 25. 形式门禁全绿，不代表文档说了实话

- **现象**：`docs.test.mjs` 十条检查全绿——127 条内部链接可解析、37 张表无跨文件重复、README 76 行远低于 140 上限、API 快照 14 键契约一致。同一时刻的 README：① **零处**提到当期头条特性（第三个 tab「小浣熊」）；② 三处仍写「侧边栏」，而代码早已迁到 Plugins 页，第 31 行「打开侧边栏「积分面板」」让用户**找不到入口**；③ 仍挂着「面板**只读**」的承诺，而它已经会注册推理通道、挂出图工具、写 DSH settings。
- **根因**：那套门禁验的全是**形式**——对一个题材「文档断言的事是否与代码一致」毫无感知。而 README 进了 npm 的 `files` 白名单，是用户安装完成后读到的**唯一**说明书；`cordis.patch.yml` 同样在包里，也藏着过期的「sidebar panel」注释。
- **修法**（2026-10-01 已做，两道新检查进 `docs.test.mjs`）：
  - **检查 9：README 必须覆盖面板的每一个 tab。** 文案不写死，从两个真源派生——`panel-page.ts` 里 `activeTab` 的联合类型给出 tab id 集合，`i18n.ts` 的 `tab.<id>` 给出中文文案；README 少了任何一个就红。于是「加一个 tab 忘了告诉用户」和「改了 tab 名而不跟」都必然红。
  - **检查 10：自述面声明的 UI 位置必须与 client 实际注册的槽位一致。** 受检「自述面」= `README.md` + `cordis.patch.yml`；槽位证据从 `src/client/*.ts` 的**非注释行**里找（只剥整行注释，不动行内 `//`，否则 URL 里的 `https://` 会被削掉半条路由）。声称了代码里没有的槽位 = 红。
  - **两处易漏的细节**：检查 10 要跳过否定句——「面板**不在**侧边栏」是在帮用户纠偏，不是位置声明；当初事故那句「打开侧边栏」不含否定词，照样红。检查 9 的正则必须钉住 `activeTab`，泛配 `useState<` 会先抓到同文件里的 `useState<SnapshotData | null>`，反而漏掉真目标。
- **验证**（缺这步等于自洽练手）：故意破坏后必须红——① 删光 README 里的「AgnesCode」→ 精确报 `agnescode（面板文案「AgnesCode」）`；② 把「Plugins 页内联卡片」改回「侧边栏」→ 报「声称面板在侧边栏，但 `src/client/*.ts` 里没有 sidebar 槽位注册」。两条都实测红过，再还原复验绿。
- **教训**：形式门禁越完善，越容易吸走「语义对不对」的注意力——绿得越好，越让人懒得读文档本身。**任何纯形式检查对语义漂移一律无效**，除非它的期望值是从代码派生出来的（像检查 9/10 那样：tab 名单来自 `panel-page.ts`、槽位证据来自 `apply.ts`）。

## 26. 重命名资产时只改了一半：清单指空，而所有检查都是绿的

- **现象**：重截截图时文件名从 `panel-credit-pools.png` / `panel-provider-setup.png` 换成 `panel-credit.png` / `panel-API-provider.png`。磁盘上是新文件、git 里也是新文件（`git status` 干净），**唯独 `screenshots.json` 还指着两个已删掉的旧名**。此刻工作树干净、构建通过、`docs.test.mjs` 十条检查全绿——**没有任何东西在报错**。而这份清单是市场页取图的唯一依据，推上去就是两张图全裂。
- **根因**：**「文档」这个词会让人只想到 `.md`**。`screenshots.json` 是数据文件、在 `package.json` 的 `files` 白名单里、被市场直接消费，但它在检查网里完全不存在——没人把它当「自述面」。重命名的人（人或并行会话里的 AI）改了两处该改的（磁盘、git），漏掉那个不显眼的清单。
- **修法**（检查 11，进 `docs.test.mjs`）：`screenshots.json` 声明的**每一条路径必须真实存在于磁盘**、是图片扩展名（`png/jpg/jpeg/webp/gif`）、条目数在 1–8 之间、且为仓库根相对路径（绝对路径与 `..` 逃逸在别人机器上必裂）。
- **验证**：三种破坏都实测红过再还原复验绿——① 换回两个旧文件名 → 精确报两条「清单指空，市场按它取图必然裂」；② `../outside.png` + 空条目 → 报「不是仓库根相对路径」与「含空条目」；③ 拿 `README.md` 当条目 → 报「不是图片扩展名」。
- **教训**：**「清单类文件」不是文档，但同样是契约**——`.json` / `.yml` / `.toml` 里写着别人的路径，改资产时最容易只改一半。本仓库按文件名引用 `assets/` 的机器消费方只有 `screenshots.json` **一处**；正是「只有一处 + 又不叫 `.md`」，让它成了盲区。**给资产改名之前先问：还有谁按名字引用它？** 答案里除了仓库内的文件，还包含仓库外的人工引用（如市场投稿 PR 正文会点名截图）。

## 27. 浏览器把保存的账号填进模型搜索框：不是关键词，是密码表单缺了用户名字段

- **现象**：打开插件面板，浏览器的密码管理器把**商汤（SenseNova）控制台的账号**自动填进输入框——不只是登录表单，连「接入 API」tab 里的**模型搜索框**也被塞了账号。看起来像浏览器按关键词猜中了什么，于是很容易往"是不是哪里写了 username/email 之类的字眼"方向查，查不出东西。
- **根因**：三条事实叠加，**没有一条是"猜"**。
  1. **密码库按 origin 存，不按插件**。两个插件（`dsh-connect-sensenova-token-plan` 与 `dsh-connect-agnes-token-plan`）同时装在 `profiles/web` 的 `bundles` 里，都注册进同一个 `plugins.bundle.config` slot、都由 `http://127.0.0.1:3080` 提供。浏览器眼里没有两个插件，只有一个 origin。
  2. **两个插件的表单语义逐行相同**（`account-form.ts:166/175/190/192`、`api-key-form.ts:99/101/142`、`model-picker.ts:222`）。`<form>` + `autocomplete="username"` + `type="password"` + `autocomplete="current-password"` 正是 Chromium 文档里的标准登录表单形状——**是我们主动声明的，不是它猜的**。
  3. **API Key 那个 `<form>` 里只有密码字段、没有用户名字段**。Chromium 自己的文档（*Password Form Styles that Chromium Understands* 第 2 条）明确要求：用户名与密码拆成两个表单时，**密码表单里必须放一个含用户名的字段**（可用 CSS 隐藏），否则它会自己去找一个。它挑中了同页唯一一个既无 `autocomplete` 又无 `name` 的文本输入框——模型搜索框（`type="search"`）。
- **修法**：给模型搜索框加 `autoComplete: "off"` 与 `name="model-search"`。**账号表单的 `username`/`current-password` 语义保持不动**——那是刻意的（浏览器记住 Agnes 账号是想要的能力），本次只堵"去表单外找用户名"这条路径。
- **验证**：机制由两处源码逐行对照 + Chromium 官方文档确认。`render.test.mjs` I2 组新增遍历式检查：渲染全部 7 个可能含输入框的组件，断言**每个可填文本输入框要么 `autoComplete="off"`、要么声明凭据角色**，并把「唯一声明凭据角色的是账号表单」钉死。该检查实测会红（临时把值改成 `TEMP_PROBE` → 精确报出 `ProviderForm: type=search` 与 `ModelPicker: type=search`，随后还原复验绿）。
- **教训**：浏览器自动填充**没有标准**（web.dev 原话："the algorithms for guessing, storing and displaying values are not standardized"）。**"它怎么知道这是登录框"的答案通常是"你告诉它的"**——`autocomplete` 是最强的信号，强过任何关键词猜测。反过来，**没有 `autocomplete` 的文本输入框是公共资源**：同页只要有任何一个密码字段，它就可能被拿去当用户名字段。同一 origin 上跑多个插件时，这一点会被放大成"凭据互相串门"。

## 28. 「已经好了」的错误字符串永不消失：清除路径只在 acquire 里，而它根本不跑

- **现象**：面板头部长期挂着「需要重新登录」chip，可下面额度、用量、套餐全都正常显示——数据是真的，chip 是假的。它不会自愈，重启 Host 才消失。
- **根因**：`state.lastError` 描述「最后一次取令牌失败」。它**由 `getToken()` 的 `acquire()` 路径写入、也由那条路径清除**——但 `getToken()` 在缓存令牌仍然新鲜时会**提前 return**，根本不进 `acquire()`。而面板上的手动登录（`POST /account` → `loginFromAccount` → `store(...)`）是**直接存令牌**的，从不经过 `acquire()`。于是：一次失败的自动重登把 `lastError` 写上；用户手动登录成功后，节流记录被清了（`retryAfterMs: null`、`needsUserAction: false`），**这个字符串没清**，而新令牌足够新鲜、`getToken()` 永远提前返回，清除路径再也不会跑到。
- **修法**：不在每个写入点补一次清除（那要靠人记得），而是把**上报**钉在结果上——`state()` 里 `error: isFresh(stored) ? null : …`。语义也更准：`auth.error` 的契约是「面板该向用户要账号」，而**持有一个控制台没拒绝过的令牌时就不存在当前错误**，无论上一次尝试说过什么。
- **同族（客户端）**：`AccountForm` 的「已保存并登录，正在读取额度…」也从不落地——`saved` 只被「清除已保存的账号」复位，于是额度已经完整渲染在它上面了，那行还在声称"正在读取"。改由父组件传 `hasSnapshot` 门控：独立表单（还没有快照）照旧显示，面板内嵌（快照已在屏上）不再显示。**这条没有测试覆盖**——测试替身的 `useState` 只返回初值，`saved` 进不去，是记录在案的缺口而不是假装覆盖。
- **验证**：`store.test.mjs` 8c 组（「改正密码被接受」那条）补两处断言——parked 期间**必须**报出错误，改正之后**必须**不再报。实测会红：把判定改成恒假（等价改前行为），精确报出 `sign-in is not being retried automatically: the account needs to be entered again`——与用户面板上看到的那句逐字相同，随后还原复验绿。`store-baseline.test.mjs` 冻结基线零漂移。
- **教训**：**只在一条路径上清除的状态，会在所有其它路径上变陈旧**。「写入点和清除点是同一个函数」看起来干净，但只要有一条**绕过那个函数**的成功路径（这里是"直接存令牌"），陈旧就是必然的。给状态字段定契约时先问：**它的每一个写入者，是不是也都是清除者？** 不是的话，就把判断挪到读取侧。

## 29. 两站凭据不互通：国内站 token 填进国际站必 401

- **现象**：用户在国内站 `api.agnes-ai.cn` 申请的令牌，填到国际站 `apihub.agnes-ai.cn` 的插件里（或反过来），全部 401，排查半天才发现站搞混了。
- **根因**：国内站与国际站是两套独立账号体系，令牌各自签发、互不承认，不能混用。
- **修法**：`docs/SETUP.md` 与面板 `needsKey` 文案明确区分两站 host；令牌与 host 必须成对来自同一站点，配置面板不做跨站猜测。
- **验证**：`SETUP.md` 的 `apiBase` 行附注「国内站 / 国际站 host 不同、令牌不互通」；面板 `noTools`/`needsKey` 文案不暗示一套凭据通吃。
- **教训**：任何「一套凭据通吃」的假设在跨站点场景下都该被显式否定。把边界写进文档和提示，比事后线下排查便宜得多。

## 30. 视频是异步任务制，不是同步返回

- **现象**：照出图习惯调视频接口，以为会直接拿到结果，结果只收到一个 task id，轮询才发现还要等分钟级。
- **根因**：Agnes 视频端点先 `POST {apiBase}/videos` 建任务，再 `GET {host}/agnesapi` 轮询状态，进入终态才带 `url`；单次生成分钟级，不能同步阻塞。
- **修法**：`src/host/video.ts` 走「建任务 → 轮询 → 取 url」完整状态机，`VIDEO_MAX_POLLS = 1000` 防时钟不前进时空转；刻意不设 30s 冷却门——协议往返延迟已远宽于冷却窗口。
- **验证**：`test/video.test.mjs` 组 M 覆盖 V2.0+2.5 混合目录的候选过滤与自动选型；`test/routes.test.mjs` 组 S 覆盖开关读写与跨工具隔离。
- **教训**：把同步接口的调用习惯套到异步任务上，会在「以为失败了」和「其实还在跑」之间反复横跳。接口是同步还是异步，是契约的一部分，必须写进文档。

## 31. 视频进度 `progress:0` 不能用 `num()` 读

- **现象**：任务刚建、进度 0% 时，面板把进度读成「缺失」，错误地显示成「未知」或掉进缺省分支。
- **根因**：`num()` 为坚持「存在且为正」会把合法的 `0` 当成「没给」，于是 0% 被静默吞掉，与「真没返回进度」无法区分。
- **修法**：`parseVideoQuery` 直接 `Number(raw.progress)`，保留 `0`；只在真正缺失（`undefined` / 空串）时才落缺省值。
- **验证**：`test/video.test.mjs` 同时覆盖 `progress:0` 与「缺失」两种输入，断言前者读成 0、后者落缺省。
- **教训**：「默认正值」的辅助函数在遇到合法零值时会失真。读进度这类「允许为零」的字段，要么关掉正值假设，要么单独处理 0。

## 32. CI 六连红：hard gate 死在 peer 解析，e2e 死在没构建

- **现象**：从 2026-09-30 仓库首次 push 起，GitHub Actions **每次都是红的**（6/6，33–48s 结束），而同一提交在本机 `npm test` 全绿。红的样子还各不相同——offline job 在**第 2 个套件**就退出（`agnes-auth` 47/47 通过之后），e2e job 报 `50/61 check(s) FAILED`——看上去像两处真回归。
- **根因**（两条，互不相干，都是「本机有、runner 没有」）：
  - **offline（hard gate）**：`store/routes/wiring` 要加载**真** peer 包，而 `test/peer-roots.mjs` 的候选根只列了 `$DSH_HOME` / 仓库 `node_modules` / `~/.dsh` 解包 runtime / Windows 安装目录——**没有「全局装了一个 `dsh` CLI」这条**。runner 上四者皆无，`loadPeer` 直接抛 `cannot resolve the peer dependency @deepseek-ai/dsh-credentials`；`set -e` 让套件链断在这里，后面 20 个套件（含 build-gate）**一个都没跑**。
  - **e2e（best effort）**：workflow 装了全局 CLI，却没**构建插件**。`lib/` 与 `client.js` 都是 gitignore，fresh checkout 里 `main: ./lib/index.js` 不存在 → Host 报 `dsh: warning: 1 entry did not activate` → 第一条断言就红，其余 50 条级联。本机绿只是因为手边有 `npm run build` 的产物。
- **修法**：`test/peer-roots.mjs` 增加最后一位候选——`npm root -g` 锚定的 `<prefix>/@deepseek-ai/dsh/node_modules`（与 `test/e2e.mjs` 启动真 Host 用的是同一处，标记为 `@deepseek-ai/dsh-base`），且**只在更便宜的候选都没带标记时**才去探它（dev 机不为此付一次子进程）；CI 的 offline job 增加一步装全局 `dsh`，e2e job 在跑套件前 `npm install --legacy-peer-deps && npm run build`。
- **验证**：把 `HOME`/`USERPROFILE`/`LOCALAPPDATA` 指到空目录（模拟 runner：无桌面 runtime、无本地 link）后，`findPeerRoot()` 回落到全局 CLI 的 runtime，`node test/store.test.mjs` 仍全绿；本机常态下仍走 `~/.dsh` 解包 runtime。
- **修完 CI 后的第一个副产物（同一课的第二个症状）**：链终于跑到底，`docs.test.mjs` 立刻在 CI 报 5 条「注释引用断链：`Agnes-auth.ts`」——而本机同一条命令**一直是绿的**。根因不在注释，在文件系统：**Windows / macOS 大小写不敏感**，`existsSync("Agnes-auth.ts")` 在那边命中真实的 `agnes-auth.ts`，断链只在 Linux 上现形（5 处：`codes.ts`×2、`token-store.ts`、`trace.ts`、`util.ts`）。修法两件：5 处引用改成真实文件名 `agnes-auth.ts`；`docs.test.mjs` 的**链接检查与注释引用检查改用 `existsExact()`**——逐段与目录里的真实条目比对大小写，这类断链从此在本机也红（故意写回 `Agnes-auth.ts` 复跑，本地立刻 `❌ 失败 1 项`）。
- **教训**：「本机全绿」对门禁给出的信心是假的——**没在 CI 里跑过就不算门禁**。而且「环境缺件」与「真回归」在日志里长得一模一样（第一条断言红 + 大面积级联），所以 runner 上需要的外部件（CLI、runtime、构建产物）只有两种正当处理：在 workflow 里显式供给，或让套件**响亮地 SKIP**；两者都不做，那块红色就没人会看。同理，凡是「这个路径存不存在」的断言，在大小写不敏感的文件系统上都会给出假绿——要比就逐段比大小写。

## 33. 插件卡文案不读 `displayName`——缺 locale 导出时安静地显示英文

- **现象**：中文界面里，Plugins 页的插件卡标题是裸包名 `dsh-connect-agnes-token-plan`、描述是一段英文长文——而 `package.json` 明明写了 `displayName`，README 也全中文。全程无任何报错。
- **根因**：卡片文案不是插件 bundle 渲染的，是 Host 侧 `readPluginMeta()`（`@deepseek-ai/dsh-app-boot`）读**包元数据**的结果，本插件只提供了它不接受的那一半：
  - 它按 `${specifier}/locale/en.json` 走 Node ESM 解析器取**英文字典锚点**——`exports` 没有 `./locale/*.json` 子路径时抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，被 `missingResource()` 归为「资源缺失」**静默吞掉**（不报错、不告警）；而 `dictionariesOf` 是扫**已解析的 en.json 所在目录**，所以 en.json 缺席 ⇒ `zh.json` 永远不会被读到。
  - 字典缺席后落兜底链：标题 = `package.json.name`（**`displayName` 这条链路根本不读**），描述 = `package.json.description`（只认字符串）。这就是「中文界面显示英文」的全部来源。
  - 客户端 `resolveText()`（`dsh-client-locale`）按当前语言兜底链取词（zh → `["zh","en"]`），渲染在 `dsh-client-ui-plugin-manager` 的卡片行——**服务端没给映射，客户端拿不到中文**。
- **修法**：三件齐活，缺一即哑：`exports` 加 `"./locale/*.json": "./locale/*.json"`；`files` 加 `"locale"`（否则 npm 包里没有它，装了等于没发）；`locale/en.json` + `locale/zh.json` 提供 `meta.title` / `meta.description`（**只认非空字符串**，写成对象或留空会在读取端抛错并连累整卡文案）。对照同类已发布插件（`dsh-connect-sensenova-token-plan`）的写法。
- **验证**：`test/package.test.mjs` 检查 7 把这条链钉死——exports 子路径存在、files 白名单含 locale、en.json 锚点存在、每个 locale 的 meta 字段是非空字符串；直接跑真 `readPluginMeta('dsh-connect-agnes-token-plan', …)` 可看到 `{en, zh}` 双字典。
- **教训**：读取端把「解析失败」归类为「没有这个东西」的 API，永远不会告诉你你**本该**提供它——症状只是「界面说英文」。凡是宿主平台读包元数据的约定字段，要用**运行时同款的解析器**验证（`optionalResourcePath` 走的是真 ESM resolver，`Test-Path` 绿不代表 exports 通），别拿文件系统的眼睛看模块解析的东西。

