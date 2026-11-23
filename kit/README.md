# Persona Memory Vault Toolkit (`persona-memo-kit`)

> **当前阶段**：`Phase 3 — Runtime / 异步做梦 / 三底座转接器就绪`（规范基线：[SPEC.md](./SPEC.md) `v1.1`）

面向单角色长期记忆卡带（Cartridge）的共享烧录工具箱、离线 RiverMemo 编辑器与三底座原生转接器，服务独立的单角色记忆仓库（例如 `../cassettes/starter-persona/`）。

## 核心设计原则

- **一项目一角色（像游戏卡带），引擎与数据解耦**：角色身份、不可变账本（`ledger/sessions/`）、语义切片指针（`ledger/spans/`）、OKF 知识库（`wiki/`）与标签图谱（`tags/`）全部保存在独立卡带仓中；通过 `cartridges.local.json` 插卡即换。
- **本体归本体，外壳归外壳**：共用一套 6 接口只读/追加 Runtime（`core/runtime.mjs`）和共用 Stdio MCP Server（`bin/pmv-mcp.mjs`），在 **Antigravity / DeepSeek Harness / VCPToolBox** 三个本机底座各挂接一片极薄转接器。
- **二合一叙事总索引 + O(1) 原文切片**：`wiki/index.md` 合并近期脉络与常青支柱（≤150 行）；查原文先检 `spans` 摘要再按 UTF-8 字节偏移做 O(1) 切片读取。
- **外部接口解耦 + 双重操作签名**：向量与判断模型（`DecisionProvider`）均通过服务接口配置挂载；向量失配硬熔断请求全量重烘；模型未验证时禁止猜测，主动提醒用户代签。
- **异步做梦 + 高风险审批闸门**：低风险笔记沉淀自动写入 `wiki/`；凡改 `SOUL.md`、`USER_PROFILE.md`、合并/废弃页面或冲突裁决，一律拦截进 `dream_queue/` 待人工审批（旧页归档至 `wiki/archive/`，绝不物理删除）。

## CLI 快速入口（`pmv`）

### 1. 卡带管理与 Phase 1（账本、切片、标签治理）
- `node ./bin/pmv.mjs init <vaultPath> --id <id> --name <name> --display <displayName>`
- `node ./bin/pmv.mjs cartridges list | add <id> <vaultPath> [--default] | set-default <id>`
- `node ./bin/pmv.mjs status [vaultPathOrId]`
- `node ./bin/pmv.mjs ingest-antigravity [vaultPathOrId]`
- `node ./bin/pmv.mjs build-spans [vaultPathOrId]`
- `node ./bin/pmv.mjs search-spans [vaultPathOrId] --query <kw>`
- `node ./bin/pmv.mjs read-span [vaultPathOrId] --id <spanId> [--pad 1]`
- `node ./bin/pmv.mjs lint-tags [vaultPathOrId] [--fix]`
- `node ./bin/pmv.mjs build-index [vaultPathOrId]`
- `node ./bin/pmv.mjs mirror-doc [vaultPathOrId] <sourceFile> [--id <docId>]`

### 2. Phase 2（RiverMemo 离线烘焙与 Studio 编辑器）
- `node ./bin/pmv.mjs sign-embedding [vaultPathOrId] --provider <p> --model <m> --dim <d>`
- `node ./bin/pmv.mjs bake [vaultPathOrId] [--provider-id <id>] [--preset balanced|precision_research|associative_explore] [--full] [--confirm-switch]`
- `node ./bin/pmv.mjs query-snap [vaultPathOrId] --query <text> [--preset <p>] [--top-k <n>] [--xml]`
- `node ./bin/pmv.mjs studio [vaultPathOrId] [--port 3456]`

### 3. Phase 3（异步做梦、审批队列与三底座挂载）
- `node ./bin/pmv.mjs dream [vaultPathOrId] [--dry-run] [--min-salience 0.45] [--provider-id <id>]`
- `node ./bin/pmv.mjs queue [vaultPathOrId] [--status pending_review|approved|rejected|all]`
- `node ./bin/pmv.mjs approve [vaultPathOrId] --op <opId> [--note <text>]`
- `node ./bin/pmv.mjs reject [vaultPathOrId] --op <opId> [--note <text>]`
- `node ./bin/pmv.mjs install-antigravity [--enable]`（安装插件到 `~/.gemini/config/plugins/persona-cassette-memory/`）

## 底座挂载方式一览

1. **Antigravity**：执行 `node ./bin/pmv.mjs install-antigravity --enable` 挂载插件（含 `SessionStart`/`PreInvocation`/`Stop` 双模式钩子 + 共用 MCP 工具）。
2. **DeepSeek Harness (`dsh`)**：参考 `adapters/dsh/cordis.patch.yml` 在你的 DSH profile 中挂载 `adapters/dsh/host.js`（同时可将 `bin/pmv-mcp.mjs` 配入 DSH MCP）。
3. **VCPToolBox**：将 `adapters/vcp/` 复制或链接至你的 VCP `Plugin/PersonaMemoryVault/` 并配好 `config.env`，在角色系统提示词中添加 `[[PMV::starter]]` 或 `{{PMV_SYSTEM_PREFIX}}`。

## 文档导航

- 完整架构规格书（v1.1）：[SPEC.md](./SPEC.md)
- 外部服务配置模板：[providers.example.json](./providers.example.json)
- 卡带槽位配置模板：[cartridges.example.json](./cartridges.example.json)
