# Antigravity 深度调试样例（`examples/antigravity-tuned/`）

本目录是一份**完整可运行的 Antigravity 宿主深调参考样例**，专门把所有依赖 Antigravity 私有机制的代码从主工程（[`kit/`](../../kit/) 与 [`harness-connector/`](../../harness-connector/)）中彻底摘了出来。

如果你只想用标准 MCP 零配置即插即用，请直接使用通用连接器 [`harness-connector/`](../../harness-connector/README.md)。如果你打算给 Antigravity（或其他带生命周期 Hook 的 Agent CLI）做深度调优，本目录记录了每一处真实调试出来的坑位与解法。

---

## 一、它从 `harness-connector/` 复用了什么，又专门调了什么？

| 能力 | 来源 | 说明 |
| :--- | :--- | :--- |
| 6 个核心只读查证工具（含 `workspace_path` 单卡直读与多卡互锁） | 复用 `harness-connector` | 零重复实现 |
| 物理卡槽扫描（根目录 / 一级子目录 `character.manifest.json`）与 ≥2 卡互锁 | 复用 `harness-connector` | `slot-scanner.mjs` |
| 顶部规则文件单调排布渲染器（`SOUL → 画像 → L0 → 常青 → 底部脉络`） | 复用 `harness-connector` | `rules-renderer.mjs`，传 Antigravity 的 `24,000 bytes` 上限 |
| 通用工具 `pmv_slot_status` / `pmv_sync_rules` / `pmv_commit_turn` | 复用 `harness-connector` | 直接继承自 `harness-connector/mcp-server.mjs` |
| **生命周期 Hooks (`hooks.json`) 与 protojson `injectSteps` 契约** | **Antigravity 专调** | 严格输出纯净 `{"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}`，避开附加 `metadata` 被反序列化器静默丢弃的坑 |
| **同轮多工具防重（`pmv-ag-preinv-dedup.json`）** | **Antigravity 专调** | 处理 Antigravity 在一次多工具回合中反复触发 `PreInvocation` 且 `initialNumSteps` 递增的行为 |
| **`transcript_full.jsonl` 扫描 + `CHECKPOINT` 压缩墙刹车** | **Antigravity 专调** | Antigravity Hook 不传内存 `messages[]`；遇 `type: "CHECKPOINT"` 立刻 `break` 还原活跃窗口，避免压缩后 10 轮去重误杀已被压掉的记忆 |
| **开局前全自动拼装 `AGENTS.md` + `SessionStart` 静音启动** | **Antigravity 专调** | 检测工作区单卡或 `.persona` 后全自动渲染顶部 `AGENTS.md`（24KB 内）；已存在时开局盘上刷新并返回 `{}` 零注入；盘中严禁改写 `index.md` 锁死 Prefix KV-Cache |
| **`/persona on\|off\|boost\|status` + 动态「人格浓度」补注** | **Antigravity 专调** | 无顶部 `AGENTS.md` 的动态模式下，遇压缩墙或连续 20 轮自动补注灵魂基线 |
| **2 个 Hook 状态机联动 MCP 工具（`pmv_persona_status` / `pmv_set_persona_mode`）** | **Antigravity 专调** | 直接读写 `pmv-ag-session-modes.json`，让模型自主切换当前会话的 Hook 运行态 |

---

## 二、五步真实调试手记（为何这样设计）

1. **为什么做两套物理用法 + 多卡互锁**：
   - 工作区根目录或直接一级子目录发现 **1 张卡带**（`character.manifest.json`）→ 零注册自动激活并全自动渲染 `AGENTS.md`；
   - 发现 **≥ 2 张卡带** → 自动触发**多卡互锁静音**（绝不猜角色、不建 `AGENTS.md`、不写错账本），需显式 `/persona on <id>` 或 MCP 指定 `cartridge` 才解锁；
   - 无直插卡带的工作区 / 代码仓 → 通过固定卡带仓库目录（`cassettes/` 或 `PMV_CARTRIDGES_DIR`）按需调用。
2. **为什么把 `SOUL + 画像 + 开局 index.md` 拼进工作区 `AGENTS.md`**：
   - Antigravity 的 `SessionStart` / `PreInvocation` 只能往对话流插 `injectSteps`，触发长对话 **Compaction** 时会被压成摘要导致“人格稀释”；
   - 放进工作区根目录 `AGENTS.md`（Antigravity `<user_rules>` 单文件 24KB 上限）可 100% 免疫压缩、按工作区天然隔离；
   - 内部按 KV-Cache 单调稳定度排布（静态人设 → 常青支柱 → 最底部轮播近期脉络），**只在 `SessionStart` 更新磁盘，盘中绝不改写 `AGENTS.md`**，新增动态走 `<chronicle_board_update>` 贴在最新轮次末尾，保住整场 Prefix KV-Cache。
3. **为什么需要动态「人格浓度」补注**：
   - 无工作区裸聊或在纯代码仓临时 `/persona on` 时没有顶部 `AGENTS.md`，一旦发生 Compaction 或连续执行大量工具调用，动态注入的人格会被稀释；此时 Hook 侦测到新的 `CHECKPOINT` 或达到 `reboost_interval_turns`（默认 20 轮）会自动补注一针。
4. **为什么 10 轮去重必须止步于 `CHECKPOINT` 压缩墙**：
   - `transcript_full.jsonl` 是只增不删的总日志，Compaction 后旧行依然留在文件上半截；遇到 `type: "CHECKPOINT"` 必须立刻停止倒序扫描，把压缩墙之后的真实活跃上下文交给 `kit/core/context-assembler.mjs`，压缩前的记忆才能重新恢复可召回。
5. **为什么要把 `pmv_persona_status` / `pmv_set_persona_mode` 做成 MCP 工具**：
   - 除了用户手动敲 `/persona` 口令外，让模型也能自主自检并决定与自身上下文有关的状态（挂载/卸载规则、切回工作模式、当场补注人格浓度）。

---

## 三、一键安装与测试

```bash
# 1. 自动重写本机绝对路径并安装插件到 ~/.gemini/config/plugins/persona-cassette-memory
npm run install-antigravity-example

# 2. 单独运行 Antigravity 深调样例端到端测试
npm run test:antigravity-example
```

示例工作区见 [`sample-workspace/AGENTS.md`](./sample-workspace/AGENTS.md) 与 [`sample-workspace/.persona`](./sample-workspace/.persona)。
