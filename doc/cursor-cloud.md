# 在 Cursor 云端跑这个服务

只对 Cursor Cloud Agent 的环境成立，本机 Windows 和其他宿主不适用。原文是 Cursor Agent 2026-10-18 在 PR #2 里写的环境快照，云端环境变了就以现场为准。

- 零依赖。Node 要 `22.19.0` 或更新（与 `package.json` 及 CI 一致；`node:sqlite` 从 22.13 起不用实验开关）。环境把可用的 `node` 放到 `/usr/local/bin/node`。
- 全量测试命令是 `npm test`（依次跑 `role-contract`、端到端场景和单元测试，和 CI 一致）；单跑单元测试是 `node --test --test-concurrency=4 "tests/**/*.test.mjs"`。Node 22 会把 `node --test tests/` 当成一个文件名。测试把服务复制到临时目录，用假 Codex 和假 pi，不写仓库里的 `.data/`，也不占用 43130。
- 每次开机的 start 在 `127.0.0.1:43130` 起 daemon，并把 `SPECIALIST_SUBAGENTS_RUNTIME` 指到 `tests/fakes/fake-pi/dist/bundle/cli.js`，只为通过启动闸。这台机器没有 Codex、Grok、Claude 的登录，也没有真正的 pi SDK。`node bin/specialist-subagents.mjs demo` 会调用本机真实模型并产生用量；这里用上面的测试，或 `curl -s -X POST http://127.0.0.1:43130/seat/open -H 'content-type: application/json' -d '{"role":"coder"}'` 验证（仅单租户隔离沙箱可不设 `SPECIALIST_SUBAGENTS_TOKEN`；共享主机须在启动前配置该令牌并在请求中带 `Authorization: Bearer <token>`）。
- 健康检查是 `curl -s http://127.0.0.1:43130/health`。岗位墙是 `http://127.0.0.1:43130/`。
