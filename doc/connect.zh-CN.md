# 接上本机的专家岗位服务（部署指南）

> 中文接入指南。权威英文正文在 `doc/connect.md`；两份指南随实现同步更新。不再有同名技能。

> 需求以 `doc/PRD.md` 为准（本服务唯一的权威需求）；这份只讲怎么接上服务。

下文的 `<仓库>` 指本机 specialist-subagents 的克隆目录，换成你自己的绝对路径（JSON 和 TOML 里反斜杠要写成 `\\`）。

服务是**本机常驻**的一份东西，地址 `http://127.0.0.1:43130`，数据在 sqlite 里。任何客户端接上它，共用**同一份**岗位、座位台账和记忆——一台电脑上的所有 agent 派出去的活都进同一本账，彼此可见。

接口参数中的座位（持久专家槽位）对应概念模型的持久身份；MCP 工具名、CLI 子命令与 `seat-coder-16` 等座位号保留稳定的「座位 / `seat`」公开协议命名。

服务本身活得比会话、比客户端、比宿主都久；但**不必活过关机**（关机它就死，下次开机由登录项拉起，这是正常行为，不是故障）。

## 一、先确认服务在跑

```
node "<仓库>\bin\specialist-subagents.mjs" status
```

- 期望看到 `daemon: running`，后面跟一段 health JSON。
- 若 `not running`：**最多等一分钟**——启动项里的看门狗每分钟检查一次，会把服务拉起来；或者你在**普通终端**里手动 `… start`（幂等，已在跑就报 already running）。
- **绝不要从宿主或客户端进程里起它**：从带 job object 的进程（例如某些桌面或 CLI 宿主）里起的服务会随宿主一起死，正在跑的座位全部断掉。MCP 桥因此只连接、不自己起。
- 关机时正在跑的座位，下次启动会被标成 `interrupted`（不会永远挂在"在跑"）。

## 二、接进客户端（选一条）

**任何 stdio MCP 客户端**：命令 `node`，参数 `[<仓库>\bin\specialist-subagents.mjs, mcp]`，可选环境变量 `SPECIALIST_SUBAGENTS_PORT`（默认 43130）。协议是 NDJSON JSON-RPC 2.0，一行一个 JSON 对象。

**Claude Code**（任选一种）：

```
claude mcp add -s user specialist-subagents -- node "<仓库>\bin\specialist-subagents.mjs" mcp
```

或写进项目里的 `.mcp.json`：

```json
{
  "mcpServers": {
    "specialist-subagents": {
      "command": "node",
      "args": [
        "<仓库>\\bin\\specialist-subagents.mjs",
        "mcp"
      ]
    }
  }
}
```

**Codex**：`~/.codex/config.toml` 里加

```toml
[mcp_servers.specialist-subagents]
command = "node"
args = ["<仓库>\\bin\\specialist-subagents.mjs", "mcp"]
```

**Antigravity**：按宿主版本在 `~/.gemini/config/mcp_config.json` 或 `~/.gemini/antigravity/mcp_config.json` 的 `mcpServers` 中加入（保留已有条目）：

Antigravity 执行后端使用可执行文件 `agy`，安装后先确认能在终端调用。服务依次查找可选 `SPECIALIST_AGY_BIN`、家目录默认路径（`~/.local/bin/agy`，Windows 还包括 `~/.local/bin/agy.exe`、`~/AppData/Local/agy/bin/agy.exe`）、PATH 中的 `agy`（Windows 为 `agy.exe`）。`SPECIALIST_AGY_BIN` 显式设置为空或不存在时不回退查找；可将其指向已有安装的绝对路径。

```json
{
  "mcpServers": {
    "specialist-subagents": {
      "command": "node",
      "args": ["<仓库>/bin/specialist-subagents.mjs", "mcp"]
    }
  }
}
```

**OpenCode**：在项目 `opencode.json` 的 `mcp` 中加入：

```json
{
  "mcp": {
    "specialist-subagents": {
      "type": "local",
      "command": ["node", "<仓库>/bin/specialist-subagents.mjs", "mcp"],
      "enabled": true
    }
  }
}
```

**Grok CLI 执行后端**：本机安装并登录 `grok` 后，服务可将任务路由给它；这与宿主通过 MCP 连接本服务是两件事，无需为了使用 Grok 执行后端更换 MCP 客户端。

启用可选 `SPECIALIST_SUBAGENTS_TOKEN` 时，在 daemon 与 MCP 进程中配置相同值；上述配置可用 `env`（OpenCode 为 `environment`）传入该环境变量。

## 三、验证（三步，每步都有可看的输出）

1. `role_list` → 期望 **8 个岗位**：`coder`、`explorer`、`tester`、`web_researcher`、`handyman`、`librarian`、`refiner`、`leader`，每个带 `grant` / `deny_intent` / `spawn`。
2. `seat_start` `{ "role": "coder", "task": "不要使用任何工具。只输出一行：hello from coder" }` → 期望**立刻**返回 `{ "seat": "seat-coder-N", "state": "running", "note": "…", "next": "…" }`，`note` 是一句人话，说明交给了谁。派活**不阻塞**。这里故意不带 `cwd`，所以是一次性座位；带上 `cwd` 就会交给那个目录的专家（见 doc/PRD.md 的 E-3，原 FR-2）。web_researcher 例外：它按领域认专家，带 `domain` 不带 `cwd`，见第五节。
3. 取结果。宿主已有完成通知集成时，继续其他工作或结束本轮，由宿主在完成后通知或唤醒，再用 `task_result` 读取结果，无需另开等待。下面的等待方式只适用于没有完成通知集成的客户端。Claude Code：用 Bash 的后台运行（`run_in_background`）跑 `node <本仓库>/bin/specialist-subagents.mjs wait seat-coder-N`（`seat_start` 回复的 `next` 里有完整命令），然后去做别的；这一单结束时命令退出，宿主把输出交给你。没有后台命令的客户端：`task_wait` `{ "seat": "seat-coder-N" }`。两者的输出都以「运行 #… 结束了」开头，状态是「完成（退出码 0）」，报告里有 `hello from coder`。

三步都过说明客户端接通并完成了这次真实派单，不代表所有岗位与后端都已验收。

## 四、工具面（19 个）

返回都不带缩进；给组长读的几个（`seat_list`、`seat_show`、`task_wait`、`task_result`）默认是几行人话，原始存储结构要显式参数才给。
默认暴露全部 19 个工具（`--profile full`）；只想用 subagent 编排、不启用 skill 演化闭环时，可传 `--profile core` 或设置 `SPECIALIST_TOOL_PROFILE=core`（隐藏 `difficulty_report`、`difficulty_decide`、`candidates`、`candidate_decide`，仅暴露 15 个工具）。

| 工具 | 用途 |
|---|---|
| `role_list` | 有哪些岗位、各自合同/档位/授权/派活命令 |
| `dispatch_guide` | 派活一方的手册（只读）：不带 `role` 是组长手册（握手时已经作为 instructions 发过一次，没收到或被截断时再取），带 `role` 是那个岗位的调用指南；内容在本仓库 `dispatch/` 里 |
| `seat_start` | 派活（**不阻塞**，立刻回座位号，跑完自己落台账）；描述里写着派不派、派给谁。可选 `seat` = 点名派活：交给这个座位的专家，续它的会话；座位不存在、角色对不上、已归档（说明原因）、一次性座位、`cwd`/`domain` 与专家的对象不符，都会被拒并写明下一步；持久专家正忙时按服务合同开并行分身。回复的 `note` 说清交给了谁（名字和座位号）、它来过几次、为什么是它（点名 / 同一个目录 / 同一个领域 / 新开） |
| `task_wait` | 兜底用：给没有完成通知集成、也不能运行后台等待命令的客户端。阻塞等一单结束（`seat` 或运行号 `run`，`timeout_seconds` 默认 300），结束时直接带回 `task_result` 的内容；超时就说还在跑，再调一次接着等。Claude Code 不用它，用后台的 `wait` 命令（见第五节） |
| `task_result` | 一单的结果：状态、用量、验收、交回的未完成清单、最终报告（runner 自己的回答，不含工具调用行）；报告默认最多 4000 字（`max_chars` 调），超了给出全文文件的路径 |
| `seat_list` | 活着的专家，每人一行：名字、座位号、岗位、目录（按领域认专家的岗位显示领域）、状态、来过几次、未完成条数、一两句专长；带主题的专家显示「主题：…」，会话太长的标「建议拆分」。`role` 只看这个岗位的专家；`cwd` 只看这个目录归谁；`domain` 只看这个领域的专家；`state` 列某个状态的全部座位；`full: true` 才回原始完整行（排查用，很大） |
| `seat_show` | 一个座位和它最新一单的结果（同 `task_result`），再列出更早的运行号；原始事件要带 `events: true`（最新 200 条）、`tail`（条数或 `all`）或 `run`（某次运行的 task 事件 seq）才给 |
| `seat_rename` | 给活着的专家改名，名字写它懂什么（例如「explorer · 座位与 skill 循环」），组长靠名字挑人；座位号不变。名字去掉首尾空白后 1 到 80 字，不能和另一个活着的专家重名，已归档的座位不能改；记一条 `rename` 事件（原名 → 新名） |
| `seat_close` | 关座位。座位没在跑：只改台账。座位**正在跑**：这就是取消，杀掉它的整棵进程树、记 `cancelled` 事件（`reason` 写原因）、座位置 `closed`，回复里明说杀没杀进程；这一单没跑完，未完成清单不动。一单跑过岗位的 `timeout_minutes`（默认 60 分钟）服务会自己杀，记 `timeout` 事件、座位 `failed` |
| `task_cancel` | 取消一单但**保留专家**（区别于 `seat_close` 的归档）：杀掉进程树、记 `cancelled` 事件（`reason` 写原因），专家回到空闲、不归档；它写到一半的会话仍是它的记录，下一单接着用。分身会被一并关掉 |
| `seat_merge` | 把专家 `from` 折进 `into`（两个须同岗位、都还活着）：续接 `from` 让它写交接、交接存进 `into` 的记录、`from` 归档（原因「并入 …」），`into` 的下一单任务最前面附这份交接（只附一次）。带 `name` 就同时把 `into` 改名；`from` 写交接失败时不归档、记一条 `merge` 事件 |
| `seat_split` | 把一个专家拆成若干份：对每个 `parts:[{name, topic?, cwd?}]` 各写一份聚焦交接、开出新专家（各带自己的主题/目录），原专家归档（原因「拆为 …」） |
| `seat_verdict` | 验收完一单就记结论：`accepted`（直接用）/ `revised`（改过才能用）/ `rejected`（退回）；后两种要写 note，会进困难账本；默认记在最新一次运行上，评较早的一次带 `run`（`task_result` / `seat_show` 里的运行号） |
| `memory_read` | 读某岗位的记忆，新近优先（默认 20 条；`limit` 是不小于 1 的整数） |
| `memory_write` | 写一条记忆：`fact`（每次运行都注入）/ `lesson` / `note`（新近优先）；岗位名必须存在，单条最长 4000 字符 |
| `difficulty_report` | 困难账本：各岗位付出的冤枉代价，按"岗位 × 类型 × 工具"归类，附次数、代价、样例（见 doc/PRD.md 的 S-1，原 FR-21） |
| `difficulty_decide` | 给账本里的一类困难记裁决：contract / dispatch / service / tool_or_project / accept |
| `candidates` | skill 循环的候选版本：一个岗位攒满 5 条新困难，服务自动派 refiner 写出这个岗位 skill 的新版（完整正文 + 逐条依据），**不启用**。不带 `id` 列待核对的（和各岗位离下一次还差几条）；带 `id` 看全貌：它依据的 5 条困难、refiner 的逐条依据、对现行 skill 的差异、候选文件的路径。回复里出现"有一个 skill 候选版本待核对"的提醒时（一个客户端会话只提醒一次），告诉用户，或者带提醒里的 id 用它核对。启用写进外部 skills 目录之后，这个岗位从下一单起带的就是新版 |
| `candidate_decide` | 核对候选版本：先用 `verdicts` 把它依据的每条困难判成 `real`（真困难）/ `invalid`（不成立）/ `sporadic`（偶发），再 `decision`：`enable`（判完且至少一条是真困难才行；把候选文件**此刻的内容**写进外部 skills 目录里这个岗位的 skill，记 `skill_versions`；依据"不成立""偶发"的改动要先在候选文件里删掉）/ `reject`（判完，要写 `note`，什么都不写）/ `defer`（先放着）。除了 `enable`，服务不会往任何 skill 里写东西；外部 skills 目录的 git 不动，提交由你来 |

## 五、规矩

- **派不派、派给谁、brief 怎么写、怎么验收**：权威在 `dispatch/team-leader.md`（组长手册），见第六节。
- **派完就去做别的，干完了宿主会叫你**：组长不守着员工干活。宿主已有完成通知集成时，直接继续其他工作或结束本轮，收到完成通知后用 `task_result` 读结果，不另开 wait。以下仅用于没有完成通知集成的客户端：Claude Code 里，`seat_start` 之后用 Bash 的后台运行（`run_in_background`）跑 `node <本仓库>/bin/specialist-subagents.mjs wait <座位号>`（回复的 `next` 给出完整命令），然后接着干别的或跟用户说话；这一单结束时命令退出，宿主叫醒你，报告就在它的输出里。退出码：0 完成，1 结束但没正常完成，3 等到超时还在跑（默认等 6 小时，`--timeout 秒` 改）。没有后台命令的客户端才用 `task_wait` 兜底；有的客户端对单次工具调用有自己的超时（例如 Codex），`timeout_seconds` 要设得比它短。任何客户端都不要用 `seat_show` 轮询。
- **派活带 `cwd`**：`seat_start` 的 `cwd` 是座位干活的目录，写活所在项目的**绝对路径**，目录必须已存在，否则直接拒绝、不开座位。不给 `cwd` 的座位在服务自己的一个空目录里跑，相对路径碰不到你的任何东西。按领域认专家的岗位（`roles.json` 里 `expert_by: "domain"`，现在是 web_researcher）反过来：带 `domain`、不带 `cwd`，同一领域回到同一个座位；派之前先 `seat_list` 看已有哪些领域，能复用就复用。要接着某一个专家干，把它的座位号给 `seat_start` 的 `seat`（点名派活）；目录用真实路径认（符号链接、junction 指到同一目录算同一个专家）。
- **并发上限 10**：超了会被**直接拒绝**。服务没有队列，这是设计，不是缺陷。
- **记忆是全客户端共享的**：你为某岗位写下的 `fact`，会被该岗位之后每一次运行注入（包括别的 agent 派出去的）。写了就一直在。
- **不要直接改 `.data/ledger.sqlite3`**：一切走工具。
- **停一个座位用 `seat_close`**（在跑的也一样，它会杀整棵进程树并记 `cancelled`），不要用 taskkill 之类强杀：强杀不留遗言，日志里只剩沉默，事后没法读。
- **同一端口不要起第二个服务**：`start` 是幂等的，重复调用安全；更换端口时须让 daemon 与客户端配置一致。

## 六、派不派、派给谁

派活一方怎么做，权威在本仓库 `dispatch/`，不在本文：

- `dispatch/team-leader.md` 是组长手册：派不派（两条硬否决、R / H、一句话验收）、派给谁、brief 怎么写、派完以后、怎么验收。MCP 桥在握手时把它整份作为 `instructions` 发给每个客户端，所以接上服务的会话一开始就读到了；工具被宿主延迟加载时也一样。
- `dispatch/<role>.md` 是各岗位的调用指南（brief 要带齐什么、交回来的是什么、别让它做什么），用 `dispatch_guide` 带 `role` 取。
- 文件每次现读，改了以后新开的会话就带上新版，不用重启服务。

**除 handyman 和 leader 外（roles.json 的 skill_loop: false），每个岗位都在磨自己的 skill**：岗位干活碰到的困难进困难账本，攒够了由 refiner 写出这个岗位 skill 的候选版本，组长核对后才启用。能不能磨成功不预先判断，这些岗位都要试。handyman 和 leader 不走这个循环（`roles.json` 的 `skill_loop: false`），每单也不带 skill：杂活的教训几乎都只能用一次，攒成 skill 只会把下一单不相干的活带偏；它的困难照样记账。所以派对岗位本身就有价值：省了组长的 token，困难也进了对的循环。每一单都带着这个岗位当时在外部 skills 目录里的 skill（排在合同后面、记忆前面，和合同冲突时以合同为准），带的是哪一版记在座位的 `skill` 事件里；还没有 skill 的岗位照常干活，事件记 none。根源在派活一方的困难，核候选时判 `invalid`，教训经用户同意后写进组长手册。

## 七、人看的墙，以及排障

- **岗位墙**：<http://127.0.0.1:43130/>（机器开着时才可达）。每张卡是一个岗位的简报：在岗/最近一次 + 成功·失败计数 + 失败最近发生在何时。组长不要拿它代替 `task_wait` / `task_result`：页面是给人看的。
- **日志**：`.data/daemon.log`（服务的出生／退出／异常，出生行带父进程 pid），`.data/watchdog.log`（看门狗）。
- **看门狗**：`tools/watchdog.mjs`，由启动项 `specialist-subagents-watchdog.vbs` 在登录时拉起，每分钟查一次端口。装/卸：`pwsh -File tools/install-watchdog.ps1`（`-Remove` 卸载）。
- **岗位合同不在本文**：职责、工具面与边界由服务侧的 `roles.json` + `roles/<role>.md` 定义并注入运行时，岗位的外部 skill 跟在合同后面一起注入；调用方怎么用某个岗位，看本仓库 `dispatch/<role>.md`（`dispatch_guide` 带 `role`）。
- **CLI**：`start` / `status` / `stop` / `seats` / `pool` / `wait` / `refine` / `mcp` / `demo`。全局 `--help` / `-h`、`--port`；启动 `--non-interactive`、`--reset-onboarding`。`demo` 使用一次性 daemon 和临时台账，不碰正在跑的服务，需可用后端并花一次真实用量。

## 八、当前 CLI、语言与跨平台启动

需要 Git 克隆仓库和 Node.js >= 22.19.0。服务默认端口为 43130；环境变量 `SPECIALIST_SUBAGENTS_PORT` 可配置，CLI 全局 `--port <number>` 优先。daemon 与 MCP/CLI 客户端应配置相同端口。

完整命令：`start`、`status`、`stop`、`seats [state]`、`pool`、`wait <seat|run> [--timeout 秒]`、`refine <role>`、`mcp [--profile full|core]`、`demo`。全局帮助：`--help` / `-h`。启动参数 `--non-interactive` 禁止询问，`--reset-onboarding` 重置已保存的引导状态（包括 skippedPiInstall）。

`demo` 使用隔离 daemon 和临时台账，不碰正在运行的服务；但仍需至少一家已登录的 CLI 后端，或已配置运行时与 API key（例如 pi + DEEPSEEK_API_KEY），最后会花真实模型用量。

默认英文界面、CLI、MCP instructions 与 dispatch 指南；`SPECIALIST_SUBAGENTS_LANG=zh` 切换中文，浏览器 `?lang=en|zh` 优先于默认语言。英文指南在 `dispatch/*.md`，完整中文原件在 `dispatch/zh-CN/*.md`。`roles/*.md` 刻意保持中文，作为真实生产工程提示词合同样本。CALLER_TITLE 在两种语言都能自定义用户称呼。

Antigravity 的 MCP 配置位于 `~/.gemini/config/mcp_config.json`（部分版本用 `~/.gemini/antigravity/mcp_config.json`）。无头 MCP 调用还需要 `~/.gemini/config/config.json` 中 `userSettings.globalPermissionGrants.allow` 的具体授权，例如 `mcp(specialist-subagents/seat_start)`；leader 需要 `src/lead-tools.mjs` 列出的全部工具授权。无人值守权限模式跳过授权检查，但仍需登记 MCP 服务。

三种系统的看门狗安装入口：Windows `pwsh -File tools/install-watchdog.ps1`；macOS `sh tools/install-watchdog.sh`，模板 `tools/watchdog.plist`；Linux `sh tools/install-watchdog-linux.sh`。从普通用户终端安装。

`GET /` 返回 HTML 岗位墙，`GET /wall` 返回 JSON。启用 SPECIALIST_SUBAGENTS_TOKEN 后，除 GET /health 外的请求均需 Bearer 请求头，普通浏览器地址栏不能附带该头；可用已认证本地代理或 HTTP 客户端。CLI/MCP 自动附带配置的 token。

`npm test` 运行测试集；`node tools/prd-check.mjs` 单独验 PRD 与端到端场景，8 项真实宿主/台账/知识库检查需要本机证据，干净克隆因此退出码为 1。仓库 presets.json 是默认值，本机 .data/presets.json 覆盖可能优先于新版默认。

环境变量还包括 `SPECIALIST_SUBAGENTS_TOKEN`、`SPECIALIST_SUBAGENTS_CALLER_TITLE`、`SPECIALIST_TOOL_PROFILE`（full/core）。`wait` 默认等六小时，最长 24 小时；退出码 0 完成、1 异常、2 参数错误、3 超时。`pool` 不可达时返回「池：未知」。
