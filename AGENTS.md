# AGENTS.md

写给在这个仓库里干活的模型。

## 需求以 doc/PRD.md 为准

本服务唯一的权威需求是 `doc/PRD.md`（已取代 `doc/REQUIREMENTS.md`）。`doc/PRD.html` 是它的图版本，两者冲突时以 `PRD.md` 为准。动手前先读 PRD 第 0 节的规则：

- 需求本身只有「已实现」「未实现」两种终态，状态只由 `node tools/prd-check.mjs` 给；自述"做完了"不算。检查器对依赖宿主配置、真实台账或真模型凭据的 8 项本地检查会额外输出「需要本机」，干净克隆上因此以退出码 1 结束（见 `README.md`）；这是检查状态，不新增需求终态。
- "做完"以端到端场景（PRD 4.0 节，T-1 起）为准，零件测试只用来定位。
- 实现的人（执行改动的模型）无权擅自删除、暂停、推迟、缩小任何一条需求；前提没立住就先做前提。只有仓库拥有者 / 当前使用者（上游仓库中称「マスター」；外部 fork 或独立自建实例中即该仓库的维护者本人）能拍板修改需求范围。
- 先改 PRD，再改代码。

## 验证与进展核对

动手前与改动后，以实测输出为准：

```bash
node src/role-contract.mjs
node tools/prd-check.mjs
node --test --test-concurrency=4 "tests/**/*.test.mjs"
```

- `prd-check` 把 H-1、H-2（宿主配置）、H-4、O-2（宿主注入与通知）、C-6（真实台账数字）、B-2、K-1、K-4（真实知识库 `commit` 与同步）标为“需要本机”，不伪造通过。
- 专题实现边界见 `doc/impl/`；早期演进与阶段快照归档见 `doc/goal.md`、`doc/architecture.md`（历史快照，不作现行施工指令）。

## 改代码的规矩

- 改法由组长定死，`coder` 照做；需要调查或判断的部分先派 `explorer` 出图（`dispatch/coder.md`）。
- 改动在 git worktree 里做（`.worktrees/<分支名>`），不碰正在提供服务的 main 工作区；重启服务前先确认没有在跑的单子（`node bin/specialist-subagents.mjs stop` 后看门狗一分钟内用新代码拉起）。

## 岗位墙的「最佳默认」

- 首页顶栏（下一单 / 最佳默认 / 各后端按钮 / 设置）里，「最佳默认」的意思是「不用考虑钱的时候每个岗位该用谁」：只看岗位适配和能力，以及硬门槛（无头模式能不能调 MCP、能不能跑 shell）。要考虑成本时可直接点某一家后端的按钮整队切换；日常派单时由 `src/presets.mjs` 根据实时配额水位与近期健康状态自动避让高压或故障后端。

在 Cursor 云端（Cloud Agent）环境干活时，说明见 `doc/cursor-cloud.md`。
