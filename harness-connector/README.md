# Harness Connector（通用底座连接器）

`harness-connector/` 封装了所有 **100% 宿主无关、直接插拔就能用** 的标准 MCP 与工作区连接能力——**不包含任何 Antigravity 私有 Hook、压缩墙或日志解析代码**。

任何支持标准 **Stdio MCP** 的客户端（Claude Desktop、Claude Code、Cursor、Windsurf、Codex、Cherry Studio、DeepSeek Harness、Antigravity 等），直接挂上 [`mcp-server.mjs`](./mcp-server.mjs) 即可开箱使用。

---

## 一、模块构成

| 文件 | 职责 |
| :--- | :--- |
| [`slot-scanner.mjs`](./slot-scanner.mjs) | 两套极简物理卡带发现：① 工作区根目录/一级子目录单卡直读 + ≥2 张**多卡互锁**；② 固定卡带仓库目录（`PMV_CARTRIDGES_DIR` / `cartridges_dir` / `../cassettes`）自动发现 |
| [`rules-renderer.mjs`](./rules-renderer.mjs) | 通用工作区顶部规则文件渲染器（支持 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 或任意自定义文件名与可选字节上限），按 Prefix KV-Cache 稳定度单调排布（`SOUL → 画像 → L0 → 常青支柱 → 最底部近期脉络`），完整保留标记块外的用户自定义规则 |
| [`mcp-server.mjs`](./mcp-server.mjs) | 通用即插即用 Stdio MCP Server（6 个核心只读查证工具 + 3 个通用连接工具） |
| [`mcp_config.example.json`](./mcp_config.example.json) | 任意 MCP 客户端通用接入配置模板 |

---

## 二、标准 MCP 工具列表（6 核心 + 3 连接器，共 9 个）

| 类别 | 工具名 | 说明 |
| :--- | :--- | :--- |
| **核心记忆查证（只读）** | `pmv_status` | 查看卡带状态、4 个模型签名槽、快照与做梦计数（支持 `workspace_path` 单卡直读 & 多卡互锁） |
| | `pmv_read_index` | 读取二合一叙事总索引 `wiki/index.md` |
| | `pmv_read_wiki` | 读取指定 OKF 专题页 |
| | `pmv_search_spans` | 检索轻量语义段落指针（不读全量原始日志） |
| | `pmv_read_span` | 按 UTF-8 字节偏移 O(1) 切片读取账本原文 |
| | `pmv_query_memory` | 查询只读 RiverMemo 拓扑快照（无原生模块自动降级 `spans_fallback`） |
| **通用连接器工具** | `pmv_slot_status` | 自检工作区卡槽发现结果（单卡直读 / 多卡互锁 / 卡带仓库）、顶部规则文件同步状态、固定仓库卡带列表 |
| | `pmv_sync_rules` | 在任意工作区渲染、刷新或干净卸载托管顶部规则块（支持 `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` 与 `max_bytes`） |
| | `pmv_commit_turn` | 将重要对话回合写入卡带不可变账本并热刷新 `wiki/index.md`（让没有 `Stop` Hook 的普通 MCP 客户端也能自主落盘） |

---

## 三、即插即用接入方式

### 1. 在任意 MCP 客户端挂载
参考 [`mcp_config.example.json`](./mcp_config.example.json)：
```json
{
  "mcpServers": {
    "persona-cassette": {
      "command": "node",
      "args": ["/path/to/persona-cassette-starter/harness-connector/mcp-server.mjs"],
      "env": {
        "PMV_CARTRIDGES_DIR": "/path/to/persona-cassette-starter/cassettes"
      }
    }
  }
}
```

### 2. 两套卡带使用方式
- **工作区直插单卡**：把单张卡带文件夹直接放进你的工作区，工具传入 `workspace_path` 即可零注册直读；若工作区放了 ≥2 张卡带，自动触发**多卡互锁**报错，必须显式传入 `cartridge: "<id>"` 才会操作。
- **固定卡带仓库**：通过 `PMV_CARTRIDGES_DIR`（默认自动发现 `cassettes/`）按卡带 ID 随取随用。

### 3. 一行命令行渲染任意宿主规则文件
```bash
# 给 Codex / Antigravity 生成 AGENTS.md
node harness-connector/rules-renderer.mjs sync ./my-workspace starter --file AGENTS.md

# 给 Claude Code 生成 CLAUDE.md
node harness-connector/rules-renderer.mjs sync ./my-workspace starter --file CLAUDE.md

# 干净卸载托管块（保留你手写的规则）
node harness-connector/rules-renderer.mjs remove ./my-workspace --file CLAUDE.md
```

---

## 四、需要宿主深度生命周期集成？

如果你希望在特定 Agent 宿主里实现**自动静默注入、压缩墙感知、动态人格浓度补注与自动落盘**，请参考独立抽出的宿主深调样例：[`examples/antigravity-tuned/`](../examples/antigravity-tuned/README.md)。
