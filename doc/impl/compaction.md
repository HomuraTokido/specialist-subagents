# 各后端的压缩参数与压缩标记（C-4、L-4 用）

2026-10-11 调研，结果读自源码和官方文档，没有端到端跑过。容器里只装了 claude 2.1.296，没有 codex、grok、pi 的运行时。第一次在本机用时，先拿一个很小的阈值各跑一单，看会话文件里有没有出现下面写的标记。

## 压缩阈值

| 后端 | 参数 | 单位、默认值、上限 |
|---|---|---|
| Codex | `-c model_auto_compact_token_limit=<int>`；要超过 0.9 × 默认窗口时，再加 `-c model_context_window=<int>` | token。默认是窗口的 90%：gpt-6.1-sol 的窗口 272000，所以默认 244800。实际生效的是 min(设定值, 0.9 × 窗口)。窗口最大 872000，上限即 784800 |
| Claude Code | `--autocompact <tokens>`（2.1.221 起）。环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 会被 `claudeEnv()` 删掉，不用它 | token，范围 100000 到 1000000，不超过模型窗口。sonnet、opus 的窗口都是 1M |
| pi | `SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens } })` | 触发条件是上下文 token 数 > 窗口 − reserveTokens。要在 T 压缩，就设 reserveTokens = 窗口 − T。deepseek-flash 的窗口 1000000，默认 reserveTokens 16384 |
| Grok | 环境变量 `GROK_AUTO_COMPACT_THRESHOLD_PERCENT=<0-100>` | 窗口的百分比，默认 85。grok-4.7 的窗口在 256K 到 500K 之间，未确认 |

"默认取该后端允许的最大值"（C-4）具体是：
- Codex：784800，同时设窗口 872000。
- Claude：1000000。
- pi：reserveTokens 取 16384（pi 的默认，也就是尽量晚压缩）。
- Grok：100%。

## 压缩标记（L-4：会话被压缩过）

- Codex rollout：有一行顶层 `"type":"compacted"`。
- Claude Code 会话（`~/.claude/projects/**.jsonl`）：有一行 `"subtype":"compact_boundary"`，或一行 `"isCompactSummary":true`。
- pi 会话：有一个 `"type":"compaction"` 条目。
- Grok：`updates.jsonl` 里有 `compaction_checkpoint`，而服务跟踪的 `chat_history.jsonl` 里没有能确认的标记。

## 上下文窗口（写进 presets 的 `levels`）

| 模型 | 窗口 |
|---|---|
| gpt-6.1-sol | 272000（Codex 的默认） |
| grok-4.7 | 256000（取保守值） |
| sonnet、opus | 1000000 |
| deepseek-flash | 1000000 |

## 出处

- Codex：`codex-rs/protocol/src/openai_models.rs`、`models-manager/models.json`、`history/src/rollout_payload.rs`。
- Claude Code：https://code.claude.com/docs/en/env-vars.md 、cli-reference。
- pi 0.87.0：`dist/core/settings-manager.js`、`docs/compaction.md`、`docs/session-format.md`。
- Grok：xai-org/grok-build 仓库的 `resolve/compaction.rs`。

## 实现（2026-10-11，C-4）

- 默认值在 `presets.json` 的顶层 `compact`：`{ codex: 784800, claude: 1000000, deepseek: 16384, grok: 100 }`。四个数的单位不同：codex、claude 是 token 阈值，grok 是窗口百分比，**deepseek 是留给压缩的余量 `reserveTokens`**（越小压缩越晚），不是阈值。各模型的窗口写在 `levels.<后端>.<档>.context_tokens`（L-4 用）。旧的设置文件没有这两项也合法，缺的按默认补。
- 岗位覆盖：`roles.json` 的角色可写 `compact: { codex?, claude?, deepseek?, grok? }`，值的单位同上；启动闸门检查形状（正整数，grok 在 1 到 100），仓库里不带任何覆盖。
- cli-runner 的落点：Codex 加 `-c model_auto_compact_token_limit=<n>`，n 超过 0.9 × 窗口（244800）时再加 `-c model_context_window=872000`；Claude 加 `--autocompact <n>`；Grok 的进程环境加 `GROK_AUTO_COMPACT_THRESHOLD_PERCENT`；DeepSeek 经环境变量 `SPECIALIST_SEAT_COMPACT_RESERVE` 交给 seat-runner，它写进 `SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens } })`。
- 仍然是调研的结论，没有在本机端到端跑过；第一次在本机用时按本文开头说的，先用很小的阈值验证。
