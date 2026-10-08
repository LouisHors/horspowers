# Horspowers Release Notes

## v4.8.6 (2026-10-08)

### Bug Fixes

**MCP 的"一次 prepare、会话内复用 scope"在真实项目上失效（两个独立缺陷）**

两个缺陷都让 v4.8.x 中 HPS 的核心收益（MCP sidecar 复用 live scope）在真实项目上默默失效，而且都会返回带有误导性的 `scope_expired`（没有任何东西过期）。两者都从 v4.8.5 归入本版发布说明。

- **符号链接路径下 scope 立即失效**：`assertScope` 把请求的 `cwd` 当**字符串**与 `task_prepare` 存入的 **canonical root** 比较。宿主只要给出符号链接形式的路径（macOS 的 `/tmp`、`/var`，Linux 上链接的 checkout、bind mount），刚发出的 scope 就会被拒。现改为比较规范形式（`realpath`），仅在路径无法解析时（如 dry-run 的 `/repo`）保留字面比较。
- **`project_snapshot` 会删掉刚发出的 scope**：`task_prepare` 仅在 `eligibility === 'project'` 时才验证并合并 validator 结果，却无条件把它装成 provider。普通 git 仓库（尚无 horspowers 配置）拿到 `eligibility: "skipped"`，于是 `git_identity_digest` 与 `config_hash` 被存成 `null` 占位值，首次带 scope 的调用重算出真实值 → 不匹配 → `scope_expired` **并 `invalidateScope` 删除该 scope**，同一会话后续调用全废。而且 `project_context` 与 `project_snapshot` 各用一个 provider（plan 路径 vs 文件系统路径），两者对同一 scope 算出不同事实 —— 因此修法是**同源**：本地项目统一由 validator 验证并绑定。
- 跨项目隔离不变：用 A 的 scope 配 B 的 `cwd` 仍然 `scope_expired`，不会串数据；重新 `task_prepare` 即可恢复。

### Testing

- 新增 `tests/hps/mcp-live-scope.test.mjs`：**真实 spawn `hps serve --stdio`**，在符号链接目录上验证 prepare 后 `project_snapshot`、`project_context`、`document_resolve`、checkpoint 读写全部复用同一 scope，以及跨项目拒绝与重新 prepare 恢复。约 0.5s，已纳入 `hps-regression`（54/54）。
- `tests/hps/scope-cache.test.mjs` 新增两条单元测试锁定根因：符号链接拼写必须被接受；未注册本地项目必须绑定其验证器算出的事实。
- **为什么旧测试抓不到**：所有 scope 测试用 `cwd: '/repo'`（**不存在的路径**，字面比较恒成立且 `realpath` 回落字面比较）；所有 scope 测试用假 plan（`eligibility: 'project'`），从未覆盖真实仓库的 `'skipped'`；且没有任何测试真正 spawn sidecar（全是进程内 `server.handle()`，共享同一 runtime 对象）。

### Tooling

- 新增 `scripts/audit-hps-simulated-flows.mjs`：57 项模拟调用审计（一次性 CLI、MCP 会话、live scope 复用、跨项目隔离、CLI/MCP 等价性、capability fail-closed、兼容入口、路由语义）。开发工具，非回归闸门。
  - 它发现两个缺陷前后的对照：未修复的 4.8.4 上 **44 pass / 10 warn / 3 fail**，本版 **57 pass / 0 warn / 0 fail**。

### Compatibility and Rollback

- 无协议、operation 注册表或权限边界变更；仅放宽 scope 校验中的路径拼写比较与事实绑定范围，跨项目仍 fail closed。
- 回滚可 revert 本版提交（scope 修复在 v4.8.5 中已合入主线，本版只是补齐发布说明与工具）。

---

## v4.8.5 (2026-10-08)

### Bug Fixes

**`using-horspowers` 把「任何 non-zero」一律当成 HPS 不可用**
- 「处理结果」第 5 条原文：``HPS CLI/MCP non-zero：先报告 HPS 不可用，再按旧 router 兼容入口做一次安全 fallback``。而 `invalid_request`（调用方形状错）也是一个 non-zero 结果，于是它与同一文档里新增的「不得据此降级」直接矛盾 —— 两条规则同时成立时，不明确哪条优先，agent 可能仍然降级。
- 现在改为**按错误码分类**：`invalid_request` → 修正 envelope 后重试且不得降级；`operation_unavailable` / `operation_not_found` → 走对应受控入口，不得据此推断不可用；`scope_expired` → 重新 `task_prepare` 或重做本次 operation；只有 **HPS 不可发现、协议不可用、或明确报告初始化回退**时才走 legacy fallback。四个错误码均在 `HPS_ERROR_CATALOG` 中。

**两份通道文档给同一负载用了不同变量名**
- `SKILL.md` 用 `HPS_REQUEST`，`references/host-path-resolution.md` 用 `HPS_CALL_REQUEST`，指的是同一份 canonical envelope。变量名不统一正是把扁平对象误当成 `hps call` 负载的温床，因此统一为 `HPS_CALL_REQUEST`（扁平对象继续用 `HORSPOWERS_ROUTER_INPUT`）。

### Testing

- 新增 `validateChannelDocs(skillText, pathReferenceText)` 与对应测试：两份文档必须同时命名 `HPS_CALL_REQUEST`、不得出现歧义的 `HPS_REQUEST`、`invalid_request` 必须与「不得降级」共现、且必须对非可用类错误码分类。
- 反向验证：把变量名改回 `HPS_REQUEST`、把参照文档改成 `HPS_PAYLOAD`、删掉 `invalid_request` 禁令，三种变异都被拒绝。
- 全量回归 **479/479**。

### Compatibility and Rollback

- 仅技能文本与测试变更；CLI、协议、operation 注册表未改。
- 回滚可直接 revert 本版提交。

---

## v4.8.4 (2026-10-08)

### Testing

**技能契约测试新增第四个维度：引用的文件必须存在**
- 提取技能里的内联 `code` token，把 `references/*.md`（相对技能目录）与裸脚本名（在 `lib/`、`skills/` 下索引 basename）逐个验证存在性。文件被改名或删除时，技能里的引用会静默失效 —— 这类漂移此前只能靠人查。
- 校验器新增可注入的 `fileExists` 断言，使它与文件系统解耦，可以用合成文档测试。
- 反向验证：合成文档引用一个不存在的文件会报 ``skill references a path that does not exist``；实际变异（把技能里的 `references/config-bootstrap.md` 改名）会让实时测试失败并给出精确路径，恢复后 4/4。

**修正提取方式的一个真陷阱**：直接用 `` `([^`]+)` `` 提取内联代码会与**代码围栏的连续反引号错配**，把整个 fenced 块吞成一个 token。新的提取先剔除围栏块再取内联 token。（这个问题使首次提取结果为 0 个引用 —— 即一个静默的假阴性。）另外测试文件新增 `skillDir`，引用解析以技能目录为基准。

### 累计四个维度

`tests/hps/skill-operation-contract.test.mjs` 现在锁住：操作清单 vs 注册表、`task_prepare` 结果字段 vs 真实 envelope、请求形状 vs `parseCallRequest`、引用路径 vs 文件系统。四次漂移（`scope_id`、`mutations`、扁平 stdin 形状、即将发生的引用失效）均属同一家族，已全部纳入自动检测。

### Compatibility and Rollback

- 仅测试变更，无技能文本、CLI、协议变更。
- 回滚可直接 revert 本版提交。

---

## v4.8.3 (2026-10-08)

### Bug Fixes

**`using-horspowers` 的 stdin 契约写错了形状，导致主路径按字面执行必失败**
- 技能「安全输入契约」给出的是**扁平对象** `{schema_version, host, cwd, message, active_route}` —— 那是 **legacy `route-request.mjs`** 的输入（`lib/workflow-router.mjs` 的 `INPUT_KEYS`）。但同一节的示例却把它喂给 `hps call`，而 `hps call` 要的是 **canonical envelope** `{schema_version, request_id, operation, cwd, input}`。
- 实测：扁平对象喂 `hps call` → `invalid_request`。后果是 agent 照技能执行 → 报错 → 按「处理结果」第 5 条判为「HPS 不可用」→ **静默降级到兼容入口**。主路径名义上存在、实际不可用。
- 修正：技能与 `references/host-path-resolution.md` 现在分开写明两种形状，并明确「把扁平对象喂 `hps call` 只会得到 `invalid_request`，那不是 HPS 不可用，不得据此降级」。示例改用 `HPS_CALL_REQUEST`（envelope），兼容入口用 `HORSPOWERS_ROUTER_INPUT`（扁平）。

### Testing

- 技能契约测试新增一条：**技能必须包含一份 `hps call` 真正接受的请求示例**（用 `parseCallRequest` 校验文档里的 fenced JSON 块）。此前的检查只看 operation 清单与 `task_prepare` 的结果字段，看不到请求形状。
- 反向验证：合成文档用扁平对象冒充 `hps call` 请求时，检查器会报 ``skill must show a `hps call` request the CLI accepts``。

### Compatibility and Rollback

- 仅有技能文本与测试变更；CLI、协议、operation 注册表均未改（`hps call` 一直要求 envelope，是文档写错了）。
- 回滚可直接 revert 本版提交；已按旧文档降级到兼容入口的宿主行为不变。

---

## v4.8.2 (2026-10-08)

### Testing

**技能文本与 runtime 的契约测试（pin 住已漂移两次的字段）**
- 新增 `tests/hps/skill-operation-contract.test.mjs`：不再重抄文本，而是**从 operation 注册表推导期望值** —— 「无 scope 依赖」与「必需 `scope_id`」两个清单必须等于注册表按 descriptor 的 `required` 划分的集合（`session_*`/`checkpoint_*` 由注册表展开）。
- 同时跑一次真实 `hps call` 的 `task_prepare` envelope：技能点名的字段（`routing`/`project`/`collected`/`scope`/`capabilities`）必须真实存在，`mutations` 必须**不存在**。
- 校验器自身用合成文档测过四种情形（正确 → 无违规；历史 `mutations` 措辞 → 违规；清单多出注册表没有的 operation → 违规；清单被删 → 违规），避免「实时文本恰好匹配」造成假通过。

**`hps-unit` verification profile 纳入该套件**
- profile 从 18 个测试增至 21 个（`protocol` + `runtime` + `skill-operation-contract`）。此前只有全局 `node --test tests/hps/*` 覆盖它，MCP `verification_run(profile="hps-unit")` 看不到。
- 新增断言要求 `hps-unit` 必须包含该套件，避免日后被静默移除。
- 实测该 profile 仍为 `status: passed`、`exit_code: 0`、约 231ms、未截断。

### Documentation

- **`AGENTS.md` 重写**：补充 HPS 分工（技能推理 / HPS 执行）、两条执行通道与 scope 边界、宿主矩阵（Codex / Claude Code / Pi / OpenCode 兼容）、capability fail closed、仓库布局与 portable timeout 要求；修正 4 处事实错误（`tests/Codex` 大小写、不存在的根 `plugin.json`、个人技能目录、发明出来的测试调用方式）。
- **移除 `CLAUDE.md`**：与旧 `AGENTS.md` 归一化后逐行相同（无独有内容），且 Pi 会用同一目录的两份上下文文件重复注入过时指引；Claude Code 2.x 亦发现 `AGENTS.md`（其 bundle 原文：`Claude Code hardcodes CLAUDE.md / AGENTS.md discovery.`）。
- **归档 5 份 HPS 迁移前的历史文档**到 `docs/archive/`（`docs/tasks/` 随之清空），并修正 `README.md` 的入站链接。
- `docs/README.pi.md`：安装/更新步骤可验证化（补 tag、pin 与跟随 main 两种策略、`--exposure direct`、`/reload` 生效方式、验证命令），新增开发期跟随工作副本的说明与 symlink 陷阱。

### Bug Fixes

**修正技能里两处"描述错 envelope"的说明**
- `scope_id` 不跨 `hps call` 进程存活，原文「`hps call`（先 `task_prepare` 取 scope）」无法实现；现按「无 scope 可直接一次性调用」与「必需 `scope_id`」分流，落入受控兼容入口。
- `mutations` 不是 `task_prepare` 的字段（它只由 legacy `route-request.mjs` 产生）；主路径改指 `project.config_action` / `project.docs_action`。

### Compatibility and Rollback

- 除 verification profile 的文件列表外，无运行时代码变更；无技能契约、协议或安全边界变更。
- 未删除文件（除重复的 `CLAUDE.md`），未修改用户级配置；文档移动均可用 revert 恢复。
- `docs/archive/` 内文档的内部链接与历史遗留断链未改写。

---

## v4.8.1 (2026-10-08)

### Documentation and Skill Contracts

**明确 HPS 两条执行通道的边界（MCP 与 CLI）**
- `using-horspowers` 新增 `## 执行通道`：列出无 scope 依赖、可一次性 `hps call` 调用的 operation（`task_prepare`、`project_snapshot`、`git_preflight`、`diff_snapshot`、`document_resolve`、`runtime_doctor`），以及必需 `scope_id`、不能跨 `hps call` 进程调用的 operation（`project_context`、`document_search`、`document_get`、`document_manifest`、`document_verify`、`context_collect`、`verification_run`、`session_*`、`checkpoint_*`、`commit_preview`、`merge_preview`）。
- `document-management` 修正了无法实现的表述「`hps call`（先 `task_prepare` 取 scope）」：`resolve` 可走一次性 CLI；`get`/`search`/`manifest`/`verify` 必需 `scope_id`，无 MCP 时改走受控兼容入口 `document-runtime-cli.mjs`，不再依赖「HPS 不可用」作为前提。
- 明确 HPS 运行态不落盘（`documentCache`/`sessionState`/`checkpoints`/`sessionRecords` 均为内存 Map）：MCP 提供的是**会话内复用**，不是持久化；跨会话持久化由文档系统与 Wiki 承担。scope 还受 5 分钟 TTL 与 `generation`/`fact_digest` 校验约束。
- `docs/README.pi.md` 新增 `MCP is not required — pick a channel`；`docs/README.codex.md`、`docs/README.opencode.md` 补充同样的边界。

### Testing

- 新增 `CLI-only hosts route scope-requiring operations away from hps call`（确定性，断言技能文本不得把 CLI 进程描述为可复用 scope）。
- 更新 `tests/hps/skill-chain.test.mjs` 与 `tests/hps/skill-entrypoint-chain.test.mjs` 的断言以锁住新分流，并新增禁止旧跨进程 scope 表述的反向断言。
- 合并回归（collector + wiki-docs + workflow-router + hps）：468/468 通过，0 failed、0 skipped。

### Compatibility and Rollback

- 纯文本与契约变更，无运行时代码改动；MCP 仍为可选增强。
- 未删除文件，未修改用户级配置。回滚可直接 revert 本版提交。

---

## v4.8.0 (2026-10-08)

### New Features

**Pi agent 适配（首个通过真实验收的宿主）**
- Host 抽象扩展：`HPS_HOSTS`、operation `host` enum、workflow router `VALID_HOSTS`、legacy route bridge 均支持 `pi`。
- MCP 注册：`SUPPORTED_HOSTS` 新增 `pi`（`mcpServers` 形状），新增 `templates/mcp/pi.json`，`scripts/install-hps-mcp.mjs` 支持 `--host pi`。
- 路径解析：`skills/using-horspowers/references/host-path-resolution.md` 与 `SKILL.md` 新增 Pi 行与示例（安装根由 Pi 给出的 skill 绝对路径向上解析）。
- native host probe 支持 `pi`：使用临时 `PI_CODING_AGENT_DIR` 与临时 `mcp.json`（`exposure: "direct"`），**不改写全局 MCP 配置**；符号链接复用操作者的 `auth.json`/`models.json` 而不复制密钥；`pi --print --mode json` 经 stdin 传 prompt，并容忍模型把答案包在 ```` ```json ```` 围栏里。
- 文档：新增 `docs/README.pi.md`。

### Verification

- **真实 pi native probe：`STATUS = pass`（退出码 0）**。direct 通道（`hps version`、`hps call`、`hps serve --stdio` 的 19 工具 MCP 握手）通过；`pi mcp list` 报告 `hps` connected / 19 工具；agent 步退出码 0，真实调用 `mcp__hps__runtime_doctor` 成功（`runtimeDoctorCalls: 1`）。
- 合并回归（collector + wiki-docs + workflow-router + hps）：467/467 通过，0 failed、0 skipped。
- 新增测试先 RED 后 GREEN：capability adapter、MCP 注册、router host、probe invocation/parser（含围栏 JSON 解析）。
- 仓库审计按预期拒绝未登记的文件系统写入：`lib/hps-native-host-probe.mjs` 的 mutation inventory 显式新增 `mkdir`/`symlink`，均限定在探针自己的 `mkdtemp` artifact 目录内。

### Compatibility and Rollback

- Codex / Claude Code 适配仍不作为验收门（用户决策 2026-10-08）；两宿主的 direct 通道通过，真实 agent 步为宿主侧 timeout/failed，不计为通过。
- Pi 无 SessionStart hook：Horspowers 不为 Pi 写入 `AGENTS.md`，也不安装 Pi extension。
- Pi capability 默认 fail closed；`approval_available` 无 Pi 对应语义，应保持 `false`。
- 未删除文件，未自动修改用户级配置。探针的所有写入都限制在临时目录。

---

## v4.7.1 (2026-10-08)

### New Features

**HPS agent-first core CLI 与 MCP sidecar**
- `bin/hps` 提供 `hps call`（stdin-only 结构化调用）、`hps version --json`、`hps doctor --json` 与 `hps serve --stdio`（MCP sidecar）四个入口。
- 19 个公开 operation 共用单一 registry；CLI 与 MCP 的 canonical envelope（success / error / result / metrics）等价。
- 子进程固定 program/args 且 `shell:false`，env 显式 allowlist；宿主 capability 无法验证时一律 fail closed，Sidecar 不作为沙盒绕过通道。
- Scope / snapshot / document cache、persistent qmd read session、session / checkpoint 控制态递归安全、commit / merge preview 与 19 个 MCP 工具的强类型 schema 已实现。
- Skill 的确定性边界迁移到 HPS/Core：route、document 只读、context 与 session 走 `hps call`；document 写操作保留受控兼容入口；legacy route/hooks 保持旧 envelope 等价。
- 提供 Codex / Claude Code capability adapter、MCP 注册模板与 project-local 注册生成，以及替换 GNU `timeout` 的仓库内 portable helper。
- 设计、实施与收口计划见 `docs/plans/2026-08-13-design-hps-agent-first-core-cli-与-mcp-sidecar.md`、`docs/plans/2026-08-13-hps-phase2-skill-execution-plane.md` 与 `docs/plans/2026-08-14-hps-phase-1-2-gap-closure-plan.md`。

### Bug Fixes

**回归套件不确定性（含真实 runtime bug）**
- `scopeToken()` 原先使用 `randomBytes(18).toString('base64url')`，有 3.125% 概率生成首字符为 `-` 或 `_` 的 id，而控制态校验器要求首字符为字母数字；另有 `-var-` 词边界片段与 `sk-`/`gh?_` 凭据前缀误判类别。结果是由 runtime 自己生成、随后被自己拒绝的 opaque id 随机失败（实测 200000 次 `openScope`+`sessionPrepare` 拒绝 6233 次）。现改为 `randomBytes(12).toString('hex')`，实测 1,000,000 次 0 拒绝。
- `tests/wiki-docs` 的仓库审计会遍历仓库内 `tests/.artifacts/`（实测 42012 个目录 / 266MB，且随运行次数无界增长），并与并行测试的 `rm -rf` 竞态，导致约 30% 概率随机失败且失败项不固定。审计忽略列表新增 `.artifacts` 与 `.horspowers`。
- 合并回归（collector + wiki-docs + workflow-router + hps）：连续 5 次 464/464 通过，0 failed、0 skipped；`tests/hps/*` 单独 177/177。

### Compatibility and Rollback

- Codex / Claude Code 的 native probe direct 通道（`hps version`、`hps call`、`hps serve --stdio` 的 19 工具 MCP 握手）通过；两宿主的真实 agent 步在本机为宿主侧 timeout / failed，已明确移出本版验收门，不记为通过。
- Pi agent 适配列为下一阶段，本版不包含。
- 未删除文件，未修改全局 MCP 配置。回滚可直接撤销本版提交。

---

## v4.7.0 (2026-08-13)

### New Features

**确定性快慢工作流路由**
- `using-horspowers` 现在通过 stdin-only 本地路由器返回唯一高置信度 workflow、`direct` 或 `uncertain`，避免在明确请求上重复展开通用流程。
- 路由器将安全项目资格检查、只读 Plan 与幂等 Apply 合并为一个入口；Codex 的 AGENTS 托管区块、团队配置和通用 docs 均不覆盖已有用户内容。
- brainstorming 仅在需要探索时并行收集 Wiki、仓库、Git 和已知入口背景，并在 `rg` 或 qmd 缺失时有边界地回退。

**公司项目 Wiki 外置配置与文档**
- 已确认的公司 Git remote 现在按精确 host 和稳定 SHA-256 fingerprint 解析 Wiki Registry、项目配置和 manifest；域名/IP 的同一仓库得到同一身份，后缀伪装与身份歧义会 fail closed。
- 公司项目判定增加本机路径条件：macOS/Windows 用户目录内的公司仓库副本保持普通本地项目行为，Linux 跳板机上的可信 remote 继续进入外置模式；可用 `HORSPOWERS_LOCAL_PROJECT_ROOTS` 显式覆盖。
- 公司项目的配置与已入库文档可从 Wiki 精确读取，所有 create、update、archive、restore、config-change 和会话记录统一走 Inbox-only 投稿与唯一 `documentation.submission.auto_submit` 开关。
- Registry、配置、manifest、qmd、SSH 或 Inbox 不可用时，不创建项目内配置或 Horspowers `docs/`，也不会把待审核投稿误称为已入库。用户仍在本机审核、入库并运行 `qmd update`。

### Compatibility and Rollback

- Codex 和 Claude Code 继续使用各自原生入口；未知宿主无法安全解析路径时保持 LLM 回退且零写入。
- 回滚可撤销路由 / hook 集成提交；已有 Codex AGENTS 托管区块采用版本 marker 与备份，不需要删除用户内容。
- 非删除式双宿主 route-only 验收已记录于 `tests/skill-trigger/runs/2026-08-05-fast-slow-routing-v1.yaml`。含清理行为的 legacy suites 未获授权，未执行也未标记为通过。

## v4.5.1 (2026-06-18)

### Bug Fixes

**修复 `session-start.sh` hook 的路径解析问题**
- 将 `require('./lib/config-manager.js')` 改为基于 `PLUGIN_ROOT` 的绝对路径引用
- 解决 Claude Code 从项目目录启动 hook 时 `MODULE_NOT_FOUND` 导致退出码 1 的问题
- 兼容插件缓存目录、本地源码目录以及手动直接运行等多种调用场景

---

## v4.5.0 (2026-05-13)

### Improvements

**提升 Claude Code 技能触发可用性**
- 为 `writing-plans`、`systematic-debugging`、`test-driven-development`、`requesting-code-review`、`document-management` 增加强制首响规则与更明确的触发边界
- 为 `executing-plans` 和 `subagent-driven-development` 补齐 execution-lane 的区分规则，修复 Claude 在“检查点执行”和“当前会话连续推进”之间的混淆
- 强化 Claude startup profile 的 route-only 约束，避免评测时直接越界执行任务内容

### Testing

**修正 skill-trigger harness 并补充 Claude route-only 回归**
- 修正官方 runner 对 startup profile 的真实注入方式
- 改为过滤式 skills 目录注入，避免递归 `skills/skills` 之类的路径污染
- 新增 `2026-05-13-claude-route-only-recovery.yaml`，记录 Claude 在 route-only 首响评估下恢复到可用状态

---

## v4.4.0 (2026-04-29)

### New Features

**同步上游 brainstorming / Codex 兼容能力**
- 对齐持续执行与 worktree 检测/延迟策略，强化隔离开发流程
- 为 brainstorming 与 writing-plans 增加文档审查门禁，补齐 Claude Code 与 Codex 的测试覆盖
- 完善 brainstorming visual companion 指南，并提供独立的脑暴服务测试入口

### Testing

**稳定客户端兼容性测试**
- 稳定 Claude Code 技能测试提示词，降低因模型自由发挥导致的误报
- 验证 `tests/claude-code/run-skill-tests.sh --suite full` 全量通过
- 验证 Codex 文档审查流程与 brainstorm server 测试可独立运行

---

## v4.3.4 (2026-02-12)

### Bug Fixes

**移除对旧配置文件的依赖**
- 修复 `brainstorming` 和 `writing-plans` 技能中对 `.superpowers-config.yaml` 的引用
- 移除 `session-end.sh` hook 中对旧配置文件的检测逻辑
- 确保所有技能和脚本仅依赖 `.horspowers-config.yaml`

---

## v4.3.3 (2026-01-27)

### Improvements

**增强文档系统与工作流的集成**
- 优化 brainstorming 技能中的文档创建流程
- 更新 writing-plans 技能的计划文档模板
- 改进 subagent-driven-development 的文档追踪逻辑

---

## v4.3.2 (2026-01-27)

### Documentation

**完善 README 中文安装使用指南**
- 新增「安装与使用」中文章节
- 包含：插件安装、验证安装、快速开始、配置说明、文档系统、常用命令速查、故障排除
- 提升中文用户的使用体验

**文档结构优化**
- 移除重复的集成指南文档 (`document-driven-integration-guide*.md`)
- 归档已完成任务文档到 `docs/archive/`
- 简化文档目录结构

---

## v4.3.1 (2026-01-22)

### Bug Fixes

**修复 /upgrade 命令缺失技能定义**
- 问题：`commands/upgrade.md` 引用 `horspowers:upgrade` 技能，但技能文件不存在
- 修复：
  * 创建 `skills/upgrade/SKILL.md` 技能定义
  * 更新 `commands/upgrade.md` 使用标准命令格式
  * 添加 `tests/claude-code/test-upgrade.sh` 测试文件
- 影响：`/upgrade` 命令现在可以正常工作

### Documentation

**添加 upgrade 技能测试**
- 测试技能可用性和版本检测功能
- 验证 DDAW 目录处理逻辑
- 确认文档迁移相关功能

---

## v4.2.2 (2025-01-20)

### Documentation

**更新 .gitignore**
- 添加 `.DS_Store` 和 `.DS_Store?` 到忽略列表（macOS 系统文件）

**移除过时的配置文件**
- 移除 `.superpowers-config.yaml` 和 `.superpowers-config.yaml.example`
- 配置系统已简化，这些文件不再需要

---

## v4.2.1 (2025-01-20)

### New Features

**版本升级脚本 (Version Upgrade Script)**

添加了自动检测和迁移旧版本的功能，帮助用户从 4.2.0 以前版本平滑升级。

- `lib/version-upgrade.js` - 升级脚本核心模块
  * 检测版本标记文件 `.horspowers-version`
  * 识别并处理 `document-driven-ai-workflow` 旧目录
  * 执行文档目录统一迁移
  * 交互式用户确认和错误恢复
- `bin/upgrade` - CLI 命令行入口
- `commands/upgrade.md` - Claude Code 命令
- `hooks/session-start.sh` - 会话开始时自动检测升级需求

升级功能：
- 版本比较逻辑（仅对 < 4.2.0 触发）
- 询问用户是否移除旧目录（带详细说明）
- 执行文档迁移到统一 `docs/` 结构
- 备份旧目录到 `.horspowers-trash/`
- 成功后更新版本标记文件

### Bug Fixes

**修复版本升级脚本仅在成功时更新标记**
- 问题：`run()` 方法始终调用 `showCompletion()` 和 `updateVersionMarker()`，无论迁移是否成功
- 修复：添加 `hasError` 标志，仅在 `!hasError` 时更新版本标记
- 影响：确保失败后可以重试升级

**修复 quiet 模式下版本标记未更新**
- 问题：版本标记更新在 `if (!options.quiet)` 块内
- 修复：移到块外，确保所有模式都更新标记
- 影响：quiet 模式现在正确记录版本

**修复文档元数据路径跨设备兼容性**
- 问题：`session-end.sh` 保存绝对路径，跨设备协作失效
- 修复：改用相对路径存储（`path.relative(workingDir, absPath)`）
- 影响：`TASK_DOC` 和 `BUG_DOC` 现在支持跨设备恢复

**修复 getActiveTask 向后兼容性**
- 问题：新格式 `task:path` 导致旧格式（仅绝对路径）文件无法解析
- 修复：添加旧格式回退逻辑（路径仅存在时假定为 task 类型）
- 影响：现有 `active-task.txt` 文件继续可用

**修复 brainstorming 测试缺失失败判断**
- 问题：`test_brainstorming_asks_questions` 所有路径都返回 0
- 修复：改为扁平 if 序列，最终 `return 1`
- 影响：测试现在能正确检测失败情况

**修复 hooks/bash 语法问题**
- 问题：`WORKING_DIR` 变量未定义
- 修复：改用 `$PWD`
- 问题：node -e 中使用 `return` 语句非法
- 修复：改用变量赋值 + `break` 模式

### Documentation

**更新 .gitignore**
- 添加 `.horspowers-version` 到忽略列表

---

## v4.2.0 (2025-01-19)

### Major Features

**统一文档系统 (Unified Document System)**

实现了一套完整的文档管理系统，替代了原有的 document-driven-bridge 集成方式，提供无缝的文档追踪和状态管理。

核心组件：
- `lib/docs-core.js` (1076 行) - 文档管理核心模块
  * 支持文档创建、更新、搜索、统计
  * 智能文档分类（design、plan、task、bug、decision、context）
  * 自动迁移工具（检测并整合多个文档目录）
  * 元数据追踪（活跃任务、检查点验证）
- `hooks/session-end.sh` - 会话结束自动归档和状态更新
- `skills/document-management/` - 文档管理技能
- 6 个新命令：`/docs-init`, `/docs-migrate`, `/docs-search`, `/docs-stats`, `/docs-analyze`, `/docs-status`

工作流集成：
- **brainstorming**: 设计完成后自动创建 decision 文档
- **writing-plans**: 计划完成后自动创建 task 文档并设置 `$TASK_DOC`
- **subagent-driven-development**: 每个任务完成后自动更新进展
- **test-driven-development**: 测试失败时自动创建 bug 文档，修复后更新状态
- **finishing-a-development-branch**: 完成后自动归档文档

配置支持：
```yaml
# .superpowers-config.yaml
documentation:
  enabled: true
  # 自动创建和更新文档
```

### Bug Fixes

**修复环境变量设置错误**
- 问题：在 Node.js `-e` 脚本中直接使用 `export` 命令导致语法错误
- 修复：使用命令替换 `VAR=$(node -e "...")` 捕获输出，再在 shell 层面导出
- 影响：test-driven-development, writing-plans 技能

**修复不可达代码**
- 问题：`subagent-driven-development` 中 `else if` 使用与 `if` 相同的条件
- 修复：改为 `else` 分支，处理没有进展记录的情况
- 影响：任务文档进展更新功能

**修复配置解析错误**
- 问题：YAML 点分符号（如 `documentation.enabled`）被解析为扁平键而非嵌套对象
- 修复：使用 Node.js 正确解析为嵌套 JSON 结构
- 影响：session-start.sh 和 session-end.sh 的配置检查

### Deprecations

**document-driven-bridge 已标记为废弃**

原有的 bridge 集成方式已被统一文档系统替代：
- ✅ 无需额外配置或 bridge
- ✅ 自动状态追踪
- ✅ 会话恢复
- ✅ 智能归档
- ✅ 与所有工作流技能无缝集成

### Documentation

新增文档：
- `docs/unified-document-system.md` - 用户指南
- `docs/document-migration-guide.md` - 迁移指南
- `docs/plans/2025-01-19-unified-document-system-design.md` - 设计文档

---

## v4.0.3 (2025-12-26)

### Improvements

**Strengthened using-superpowers skill for explicit skill requests**

Addressed a failure mode where Claude would skip invoking a skill even when the user explicitly requested it by name (e.g., "subagent-driven-development, please"). Claude would think "I know what that means" and start working directly instead of loading the skill.

Changes:
- Updated "The Rule" to say "Invoke relevant or requested skills" instead of "Check for skills" - emphasizing active invocation over passive checking
- Added "BEFORE any response or action" - the original wording only mentioned "response" but Claude would sometimes take action without responding first
- Added reassurance that invoking a wrong skill is okay - reduces hesitation
- Added new red flag: "I know what that means" → Knowing the concept ≠ using the skill

**Added explicit skill request tests**

New test suite in `tests/explicit-skill-requests/` that verifies Claude correctly invokes skills when users request them by name. Includes single-turn and multi-turn test scenarios.

## v4.0.2 (2025-12-23)

### Fixes

**Slash commands now user-only**

Added `disable-model-invocation: true` to all three slash commands (`/brainstorm`, `/execute-plan`, `/write-plan`). Claude can no longer invoke these commands via the Skill tool—they're restricted to manual user invocation only.

The underlying skills (`superpowers:brainstorming`, `superpowers:executing-plans`, `superpowers:writing-plans`) remain available for Claude to invoke autonomously. This change prevents confusion when Claude would invoke a command that just redirects to a skill anyway.

## v4.0.1 (2025-12-23)

### Fixes

**Clarified how to access skills in Claude Code**

Fixed a confusing pattern where Claude would invoke a skill via the Skill tool, then try to Read the skill file separately. The `using-superpowers` skill now explicitly states that the Skill tool loads skill content directly—no need to read files.

- Added "How to Access Skills" section to `using-superpowers`
- Changed "read the skill" → "invoke the skill" in instructions
- Updated slash commands to use fully qualified skill names (e.g., `superpowers:brainstorming`)

**Added GitHub thread reply guidance to receiving-code-review** (h/t @ralphbean)

Added a note about replying to inline review comments in the original thread rather than as top-level PR comments.

**Added automation-over-documentation guidance to writing-skills** (h/t @EthanJStark)

Added guidance that mechanical constraints should be automated, not documented—save skills for judgment calls.

## v4.0.0 (2025-12-17)

### New Features

**Two-stage code review in subagent-driven-development**

Subagent workflows now use two separate review stages after each task:

1. **Spec compliance review** - Skeptical reviewer verifies implementation matches spec exactly. Catches missing requirements AND over-building. Won't trust implementer's report—reads actual code.

2. **Code quality review** - Only runs after spec compliance passes. Reviews for clean code, test coverage, maintainability.

This catches the common failure mode where code is well-written but doesn't match what was requested. Reviews are loops, not one-shot: if reviewer finds issues, implementer fixes them, then reviewer checks again.

Other subagent workflow improvements:
- Controller provides full task text to workers (not file references)
- Workers can ask clarifying questions before AND during work
- Self-review checklist before reporting completion
- Plan read once at start, extracted to TodoWrite

New prompt templates in `skills/subagent-driven-development/`:
- `implementer-prompt.md` - Includes self-review checklist, encourages questions
- `spec-reviewer-prompt.md` - Skeptical verification against requirements
- `code-quality-reviewer-prompt.md` - Standard code review

**Debugging techniques consolidated with tools**

`systematic-debugging` now bundles supporting techniques and tools:
- `root-cause-tracing.md` - Trace bugs backward through call stack
- `defense-in-depth.md` - Add validation at multiple layers
- `condition-based-waiting.md` - Replace arbitrary timeouts with condition polling
- `find-polluter.sh` - Bisection script to find which test creates pollution
- `condition-based-waiting-example.ts` - Complete implementation from real debugging session

**Testing anti-patterns reference**

`test-driven-development` now includes `testing-anti-patterns.md` covering:
- Testing mock behavior instead of real behavior
- Adding test-only methods to production classes
- Mocking without understanding dependencies
- Incomplete mocks that hide structural assumptions

**Skill test infrastructure**

Three new test frameworks for validating skill behavior:

`tests/skill-triggering/` - Validates skills trigger from naive prompts without explicit naming. Tests 6 skills to ensure descriptions alone are sufficient.

`tests/claude-code/` - Integration tests using `claude -p` for headless testing. Verifies skill usage via session transcript (JSONL) analysis. Includes `analyze-token-usage.py` for cost tracking.

`tests/subagent-driven-dev/` - End-to-end workflow validation with two complete test projects:
- `go-fractals/` - CLI tool with Sierpinski/Mandelbrot (10 tasks)
- `svelte-todo/` - CRUD app with localStorage and Playwright (12 tasks)

### Major Changes

**DOT flowcharts as executable specifications**

Rewrote key skills using DOT/GraphViz flowcharts as the authoritative process definition. Prose becomes supporting content.

**The Description Trap** (documented in `writing-skills`): Discovered that skill descriptions override flowchart content when descriptions contain workflow summaries. Claude follows the short description instead of reading the detailed flowchart. Fix: descriptions must be trigger-only ("Use when X") with no process details.

**Skill priority in using-superpowers**

When multiple skills apply, process skills (brainstorming, debugging) now explicitly come before implementation skills. "Build X" triggers brainstorming first, then domain skills.

**brainstorming trigger strengthened**

Description changed to imperative: "You MUST use this before any creative work—creating features, building components, adding functionality, or modifying behavior."

### Breaking Changes

**Skill consolidation** - Six standalone skills merged:
- `root-cause-tracing`, `defense-in-depth`, `condition-based-waiting` → bundled in `systematic-debugging/`
- `testing-skills-with-subagents` → bundled in `writing-skills/`
- `testing-anti-patterns` → bundled in `test-driven-development/`
- `sharing-skills` removed (obsolete)

### Other Improvements

- **render-graphs.js** - Tool to extract DOT diagrams from skills and render to SVG
- **Rationalizations table** in using-superpowers - Scannable format including new entries: "I need more context first", "Let me explore first", "This feels productive"
- **docs/testing.md** - Guide to testing skills with Claude Code integration tests

---

## v3.6.2 (2025-12-03)

### Fixed

- **Linux Compatibility**: Fixed polyglot hook wrapper (`run-hook.cmd`) to use POSIX-compliant syntax
  - Replaced bash-specific `${BASH_SOURCE[0]:-$0}` with standard `$0` on line 16
  - Resolves "Bad substitution" error on Ubuntu/Debian systems where `/bin/sh` is dash
  - Fixes #141

---

## v3.5.1 (2025-11-24)

### Changed

- **OpenCode Bootstrap Refactor**: Switched from `chat.message` hook to `session.created` event for bootstrap injection
  - Bootstrap now injects at session creation via `session.prompt()` with `noReply: true`
  - Explicitly tells the model that using-superpowers is already loaded to prevent redundant skill loading
  - Consolidated bootstrap content generation into shared `getBootstrapContent()` helper
  - Cleaner single-implementation approach (removed fallback pattern)

---

## v3.5.0 (2025-11-23)

### Added

- **OpenCode Support**: Native JavaScript plugin for OpenCode.ai
  - Custom tools: `use_skill` and `find_skills`
  - Message insertion pattern for skill persistence across context compaction
  - Automatic context injection via chat.message hook
  - Auto re-injection on session.compacted events
  - Three-tier skill priority: project > personal > superpowers
  - Project-local skills support (`.opencode/skills/`)
  - Shared core module (`lib/skills-core.js`) for code reuse with Codex
  - Automated test suite with proper isolation (`tests/opencode/`)
  - Platform-specific documentation (`docs/README.opencode.md`, `docs/README.codex.md`)

### Changed

- **Refactored Codex Implementation**: Now uses shared `lib/skills-core.js` ES module
  - Eliminates code duplication between Codex and OpenCode
  - Single source of truth for skill discovery and parsing
  - Codex successfully loads ES modules via Node.js interop

- **Improved Documentation**: Rewrote README to explain problem/solution clearly
  - Removed duplicate sections and conflicting information
  - Added complete workflow description (brainstorm → plan → execute → finish)
  - Simplified platform installation instructions
  - Emphasized skill-checking protocol over automatic activation claims

---

## v3.4.1 (2025-10-31)

### Improvements

- Optimized superpowers bootstrap to eliminate redundant skill execution. The `using-superpowers` skill content is now provided directly in session context, with clear guidance to use the Skill tool only for other skills. This reduces overhead and prevents the confusing loop where agents would execute `using-superpowers` manually despite already having the content from session start.

## v3.4.0 (2025-10-30)

### Improvements

- Simplified `brainstorming` skill to return to original conversational vision. Removed heavyweight 6-phase process with formal checklists in favor of natural dialogue: ask questions one at a time, then present design in 200-300 word sections with validation. Keeps documentation and implementation handoff features.

## v3.3.1 (2025-10-28)

### Improvements

- Updated `brainstorming` skill to require autonomous recon before questioning, encourage recommendation-driven decisions, and prevent agents from delegating prioritization back to humans.
- Applied writing clarity improvements to `brainstorming` skill following Strunk's "Elements of Style" principles (omitted needless words, converted negative to positive form, improved parallel construction).

### Bug Fixes

- Clarified `writing-skills` guidance so it points to the correct agent-specific personal skill directories (`~/.claude/skills` for Claude Code, `~/.codex/skills` for Codex).

## v3.3.0 (2025-10-28)

### New Features

**Experimental Codex Support**
- Added unified `superpowers-codex` script with bootstrap/use-skill/find-skills commands
- Cross-platform Node.js implementation (works on Windows, macOS, Linux)
- Namespaced skills: `superpowers:skill-name` for superpowers skills, `skill-name` for personal
- Personal skills override superpowers skills when names match
- Clean skill display: shows name/description without raw frontmatter
- Helpful context: shows supporting files directory for each skill
- Tool mapping for Codex: TodoWrite→update_plan, subagents→manual fallback, etc.
- Bootstrap integration with minimal AGENTS.md for automatic startup
- Complete installation guide and bootstrap instructions specific to Codex

**Key differences from Claude Code integration:**
- Single unified script instead of separate tools
- Tool substitution system for Codex-specific equivalents
- Simplified subagent handling (manual work instead of delegation)
- Updated terminology: "Superpowers skills" instead of "Core skills"

### Files Added
- `.codex/INSTALL.md` - Installation guide for Codex users
- `.codex/superpowers-bootstrap.md` - Bootstrap instructions with Codex adaptations
- `.codex/superpowers-codex` - Unified Node.js executable with all functionality

**Note:** Codex support is experimental. The integration provides core superpowers functionality but may require refinement based on user feedback.

## v3.2.3 (2025-10-23)

### Improvements

**Updated using-superpowers skill to use Skill tool instead of Read tool**
- Changed skill invocation instructions from Read tool to Skill tool
- Updated description: "using Read tool" → "using Skill tool"
- Updated step 3: "Use the Read tool" → "Use the Skill tool to read and run"
- Updated rationalization list: "Read the current version" → "Run the current version"

The Skill tool is the proper mechanism for invoking skills in Claude Code. This update corrects the bootstrap instructions to guide agents toward the correct tool.

### Files Changed
- Updated: `skills/using-superpowers/SKILL.md` - Changed tool references from Read to Skill

## v3.2.2 (2025-10-21)

### Improvements

**Strengthened using-superpowers skill against agent rationalization**
- Added EXTREMELY-IMPORTANT block with absolute language about mandatory skill checking
  - "If even 1% chance a skill applies, you MUST read it"
  - "You do not have a choice. You cannot rationalize your way out."
- Added MANDATORY FIRST RESPONSE PROTOCOL checklist
  - 5-step process agents must complete before any response
  - Explicit "responding without this = failure" consequence
- Added Common Rationalizations section with 8 specific evasion patterns
  - "This is just a simple question" → WRONG
  - "I can check files quickly" → WRONG
  - "Let me gather information first" → WRONG
  - Plus 5 more common patterns observed in agent behavior

These changes address observed agent behavior where they rationalize around skill usage despite clear instructions. The forceful language and pre-emptive counter-arguments aim to make non-compliance harder.

### Files Changed
- Updated: `skills/using-superpowers/SKILL.md` - Added three layers of enforcement to prevent skill-skipping rationalization

## v3.2.1 (2025-10-20)

### New Features

**Code reviewer agent now included in plugin**
- Added `superpowers:code-reviewer` agent to plugin's `agents/` directory
- Agent provides systematic code review against plans and coding standards
- Previously required users to have personal agent configuration
- All skill references updated to use namespaced `superpowers:code-reviewer`
- Fixes #55

### Files Changed
- New: `agents/code-reviewer.md` - Agent definition with review checklist and output format
- Updated: `skills/requesting-code-review/SKILL.md` - References to `superpowers:code-reviewer`
- Updated: `skills/subagent-driven-development/SKILL.md` - References to `superpowers:code-reviewer`

## v3.2.0 (2025-10-18)

### New Features

**Design documentation in brainstorming workflow**
- Added Phase 4: Design Documentation to brainstorming skill
- Design documents now written to `docs/plans/YYYY-MM-DD-<topic>-design.md` before implementation
- Restores functionality from original brainstorming command that was lost during skill conversion
- Documents written before worktree setup and implementation planning
- Tested with subagent to verify compliance under time pressure

### Breaking Changes

**Skill reference namespace standardization**
- All internal skill references now use `superpowers:` namespace prefix
- Updated format: `superpowers:test-driven-development` (previously just `test-driven-development`)
- Affects all REQUIRED SUB-SKILL, RECOMMENDED SUB-SKILL, and REQUIRED BACKGROUND references
- Aligns with how skills are invoked using the Skill tool
- Files updated: brainstorming, executing-plans, subagent-driven-development, systematic-debugging, testing-skills-with-subagents, writing-plans, writing-skills

### Improvements

**Design vs implementation plan naming**
- Design documents use `-design.md` suffix to prevent filename collisions
- Implementation plans continue using existing `YYYY-MM-DD-<feature-name>.md` format
- Both stored in `docs/plans/` directory with clear naming distinction

## v3.1.1 (2025-10-17)

### Bug Fixes

- **Fixed command syntax in README** (#44) - Updated all command references to use correct namespaced syntax (`/superpowers:brainstorm` instead of `/brainstorm`). Plugin-provided commands are automatically namespaced by Claude Code to avoid conflicts between plugins.

## v3.1.0 (2025-10-17)

### Breaking Changes

**Skill names standardized to lowercase**
- All skill frontmatter `name:` fields now use lowercase kebab-case matching directory names
- Examples: `brainstorming`, `test-driven-development`, `using-git-worktrees`
- All skill announcements and cross-references updated to lowercase format
- This ensures consistent naming across directory names, frontmatter, and documentation

### New Features

**Enhanced brainstorming skill**
- Added Quick Reference table showing phases, activities, and tool usage
- Added copyable workflow checklist for tracking progress
- Added decision flowchart for when to revisit earlier phases
- Added comprehensive AskUserQuestion tool guidance with concrete examples
- Added "Question Patterns" section explaining when to use structured vs open-ended questions
- Restructured Key Principles as scannable table

**Anthropic best practices integration**
- Added `skills/writing-skills/anthropic-best-practices.md` - Official Anthropic skill authoring guide
- Referenced in writing-skills SKILL.md for comprehensive guidance
- Provides patterns for progressive disclosure, workflows, and evaluation

### Improvements

**Skill cross-reference clarity**
- All skill references now use explicit requirement markers:
  - `**REQUIRED BACKGROUND:**` - Prerequisites you must understand
  - `**REQUIRED SUB-SKILL:**` - Skills that must be used in workflow
  - `**Complementary skills:**` - Optional but helpful related skills
- Removed old path format (`skills/collaboration/X` → just `X`)
- Updated Integration sections with categorized relationships (Required vs Complementary)
- Updated cross-reference documentation with best practices

**Alignment with Anthropic best practices**
- Fixed description grammar and voice (fully third-person)
- Added Quick Reference tables for scanning
- Added workflow checklists Claude can copy and track
- Appropriate use of flowcharts for non-obvious decision points
- Improved scannable table formats
- All skills well under 500-line recommendation

### Bug Fixes

- **Re-added missing command redirects** - Restored `commands/brainstorm.md` and `commands/write-plan.md` that were accidentally removed in v3.0 migration
- Fixed `defense-in-depth` name mismatch (was `Defense-in-Depth-Validation`)
- Fixed `receiving-code-review` name mismatch (was `Code-Review-Reception`)
- Fixed `commands/brainstorm.md` reference to correct skill name
- Removed references to non-existent related skills

### Documentation

**writing-skills improvements**
- Updated cross-referencing guidance with explicit requirement markers
- Added reference to Anthropic's official best practices
- Improved examples showing proper skill reference format

## v3.0.1 (2025-10-16)

### Changes

We now use Anthropic's first-party skills system!

## v2.0.2 (2025-10-12)

### Bug Fixes

- **Fixed false warning when local skills repo is ahead of upstream** - The initialization script was incorrectly warning "New skills available from upstream" when the local repository had commits ahead of upstream. The logic now correctly distinguishes between three git states: local behind (should update), local ahead (no warning), and diverged (should warn).

## v2.0.1 (2025-10-12)

### Bug Fixes

- **Fixed session-start hook execution in plugin context** (#8, PR #9) - The hook was failing silently with "Plugin hook error" preventing skills context from loading. Fixed by:
  - Using `${BASH_SOURCE[0]:-$0}` fallback when BASH_SOURCE is unbound in Claude Code's execution context
  - Adding `|| true` to handle empty grep results gracefully when filtering status flags

---

# Superpowers v2.0.0 Release Notes

## Overview

Superpowers v2.0 makes skills more accessible, maintainable, and community-driven through a major architectural shift.

The headline change is **skills repository separation**: all skills, scripts, and documentation have moved from the plugin into a dedicated repository ([obra/superpowers-skills](https://github.com/obra/superpowers-skills)). This transforms superpowers from a monolithic plugin into a lightweight shim that manages a local clone of the skills repository. Skills auto-update on session start. Users fork and contribute improvements via standard git workflows. The skills library versions independently from the plugin.

Beyond infrastructure, this release adds nine new skills focused on problem-solving, research, and architecture. We rewrote the core **using-skills** documentation with imperative tone and clearer structure, making it easier for Claude to understand when and how to use skills. **find-skills** now outputs paths you can paste directly into the Read tool, eliminating friction in the skills discovery workflow.

Users experience seamless operation: the plugin handles cloning, forking, and updating automatically. Contributors find the new architecture makes improving and sharing skills trivial. This release lays the foundation for skills to evolve rapidly as a community resource.

## Breaking Changes

### Skills Repository Separation

**The biggest change:** Skills no longer live in the plugin. They've been moved to a separate repository at [obra/superpowers-skills](https://github.com/obra/superpowers-skills).

**What this means for you:**

- **First install:** Plugin automatically clones skills to `~/.config/superpowers/skills/`
- **Forking:** During setup, you'll be offered the option to fork the skills repo (if `gh` is installed)
- **Updates:** Skills auto-update on session start (fast-forward when possible)
- **Contributing:** Work on branches, commit locally, submit PRs to upstream
- **No more shadowing:** Old two-tier system (personal/core) replaced with single-repo branch workflow

**Migration:**

If you have an existing installation:
1. Your old `~/.config/superpowers/.git` will be backed up to `~/.config/superpowers/.git.bak`
2. Old skills will be backed up to `~/.config/superpowers/skills.bak`
3. Fresh clone of obra/superpowers-skills will be created at `~/.config/superpowers/skills/`

### Removed Features

- **Personal superpowers overlay system** - Replaced with git branch workflow
- **setup-personal-superpowers hook** - Replaced by initialize-skills.sh

## New Features

### Skills Repository Infrastructure

**Automatic Clone & Setup** (`lib/initialize-skills.sh`)
- Clones obra/superpowers-skills on first run
- Offers fork creation if GitHub CLI is installed
- Sets up upstream/origin remotes correctly
- Handles migration from old installation

**Auto-Update**
- Fetches from tracking remote on every session start
- Auto-merges with fast-forward when possible
- Notifies when manual sync needed (branch diverged)
- Uses pulling-updates-from-skills-repository skill for manual sync

### New Skills

**Problem-Solving Skills** (`skills/problem-solving/`)
- **collision-zone-thinking** - Force unrelated concepts together for emergent insights
- **inversion-exercise** - Flip assumptions to reveal hidden constraints
- **meta-pattern-recognition** - Spot universal principles across domains
- **scale-game** - Test at extremes to expose fundamental truths
- **simplification-cascades** - Find insights that eliminate multiple components
- **when-stuck** - Dispatch to right problem-solving technique

**Research Skills** (`skills/research/`)
- **tracing-knowledge-lineages** - Understand how ideas evolved over time

**Architecture Skills** (`skills/architecture/`)
- **preserving-productive-tensions** - Keep multiple valid approaches instead of forcing premature resolution

### Skills Improvements

**using-skills (formerly getting-started)**
- Renamed from getting-started to using-skills
- Complete rewrite with imperative tone (v4.0.0)
- Front-loaded critical rules
- Added "Why" explanations for all workflows
- Always includes /SKILL.md suffix in references
- Clearer distinction between rigid rules and flexible patterns

**writing-skills**
- Cross-referencing guidance moved from using-skills
- Added token efficiency section (word count targets)
- Improved CSO (Claude Search Optimization) guidance

**sharing-skills**
- Updated for new branch-and-PR workflow (v2.0.0)
- Removed personal/core split references

**pulling-updates-from-skills-repository** (new)
- Complete workflow for syncing with upstream
- Replaces old "updating-skills" skill

### Tools Improvements

**find-skills**
- Now outputs full paths with /SKILL.md suffix
- Makes paths directly usable with Read tool
- Updated help text

**skill-run**
- Moved from scripts/ to skills/using-skills/
- Improved documentation

### Plugin Infrastructure

**Session Start Hook**
- Now loads from skills repository location
- Shows full skills list at session start
- Prints skills location info
- Shows update status (updated successfully / behind upstream)
- Moved "skills behind" warning to end of output

**Environment Variables**
- `SUPERPOWERS_SKILLS_ROOT` set to `~/.config/superpowers/skills`
- Used consistently throughout all paths

## Bug Fixes

- Fixed duplicate upstream remote addition when forking
- Fixed find-skills double "skills/" prefix in output
- Removed obsolete setup-personal-superpowers call from session-start
- Fixed path references throughout hooks and commands

## Documentation

### README
- Updated for new skills repository architecture
- Prominent link to superpowers-skills repo
- Updated auto-update description
- Fixed skill names and references
- Updated Meta skills list

### Testing Documentation
- Added comprehensive testing checklist (`docs/TESTING-CHECKLIST.md`)
- Created local marketplace config for testing
- Documented manual testing scenarios

## Technical Details

### File Changes

**Added:**
- `lib/initialize-skills.sh` - Skills repo initialization and auto-update
- `docs/TESTING-CHECKLIST.md` - Manual testing scenarios
- `.claude-plugin/marketplace.json` - Local testing config

**Removed:**
- `skills/` directory (82 files) - Now in obra/superpowers-skills
- `scripts/` directory - Now in obra/superpowers-skills/skills/using-skills/
- `hooks/setup-personal-superpowers.sh` - Obsolete

**Modified:**
- `hooks/session-start.sh` - Use skills from ~/.config/superpowers/skills
- `commands/brainstorm.md` - Updated paths to SUPERPOWERS_SKILLS_ROOT
- `commands/write-plan.md` - Updated paths to SUPERPOWERS_SKILLS_ROOT
- `commands/execute-plan.md` - Updated paths to SUPERPOWERS_SKILLS_ROOT
- `README.md` - Complete rewrite for new architecture

### Commit History

This release includes:
- 20+ commits for skills repository separation
- PR #1: Amplifier-inspired problem-solving and research skills
- PR #2: Personal superpowers overlay system (later replaced)
- Multiple skill refinements and documentation improvements

## Upgrade Instructions

### Fresh Install

```bash
# In Claude Code
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers@superpowers-marketplace
```

The plugin handles everything automatically.

### Upgrading from v1.x

1. **Backup your personal skills** (if you have any):
   ```bash
   cp -r ~/.config/superpowers/skills ~/superpowers-skills-backup
   ```

2. **Update the plugin:**
   ```bash
   /plugin update superpowers
   ```

3. **On next session start:**
   - Old installation will be backed up automatically
   - Fresh skills repo will be cloned
   - If you have GitHub CLI, you'll be offered the option to fork

4. **Migrate personal skills** (if you had any):
   - Create a branch in your local skills repo
   - Copy your personal skills from backup
   - Commit and push to your fork
   - Consider contributing back via PR

## What's Next

### For Users

- Explore the new problem-solving skills
- Try the branch-based workflow for skill improvements
- Contribute skills back to the community

### For Contributors

- Skills repository is now at https://github.com/obra/superpowers-skills
- Fork → Branch → PR workflow
- See skills/meta/writing-skills/SKILL.md for TDD approach to documentation

## Known Issues

None at this time.

## Credits

- Problem-solving skills inspired by Amplifier patterns
- Community contributions and feedback
- Extensive testing and iteration on skill effectiveness

---

**Full Changelog:** https://github.com/obra/superpowers/compare/dd013f6...main
**Skills Repository:** https://github.com/obra/superpowers-skills
**Issues:** https://github.com/obra/superpowers/issues
