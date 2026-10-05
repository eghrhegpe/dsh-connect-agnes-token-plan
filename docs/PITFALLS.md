# 踩坑经历（Pitfalls）

把对接控制台过程中真实踩过的坑记下来，按「现象 → 根因 → 修法」写。多数已写进代码，这里是为了**下次改的时候别再踩一遍**，也方便接手的人理解代码里那些「看起来多此一举」的防御。

> **范围说明**：本插件 2026-10 从商汤 SenseNova 控制台迁到 **Agnes 控制台**，登录线由 OIDC 授权码 + JWE 密码封包换成**一跳账号密码 POST**（见 [AUTH.md](./AUTH.md)）。于是下面分三类：
> - 标了「**商汤时代，代码已删除**」的条目（第 1、2、3、5、14 条）描述的是**已经不存在的文件**。保留它们是为了记住这类坑的**形状**——**不要按字面去找这些函数**。
> - 标了「**商汤时代实测**」的条目（第 20、21 条）是在已退役的推理网关上量的数据；**现行推理契约以 [AGNES-API.md](./AGNES-API.md) §7 为准**。
> - 其余条目（第 4、6–13、15–19、22–48 条）对**当前代码全部有效**。

---

## 目录索引（按主题归类）

| 主题 | 条目 |
|---|---|
| 登录 / 凭据 / 认证重登 | 1、2、3、4、5、6、7、14、15、29、**44（脱敏漏一条就漏凭据）** |
| 同源 / 请求安全 | 13、35、**46（403 不是令牌失效，是同源闸）** |
| 构建 / 装载 / profile | 8、22、23、33 |
| peer 依赖 | 16 |
| 解析 / 形状 / 契约 | 11、12、20、21、24、30、31、**45（平台给了权威值却自算）** |
| 状态 / 开关 / 发布 | 18、19、28、34、36、37、40 |
| 测试 / CI / 环境 | 17、32、41 |
| 文档 / 检测 | 25、26、39、**47（清单在包里、指的东西不在）** |
| 仓库卫生 | 9、10 |
| 收敛 / 死件清理 | 38 |
| 浏览器 / UI | 27、42、46 |
| 承诺 / 注释 / 护栏 | 43、45、46 |

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

- **现象**：潜在——诊断文件、日志或面板上出现明文密码、token 或 `sk-` / `cpk-` Key。
- **根因**：每次登录都写 trace 便于「浏览器能登、面板不能」的对照排查，写不好就泄密；另一头更隐蔽——provider / 桌面端上游 注册失败时，HTTP 错误对象的 `message` 往往**内嵌了它构造时的请求头**（axios / fetch 的错误都这样），而平台 4xx 正文也可能把 `sk-` / `cpk-` Key 原样回显。这些字符串会顺着 `providerState.error` 与 `ctx.logger.warn` 出去。
- **修法**（两层，别只做一层）：
  - **登录 trace 靠「不写值」，不靠事后脱敏**：hop 记录只放形状事实（`step` / `status` / `code` / `retryAfterMs` / `tokenLength` / `tokenIsJwt` / `expiresIn`）、平台原话（截 200 字，本身不含凭据）与**掩码后的账号名**（`maskUsername`）；token 只记长度、不记值。落盘权限 `0o600`，仅留最近 20 个。**新增输出点时别改成「先写后脱敏」——这一层没有 sanitize 兜底，纪律就是「值不进 trace」。**
  - **错误文本靠 `redactSecrets()`**（`src/host/util.ts`）：provider / 桌面端上游 / 路由 / **agent 工具 execute 错误**（`describeDrawFailure` / `describeVideoFailure` 把平台 body 片段拼进 agent 可见消息，同属第四张脱敏表面）四处的 error message 在进快照、日志或对话前必须过它，覆盖六类形态——`Authorization:` 头、`Bearer` / `Basic`、裸 `sk-…`、裸 `cpk-…`（Token Plan 主力 Key 形态，2026-10-03 补齐前是规则缝隙）、带引号的 `{"password":"…"}` 键值对、以及 `password=…` 形式。`test/provider.test.mjs` §14 钉住这套替换（含 cpk- 正反样例）。

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
- **已做**（原 P0，2026-10）：`tools/doctor.mjs`（`npm run doctor` / `npm run doctor:json`）——「这台机器上 provider 到底是开是关」有了可问处：按 profile 逐行点出 provider / draw / video / AgnesCode 四个开关、catalog 与模型勾选，外加 AgnesCode 本机存储盘点与同源闸审计。状态目录的分段**已在第 23 条做掉**。

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
- **未做**：文件级**版本协商**——分段只隔离了「哪个 profile 的配置」，没有解决「哪个版本的格式」。老进程仍可能把新格式覆盖回旧格式（每个 store 的 `parse` 对认不出的版本一律读作「无记录」，随后写回自己那一版）。`doctor --json` 一项已随第 22 条落地，从此条待办移除。

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
  - **检查 `README_TABS`：README 必须覆盖面板的每一个 tab。** 文案不写死，从两个真源派生——`panel-page.ts` 里 `activeTab` 的联合类型给出 tab id 集合，`i18n.ts` 的 `tab.<id>` 给出中文文案；README 少了任何一个就红。于是「加一个 tab 忘了告诉用户」和「改了 tab 名而不跟」都必然红。
  - **检查 `SELF_DESCRIPTION`：自述面声明的 UI 位置必须与 client 实际注册的槽位一致。** 受检「自述面」= `README.md` + `cordis.patch.yml`；槽位证据从 `src/client/*.ts` 的**非注释行**里找（只剥整行注释，不动行内 `//`，否则 URL 里的 `https://` 会被削掉半条路由）。声称了代码里没有的槽位 = 红。
  - **两处易漏的细节**：检查 `SELF_DESCRIPTION` 要跳过否定句——「面板**不在**侧边栏」是在帮用户纠偏，不是位置声明；当初事故那句「打开侧边栏」不含否定词，照样红。检查 `README_TABS` 的正则必须钉住 `activeTab`，泛配 `useState<` 会先抓到同文件里的 `useState<SnapshotData | null>`，反而漏掉真目标。
- **验证**（缺这步等于自洽练手）：故意破坏后必须红——① 删光 README 里的「AgnesCode」→ 精确报 `agnescode（面板文案「AgnesCode」）`；② 把「Plugins 页内联卡片」改回「侧边栏」→ 报「声称面板在侧边栏，但 `src/client/*.ts` 里没有 sidebar 槽位注册」。两条都实测红过，再还原复验绿。
- **教训**：形式门禁越完善，越容易吸走「语义对不对」的注意力——绿得越好，越让人懒得读文档本身。**任何纯形式检查对语义漂移一律无效**，除非它的期望值是从代码派生出来的（像检查 `README_TABS`/`SELF_DESCRIPTION` 那样：tab 名单来自 `panel-page.ts`、槽位证据来自 `apply.ts`）。

## 26. 重命名资产时只改了一半：清单指空，而所有检查都是绿的

- **现象**：重截截图时文件名从 `panel-credit-pools.png` / `panel-provider-setup.png` 换成 `panel-credit.png` / `panel-API-provider.png`。磁盘上是新文件、git 里也是新文件（`git status` 干净），**唯独 `screenshots.json` 还指着两个已删掉的旧名**。此刻工作树干净、构建通过、`docs.test.mjs` 十条检查全绿——**没有任何东西在报错**。而这份清单是市场页取图的唯一依据，推上去就是两张图全裂。
- **根因**：**「文档」这个词会让人只想到 `.md`**。`screenshots.json` 是数据文件、在 `package.json` 的 `files` 白名单里、被市场直接消费，但它在检查网里完全不存在——没人把它当「自述面」。重命名的人（人或并行会话里的 AI）改了两处该改的（磁盘、git），漏掉那个不显眼的清单。
- **修法**（检查 `SCREENSHOTS`，进 `docs.test.mjs`）：`screenshots.json` 声明的**每一条路径必须真实存在于磁盘**、是图片扩展名（`png/jpg/jpeg/webp/gif`）、条目数在 1–8 之间、且为仓库根相对路径（绝对路径与 `..` 逃逸在别人机器上必裂）。
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
- **修法**：`src/host/video.ts`（2026-10 拆分后状态机在 `video-client.ts`，`video.ts` 仍是兼容入口）走「建任务 → 轮询 → 取 url」完整状态机，`VIDEO_MAX_POLLS = 1000` 防时钟不前进时空转；刻意不设 30s 冷却门——协议往返延迟已远宽于冷却窗口。
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

## 34. 四个 opt-in 开关互相复制：继承来的值落盘即腐烂，而测试一条都没红

- **现象**：面板把某个 opt-in 开关打开后，**下一次 Host 启动它自己回到配置默认（关）**——没有报错、没有告警，`doctor` 也看不出异常（它只是读到"未设置"）。只在做过 profile 分段迁移（§23）的机器上出现，且**不是所有开关都中**：provider / AgnesCode 正常，draw / video 会丢。
- **根因**：四个开关商店（provider / draw / video / AgnesCode）是**逐字互抄**的四份代码（`draw-store.ts` 与 `video-store.ts` 连 JSDoc 都只换了单词），`doctor.ts` 又手抄了第五~八份解析器。`state-store.ts` 当初把**底层**原语收敛了（版本载荷、temp+rename、短 TTL 读缓存、§23 一次性继承缝），但真正的重复形状——「一个 bool 开关 + 一个可选 model 偏好 + 未设置三态」——留在每个文件里。于是 §23 的继承回写出现了两份写法：
  - 布尔-only 的两份（provider / AgnesCode）：`inheritFrom.write` 收到的是布尔，写回 `{version, enabled}` —— 正确；
  - 带偏好的两份（draw / video）：同一个回调收到的是 `{enabled, modelId}` **对象**，而写回体照抄了布尔版，把整个对象塞进了 `enabled` **字段** → 文件里是 `"enabled": {"enabled": true, …}`，再读时 `normalizeDrawEnabled(对象)` 返回 `null`。
  **进程内看不出来**：`createStateReadCache` 的继承路径返回的是内存里那份正确对象，所以当次会话 `enabled()` 就是 `true`；只有重开 Host、从磁盘重读才腐烂。所以「没在重启后读一遍」的测试全都绿——`provider.test.mjs` 那条"继承到的值"断言正是只验了内存答案。
- **修法**：抽 `switch-store.ts`（`createSwitchStore` + `createSwitchParser`），四个 store 只声明各自不同的事实（文件名 / 形状版本号 / 偏好 wire key / 报错措辞），继承回写与 save/forget 走同一个 `writePayload`（按各自 wire key 落位）；`doctor` 的三个 `parse*Payload` 改为 re-export store 的解析器（AgnesCode 那处内联判断同改）。
- **验证**：新增 `test/switch-store.test.mjs`——**四个商店跑同一组断言**（84 条），其中"继承后重新构造 store 仍读得到"这条在修复前是红的（正是这个坑的复现）。重构前后 `store 112 / routes 190 / provider 204 / draw 70 / video 127 / agnescode 119 / wiring 44 / config 94 / contract 102 / doctor 39` 逐项计数一致。
- **教训**：**抽原语不等于抽到那一层**——把 `writeStateFile` 收敛了，四个形状完全相同的调用方仍会各自发明"这一格写什么"。凡是"N 个同构文件"的局面，判断收敛是否到位的标准是**有没有一个所有 N 者共用的构造入口**，不是有没有共用函数。同理，"进程内答案正确"永远不能替代"重开一次读回来"——带短 TTL 缓存的状态层尤其如此，缓存会替错误写法遮羞。
## 35. 同源闸「无 Origin 放行」不是漏洞——但那条分支必须留下痕迹

- **现象**：审 `isAdmitted`（`src/host/host-config.ts`）时容易得出"闸是薄的"：`Origin` 缺失直接 `return true`，而它守着 `/account` `/api-key` `/models` `/provider` `/draw` `/video` `/agnescode` 这些写路由。直觉的加固是"写方法必须带 `Origin`"。
- **根因**：那条直觉是错的，而且错在没分清威胁模型。① 浏览器的**跨站 POST 必然发 `Origin`**，发了就被 `Origin`/`Host` 比对拦掉（现闸已经挡住了真正的跨站与 DNS rebinding）；② 同站 GET 不发 `Origin`，所以"缺失即放行"是**必须的**，不是疏漏；③ 因此走这条分支的只可能是**非浏览器客户端**，而它们本来就能自己伪造 `Origin` 与 `Host`。补那条规则换不来任何安全性，只增加摩擦，外加一个"面板被代理剥掉 `Origin` 就全站 403"的功能性风险。闸真正的承重层是 **Host 自己的 auth cookie**，`Origin` 只是纵深防御（该判断已写进 `isAdmitted` 的头注）。
- **修法**：不改放行，改**可见性**——新增 `src/host/admission-audit.ts`：`isAdmittedWithAudit()` 放行结论与 `isAdmitted` **逐位相同**，只在"放行 + 未声明 `Origin` + 会改状态"三条件同时成立时记一笔（次数 / 时间 / 归一化方法名，**不含任何头值或凭据**），落共享 state 目录（与 `throttle` 同款，故意不按 profile 分段，§23）；`doctor` 报告中新增 `admission` 行。写路由改接审计版，只读的 `snapshot` 保持原闸。`test/admission-audit.test.mjs` 钉住"哪些情形留痕、哪些不留"与"新增写路由接错闸会红"。
- **验证**：27 条新检查；`routes` 190 / `wiring` 44 / `doctor` 39 逐项与改动前一致（零回归，因为放行逻辑没动）。
- **教训**：**"看起来缺一道检查"不等于"缺一道防护"**——先把威胁模型写清楚（谁会发这个头、谁不会、谁能伪造），再判断缺口在哪。判断完发现"不需要加固"时，也别停在"什么都不做"：把那条分支做成**可观测**的，这样"它到底有没有被走过"不再靠猜。另外，审计类文件的失败取向必须是"认不出 = 没发生过"且**不能抛**——它坏了不能让请求失败，但这也意味着**写错它会静默失效**（见 §36）。

## 36. `writeStateFile` 要的是已序列化的字符串，传对象会静默落一个 `[object Object]`

- **现象**：新写的状态文件读回来永远是 `null`，插桩看文件内容是字面量 `[object Object]`——没有异常、没有告警，只是"好像从没写过"。
- **根因**：`src/host/state-store.ts` 的 `writeStateFile(file, payload, { temporary })` 内部曾是 `` `${payload}` ``（模板字符串），**不做 `JSON.stringify`**。每个既有调用方（`throttle-store` / `catalog-store` / `switch-store`）都自己先 `JSON.stringify(...)` 再传，所以这个契约只存在于调用方的示范里——新调用方按"传对象"的直觉写，就会静默产出一个不可解析的文件。**原语已加固（2026-10）**：`writeStateFile` 现接受 `string | object`——字符串逐字写、对象自动 `JSON.stringify`、`null`/裸原始值直接抛错，`[object Object]` 陷阱在原始层面已不可能复现；本条保留作历史记录，教训（状态文件写入必须可解析、写失败必须可观测）仍然有效。
- **修法**：调用处序列化，并在 `admission-audit.ts` 的调用点写了注释说明原因。审计/节流这类"读不出来就当作没发生"的文件，是这个坑危害最大的地方——它的失败方向与"真的没发生"完全同形。
- **验证**：`test/admission-audit.test.mjs` 断言落盘文件恰好四个字段（`version/count/lastAt/lastMethod`）且能被 `JSON.parse`——传错类型时这条会红。
- **教训**：**参数类型是"字符串"却长得像"载荷"的 API，是静默失败的温床**。收敛原语时（§34 的教训）把"I/O 怎么做"收上来了，但"传进去的东西是什么形状"留在了每个调用方的示范里——跟 §34 同一个病：抽到一半。

## 37. 「面板值 > 配置默认」手抄十一处会漂移，且藏了四类真实缺陷

- **现象**：opt-in 开关的启用判定「面板存过的值胜过配置默认值」在 11 个调用点各自手抄，肉眼看都「差不多对」，但行为并不一致；其中几处带着只有在边界情形才暴露的真实 bug。
- **根因**：这条规则需要在每个开关处都回答「有没有面板值？没有就回退配置默认吗？」，而它有两个语义分叉与一个易错写法：
  1. **AgnesCode 没有配置默认**。其余开关（provider / draw / video）可回退到 `settings.*` 的布尔默认值；AgnesCode 的启用完全由面板决定、从不读 `settings`。一旦某处被「顺手」写成 `panelValue ?? settings.x`，补丁里哪天多出一个默认值时，AgnesCode 就会在用户毫无操作的情况下**自行注册**。
  2. **`panelValue ?? x === true` 的运算符优先级**：`??` 的优先级低于 `===`，于是 `panelValue ?? effectiveSettings.registerProvider === true` 实际解析成 `panelValue ?? (effectiveSettings.registerProvider === true)`——结果恰好对，但读起来像「panelValue 为空时用 settings 的值」，诱导后续编辑者误以为它做的是回退比较，进而改坏。
  3. **值与来源各读一次会翻车**：`snapshot-aggregate.ts` 一度先读 `enabled` 判定显隐、再读一遍判定来源，两次读取之间状态一翻，本该标 `panel` 的会落 `config`。来源（panel / config / off）必须和值**同一次**派生。
  4. **`store ? store.enabled() : null` 再 `.catch()` 会 TypeError**：store 缺席时表达式是 `null`，对 `null` 调 `.catch` 直接抛——`undefined` 与 `null` 都得先判空再链。
- **修法**：抽 `src/host/switch-precedence.ts` 作为唯一裁决处，三个函数承载全部语义：`resolveSwitchEnabled(panelValue, configDefault?)`（**不传** `configDefault` ⇒ 未设置的面板值解析为关，正是 AgnesCode 语义）、`resolveSwitchValue<T>(panelValue, configDefault)`、`readPanelValue<T>(read)`（store 缺席 / 读不到一律返回 `null`，一并消掉 `.catch` 陷阱）；三函数都连 `source`（panel / config / off）一起返回。11 个调用点改为走它，`test/switch-precedence.test.mjs`（23 条）钉住两种语义分界 + 四类缺陷 + 一条接线钉（任何 host 文件仍自己拼 `?? settings.x` 或 `=== null ?` 即红）。
- **验证**：改动前后 `routes 190 / provider 204 / agnescode 119 / doctor 39 / switch-store 84 / admission-audit 27` 逐项计数一致；新增套件 23 条全绿。
- **教训**：**「差不多对」的多份手抄必然在某处分叉**，而分叉点往往正是边界情形。凡是一条判定规则出现在 N 个地方，就该抽成「返回结论 + 返回结论来源」的单一函数——来源和结论一起返回，才能杜绝「同一条规则被算两遍、中间状态变了」这类漂移（与 §34 同理：抽到一层不够，要抽到「所有 N 者共用的裁决入口」）。

---

## 38. 「看起来有的东西」：fork 与复制之后，共享层留下的零读者件

- **现象**：三次彼此独立的清理，根因是同一个——`CODE.JWKS` / `jwksEndpoint` / `encKeyId` / `JwksOptions`（Agnes 侧没有 JWE 封包端点）、AgnesCode 的 `state.signature`（只写不读）、`HostDeps` 的 12 个零读取字段。三者都不报错、不改变任何行为，却让读者以为存在一条路径或一个注入点。
- **根因**：本插件从兄弟插件 `dsh-connect-sensenova-token-plan` 起家，其后三件事各自改了实现层、漏了共享层：
  1. **fork 换实现**：登录流由「OIDC + JWE 封包」换成一跳账号密码，`agnes-auth.ts` 明说无 JWKS，但 `codes.ts` 的码表与 `types.ts` 的类型还留着那条线的名字——`host-config.ts` 甚至写着这些旋钮「are gone」，**文档说没了、类型说还在**。
  2. **复制机制**：Provider 侧的 `state.signature` 是活件（`snapshot-aggregate.ts` 读它做目录去抖，因为那边的调用方**轮询**、目录变化不请自来）；抄到 AgnesCode 侧后没有对应机制（每次 publish 都是显式调用、花名册随调用送达），于是只写不读。
  3. **借道取参**：publisher 起初没有自己的 deps 类型，就从 `apply()` 的宽包 `HostDeps` 里读六个字段。专用类型一落地，这六个连同六个 auth/transport 遗留一起失去读者。
- **修法**：删。判定只看**全仓有没有读者**，且必须**符号与字面量双查**——码是 wire value，可能不走 `CODE.X` 而写字面量。删除时要处理**连带件**，它们往往才是真正的误导源：一条名不副实的测试（`the signature covers the base, so a base change rebuilds` 实际只测纯函数性质）、一段自相矛盾的注释、以及一条会把 client 映射判红的**既有不变式**（`panel.test.mjs` 的「every code the panel branches on is declared in codes.js」）。
- **验证**：`panel.test.mjs` 先把 client 侧那四行映射判红——说明这**不是审美问题**，而是与既有不变式冲突；删除后 typecheck + 全量套件零漂移。`HostDeps` 收窄用负向验证钉住：把 `settings.registerProvider` 拼成 `registerProviders`，tsc 报 TS2551（改前是 `any`，拼错零反馈）。
- **教训**：**「看起来有的东西」比「缺东西」更贵**——缺东西会报错，看起来有的东西只会误导，而且专门误导不熟悉这份历史的读者（包括下一个 AI 会话）。两个动作可以制度化：每次**改实现**后问「共享层里还有谁在提这条旧路」，每次**复制一份机制**后问「它依赖的调用方形态，这边也一样吗」——AgnesCode 侧那两处 `state.built` 残留，就是没问第二句的代价。

## 39. 「点名守护物，而不校验守护物本身」：注释里的门禁不是门禁

- **现象**：三次审计各抓到一个，形状相同——某处注释**声称**有一条守护线，而那条线要么不存在、要么钉的是别的东西。① `src/client/wire.ts` 开头写着「`test/contract.test.mjs` asserts the snapshot's key shape」——该断言**从未存在**（`git log -S buildSnapshotBody -- test/contract.test.mjs` 全空），于是「client 半镜像了 host 的键」这条**自觉声明的复制约束**零覆盖：host 多加一个键、client 不声明，没有任何东西会红。② `src/host/llm-models.ts` 的 `supportedThinkingLevels` 写着「(pinned by test/render + routes)」——真正逐格比对的是 `contract.test.mjs` §6 与 `retry.test.mjs`，被点名那两个只是 fixture 里出现了同名字段，读者照注释去查会查到一个不存在的钉。③ `test/e2e.mjs` 的注释复述「A run that prints "all 24 checks passed"」——实际 61，且套件规模此后只会继续涨。
- **根因**：**注释里的门禁是承诺，不是可执行物**。它不参与任何构建、不进任何门禁，重构拆文件时它跟着源码一起被搬走并原样留下——而它恰好在所有既有护栏的打击面之外：`docs.test.mjs` 检查 `COUNT_GUARD`（活文档计数护栏）**只扫 `docs/` 的 md**，可是这类承诺最密集的地方恰恰是**代码注释**。（这三次抓到的三处，两处在代码里。）
- **修法**：两条腿，缺一不可。① **把承诺变成可执行物**：`wire.ts` 那条不是改注释了事，而是在 `contract.test.mjs` 新增 §10——client 半不能 import host，所以用**文本解析**取两侧顶层键（host 的 `return {` 字面量按 4 空格缩进取键、含 `...(cond ? { key } : {})` 条件键；client 的 `SnapshotData` 按 2 空格 indent 取字段），**硬断言 host ⊆ client**（host 服务的键而 client 没声明 = 数据被静默丢弃），反向差异（client 声明而 host 不产）只打印 note——那是 §38 的「看起来有路径」信号，靠 review，不该判红。② **把复述数字纳入护栏**：检查 `COUNT_GUARD` 新增「套件规模」子检查，并把扫描面**从 md 扩到 `src/` 与 `test/` 的代码文件**。代码侧**只跑这一条子检查**：`N 行` / `N 个模块` 在代码注释里语义完全不同（「见第 3 行」「3 个模块参数」），照搬必误伤；套件规模反而不存在这个问题——代码里除注释外不会说「N 项」。
- **验证**：跨半检查两条负向——往 host 的 `return` 里塞 `bogusKey` → `SnapshotData is missing: bogusKey`；把 `return {` 改成 `return{` 让解析失效 → **锚点守卫先红**（项数从 104 掉到 103，而非静默通过）。护栏本身也负向验过：临时往活文档写 `（123 项）` 与 `131 checks` 双双判红，而同行的「超过 500 项返回 400」（接口限额，非计数）**不判红**——这条合取是护栏能落地的前提。
- **教训**：**护栏上线的同一轮，它当场抓到了作者自己**——新写的注释里顺手复述了「94 项」「24 checks」，被自己的规则判红两处。这不是尴尬，是**设计证据**：只约束别人的规则等于没有规则。还有一条更隐蔽的：§10 的文本解析器必须有**存活守卫**（锚点键 `ok/now/quota/usage/llm` + **尾键哨兵 `shapeWarnings`**），否则正则一旦失配，两侧集合**双双缩水**，「相等」断言会以完全错误的理由通过——第一版正因为要求键后有 `:` 或 `,` 而漏掉无逗号的尾键，把 `shapeWarnings` 误报成「client 多声明」。**「点名守护物」这条病，护栏自己也同样会得**：写守护物时，必须同时写出「守护物失效时谁会喊」。

## 40. `persist()` 吞掉写盘失败，而调用方已经先把内存签名推进了：磁盘与内存永久分叉

- **现象**：面板显示 N 个模型、provider 也「已注册」，但重启后注册的是**另一份**目录；或面板上勾选的模型允许清单当场生效、**重启后回到旧清单**。日志无异常，`doctor` 也看不出问题。它与 §18（「两次 publish 并发，慢的那一次赢」）**现象同形**，但 §18 的修法（`publishChain` 串行化 + `disposed` 闸）对它**完全无效**。
- **根因**：写盘失败被**有意**吞掉，而调用方在吞掉之后**继续推进了内存状态**。三处各自的注释都是对的，合起来才出错：① `catalog-store.ts` 的 `persist()` 明说「a write failure only loses the cache」——只读 Home 不能让面板挂掉，这是**承重设计**，不该改；② `replace()` / `setEnabledIds()` 的契约因此是「**写盘失败也不抛**」，内存副本照样更新；③ 但 `snapshot-aggregate.ts:444` 与 `routes/models.ts:85` 在调用它们时，**先**把 `providerState.signature` 赋成了新目录/新清单的签名，**再**才（可能失败地）写盘。于是写盘失败的那一刻起，**内存签名描述的是「磁盘上并不存在的目录」，而它的唯一用途正是「相等就跳过 publish」**。后果分两条路：**重启路**（可自愈）——`seedPublisherFromCatalog` 从磁盘读回旧目录并算成签名，下次轮询目录变了 → 重新 publish，这条是通的；**不重启路**（卡死）——进程继续跑，磁盘停在旧目录、内存签名是新目录，下一次轮询 `catalog` 来自小时级缓存、签名相等 → **永久跳过**，而磁盘上那份旧目录会在**下次进程启动时被播种成正式注册**——面板与实际注册分叉，与 §18 的现象逐字相同。
- **修法**（三选一，按侵入性排序；**不要动 `persist()` 的吞错语义**——那是承重设计）：① **可观测方案（最小，最合本仓 §35 精神）**：让「磁盘与内存分叉」从不可见变可见，不改任何行为。**已落地**（`doctor.ts` 的 `probeStateWritable`），但落地形式与当初设想**不同，且这个差异是要点**：原先设想的是「比照 `admission-audit.ts` 记写盘失败次数/时间」，写下来才发现它撞上**递归陷阱**——**记录「写盘失败」本身要写盘**，而写盘正失败着；退一步记到内存里也行不通，`doctor` 是**另一个进程**（`diagnose` 收 `dshHome` 参数），读不到。所以改成**主动探测**：doctor 往状态目录写一个 `.write-probe-<pid>-<ts>` 探针文件（`flag: "wx"`、立即删除），直接回答「**现在能不能写**」，而不是「上次有没有写失败过」。这比原设想更强——它免疫递归，且正好是本条教训的字面落实（§39：**别点名守护物，要校验守护物本身**）。两条纪律写进了实现：**不 `mkdir`**（探测不得创建它正在询问的目录，否则它会改变自己喂给报告的那个事实——`readScope` 只在目录已存在时才被调用）；**只在 `false` 时报行**（`true` 是常态、`null` 是无话可说，报它们会训练读者跳过这一行，那正是诊断件失效的方式）。
  - 这条探测回答的是**本条的确切症状**：只读的 doctor 会如实报告**旧** catalog，永远不知道有个更新的没落盘。新增 `DoctorScope.writable`（`true`/`false`/`null`=无目录可问），`renderReport` 在 `false` 时输出 `STATE DIRECTORY IS NOT WRITABLE — writes are being swallowed`，并说清代价（「面板可能显示一份**重启后不会存在**的 catalog」）。
② **保守方案**：`replace()` / `setEnabledIds()` 返回「是否真的落盘」，写失败就**不更新** `providerState.signature`——代价是下一次轮询会重试写盘（可接受：写盘失败本就是异常态）。**已落地**：两个方法现返回 `Promise<boolean>`（写失败吞错但如实回 `false`），`snapshot-aggregate.ts` 与 `routes/models.ts` 只在返回 `true` 时推进签名；形态护栏 `test/state-authority.test.mjs` 的台账同步更新，行为验证在 `routes.test.mjs` 组 S——注入一个永远写失败的 store，断言下一次同目录轮询**仍会**重发 publish，而不是因签名相等被跳过。③ **对齐方案**：把两处 `providerState.signature = …` 的赋权**移进写盘成功的回调内**，让签名与磁盘同生共死。**未做**——② 已消除本条的分叉根源，③ 的收益只剩「结构上不可能再写错」，权衡后未取。
- **验证**：注入一个 `writeStateFile` 必失败的 store 替身，断言「写盘失败后，下一次同目录轮询**不得**因签名相等而跳过 publish」（方案 ②/③ 会红→绿）；方案 ① 则断言失败计数真的进了 doctor 报告。参照 §34 的纪律——**「进程内答案正确」永远不能替代「重开一次读回来」**，这条必须**两个 store 实例**测（第一个写失败，第二个读磁盘）。本次反向审计已用一次纯离线实验（模拟 `persist()` 吞错 + 真实磁盘基线）复现全部五个环节：磁盘基线 A → 写盘失败被吞后磁盘仍是 A → **第二次轮询因签名相等而跳过** → 重启路可自愈（磁盘签名 ≠ 内存签名）→ 按方案 ②/③ 不推进签名则不跳过；其中第 3、4 条的并置正是本条的关键：**分叉真实存在，但只在「不重启」这条路上卡死**——这解释了它为何至今没被撞见：重启是开发者的本能动作，而重启恰好是自愈路径。
  - 方案 ① 的落地验证（`doctor.test.mjs` 新增 8 条）：可写目录答 `true`；**不存在的目录答 `null` 且探测确实没有把它创建出来**（这条钉的是「探测不得改变它问的东西」）；探针文件不留残留；`true` 与 `null` 都不产生报告行、只有 `false` 产生且必须说清代价。
  - **只读目录答 `false` 这一条在本机（Windows）是跳过的**——`chmod` 对目录几乎不限制，CI 的 Linux 才是它真正跑起来的地方。所以**没有以本机绿为准**（§41 的准则）：另跑一次离线实验，把 CI 的输入直接喂给判定逻辑——`writeFile` 抛 `EACCES` + 目录存在 → `false`，`EACCES` + 目录不存在 → `null`，写成功 → `true`。**复现目标平台的输入**，而不是等 CI 告诉我。
- **教训**：**每一次「正确地吞掉一个错误」，都可能在调用方制造一个新的静默面。** `persist()` 的契约是「失败不抛」，而调用方误把「不抛」读成了「已生效」。这类坑**不会以新条目出现，它会伪装成已有条目的复发**（这里伪装成 §18），正是 §38 警告的「看起来有的东西」——所以本条与 §18 **必须分开登记**：触发条件（两次并发 vs 一次写盘失败）、根因（await 让同步去抖失效 vs 签名自己成了掩盖写盘失败的机制）、修法（`publishChain` 串行化 vs 让签名与磁盘同生共死）三者都不同，照 §18 去修这条只会白忙。给状态字段定契约时要问的和 §28 是同一个问题——**它的每一个内存写入点，是不是都与磁盘写入点同生共死？** 不是的话，就把权威挪到磁盘侧（方案 ②/③），或至少让它可见（方案 ①）。

## 41. 护栏的存活守卫自己漏了平台假设：`split("\\")` 让它在 Linux 上永远判红

- **现象**：§40 落库后 CI 硬门禁红、本机 `npm test` 全绿。失败的是**这条坑自己新加的护栏**中的一条存活守卫：「递归覆盖子目录（routes/ 等未被漏掉）」，而它的 detail 里赫然列着 `..., routes.ts, routes, snapshot-aggregate.ts, ...`——`routes.ts`（文件）与 `routes`（目录）**同时出现在同一个「顶层项」集合里**，这个自相矛盾的输出就是破绽。
- **根因**：`relative()` 给出的路径分隔符**随平台变**（Windows `\`、Linux `/`），而守卫第一版硬切反斜杠：`relative(SRC, f).split("\\")[0]`。在 Linux runner 上，整条 `routes/account.ts` 不被切开，集合里于是没有 `routes` 这一项，`scannedDirs.has("routes")` 判假 → 红；Windows 机缘巧合能切开 → 绿。**这条守卫存在的意义恰恰是「防护栏静默失效」**（§39 那条教训的落地），它自己却因平台假设失效了一次——而且失效方向是「永远判红」，比静默通过更吵，但同样说明它测的不是它以为在测的东西。
- **修法**：归一化改用跨平台正则 `split(/[\\/]/)`，两处都改——白名单比对的 `rel`（**第一版只把 `\` 换成 `/`，在 Linux 上是恒等操作，等于没归一化**）与存活守卫的顶层目录名。判据：**任何拿 `relative()`/`join()` 结果做字符串切分的检查，都必须用 `/[\\/]/`，不得出现裸 `split("\\")`。** 这条判据已升格为机械检查 `test/platform-assumptions.test.mjs`（扫 `src/` 与 `test/` 全部源码与测试，零命中；并自带「正则能命中坏样例」的存活守卫——把正则改坏它当场喊）。
  - **同一套件刻意放过 `split(sep)`**：第一版把「拿 `path.sep` 切分」也列为违规，当场误伤了 `docs.test.mjs` 的两处 `rel.split(sep)`。复核确认那两处**是正确的**——`relative()` 产出的分隔符就是本平台的 `sep`，必然一致，它不是平台假设、它就是平台本身。这条误伤留成记录：护栏抓的必须是**真的会坏**（依赖某个平台的具体值），不是**看起来像坏写法**（涉及分隔符）。会误伤的规则最终只有两种下场——被人绕着走、或被人删掉，两种都让防线消失。
- **验证**：**不能以「本机跑绿」为准——第一版本机同样是绿的**（这正是本条与前一条红法的分界）。改法是把 **CI 的失败输入直接喂给归一化函数**，看旧写法是否复现、新写法是否消失：`"routes\\account.ts"` 与 `"routes/account.ts"` 两个输入下，`split(/[\\/]/)[0]` 都返回 `routes`，而 `split("\\")[0]` 在后者返回**整串**——与 CI 日志逐字吻合。**复现失败 + 证明消失**，才算验过；只跑一遍本机不算。
- **教训**：**「本机全绿」是 §32 那条教训的第三次发作，但载体换了**——§32 是「环境缺件」（runner 上没有 CLI / runtime / 构建产物）与「文件系统大小写」（同一路径的不同拼写），本条是「路径分隔符」（同一路径的不同**书写形式**）。三者的共同判据是一条可复用的验证准则：

  > **凡断言涉及「平台如何书写一个路径 / 定义一个环境」，就不能以本机绿为准，必须复现目标平台的输入。**

  推论有二：① **跨平台假设的守卫，要像 §39 要求「写出守护物失效时谁会喊」一样，写出「它在另一个平台上会怎样」**——本条的守卫当初若在 Linux 上跑过一次就不会漏，而 CI 恰好就是那张网；② **一个坏掉的守卫比没有守卫更坏**：它会给「这块已被覆盖」的错觉，而这条守卫的失败方式是**恒判红**，如果当时为了让它变绿而删掉它（而不是修分隔符），就正好消灭了唯一一条盯预测判据的机械防线。见 §40 与本条的分工：§40 管「状态字段的权威在哪」，本条管「检查它的代码别自己先坏」。

## 42. web 端浏览器控制台看不到插件报错——这是两半进程 + 有意降级的表象，不是错误丢了

- **现象**：面板出了错（登录失败、provider 缺席、某 tab 空白），用户打开 Web GUI 的 F12 控制台，里面干干净净，报错只在**面板文本框**里显示；于是自然地问「DSH 有没有内存环形日志（ring buffer），为什么控制台抓不到」。
- **根因**：三件事叠加，缺一都问不出这个现象——
  1. **插件是两半、跑在两个进程**（[ARCHITECTURE.md](./ARCHITECTURE.md)）：Host 半边（登录、重登、节流、provider 注册、控制台请求）跑在 **Node 服务进程**（跑 `dsh web` 的那个终端 / 桌面版主进程），它的 `console.log/warn/error` 冒到**服务器 stdout/stderr**；Client 半边（React bundle 面板）才跑在浏览器里。Web GUI 是浏览器 hitting `http://127.0.0.1:19387`，**Host 在它背后的另一个进程**——浏览器 F12 天然看不见 Host 的 console。
  2. **面板错误是故意「降级为数据」，不是抛异常**：HTTP **永远 200**，成败靠 body 里的 `ok` 与 `code` 区分，渲染进面板文本区（红线 6 / [ADR.md](./ADR.md) / [ARCHITECTURE.md](./ARCHITECTURE.md) §5 不变量 3）。一旦抛异常，浏览器控制台确实会响——代价是「一次读取失败」顺 React 渲染树炸穿，把一个模块的缺席变成整页崩溃，连带把不相关的另外两个 tab 一起埋掉；这正是本插件历史上真违反过一次、后来专门修掉的形状。所以**控制台安静是这套降级的表象，不是错误丢了**。
  3. **DSH 没有内置内存环形日志**；顶这个位的是**落盘 trace**——红线 5 强制「每一次登录尝试（成功也算）都经 `onTrace` 落 `$DSH_HOME/logs/`」，当初立这条红线的理由就是本条的现象：浏览器控制台指望不上，「浏览器能登、面板不能」只能靠落盘文件对照排查。
- **修法 / 排障的正确入口**（不改代码，改排查方向）：① 想抓 **Host 侧**报错（登录/重登/节流/provider 注册）→ 看跑 `dsh web` 的**终端 stdout**，或直接 `tail $DSH_HOME/logs/agnes-login-<时间戳>-<结果>.json`（`DSH_HOME` 默认 `~/.dsh`；trace 只记脱敏形状，凭据永不进去）；要「实时刷新」的体验就把 Host stdout 重定向到文件 `tail -f`，等价于一个磁盘环形日志。② 想调试 **Client 侧**（面板渲染决策）→ F12 控制台确实有，但多数不报是因为被 catch 成了面板文本，直接对照 `decidePanelView` / `test/panel.test.mjs` 的决策函数比看控制台快。**别在浏览器 F12 里找 Host 的报错，那里根本没有。**
- **教训**：与 §35 同一族——**「看起来缺一个东西」（这里是没有控制台红、没有环形日志）不等于「缺防护」**。§35 说「看起来缺一道检查」不等于缺防护；本条说「控制台没响」不等于错误没被记录。降级取向是**刻意的可观测设计**：把错误当数据摊到面板、把真相落到 `logs/`，换的是「一个模块缺席不带走全页」。排障时先认清**你在动哪一条线**（Host 进程 vs 浏览器），再决定去 stdout/`logs/` 还是 F12。

## 43. 承诺写在注释里，实现绕开它，护栏点名了别的东西——三层各自需要独立的存活守卫

- **现象**：三处缺陷形状完全一致，且**在评审前全部绿着**：
  1. `provider-publish.ts` / `agnescode-publish.ts` 在 publish 开头就把「目录身份」（`entries`/`enabledIds`/`unavailableIds` / `rows`/`bffBase`）推进到新值，构建失败时那条 `catch` **只写了 `state.error` 就 return**。旧 adapter 还在服务，而快照读的 `providerState.entries` 已经是那份从未注册过的目录——`registered` 仍是 `true`，把分叉伪装成「在服务」。
  2. `test/panel-decision.js` 的注释写着「Import the single-source decision from snapshot.ts to avoid duplicate derivation」，**下一行**原地重声明了同一个箭头函数；而 `snapshot.ts` 自己的注释说「callers should use `shouldShowAccountManagement(auth)` rather than duplicating `auth !== null`」。ADR-006 已把它记成「判据 1 的真残留」，但 71 条 `panel` 检查全绿。
  3. `token-store/throttle.ts` 与 `routes/api-key.ts` 各有一句「记录下来，否则无法排查」的告警，`.catch()` 却挂在**从不 reject** 的 store 上（`throttle-store.write` / `catalog-store.clear` 整段在 try/catch 里）——告警是**永不可达的死代码**，守的正是 §6 跨进程节流与 §40 写盘失败这两个最需要可观测性的位置。
- **根因**：三者都是**同一个形状**——注释/ADR 承诺 X，实现在 X 最该生效的那条路径上没做，而护栏绿着，因为护栏钉的是别的东西：
  - ①的护栏（`state-authority.test.mjs`）只认 `signature`。它是对的：`signature` 是**预测判据**（权威在磁盘），而目录身份是**事实判据**的近亲（权威在注册动作）。两族判据不同，却只给前者配了护栏。
  - ②的检查无法看见：重复的那行与原文逐字相同，所以任何「两边一致」的断言都恒成立；而 ADR-006 判据 3 要求的「改语义应红」当时是**反的**（改 `snapshot.ts` 的规则，`panel` 仍返回旧答案）。
  - ③的 `.catch()` 语法上无懈可击，语义上永空转——**它锚的是语法，不是可达性**。
- **修法**（三件都要，缺一件即复发）：
  1. **每个「没有产生新注册」的路径都必须恢复身份**，而不是只有 `onRollback` 那一条。两侧 publisher 各抽一个 `restoreIdentity()`，构建失败路径与 `onRollback` 共用它——注释里那句「must not keep pointing at a set we failed to publish」从此在**它唯一该生效的地方**成立。
  2. **护栏按判据分族补齐**：`state-authority.test.mjs` 增 E 组「身份判据」，锚在**机制**上（`describeBuildFailure(` 与 `warnBuildFailure(` 之间那段就是构建失败 catch 体）而非函数名清单。
  3. **注释声称的门禁必须变成可执行物**：`panel-decision.js` 改为真 import（`snapshot.ts` 是 ADR-006 认可的纯模块，Node 可直调），并在 `panel.test.mjs` 断言「client 规则与决策层答案一致」+「`viewOf` 的返回成员逐个核对」。
  4. **告警要锚在返回值上，不是 `.catch()` 上**：store 的 `write`/`clear` 改为**返回是否落盘**（与 `catalog-store.replace()` 既有契约一致，**不动吞错语义**——那是承重设计），调用方按 `false` 告警。
- **本条自身也踩了同一族**（如实记录）：E 组第一版用 `[\s\S]*?
 {2}\};` 取 `restoreIdentity` 的块体，它会从多余空格的第 3 位开始匹配，把闭括号**之后、函数体外**的推进赋值一起吞进「恢复体」——于是删掉恢复体里的一行，覆盖检查仍靠外面那行赋值而假绿。**这正是 §39 的形状，只不过这次是护栏自己得的病。** 改成缩进扫描（遇到缩进回到声明级即停），并给它配了一条「块体未越界」的存活守卫。
- **验证**（每条都「复现失败 + 证明消失」，不靠本机绿）：
  - ① 移除任一 `restoreIdentity()` 调用 → `publish-core` 与 `agnescode` 两套各红 2 条，且 detail 打印出面板真会读到的 `-v2` 花名册与 `bff-other` base；
  - ② 把 client 规则反转（`auth !== null` → `auth === null`）→ `panel.test.mjs` **红 4 条**（ADR-006 判据 3 第一次真的成立）；
  - ③ 把告警条件改成 `if (false)` → `store.test.mjs` 红 2 条；
  - ④ 删掉 `restoreIdentity` 里的一行 → E 组精确报 `未覆盖：unavailableIds`。
- **教训**：**「承诺 → 实现 → 护栏」是三层，每层都要有自己的存活守卫；上一层做对了不等于下一层会跟上。** 更一般的形态，与 §40 / §28 同族：**「正确地吞掉一个错误」在调用方会制造新的静默面，而「写了一句告警」在链路断了时同样制造静默面**——告警必须锚在**结果**（返回值 / 落盘事实）上，锚在**语法**（`.catch` / try）上等于没写。下次加检查时顺手问一句：**这条检查的受检量会不会是 0，而 0 也会让它绿？**

## 44. 同族两个工具都做了脱敏，就走岔路的那条漏了：不对称是「谁漏了」的最强证据

- **现象**：视频任务失败时，`video.ts` 把**平台返回的原始错误对象**拼进了一条**落进 agent 对话**的消息：`throw new Error(\`视频生成失败（…）：${detail}\`)`。一次 4xx 若把 API Key 原样回显，凭据明文就进了 agent 会话记录、trace、以及任何消费它的上游。**这是红线 1 的第四张脱敏表面（agent 工具 execute 错误）第一次被真正找到**（同条红线的其余三张：provider / 桌面端上游 / 路由，早就各有一处调用）。
- **根因**：`video.ts` 的 import 是 `import { str, num } from "./util.ts"`——**没有 `redactSecrets`**。它也没有走同族已经写好的 `describeVideoFailure`（`video-protocol.ts`，第 316 行就在脱敏），而是自己**手拼**了一条同形状的路径。`detail` 的来源是 `result.error` = `source.error ?? metadata.error`（`video-protocol.ts:289`），即**未过滤的上游 body**。所以「同族都脱敏、就这条没有」不是偶然遗漏，是**复用时绕过了现成的脱敏点**。
- **不对称就是证据**：同族的 `draw.ts` 在**完全对应的位置**（`describeDrawFailure`）做了 `redactSecrets(str(bodyText,"").slice(0,300))`，并且注释明写「this message lands in the agent conversation, not just a panel line — the same red line `redactSecrets` guards on」；`video-protocol.ts` 的 `describeVideoFailure` 也做了。**唯独 `video.ts` 这条「任务失败」路径既不走 `describeVideoFailure`、又跳过了 `redactSecrets`。**——评审时，**「同族两个都做了、第三个没做」的不对称，是定位漏网面最省力的线索**：它把「这里该脱敏吗」的疑问变成「凭什么它例外」。
- **修法**：`detail` 外包一层 `redactSecrets`（最小改动，不动控制流），并加注释点名这张表面与两个已合规的兄弟。`video.ts` 现在 `import { str, num, redactSecrets }`。
- **验证**：`test/video.test.mjs` 的既有「failed task」块扩为两条——平台 `error` 字段里塞一个假 `sk-…`，断言**消息里不含它**（负向：把 `redactSecrets` 那行临时替换为 `raw` → 该套件 `1/136 FAILED`），且断言**脱敏后仍保留诊断信息**（`video_id` + 其余 detail 都在）。
- **教训**：**复用一条「安全路径」时，要确认自己真的复用了它，而不是只复用了它的形状。** 抽出一个 `describeXxxFailure` 之后，每条同族路径仍要各自过一次 `redactSecrets`——因为「绕过 helper、自己拼字符串」看起来是同一条代码风格，编译器与 reviewer 都很难一眼看出它跳过了脱敏。**下次给某条新路径加错误消息时，沿着红线清单（本仓见 AGENTS.md ①与本条）逐条问「这条落进日志/面板/agent 了吗」，别假设同族别的路径已经替你做了。**（与 §15 同族；§15 点了「四张表面」，本条是那第四张第一次真的漏了。）

## 45. 平台给了权威值，客户端却自算，还顺手把它钳住了

- **现象**：面板进度条画的是客户端自己算的 `(used / limit) * 100`，而 **Host 早就解析出平台原值 `usage_pct` 一路下发到了 wire**（`parsers.ts:460` → `snapshot-aggregate.ts:216` → `wire.ts:37` 声明 `usagePct`），**`src/client/` 里读取它的点 0 处**。更刺眼的是两处文档都写着相反的话——`AGNES-API.md:109`「进度条是逐字转写，不是计算」、`API.md:47`「面板画进度条用 usagePct」。三处事实里文档是对的，客户端是那个「分头走路」的。
- **根因**：`wire.ts` 声明了字段，但**声明不等于消费**；契约门禁 `contract.test.mjs` 钉的是「host ⊆ client 的键集」（Host 有、client 也声明了 `usagePct`），**它不检查 client 是否真的读了那个值**。而客户端自算那行不仅「多此一举」，还**钳制**了结果：`Math.min(100, …)` 把平台报的 `>100`（超额窗口）封顶成 100%。所以这不是「等价实现」，是**悄悄改写了平台口径**——平台说 130，面板说 100。
- **修法**（`cards.ts`）：优先用平台 `usagePct`；**仅当它缺失或为 null 时**才回退 `used/limit` 的算术值（老 Host / 某窗口读不到百分比），并撤掉 `Math.min`。与 `used` 已有的「缺失不是零」纪律同源。
- **验证**：`render.test.mjs` 新增 A1b 组——① 平台值与算术值分歧时（`used/limit=25%` 但 `usagePct=33`）必须显示 33.0%；② 超额窗口（`usagePct=130`）**不被封顶**成 100%、且仍取 danger 色；③ `usagePct: null` 回退到算术、不渲染 NaN。**负向**：把优先级退回自算 → 该套件 `4/235 FAILED`。既有 A1 组的 fixture 不带 `usagePct`，因此**回退路径仍被原有断言钉住**（未被新行为顶掉）。
- **教训**：**「契约里有这个字段」和「代码用了这个字段」是两个断言，键集门禁只管前者。** 权威值的正确用法是**优先引用、缺才回退**，而不是自己重算一遍再把权威值扔掉。另一个更硬的判据在本次里浮出水面：**只要代码里有任何对平台值的钳制/改写**（`Math.min`、四舍五入、单位换算），就不再是「逐字转写」——**钳制是一种口径覆写**，哪怕方向看起来无害。文档里那句「逐字转写」既然已经写死，就应当是一条可被本条这类负向测试兑现的承诺。（与 §25「形式门禁全绿不代表文档说了实话」同族，但本条更隐蔽：§25 是文档说谎，本条是文档**说对了**而代码在骗它。）

## 46. 护栏把一个错误归因钉成了「正确」：修 bug 前得先承认当初判断错了

- **现象**：面板把 HTTP 403 一律读成「令牌已失效，请重新登录」，而 **Host 全仓唯一的 403 来自它的同源闸**（`routes/http.ts:77` `refuseOrigin`，body 是 `{ok:false, error:"forbidden: origin mismatch"}`）——即**凭据没问题，是来源/Host 头对不上**。于是用户被引导去做一件**修不好这个问题**的动作（重新登录）。`panel-page.ts` 更进一步：在 `!response.ok` 时**直接 return，连 body 都不读**，把 Host 明明写出来的原因扔了。更矛盾的是紧随其后那行注释还断言「Host 对每个预期失败都答 200 + ok:false」——**同源闸恰是唯一答 403 的那个**，注释的前提对它不成立。
- **根因**：**401 与 403 在「非 2xx 里没有 body」这个假设下无法区分，但那个假设是错的**——403 恰恰有 body。当年的映射把 403 和 401 焊成同义（都读成 `jwt_expired`），并被 `render.test.mjs` 一条**循环断言**固化下来。于是**修复的第一步是先拆掉这条护栏**——它不是障碍，它是**错误被制度化的现场**。这与 §43「护栏点名了别的东西」互补：**§43 是护栏钉错了对象，本条是护栏把错的答案钉成了标准**。
- **修法**：`errorOfStatus(status, bodyError?)`——403 且 body 里有非空 reason 时，**保持 transport string 并原样显示 Host 的措辞**（`viewOf` 因此不弹登录引导、`guidanceKey === null`）；**裸 403（无 body / body 空白）仍按令牌失效读**（无解释的状态码，更可能是凭据而非闸）。`panel-page.ts` 改为**尽力读错误信封**（读不到/形状不对就退回原逻辑）。
- **验证**：`render.test.mjs` 里那条把 401/403 一起 loop 的旧断言**拆成三段**——401 仍读作令牌失效并弹表单；403 带 reason 显示真实成因且 `guidanceKey === null`；403 空/空白 body 回退到旧读法。**负向**：删掉 403 的 body 分支 → `2/237 FAILED`。
- **教训**：**一个把错误归因写进断言的护栏，会在 bug 被修好时挡住修复**——所以「红」不总是「回归」，有时是「护栏在拦一道本该推倒的旧判断」。动手前先分清是这两种红里的哪一种。本条的一般形态：**当一个断言把「某种状态码 ⇒ 某种原因」的映射钉死时，先问「这个映射在所有来源上都成立吗」**——同一个状态码可能由不同层发出（401 来自凭据、403 来自同源闸），把它们并成一条，等于替上游做了它没做的区分。另：丢弃 body 的写法（「`if (!res.ok) return;`」）在**错误分类靠 body 的 HTTP 上是反模式**，它把「上游已经把原因算好了」这一步扔在了地上。

## 47. 清单类契约的变种：清单本身在包里，而它指的东西从没被打包

- **现象**（§26 的变种）：`screenshots.json`（在 `package.json` 的 `files` 白名单里，**随包发布**）声明 `assets/panel-credit.png`、`assets/panel-API-provider.png`，两张图**都在 git 里、磁盘上都在**。但 `assets/` **不在 `files` 白名单里**。于是**装到别人机器上时，包里有清单、没有图**——市场页截图全裂，而**所有门禁全绿**：工作树干净、构建通过、e2e PASSED。
- **根因**：§26 是「清单指空名」（指向已删文件），本条是「**清单指的东西从未进包**」——**同一个病的两端**。漏掉它是因为 `docs.test.mjs` 的 `SCREENSHOTS` 检查只验「清单里的每条**存在于磁盘**」，**从不验「存在于 tarball 内」**。而 `files` 白名单是**另一条独立的门禁**（`package.test.mjs` 只验 `main`/`exports` 入口被覆盖）。**两条门禁各自都合理，缝隙正好落在「谁指的」×「在不在包里」这个交叉点上。**
- **修法**（两半，缺一即复发）：① `package.json` 的 `files` 加 `"assets"`（`npm pack --dry-run` 从 16 文件 / 242 kB → 18 文件 / 340 kB，两张 PNG 确认进包）；② `package.test.mjs` 增「**`screenshots.json` 每条都被 `files` 覆盖**」检查，复用入口检查已有的「祖先目录也算覆盖」匹配。**负向**：把 `"assets"` 从 `files` 移除 → 精确报 `2/169 FAILED`（detail：`declared in screenshots.json but excluded from package.json files`）。
- **附带发现（门禁自己抓到的）**：`files` 一改，`docs.test.mjs` 的 `SNAPSHOT`（`docs/DSH-PLUGIN.md` 教学快照的 `files` 数组必须镜像 `package.json`）**立刻变红**——这就是这套门禁网的价值：白名单和它的文档镜像绑在一起，漂移当场可见。同步快照时特意在该条目上留了注释（说明「清单在包里而图不在包」的后果），防后人当「无用项」删掉。
- **教训**：**「文件存在于仓库」≠「文件存在于发布包」**，而引用清单的机器消费方（市场页、`screenshots.json`）只认包。给任何「按名字引用别的文件」的清单加东西时，顺手问一句：**被引用的那些，也在发布面里吗？**（与 §26 同族；§26 漏在「磁盘」，本条漏在「包内」。）

## 48. 护栏的存活守卫漏了**时间**假设：`now + 1h` 让门禁每晚 23:00 后固定转红

- **现象**：每天 **23:00–00:00** 之间跑 `test/render.test.mjs`，**恰好红 1 项**——「a same-day reset prints the clock alone」，detail 里赫然是 `重置 10-04 00:59`（23:59 跑的，`now+1h` 已经跨到明天）。同一份代码在白天跑**全绿（257/257）**，所以它既不会被白天的本机 `npm test` 抓到，也不会进任何一次人工排查的第一现场——它只在那个特定小时里存在。**这是一个每天定时炸、炸完自己消失的门禁。**
- **根因**：fixture 用**相对偏移**构造「同日」样本——`laterToday = now + 3600`（`render.test.mjs:175`），再断言渲染结果**不含**日期（`!/\d{2}-\d{2} \d{2}:\d{2}/`）。但 `clockSameDay` 判的是**日历日相等**（`format.ts:30-38`），于是 23:00 之后 `now+1h` 落在**明天**，格式化器**完全按契约**输出 `MM-DD HH:mm`，而断言仍在要求一个裸时钟。**红的不是代码，是 fixture 自己违反了「同日」这个前提**——注释（`render.test.mjs:168-170`）与断言本来就写着「同日折叠成 `HH:mm`」，偏偏构造出来的时刻在夜里不是同日。也就是：**测试的意图与它的构造式互相矛盾，而这个矛盾只在特定钟点显形。**
- **修法**：把「同日」由**偏移**改为**按构造恒为当天**——`new Date(y, m, d, 23, 58, 0)`，取当天 23:58 的本地墙钟时刻。它**在一天里的任何时刻都是「今天」**，前提因此结构性成立，不再依赖运行时刻。`tomorrow`（`+48h`）保持偏移形式不动：它断言的就是**跨日**渲染，跨夜正是它想要的。
- **验证**：脚本对 `09:00 / 22:59 / 23:00 / 23:30 / 23:59 / 00:01` 六个钟点各跑一次两种构造式的同日判定——**旧式恰在 23:00 / 23:30 / 23:59 三个点判 `false`，新式六个点全部 `true`**（含整个危险窗口）。修复后 `render.test.mjs` 257/257 全绿。**注意验证方式**：本条的窗口一旦错过就要再等一天，**不能靠「现在跑是绿的」证明修好了**（跨过午夜后旧写法同样会绿）——必须用**注入钟点**的方式把窗口逼出来，如上。
- **教训**：**「守卫的存活假设」除了平台（§41）还有时间。** §41 是守卫漏了**平台**假设（`split("\\")` 在 Linux 上永远判红），本条是同一个病落在**时间**轴上：**任何用「当前时刻 + 偏移」构造的样本，都要先问「这个偏移会不会跨过它正在断言的那条边界」**——判「同日」的样本偏偏用偏移去造，而偏移在夜里必然跨日。三条可迁移的判据：① **样本应当按构造满足前提，而不是按运行时运气满足**（写「今天」就钉今天的钟点，别写 `now + Δ`）；② **定时窗口型的缺陷要主动注入钟点复现**，不要指望下次撞上——它每天只存在一小时，且**错过之后「跑一遍是绿的」会伪造出「已修复」的假象**；③ 这类缺陷**不进第一现场**（白天全绿、CI 排班若不在该小时也全绿），因此它比普通 flake 更危险：**别人看到的是「这仓库的门禁会无故变红」，而被腐蚀的是整套纪律的可信度**。（与 §41 同族：**护栏自己掉了假设**；§41 掉的是平台，本条掉的是时间。另与 §46 呼应：**红不总是回归**——本条的红是 fixture 的问题，修的时候要动测试而**不是**去动 `format.ts` 那个正确的实现。）

## 49. 复用一个「拒 0」的读数助手，把「免费」读成了「未声明」

- **现象**：AgnesCode 的模型倍率要接进面板与模型名（`· xNN.NN`）。倍率字段 `points_cost_multiplier` 在平台侧用 **`0` 表示「该模型免费」**——那是**已公布的价格**，不是缺字段。而本仓现成的两个读数助手 **`num()`（`util.ts:35`）与 `numOrNull()`（`util.ts:123`）都写死 `value > 0`**，对它们的**原用途**（额度上限、窗口大小、计数）这是**正确的**：那些量报 0 等同于「平台没说」。但复用到倍率上，`0` 会被判成缺失、静默返回 `undefined`，于是**四个免费模型的「免费」事实凭空消失**——面板不画芯片、模型名不带后缀，**没有任何东西会红**（缺字段与免费字段在渲染层同形）。
- **根因**：`num()` 的 `> 0` 不是「防御性」而是**一条领域断言**：「这个量不可能是合法的 0」。它只在**调用方所属的领域**成立。跨领域复用这个助手，等于**把那条断言偷偷搬到了不成立的地方**——而它不会抛错，只会安静地把合法值翻译成缺失值。这与红线⑦「不得计算剩余」是同一族病：**把一个领域里没人能负责的推导，搬到一个它其实有确切答案的地方**；也与 §45「平台给了权威值，客户端却自算」互补——§45 是扔掉了权威值，本条是**把权威值读丢了**。
- **修法**：新增 `numZeroOk()`（`util.ts`）——**只对倍率这类「0 是合法价格」的字段使用**：`0 → 0`（宣称免费）、缺席 / 非数字 / 非有限 / 负 → `undefined`（不做宣称）。**不改 `num()` / `numOrNull()`**：它们对原调用方的语义正确，放宽会把「平台没报」误读成「平台报了 0」，那是同一个病的镜像方向。
- **验证**：`test/agnescode.test.mjs` 三条负向可分辨的断言——① 显式 `points_cost_multiplier: 0` 必须**活下来**（`catalog[0].multiplier === 0`）；② `5.3` 原样传递；③ **缺席必须缺席**（`!("multiplier" in row)`）。README/面板侧另由描述符测试钉显示名：`· x0.00`（免费）、`· x1.85`（付费）、无字段则**裸名**。真机端到端复核（`/v2/models` 实拉）：`agnes-3.0-flash · x0.00` / `glm-5.2 · x1.85` / `kimi-k3 · x5.30`，与桌面端选择器逐一对上。
- **教训**：**判断一个「缺省/兜底」助手能不能复用，要问的不是「类型对不对」，而是「它替我做的那个领域断言，在我这里还成立吗」。** 三条可迁移判据：① **`0` 与「缺失」在业务上经常是两件事**——数字字段接进来前先问「这个域的 0 是价格、还是没读到」；② **静默同形是最贵的失败**：缺字段与「值为 0」在渲染层长得一样，所以这类 bug **不会红，只会让面板少说一句话**，只有专门的负向断言（显式 0 vs 缺席）才抓得住；③ 修法应当**新增一个更精确的助手，而不是放宽旧助手**——放宽 `num()` 会让它的老调用方把「没读到」读成 0，把同一类错误制造到别处。（与 §45「扔掉权威值」互为镜像；与红线⑦「不得计算剩余」同族：**都是让一个领域的规则越界去管另一个领域**。）

## 50. 每一层失败处理都只对「它认识的失败形状」生效——没人为「认识机制本身失效」留一层

- **现象**：一跳登录的失败处理看起来很密：`classifyLoginFailure` 分五类、凭据型停车、平台声明窗口照单全收、五个额度源一律软失败、状态文件「损坏即忽略」。但**每一层的兜底都是手工枚举，而枚举表的下沿就是悬崖**，四处同时成立：① 分类器认不出的措辞落到 `LOGIN_FAILED`，而它**不在** `CREDENTIAL_REFUSALS` 里 → 不停车 → 本地退避**无限**重试。平台改一个词（密码过期 / 需要重置 / MFA），防锁号机制就变成自动撞锁——它只在平台恰好使用已枚举措辞时生效。② `ACCOUNT_LOCKED` 同样不在停车表：分类器认出了「号已锁」，停车表不认，于是对**已锁账户**定时重发密码，而「需要验证码」反而停了车（就因为那张表只有两行）。③ `throttle.json` 的 `version` 不匹配一律读成「无记录」——对 parked 记录那等于解除防撞锁，所以**改一次版本号就静默解开全机所有锁**。④ `quota.error` 是**单值**，四个源并行取可以同时挂掉几个，只报第一个时，「平台挂了」与「平台挂了 + 你没登录」不可分辨，用户修好报出来的那一半、下一轮才撞见另一个。
- **根因**：**失败的形状是开放集合，而处理它的机制是封闭的枚举。** 枚举型兜底有一个共同缺陷：它的 `else` 分支必须选一个方向，而这个方向总是**照着已认识的形状里最常见的那种**挑（此处是「暂时故障，退避重试」），因为那在已知集合里是对的。于是**未知形状被翻译成最危险的那个动作**，且翻译发生在没人看的地方：`LOGIN_FAILED` 的语义是「我不知道这是什么」，而下游读它读到的是「可以重试」。同一病的另外两张脸：**版本演进**把「读不懂」翻译成「没有」（保守方向被选反了），**单值报告**把「多个失败」降维成「一个」（契约层就决定了，实现层无法补）。
- **修法**：给「猜」设上限，给「读不懂」设保守方向，给「集合」留数组。① `MAX_INVENTED_WAITS = 3` + `exhaustsInventedWaits()`：自造退避（平台**没**声明窗口的那些）最多 3 次，之后强制停车；**平台声明的窗口永不计数**（那不是猜，截断它才是走进锁里）。② `MIGRATIONS` 迁移缝：改 `THROTTLE_VERSION` 必须同时加一条迁移；更高的版本（另一个进程写的）按 `FOREIGN_VERSION_WAIT_MS` 短等一次再重试读，**不是**当作没记录。③ `quota.errors` 与 `quota.error` 并存：单行答案保持权威（面板与既有测试都读它），全量集合另开字段；没失败时是 `null` 不是 `[]`。④ 顺带补两张**纪律型**安全的脸：日志出口（8 处 `logger.warn` 里 7 处没过 `redactSecrets`——脱敏只防住「记得调它的人」）改为全部脱敏；`void p` 收敛为 `forget(p)`（Node 15+ 会为未处理 rejection 终止进程，而本仓**刻意**不装 `process.on` 网——插件不能在别人的进程里装全局处理器，所以保证只能逐调用点给）。
- **验证**：`test/store.test.mjs` 新增 9 条——第 1、2 次未识别拒绝仍在等待、第 3 次**停车**、停车后无 deadline；平台声明的 2h 窗口**不**被转成停车；`rate_limited` 保持无限退避（等待真能治好它）；`version: 99` 不读成「无节流」且给出等待、`version: 0` 无迁移路径时仍读作无记录。`test/routes.test.mjs` 3 条：`errors` 是数组且 ≥2 条、`error` 是它的第一条。`test/provider.test.mjs` 4+4 条：裸 JWT（无论键名）被脱敏、普通带点标识符不被误伤；`forget` 把 rejection 变成一条脱敏 warning 而非崩溃、非 promise 静默接受。冻结基线（`store-baseline`）零漂移——S4 用 `rate_limited` 且 attempt 只到 2，封顶阈值在它之上。
- **教训**：**看到「分类 + 兜底」就要问一句：兜底方向是不是照着已知形状里最常见的那个挑的？** 三条可迁移判据：① **兜底分支的语义是「我不知道」，下游读它却会读成「可以重试」——这种语义落差必须显式钉死**（要么给未知形状一个尝试上限，要么让它走最保守的分支，不能让它复用已知形状的乐观分支）；② **「读不懂」不等于「没有」**，二者的保守方向常常相反（对节流是「当作有」，对目录缓存才是「当作没有」），**逐状态决定，别让一个通用的 `return null` 替所有状态做这个决定**；③ **枚举表的每次扩展都要问「这张表的下沿是谁」**——新增一个 code 要问它停不停车、新增一个 version 要问旧文件怎么读、新增一个源要问它的失败报不报得出来。（与 §44 同族：**不对称是证据**——本条里 `ACCOUNT_LOCKED` 比 `VERIFICATION_REQUIRED` 得到更激进的重试待遇，就是那张两行表的形状直接暴露的；与 §46 呼应：**兜底归因错了，机制会照着错误归因稳定地做错事**。）

## 51. 聚合核心谎称「纯投影」却内联副作用——纯核心的边界要用单一副作用函数锚死

- **现象**：`snapshot-aggregate.ts` 的 `buildSnapshotBody` 头注释自述 "Pure by design: ... No HTTP surface, no filesystem writes, no module-level state"，但实测（2026-10-05 摸排）它在 509–540 行内联了本函数**仅有的两处真实 I/O**：`catalogStore.replace(catalog, enabledIds)`（PITFALLS §40 的写失败处理）与 `publisher.publish(catalog, enabledIds, unavailableModelIds)`（provider 重注册）。注释与现实自相矛盾：它**不是**纯投影，是"纯投影 + 顺手落盘 + 顺手重注册"。下一个改快照的人看到头注释会把它当纯函数单测，结果测到的是带副作用的时序；或反过来，想加一条副作用时又顺手内联回核心，让"纯聚合"的谎越撒越大。
- **根因**：`buildSnapshotBody` 把"读 wiring 字段 + 纯聚合出 quota/usage/llm 块"和"把 catalog 落地 + 触发 provider 重注册"**混在同一函数体**。前者是纯计算（可被 `routes.test.mjs` 用 stub 钉死每个分支），后者是**必须在挂载期发生的副作用**（catalog 持久化失败要软降级、provider 重注册要按 signature 跳过）——两者生命周期不同，却共享同一个函数边界，于是边界被注释假装掉。
- **修法**（commit `ae6cd87`）：把 509–540 的 catalog 持久化 + provider 重注册抽成**同文件** `applyCatalogEffects({catalogStore, publisher, providerState, catalog, enabledIds, unavailableModelIds})`；`buildSnapshotBody` 现在只剩"抓取 + 纯投影"，头注释改为"唯一副作用已隔离在 applyCatalogEffects"。签名推进逻辑（`freshSignature !== providerState.signature` 才写、写失败不推进 signature）与调用顺序**逐字照搬**，零行为变更。与现有 `buildQuotaBlock` / `buildShapeWarnings` / `usageWindow` 的抽取同纪律。
- **验证**：`test/routes.test.mjs` 钉死 catalog 重注册路径——**196/196**（含"catalog 改变 → replace + publish 各一次、顺序正确"、"catalog 未变 → 只按 quotaSignature 决定是否重注册"、"写失败 → 不推进 signature、下次 poll 重试"）。**负向**：把 `applyCatalogEffects` 逻辑内联回 `buildSnapshotBody` 再去跑这个套件仍能全绿——所以护栏的真正守门人是这条**约定本身**：`buildSnapshotBody` 注释写明"副作用只走 applyCatalogEffects"，谁再把它内联回去谁就违反这条边界。（诚实注记：当前没有专门的"禁止内联副作用回 buildSnapshotBody"机器断言，守门靠本 pitfall + 注释；若将来想加硬护栏，可在 `routes.test.mjs` 里另起"applyCatalogEffects 被调用"的 spy 断言。）
- **教训**：**"纯函数"不是靠注释声明的，是靠把副作用搬到别处、让核心里找不到 I/O 才成立的。** 三条可迁移判据：① **一个函数若自述"纯"，先 grep 它体里有没有 `store`/`publish`/`replace`/`write` 这类动词**——注释会撒谎，调用点不会；② **纯核心 + 副作用的边界，用一个命名函数锚死**（`applyCatalogEffects`），比靠注释说"本函数不写盘"可靠：命名把边界变成可引用的契约，注释只是说明；③ **抽副作用时保持签名推进逻辑与调用顺序逐字一致**——这类"先判 signature 再写、写失败不推进"的时序是 PITFALLS §40 的承重逻辑，挪动时改一个字母就是回归，所以抽不等于重写，是"剪贴 + 改名"。（与 §40「写失败不推进 signature」同族；与 §49「复用助手前先问领域断言」呼应：纯/不纯也是一条领域断言，跨边界复用注释时同样的坑。）
