# 贡献约定（Contributing）

面向在本仓库提交改动的人。原则：Host 半边改动代价高、登录失败会锁号、凭据绝不能进版本库。

---

## 1. 提交信息风格

沿用现有历史的中文 `type:` 前缀：

- `feat:` 新能力
- `fix:` 修复
- 正文用中文说明「为什么」，而非「改了什么」（diff 自明）。

例：`fix: stop retrying a refused sign-in, so a bad password cannot lock the account`

---

## 2. 改动 Host 半边必须重启

`index.js` / `token-store.js` / `sensenova-auth.js` 在 Host 启动时加载一次，**改完须完全退出 DSH（含托盘）再启动**。只改 `client.js` 时浏览器刷新即可。提交前用 [SETUP.md](./SETUP.md) §4 的自查确认跑的是新代码。

---

## 3. 测试先行

- 改动登录 / 续期 / 节流 / 路由 / 面板决策后，跑 `npm test`。
- 新增登录分支（新的拒绝类型、新的窗口读取）必须补 `auth.test.mjs` 或 `store.test.mjs`。
- 面板渲染决策改动后，`panel.test.mjs` 应同步（它通过 `client-surface.js` 把 `client.js` 作为模块加载、直接调用工厂物化出的 `panel` 测试面，不需手写副本，也没有字符串锚点）。若 `client.js` 的工厂不再导出 `panel` 测试面或改动了结构，`client-surface.js` 会**直接抛错**——更新它，别退回抠源码。
- 网络层一律打桩，密码用临时密钥，**绝不发往商汤**，也不依赖真实账号。

---

## 4. 红线：什么绝不进版本库

- **凭据**：`.env`、`.env.*`、`*.env` 已被忽略；账号密码、access/refresh token 只经 DSH 凭据服务，不写文件、不写日志。
- **`upstream/`**：已被 `.gitignore` 忽略。它是独立 git 仓库（自带 `.git` 与 GitHub remote），容纳进本仓库只为本地对照，**不要 `git add upstream/`**，也不要把它的 `accounts.json` 等带进来。
- **运行时产物**：`*.log`、`logs/`、`tmp/`、`node_modules/`、`dist/`、`build/` 已忽略。
- **DSH 内部抽取物**：本仓库曾误把 `_asar_extract/`（Host 打包产物）提交进历史，应将其从跟踪中移除（见下方 §6），且不再 add。

---

## 5. 文档同步

逻辑改动若影响以下内容，同步更新 `docs/`：

- 路由 / 配置字段变化 → `API.md` / `SETUP.md`
- 登录 / 续期 / 节流变化 → `AUTH.md`
- 结构或双仓库关系变化 → `ARCHITECTURE.md`

根 `README.md` 保持为索引与快速上手，细节下沉到 `docs/`。

---

## 6. 仓库整洁（历史遗留清理）

本仓库曾把 DSH 的 `_asar_extract/`（asar 解包出的 Host 内部文件）误纳入 git 跟踪。这些不是本插件源码，且随版本变化会制造巨大 diff。建议将其从索引中移除（保留工作区文件、不再跟踪）：

```powershell
git rm -r --cached _asar_extract
# 然后确认 .gitignore 已忽略（或在 .gitignore 追加 _asar_extract/）
git commit -m "chore: stop tracking DSH internal _asar_extract dump"
```

> 此项属仓库整理，按需进行；与本插件功能无关。

---

## 7. 已知取舍（挂起，按需收）

- **`SENSENOVA_API_KEY` 走 `process.env` 不走凭据服务**（详见 [OPEN-ISSUES.md §SENSENOVA_API_KEY](./OPEN-ISSUES.md#sensenova_api_key-走-processenv-不走凭据服务)）。
  挂载时从 `process.env` 读一次，空则 `catalog` 整块不查、`catalogAvailable: false`。
  收口时需把 `index.js` 的 `apiKey` 改成「凭据服务优先、env 兜底」并同步两份 docs 与测试。
