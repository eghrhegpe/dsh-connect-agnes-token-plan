# 测试体系（Testing）

本插件以**离线单元测试**为主：网络层全部打桩，密码用临时生成的密钥加密，绝不发往商汤。目标是守住三条关键路径——登录/续期、令牌存储、路由与面板决策。

---

## 1. 运行

```powershell
npm test       # 依次跑 auth / store / routes / panel / render / parsers / config / package / wiring，末尾 e2e-gate（无 dsh CLI 则 SKIP）
npm run test:e2e    # 只跑端到端：真 Host + 假平台，需 dsh CLI 在 PATH
npm run test:live   # 仅 live-jwks.test.mjs，需联网，验证 JWKS 文档可达
```

测试**无需 `npm install`**：`@deepseek-ai/dsh-credentials` 是 Host 里的 peer 依赖，由 `test/peer-roots.mjs` 在 DSH 运行时里就地解析（`$DSH_HOME` → 插件 `node_modules` → 默认安装位置 `~/.dsh/dsh-asar-unpacked` → 打包安装目录）。找不到时会列出每个候选根**各自失败的原因**，而不是静默跳过或只报搜索路径。`config.test.mjs` 不依赖任何 peer，干净检出即可跑。

---

## 2. 各测试文件职责

| 文件 | 守什么 |
|---|---|
| `test/auth.test.mjs` | JWE 封包（RSA-OAEP + A256GCM）round-trip、PKCE（S256 向量）、登录分类（错密码 / 锁号 / 限频 / 验证码）、拒绝消息取平台原话、**登录 trace 成功与失败都要上报**、**错误码 taxonomy 一致性** |
| `test/store.test.mjs` | 令牌存储与续期、并发轮询只触发一次刷新、401 拒绝记忆、节流状态跨进程、env 账号识别、内存态 ephemeral |
| `test/routes.test.mjs` | 把面板的判断逻辑**原样跑在真实接口响应上**，专门守住「无凭据服务时表单仍可达」这条路径；同源校验、body 上限、跨域拒绝、**一个请求只答一次** |
| `test/panel.test.mjs` | 面板「显示什么」的决策，**直接从 `client.js` 抠出决策块求值**（见 `panel-decision.js`），而不是手写副本——逻辑一变测试自动跟；**中英文字典键集一致**；控制台故障不伪装成登录表单 |
| `test/render.test.mjs` | 面板「数字怎么上屏」的渲染，`panel-render.js` 抠出 `WindowRow` / `PoolCard` / `TrendTable` 真源码、以记录型 `h` 在 Node 求值：`used/limit` 写反、剩余量丢失、进度条色阶错档、除零 NaN 都会红 |
| `test/parsers.test.mjs` | **控制台响应解析层**（纯函数、无网络）：字符串数值与 epoch 归一（§11）、`reset_at="0"` 不得读成 1970、`checkShape` 双向漂移检测（§12 `shapeWarnings` 的来源）、trend 对 points **求和**而非取首个 |
| `test/config.test.mjs` | **配置单一事实源钉子**：`CONFIG_DEFAULTS` 与 `cordis.patch.yml` 不得静默漂移；不依赖 peer，干净检出即可跑 |
| `test/package.test.mjs` | **打包清单钉子**：从 `main`/`exports` 走静态 import 闭包，可达模块必须在 `files` 里（曾漏 5 个 → tarball 加载即崩）；反向钉住"`files` 里却无人引用"的死重；不依赖 peer，干净检出即可跑 |
| `test/wiring.test.mjs` | **真实 Cordis 容器**里的装配：`inject` 解析、服务注册、路由挂载与卸载、配置错误 |
| `test/live-jwks.test.mjs` | （仅 `test:live`）真实拉取 JWKS 文档，确认封包公钥可达 |

不碰真实账号的保证：网络层打桩，密码用临时密钥加密，不发往商汤；`routes.test.mjs` 用真实响应形状但全 stub。

---

## 3. `panel-decision.js` / `client-surface.js` 为何特殊

面板的渲染决策与渲染组件**不是手写副本、也不再是从源码抠字符串**：`client-surface.js` 把 `client.js` **作为模块加载**（装一个捕获型 `window.__ModuleLoader__`，给工厂喂一个记录型 React 替身），拿到工厂物化出的 `panel` 测试面（`interpretSnapshot` / `viewOf` / 字典 / 错误码表 / 样式令牌 / 组件），`panel-decision.js` 与 `panel-render.js` 再从这个真实对象上取用。若 `client.js` 的结构变了，检查跟着变——测的始终是浏览器真正跑的那段代码。

> 机制有两代：早期一版是手写 `panelDecision` 副本（会漂移，且漏了节流字段）；再一版是从 `client.js` 源码用平衡括号抠函数体、`new Function` 求值（锚点绑死源码排版）。现版把 `client.js` 物化成模块后两者都取代了。

---

## 4. 已知缺口

> 本文曾记载「`wiring.test.mjs` 缺失、`panel.test.mjs` 有失败用例」。两条都已不成立：`wiring.test.mjs` 现在 24 项全过，`panel.test.mjs` 41 项全过。后来记载的「同源校验挡不住 DNS rebinding」「密码会被静默 trim」也已收口：前者由 `isAdmitted` 的 Host 白名单（`index.js`，`routes.test.mjs` D2 守住「Origin 与 Host 一致的陷阱」），后者由 `token-store.js` 的 `verbatim()`（密码按原样存取，store.test.mjs 断言 kept verbatim）。「渲染层没有被测到」同样不再成立：`test/render.test.mjs` 通过 `panel-render.js` 检查上屏数字，`used/limit` 写反的演练实测 5 项变红。文档比代码先过期也是一类缺陷，所以这里只保留仍然真实的缺口：

- **`AccountForm` 的渲染没有被测到。** 它建立在 `useState`/`useEffect` 之上，React 替身只会无脑返回初值——测的会是那个假件。宁可留着缺口也不假装覆盖；表单的行为部分由 `store`/`routes` 套件在 Host 侧守住。
- **路由测试用的是假 `response`，不是真实的 `http.ServerResponse`。** 它会计数写入次数（这是抓住「保存账号答了两次」的原因），但不会复现真实对象的 `ERR_HTTP_HEADERS_SENT`、`setHeader` 顺序与流语义。
- **端到端已进 `npm test` 门禁，但依赖 dsh CLI。** `test/e2e.mjs` 拉起**真 Host 进程**（`dsh web`）+ 一个 127.0.0.1 上的**假商汤平台**（`test/fake-platform.mjs`，自带独立 `$DSH_HOME`、零真实凭据、全部端点重定向到本机），断言登录/池用量/节流分类等端到端行为，并校验假平台真的收到了流量。它曾长期被排除在默认跑之外——而「嵌套 `auth:` 块打到真平台锁号」这类最危险的 bug 只有它能抓。现在 `npm test` 末尾接 `test/e2e-gate.mjs`：探到 dsh CLI 就实跑（失败即红），探不到就打醒目 SKIP 并退出 0。缺 CLI 不是回归，但一次绿跑若跳过了端到端，装配路径就没被真正验过——`.github/workflows/ci.yml` 把它列为独立的 best-effort job 正是为了让这个信号不被离线绿灯掩盖。
