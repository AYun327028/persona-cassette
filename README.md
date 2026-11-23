# Persona: Cassette（角色卡带）

一个**零第三方依赖、开箱即用、内核与宿主彻底解耦**的角色长期记忆、通用 MCP 连接器与标准 OpenAI 对话工程。

---

## 仓库分层结构

```text
persona-cassette/
├── kit/                          # 【1. 纯净卡带引擎】宿主中立记忆与上下文拼装内核（零特定客户端耦合）
├── cassettes/starter-persona/    # 【2. 空白角色卡带模板】纯文本 Git 友好记忆仓，改 SOUL.md 即可上岗
├── harness-connector/            # 【3. 通用底座连接器】即插即用标准 MCP + 工作区单卡直读/多卡互锁 + 通用规则渲染
├── chat-cli/                     # 【4. 纯净 OpenAI 对话前端】单文件纯 Python 标准库 CMD 客户端
└── examples/
    └── antigravity-tuned/        # 【5. 宿主深调样例】独立摘出的 Antigravity Hooks/压缩墙/浓度补注完整样例
```

- **`kit/`（纯净卡带引擎）**：负责卡带读写、**开局基线冻结 + `<chronicle_board_update>` 信息板差量热更新**、不足 10 轮自动账本补齐（≥10 轮透传不越界压缩）、10 轮原始历史查重、完整正文召回、UTF-8 O(1) 切片、无头 HTTP 上下文服务与后台做梦收尾。
- **`cassettes/starter-persona/`（空白卡带模板）**：零私人数据，4 个模型签名槽保持诚实 `unsigned`，支持放多张卡带插卡即换。
- **`harness-connector/`（通用底座连接器）**：**100% 宿主无关、直接插拔就能用**的标准 Stdio MCP Server（6 个只读查证工具 + `pmv_slot_status` / `pmv_sync_rules` / `pmv_commit_turn`），内置工作区物理卡槽发现（单卡直读、≥2 张**多卡互锁**）与多宿主顶部规则渲染器（`AGENTS.md` / `CLAUDE.md` / `GEMINI.md`）。详见 [`harness-connector/README.md`](./harness-connector/README.md)。
- **`chat-cli/`（纯净标准 OpenAI CMD 前端）**：直接发标准 `POST /chat/completions`，不碰卡带内部文件，随时可切换纯裸调或接入卡带 HTTP 协议。
- **`examples/antigravity-tuned/`（Antigravity 深度调试样例）**：基于 `harness-connector/` 扩展，单独存放所有针对 Antigravity 私有机制调试出来的功能（`SessionStart`/`PreInvocation`/`Stop` Hooks、protojson `injectSteps`、`transcript_full.jsonl` `CHECKPOINT` 压缩墙刹车、24KB 顶部 `AGENTS.md` 静音启动、动态「人格浓度」补注、`/persona` 指令与会话态联动 MCP）。详见 [`examples/antigravity-tuned/README.md`](./examples/antigravity-tuned/README.md)。

---

## 环境要求

- **Node.js ≥ 22**（驱动 `kit/`、`harness-connector/` 与示例，零 `npm install` 依赖）
- **Python ≥ 3.10**（驱动 `chat-cli/`，零 `pip install` 依赖）

---

## 方式一：即插即用接入任意标准 MCP 客户端（`harness-connector`）

适用于 Claude Desktop、Claude Code、Cursor、Windsurf、Codex、Cherry Studio、DeepSeek Harness 等任意支持 Stdio MCP 的客户端，参考 [`harness-connector/mcp_config.example.json`](./harness-connector/mcp_config.example.json)：

```json
{
  "mcpServers": {
    "persona-cassette": {
      "command": "node",
      "args": ["/path/to/persona-cassette/harness-connector/mcp-server.mjs"],
      "env": {
        "PMV_CARTRIDGES_DIR": "/path/to/persona-cassette/cassettes"
      }
    }
  }
}
```

两种极简物理卡带用法：
1. **工作区直插单卡**：把整张卡带文件夹直接放进工作区（根目录或直接一级子目录含 `character.manifest.json`），传入 `workspace_path` 零注册自动读取；若放入 **≥ 2 张卡带**，自动触发**多卡互锁**拒绝猜测。
2. **固定卡带仓库目录**：通过 `PMV_CARTRIDGES_DIR`（默认自动发现 `cassettes/`）按卡带 ID 随取随用。

---

## 方式二：三步启动纯净 OpenAI CMD 前端（`chat-cli`）

1. **配置 API**：打开 `chat-cli/chat.py` 顶部配置区填写 `API_BASE`、`API_KEY`、`MODEL`（也可通过环境变量 `OPENAI_API_KEY` 或命令行参数传入）。
2. **启动无头卡带服务**：双击 `start-cassette.bat` 或运行：
   ```bash
   npm run serve
   ```
   默认监听 `http://127.0.0.1:3891`（只负责上下文拼装与账本落盘，**绝不代理 OpenAI 请求、不碰 API Key**）。
3. **启动 CMD 前端**：双击 `start-chat.bat` 或运行：
   ```bash
   python chat-cli/chat.py --cassette starter --commit --raw
   ```
   常用命令：`/raw`（看拼装报文）、`/historymode`（切换自带历史/卡带补足 10 轮）、`/cassette [id|off]`、`/commit`、`/session <id>`。

---

## 方式三：体验 Antigravity 深度调试样例（`examples/antigravity-tuned`）

```bash
# 一键安装到 ~/.gemini/config/plugins/persona-cassette-memory（自动写入本机路径）
npm run install-antigravity-example
```
完整的五步真实踩坑优化手记（压缩墙刹车、工作区 24KB 顶部规则静音启动、多卡互锁与动态人格浓度补注）见 [**`examples/antigravity-tuned/README.md`**](./examples/antigravity-tuned/README.md)。

---

## 卡带管理与分模块测试

```bash
# 运行全部三层测试套件（kit + harness-connector + antigravity-tuned 样例）
npm test

# 按层单独测试
npm run test:kit
npm run test:connector
npm run test:antigravity-example

# 新建一张独立角色卡带
node kit/bin/pmv.mjs init cassettes/my-persona --id my-persona --name MyPersona --display "我的角色"

# 查看默认卡带状态
npm run status

# 后台做梦整理收尾
node kit/bin/pmv.mjs dream-commit starter --summary "本次整理的叙事摘要"
```

### 可选：启用 RiverMemo 原生向量拓扑快照
默认零原生依赖运行（未烘焙快照时自动无损降级为 `spans_fallback`）。如需启用 `rust-vexus-lite` 向量召回：
1. 复制 `kit/providers.example.json` 为 `kit/providers.local.json` 并配置 Embedding 接口；
2. 将 `rust-vexus-lite` 放至 `kit/native/vexus-lite/index.js` 或设置 `PMV_VEXUS_LITE_PATH`；
3. 执行 `node kit/bin/pmv.mjs sign-embedding ...` 与 `node kit/bin/pmv.mjs bake`。

更多底层架构规格见 [`kit/SPEC.md`](./kit/SPEC.md) 与 [`kit/README.md`](./kit/README.md)。

---

## 许可证

本项目采用 **CC BY-NC-SA 4.0（署名 - 非商业性使用 - 相同方式共享 4.0 国际）** 许可协议，与上游参考项目 [VCPToolBox](https://github.com/lioensky/VCPToolBox) 保持协议对齐。你可以自由共享与演绎，但须保留署名、仅限非商业用途，并以相同方式共享衍生作品。完整条款见 [`LICENSE`](./LICENSE)。

> **用户数据归属说明**：用户基于 `cassettes/starter-persona/` 空白模板自行创作与填写的个人角色设定（`SOUL.md`）、用户画像（`USER_PROFILE.md`）、对话账本（`ledger/`）与记忆日记（`wiki/`）均归用户本人所有，不受本模板仓库协议的传染性限制。

---

## 致谢

- **[VCPToolBox](https://github.com/lioensky/VCPToolBox)**（作者：**莱恩 (Ryan) · lioensky**，官网：[vcptoolbox.com](https://www.vcptoolbox.com)）：本项目在可选的向量拓扑记忆召回层（`kit/native/vexus-bridge.mjs`、`kit/core/rivermemo-snapshot.mjs`）中对接并参考了 VCPToolBox 的 **RiverMemo** 记忆召回结构、`rust-vexus-lite` 原生检索契约与 AgentDream 后台整理理念，特此致谢并遵循其 **CC BY-NC-SA 4.0** 协议。
- 同时感谢 **Cteno**（不可变事件账本思路）、**OKF（Open Knowledge Format）** 与 **MCP（Model Context Protocol）** 等开源社区规范与生态项目带来的启发。
- 作者：**AYun327028**。
