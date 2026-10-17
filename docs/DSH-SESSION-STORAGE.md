# DSH 会话存储（Session Storage）

本插件运行在 DSH（DeepSeek Harness）里，所有对话 transcript 与派生数据都落在宿主的 `$DSH_HOME`（本机 `C:\Users\zhujieling11\.dsh`，平台等价 `~/.dsh`）下。AI 协作会话要「翻某条对话的原文」「查某次探针返回落在哪」时，先认清下面两层，别绕弯路。

---

## 1. 真原文：会话 transcript

路径：

```
$DSH_HOME/sessions/<encoded-cwd>/session-<uuid>/session.v4.jsonl.zstd
```

- 第一层目录名是**工作目录路径的编码**（`/` 与 `:` 转成 `-`、整段用 `--` 包住）。例如默认工作区是 `--C-Users-zhujieling11-.dsh--`，某个项目目录是 `--C-Users-zhujieling11-ysm-model-manager--`。
- 第二层每一条会话一个目录 `session-<uuid>`，里面**只有**一个文件 `session.v4.jsonl.zstd`。

格式：

- **`jsonl.zstd`** = 每行一条 JSON 事件（换行分隔）+ 整文件 zstd 压缩。**不是** `.json`，也**不是**普通 `.jsonl`。
- 解压后每行是一条事件记录，常见 `type`：`workspace/changes`、`model/selection`（含 `{provider, model, reasoningEffort}`，即「这条会话用了哪个模型」的元数据——注意这只是路由信息，不是接口返回体）、`agent/inbox/spliced`（用户/助手消息，含 `content`/`source`/`role`/`id`）、`tool/*` 等。
- 用户/助手**原文**在 `agent/inbox/spliced` 事件的 `data.inserted[].content[].text` 里。

读取方式（本机已验证 `zstd` CLI 可用）：

```bash
zstd -d "$DSH_HOME/sessions/<encoded-cwd>/session-<uuid>/session.v4.jsonl.zstd" -o /tmp/sess.jsonl
# 随后按行 grep / 解析
```

> **重要区分**：会话文件里出现模型名（如 `agnes-3.0-flash`）几乎总是 `model/selection` 的**路由元数据**，不是接口探针的原始返回。**接口探针的返回内容（如 `docs/ROADMAP.md` §6.3 的 7 发思考 wire 表、`/v2/models` 倍率表）只写在仓库文档里，不在任何 `session.v4.jsonl.zstd` 中**——想回看一次探针返回，去对应的 docs 章节，别来翻会话文件。

---

## 2. 投影缓存：session_projcache（派生数据，非原文）

路径：

```
$DSH_HOME/storages/session_projcache/sessions/<id>.json
```

- 这是会话的**投影缓存**（projcache）：路由、用量统计、turn 大纲等**派生数据**，不是对话原文。
- 内容含 `agentPreset`、`watcherInsights`（其中 `route` 是 `{provider, model, effort}`，`totals` 是 `{calls, tokens, input, output, cacheRead, reasoning, ...}` 用量统计）、`turnOutline`（每轮的 `prompt`/`response` 摘要）。
- 定位「某条会话用了哪个模型、花了多少 token」看这里最快；要**原文**仍回 §1。

---

## 3. 归档（dsh-session-archive 插件）

`$DSH_HOME/dsh-session-archive/` 是 `@linxin666/dsh-session-archive` 插件的落点（`state.json` / `archive-ledger.json`）。归档失败时 `state.json` 会记录 `detail: "cannot archive session ...: live sessions and session persistence hold no such session"`——说明归档服务找不到对应活跃会话，与 §1 的原文存储是两套独立机制，排查归档问题别误读成会话丢失。

---

## 4. 速查表

| 想要 | 去哪 |
|---|---|
| 翻某条对话**原文** | `sessions/**/session.v4.jsonl.zstd`（§1） |
| 看某会话模型 / 用量统计（派生） | `storages/session_projcache/sessions/*.json`（§2） |
| 登录 trace（脱敏） | `$DSH_HOME/logs/agnes-login-*.json`（见 `docs/AUTH.md`） |
| 插件状态文件（catalog / 开关 / 凭据引用，按 profile 分段） | `$DSH_HOME/state/<profile>/<plugin-name>/`（见 `docs/PITFALLS.md` §23） |
| **接口探针的原始返回** | **仓库文档**（如 `docs/ROADMAP.md` §6.3），**不在**会话文件里 |
