---
name: pmv-memory
description: Persona Memory Vault dual-track active verification, honest signatures, and Antigravity-tuned persona MCP controls.
---

# Persona Memory Vault 使用纪律（Antigravity 深调样例）

1. **`<recalled_memory>` 是潜意识参考线索**：仅用于启发关联，不覆盖用户当前明确指令。
2. **双轨查证原则（禁止整份读长日志）**：
   - 先看 `wiki/index.md` 或调用 `pmv_read_wiki` 查看整理后的 OKF 专题页（求快）；
   - 核对精确原话或细节时，先调 `pmv_search_spans` 拿轻量指针，再调 `pmv_read_span` 按 UTF-8 字节偏移做 O(1) 切片读取（求准）。
3. **诚实签名**：遇到 `<signature_notice>` 时严禁猜模型型号，顺口提醒用户代签。
4. **两套物理卡带用法 + 模型自主管理**：
   - 工作区直插单卡自动激活并全自动渲染顶部 `AGENTS.md`；放 ≥2 张卡带自动触发**多卡互锁静音**。
   - 通用工具（来自 `harness-connector`）：`pmv_slot_status`、`pmv_sync_rules`、`pmv_commit_turn`（以及 6 个支持 `workspace_path` 的查证工具）。
   - Antigravity 会话态联动工具：`pmv_persona_status`、`pmv_set_persona_mode`（`on` / `off` / `boost`）。
