# DSH 插件机制总览（DSH Plugin Mechanics）

这份文档解释「`dsh-connect-agnes-token-plan` 是一个 **DeepSeek Harness（DSH）插件**，它如何被 Host 加载、bundle 长什么样、和 Host 以及其它插件（如 `dsh-connect-qoder`）是同一套机制」。它是插件层面的总览，内部细节请看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

> 范本参照：`~/.dsh/plugins/dsh-connect-qoder` 的 README——它把「这是一个 DSH 插件、如何被加载、bundle 结构、测试门禁」写得极完整。本插件与之共用同一套 DSH 插件协议（Loader 条目、`cordis.patch.yml`、客户端注入、`peerDependencies` 由 Host 提供），区别只在功能域。

---

## 1. DSH 插件是什么

DSH 插件是一段在 **Host**（桌面版或 `dsh web`）进程内运行的代码，通过 DSH 的 **Loader** 注册成一个 **bundle**，在启动时按 `cordis.patch.yml` 的描述挂进 Host 的 cordis 容器。插件分两半：

- **Host 半边**：在 Node 侧运行，`index.ts` / `token-store/` / `agnes-auth.ts` 这种。本插件用它注册 HTTP 路由、调 Agnes 控制台、管令牌。
- **Client 半边**：注入到 Host 的 Web UI 里运行，`client.js` 这种（React 由 Host 提供，不打包）。本插件用它画 Plugins 页的配置卡与账号表单。

两半通过 Host 暴露的上下文（`ctx`）与本地路由（`/api/...`）通信。**插件不是独立进程，也不是独立网页**——它寄生在 DSH 里。

---

## 2. bundle 结构（本插件 `package.json` 真实字段）

> 以下片段为**教学示意**，以仓库内真实 [package.json](../package.json) 为准；`test/docs.test.mjs` 会核对 `name` / `version` / `main` 与 `files` 数组，改动 package.json 后请同步本片段，漏改会让该套件红。

```jsonc
{
  "name": "dsh-connect-agnes-token-plan",
  "icon": "./icon.svg",                  // Plugins 页插件卡图标：Host 读此字段按 SVG/PNG/JPEG/WebP 渲染（相对路径、落在 files 内、≤256 KiB，任一不满足会让整条元数据报错）
  "version": "0.10.0",
  "main": "./lib/index.js",              // Host 半边入口：src/host/*.ts 经 tsdown 打成的单条 bundle
  "exports": {
    ".": "./lib/index.js",               // 源码在 src/host/，lib/ 为纯构建产物（随库提交，git/市场直装零构建）
    "./client": "./client.js",           // Client 半边入口（宿主注入用）：src/client/*.ts 打成的 IIFE 产物
    "./locale/*.json": "./locale/*.json", // 插件卡文案（title/description）的资源子路径——不导出则 readPluginMeta 静默按「无元数据」吞掉（PITFALLS §33）
    "./package.json": "./package.json"
  },
  "files": [                            // 发到 registry 时只带这些；必须覆盖构建产物与文档，
                                        // 由 test/package.test.mjs 钉住（src/ 不进包，panel-*.js 是测试基建也不进包）
    "lib", "client.js", "icon.svg",
    "locale",
    "assets",                           // screenshots.json 指的就是这两张图：清单在包里而图不在包，
                                         // 市场页对所有从 npm 装的人全裂，且没有任何门禁会红
    "cordis.patch.yml", "README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md", "LICENSE", "screenshots.json"
  ],
  "scripts": {
    "build": "tsdown -c tsdown.config.mjs",        // 重建 lib/index.js + 根 client.js
    "build:client": "tsdown -c tsdown.config.mjs",
    "prepack": "npm run build",                    // 发布前自动重建产物
    "test": "node test/run.mjs",
    "test:live:contract": "node test/live-contract.mjs",
    "test:e2e": "node test/e2e.mjs"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 本插件向 Host 插入什么
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-renderer"
      ]
    }
  },
  "peerDependencies": {                 // 运行时由 Host 提供，不随包安装
    "@deepseek-ai/cordis": ">=4.0.2 <5.0.0",
    "@deepseek-ai/dsh-credentials": ">=0.1.5 <0.3",
    "@deepseek-ai/dsh-llm": ">=0.1.5 <0.3",
    "@deepseek-ai/dsh-llm-pi-ai": ">=0.1.5 <0.3",
    "@deepseek-ai/dsh-settings": ">=0.1.5 <0.3",
    "@deepseek-ai/dsh-home-paths": ">=0.1.5 <0.3",
    "@deepseek-ai/dsh-tools": ">=0.1.5 <0.3",
    "@deepseek-ai/dsh-host-webserver": ">=0.1.5 <0.3",
    "@deepseek-ai/dsh-client-locale": ">=0.1.5 <0.3",
    "@deepseek-ai/dsh-client-ui-renderer": ">=0.1.5 <0.3",
    "@deepseek-ai/dsh-client-ui-layout": ">=0.1.5 <0.3",
    "@deepseek-ai/schemastery": "^3.18.2",
    "@earendil-works/pi-ai": "^0.85.1"
  },
  "engines": { "node": "^22.19.0 || >=24.0.0" }
}
```

要点：

- **`dsh.bundle.patch`** 指向 `cordis.patch.yml`——这是插件声明「我要在 Host 里插入哪一行、带哪些配置」的地方。
- **`dsh.client`** 声明 Client 半边跑在 `web` 平台、立即注入，并依赖两套 Host 提供的客户端模块（locale / renderer）。
- **`peerDependencies`** 是 DSH 运行时（`@deepseek-ai/dsh-credentials`、`@deepseek-ai/cordis`、客户端模块与第三步注册 provider 用的 `@earendil-works/pi-ai` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-llm-pi-ai`；`@deepseek-ai/cordis` 在 `peerDependenciesMeta` 里标为 optional）——**由 Host 在运行时提供**，不在公共 registry 上。这与 `dsh-connect-qoder` 的处境完全一致：它的 `.npmrc` 里有 `legacy-peer-deps=true` 正是因为 peer 装不到。本插件同理，不要试图 `npm install` 这些 peer；但**它们必须能从插件文件所在目录解析到**（Node 的裸模块解析只向上找 `node_modules`）：npm 装进 profile 的插件天然满足，开发期 symlink/junction 进 profile 的检出不满足——见 [PITFALLS.md](./PITFALLS.md) §16。
- **`exports`** 把 Host/Client 各半边与工具模块都暴露出来，`index.js` 的 `apply/name/inject` 是 Host 入口约定。

---

## 3. `cordis.patch.yml` —— 插件向 Host 插入的内容

本插件 `cordis.patch.yml` 就是一个 `insert`：

```yaml
- insert:
    - id: dsh-connect-agnes-token-plan          # Loader 条目 id；Host 用它在命名空间/设置里定位本插件
      name: dsh-connect-agnes-token-plan
      config:
        consoleBase: https://platform-backend.agnes-ai.cn   # 后端源站，不是控制台前端
        usageDays: 30
        cacheSeconds: 60
        tokenSkewSeconds: 120
        # loginPath / loginTimeoutMs / fallbackExpiresInSeconds ... 都是可选覆盖，留注释=用平台默认
```

- 这里的 `id: dsh-connect-agnes-token-plan` 至关重要：DSH 的「设置 → 模型」页、命名空间推导都基于这个条目 id（参见 `dsh-connect-qoder` README 里「设置命名空间由宿主决定，不能自选」那条踩坑——本插件是硬编码 `name`，见 `src/host/host-config.ts`，其注释自述不能从这里 import 的只有 `package.json#name` 与 `cordis.patch.yml` 的 `id`/`name`）。
- `config` 是插件的配置面，**改完要重装/重载 Host 才生效**；也可以在 profile 的 `cordis.patch.yml` 里用同名 `id` 覆盖。
- 端点类字段若不是合法 http(s) 绝对地址，挂载时直接报 `config_error`，而不是第一次轮询才炸。

---

## 4. 安装与重启（和 `dsh-connect-qoder` 同一套）

已发布 npm，普通用户直接按包名安装（无需本地检出）：

```powershell
plugin_manager { action: "install_bundle", target: "dsh-connect-agnes-token-plan" }
```

本地开发时装本检出：`dsh plugin --profile web add <本仓库绝对路径>`，或 `plugin_manager` 的 target 填同一路径。target 三种形态（npm 包名 / git 地址 / 本地路径）与镜像源同步注意事项见 [SETUP.md](./SETUP.md) §2。

**安装后必须重启 DSH 进程**——bundle 的 patch 在启动时读取，Host 半边（`index.js` 等）只在启动时加载一次（见 [PITFALLS.md](./PITFALLS.md) 第 8 条）。只改 `client.js`（Client 半边）时浏览器刷新即可。

---

## 5. 与 Host 的边界（哪些该放插件、哪些归 Host）

- **插件不该做的事**：管理进程生命周期、持有全局状态、碰 Host 隐私数据。插件通过 `ctx`（cordis 容器）拿服务，如 `ctx.webServer`（注册路由）、`ctx.get("credentials")`（凭据服务）——`HostCtx` 的成员以 `src/host/types.ts` 为准，`ctx.slots` / `ctx.locale` 不是它的成员。
- **本插件注册的路由**（都在 `registerRoutes` 里，全部过 `isAdmitted` 同源闸，见 [PITFALLS.md](./PITFALLS.md) 第 13 条）：`GET|HEAD snapshot`（只读聚合，始终 HTTP 200，成败在 body 的 `ok`/`code`）、`GET|POST account`（账号配置，POST 校验 body ≤ 4KB）、`GET|POST api-key`（`AGNES_TOKEN_PLAN_API_KEY` 引用存取，响应永不回显明文）、`GET|POST provider`（面板 provider 热开关，`docs/PROVIDER-HOT-RELOAD.md`）、`POST models`（模型允许清单保存）、`GET|POST draw`（出图工具开关）、`GET|POST video`（视频工具开关，与出图各自独立，见 [AGNES-API.md](./AGNES-API.md) §7.5）、`GET|POST agnescode`（桌面端上游：登录态检测 / 断开，见 [ROADMAP.md](./ROADMAP.md) §6.3）。路由白名单以 `routes.ts` 为准（门面 `src/host/routes.ts`，家族在 `src/host/routes/`）——文档这里只给清单与约束，不复制契约。
- **凭据归 Host 的凭据服务**：账号与 access token 只经 `@deepseek-ai/dsh-credentials` 落 `~/.dsh/.credentials.yaml`；**密码不落盘**（仅登录瞬间内存使用，`AGNES_PASSWORD` 环境变量是唯一持久来源）。Agnes 不发 refresh token，令牌死了就重登一次。插件自己不写明文文件。没有凭据服务时退化为进程内存（`ephemeral`），重启需重登。

---

## 6. 与 `dsh-connect-qoder` 等兄弟插件的关系

- 它们**共用同一套 DSH 插件协议**，但**功能域互不相关**：`dsh-connect-qoder` 是把 Qoder 账号接成 DSH 的模型 provider；本插件是 Agnes 控制台的额度面板。两者都是「Host 半边 + Client 半边 + cordis.patch.yml + peer 由 Host 提供」这一形态。
- 它们可以**并存**：各自有独立的 Loader 条目 id（`llm-qoder` / `dsh-connect-agnes-token-plan`），各自的命名空间、路由前缀（`/api/dsh-connect-agnes-token-plan/...` vs 各自前缀）互不冲突。
- 都遵循同一套 Host 约定：设置命名空间由 Host 从条目 id 推导、Client 由 Host 注入、`peerDependencies` 由 Host 提供。

---

## 7. 测试与构建（本插件）

- 本插件测试**无需 `npm install`**：网络层打桩（假 Agnes 平台），登录只发一次明文 POST、密码仅内存使用，不碰真实账号；peer 依赖由 `test/peer-roots.mjs` 在 DSH 运行时就地解析（`$DSH_HOME` → 插件 `node_modules` → 安装目录）。找不到会列全部查过的位置，而非静默跳过。这只是让**测试**拿得到 peer；插件运行期自己 `import()` 的解析链是另一回事，见 [PITFALLS.md](./PITFALLS.md) §16。
- 跑 `npm test`（**全量离线测试套件**，套件清单与门禁的唯一事实源是 `test/_roster.mjs` 的 `listSuites()` + `GATES`——`package.json` 的 `scripts.test` 只是 `node test/run.mjs`，会按名册自动收集 `test/*.test.mjs`；新增套件放进 `test/` 即被自动纳入，无需手接 `&&` 链），末尾接 4 道 gate：`test/tsc-gate.mjs`（类型检查）→ `test/build-gate.mjs`（把 `src/` 重建到 gitignored 的暂存目录，验证入库的 `lib/` 与 `client.js` 产物，只读不碰工作树；tsdown 缺席则醒目 SKIP）→ `test/dup-gate.mjs`（重复度，jscpd 缺席则 SKIP）→ `test/e2e-gate.mjs`——探到 dsh CLI 就实跑端到端，探不到则醒目 SKIP 并退出 0。`test:live:contract` 需联网并要一枚真 Key，不进默认门禁。`package.test.mjs` 还把「磁盘上的 *.test.mjs ↔ `node test/run.mjs` ↔ CI 离线 job」钉成同一个事实：新写套件忘进名册会直接红。`store-baseline` 是 token-store 的全行为冻结基线（拆分 guardrail），详见 `docs/TESTING.md`。
- 本插件 **两半边均已构建化（2026-09-30）**：全部源码在 `src/host/*.ts` 与 `src/client/*.ts`，经 `npm run build`（tsdown）构建为 `lib/`（Host ESM bundle + 切分 chunk）与根 `client.js`（Client IIFE）。**两个产物均随库提交、不 `.gitignore`**——git/市场直装克隆即可用（pnpm 对 git 依赖一律拒绝执行构建脚本，`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；唯一解法是 `allowBuilds` 白名单，那不是安装期能碰的旋钮，见根目录 `.gitignore` 说明块与 `docs/ADR.md` ADR-008）；chunk 命名为 `[name].js`（不含内容哈希，见 `tsdown.config.mjs`），所以改源码是原地修改而非删旧加新。改源码后必须重建，并把 `lib/` 与 `client.js` 随 `src/` 同一 commit 提交。删掉它们后一条 `npm run build` 即可从 `src/` 完整重建。`test/build-gate.mjs` 在 `npm test` 末尾拦构建失败、产物缺失与漂移，CI 另有 `artifacts` job 以 `git diff --exit-code -- lib client.js` 拦「改了 src 没重建」。
- 所有离线测试均已通过；各套件用例数会随并行会话变化，以 `npm test` 实际输出为准，不在此处保留快照（详见 [TESTING.md](./TESTING.md)）。

---

## 8. 相关文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 插件内部双仓库关系 / Host-Client 分流 / 数据流
- [SETUP.md](./SETUP.md) — 安装、配置字段、重启注意事项
- [AGNES-API.md](./AGNES-API.md) — Agnes 接口全集（额度侧 + 推理侧）
- [PITFALLS.md](./PITFALLS.md) — 真实踩坑（含 DSH 加载 / 重启 / 同源 / peer 依赖相关）
- 范本：`~/.dsh/plugins/dsh-connect-qoder/README.md`（DSH 插件 README 的参考写法）
