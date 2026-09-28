# DSH 插件机制总览（DSH Plugin Mechanics）

这份文档解释「`dsh-connect-sensenova-token-plan` 是一个 **DeepSeek Harness（DSH）插件**，它如何被 Host 加载、bundle 长什么样、和 Host 以及其它插件（如 `dsh-connect-qoder`）是同一套机制」。它是插件层面的总览，内部细节请看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

> 范本参照：`~/.dsh/fork/dsh-connect-qoder` 的 README——它把「这是一个 DSH 插件、如何被加载、bundle 结构、测试门禁」写得极完整。本插件与之共用同一套 DSH 插件协议（Loader 条目、`cordis.patch.yml`、客户端注入、`peerDependencies` 由 Host 提供），区别只在功能域。

---

## 1. DSH 插件是什么

DSH 插件是一段在 **Host**（桌面版或 `dsh web`）进程内运行的代码，通过 DSH 的 **Loader** 注册成一个 **bundle**，在启动时按 `cordis.patch.yml` 的描述挂进 Host 的 cordis 容器。插件分两半：

- **Host 半边**：在 Node 侧运行，`index.js` / `token-store.js` / `sensenova-auth.js` 这种。本插件用它注册 HTTP 路由、调商汤控制台、管令牌。
- **Client 半边**：注入到 Host 的 Web UI 里运行，`client.js` 这种（React 由 Host 提供，不打包）。本插件用它画侧边栏面板、账号表单。

两半通过 Host 暴露的上下文（`ctx`）与本地路由（`/api/...`）通信。**插件不是独立进程，也不是独立网页**——它寄生在 DSH 里。

---

## 2. bundle 结构（本插件 `package.json` 真实字段）

```jsonc
{
  "name": "dsh-connect-sensenova-token-plan",
  "version": "0.2.0",
  "private": true,
  "main": "./index.js",                 // Host 半边入口
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",           // Client 半边入口（宿主注入用）
    "./sensenova-auth": "./sensenova-auth.js",
    "./token-store": "./token-store.js",
    "./package.json": "./package.json"
  },
  "files": [                            // 发到 registry 时只带这些；必须覆盖 import 图，
                                        // 由 test/package.test.mjs 钉住（panel-*.js 是测试基建，不进包）
    "index.js", "codes.js", "client.js", "console-client.js", "host-config.js",
    "parsers.js", "throttle-store.js", "trace.js", "util.js",
    "sensenova-auth.js", "sensenova-crypto.js", "token-store.js",
    "cordis.patch.yml", "README.md"
  ],
  "scripts": {
    "test": "node test/auth.test.mjs && ... && node test/wiring.test.mjs",
    "test:live": "node test/live-jwks.test.mjs",
    "test:e2e": "node test/e2e.mjs"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 本插件向 Host 插入什么
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-layout"
      ]
    }
  },
  "peerDependencies": {                 // 运行时由 Host 提供，不随包安装
    "@deepseek-ai/dsh": ">=0.1.7-rc.2",
    "@deepseek-ai/dsh-credentials": ">=0.1.7-rc.2",
    "react": "^18.2.0"
  },
  "engines": { "node": ">=22" }
}
```

要点：

- **`dsh.bundle.patch`** 指向 `cordis.patch.yml`——这是插件声明「我要在 Host 里插入哪一行、带哪些配置」的地方。
- **`dsh.client`** 声明 Client 半边跑在 `web` 平台、立即注入，并依赖三套 Host 提供的客户端模块（locale / renderer / layout）。
- **`peerDependencies`** 是 DSH 运行时（`@deepseek-ai/dsh`、`@deepseek-ai/dsh-credentials`、`react`）——**由 Host 在运行时提供**，不在公共 registry 上。这与 `dsh-connect-qoder` 的处境完全一致：它的 `.npmrc` 里有 `legacy-peer-deps=true` 正是因为 peer 装不到。本插件同理，不要试图 `npm install` 这些 peer。
- **`exports`** 把 Host/Client 各半边与工具模块都暴露出来，`index.js` 的 `apply/name/inject` 是 Host 入口约定。

---

## 3. `cordis.patch.yml` —— 插件向 Host 插入的内容

本插件 `cordis.patch.yml` 就是一个 `insert`：

```yaml
- insert:
    - id: dsh-connect-sensenova-token-plan          # Loader 条目 id；Host 用它在命名空间/设置里定位本插件
      name: dsh-connect-sensenova-token-plan
      config:
        consoleBase: https://platform.sensenova.cn
        trendHours: 24
        cacheSeconds: 60
        tokenSkewSeconds: 120
        # iamBase / tokenEndpoint / jwksEndpoint / ... 都是可选覆盖，留注释=用平台默认
```

- 这里的 `id: dsh-connect-sensenova-token-plan` 至关重要：DSH 的「设置 → 模型」页、命名空间推导都基于这个条目 id（参见 `dsh-connect-qoder` README 里「设置命名空间由宿主决定，不能自选」那条踩坑——本插件同样遵循 `ctx.fiber.entry.options.id` 推导，不硬编码）。
- `config` 是插件的配置面，**改完要重装/重载 Host 才生效**；也可以在 profile 的 `cordis.patch.yml` 里用同名 `id` 覆盖。
- 端点类字段若不是合法 http(s) 绝对地址，挂载时直接报 `config_error`，而不是第一次轮询才炸。

---

## 4. 安装与重启（和 `dsh-connect-qoder` 同一套）

```powershell
# 由带 plugin_manager 的会话执行，或插件管理器页面操作
# target 填本检出的绝对路径（一般在 `~\.dsh\plugins\` 下）
plugin_manager { action: "install_bundle", target: "<插件目录>\dsh-connect-sensenova-token-plan" }
```

也可以 `dsh plugin --profile web add <本仓库路径>`（本地开发模式）。

**安装后必须重启 DSH 进程**——bundle 的 patch 在启动时读取，Host 半边（`index.js` 等）只在启动时加载一次（见 [PITFALLS.md](./PITFALLS.md) 第 8 条）。只改 `client.js`（Client 半边）时浏览器刷新即可。

---

## 5. 与 Host 的边界（哪些该放插件、哪些归 Host）

- **插件不该做的事**：管理进程生命周期、持有全局状态、碰 Host 隐私数据。插件通过 `ctx`（cordis 容器）拿服务，如 `ctx.webServer`（注册路由）、`ctx.credentials`（凭据服务）、`ctx.slots`（注入 UI）、`ctx.locale`（字典）。
- **本插件注册的路由**：`GET /api/dsh-connect-sensenova-token-plan/snapshot`（只读聚合）、`GET/POST /api/dsh-connect-sensenova-token-plan/account`（账号配置，同源校验 + body ≤ 4KB）。两条路由都过 `isAdmitted` 同源闸（见 [PITFALLS.md](./PITFALLS.md) 第 13 条）。
- **凭据归 Host 的凭据服务**：账号密码 / access+refresh token 只经 `@deepseek-ai/dsh-credentials` 落 `~/.dsh/.credentials.yaml`，插件自己不写明文文件。没有凭据服务时退化为进程内存（`ephemeral`），重启需重登。

---

## 6. 与 `dsh-connect-qoder` 等兄弟插件的关系

- 它们**共用同一套 DSH 插件协议**，但**功能域互不相关**：`dsh-connect-qoder` 是把 Qoder 账号接成 DSH 的模型 provider；本插件是商汤控制台的积分用量面板。两者都是「Host 半边 + Client 半边 + cordis.patch.yml + peer 由 Host 提供」这一形态。
- 它们可以**并存**：各自有独立的 Loader 条目 id（`llm-qoder` / `dsh-connect-sensenova-token-plan`），各自的命名空间、路由前缀（`/api/dsh-connect-sensenova-token-plan/...` vs 各自前缀）互不冲突。
- 都遵循同一套 Host 约定：设置命名空间由 Host 从条目 id 推导、Client 由 Host 注入、`peerDependencies` 由 Host 提供。

---

## 7. 测试与构建（本插件）

- 本插件测试**无需 `npm install`**：网络层打桩，密码用临时密钥加密，不碰真实账号；peer 依赖由 `test/peer-roots.mjs` 在 DSH 运行时就地解析（`$DSH_HOME` → 插件 `node_modules` → 安装目录）。找不到会列全部查过的位置，而非静默跳过。
- 跑 `npm test`（auth / store / routes / panel / wiring）。`test:live` 需联网验证 JWKS。
- 本插件 **Client 半边无构建步骤**：`client.js` 直接随 bundle 注入，没有 `src/` → 产物的分离（这点与 `dsh-connect-qoder` 不同，后者有 `src/client/` 经 `tsdown` 重建 `lib/client.js`）。
- 已知缺口：`package.json` 的 `test` 脚本引用了 `wiring.test.mjs`（尚缺），且 `panel.test.mjs` 有失败用例——详见 [TESTING.md](./TESTING.md)，属实现工作，不在此文档范围。

---

## 8. 相关文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 插件内部双仓库关系 / Host-Client 分流 / 数据流
- [SETUP.md](./SETUP.md) — 安装、配置字段、重启注意事项
- [SENSENOVA-API.md](./SENSENOVA-API.md) — 商汤接口全集
- [PITFALLS.md](./PITFALLS.md) — 真实踩坑（含 DSH 加载 / 重启 / 同源 / peer 依赖相关）
- 范本：`~/.dsh/fork/dsh-connect-qoder/README.md`（DSH 插件 README 的参考写法）
