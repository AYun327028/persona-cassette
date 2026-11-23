# Persona Memory Vault 架构设计规格书（SPEC）

> **文档状态**：`v1.1 — Phase 1–3 核心与三底座适配器已完成`  
> **共享工具箱仓库**：`F:\persona-memo-kit\`  
> **1 号模板角色仓库**：`F:\algernon-memory\`（Algernon / 阿尔吉侬）  
> **修订日期**：2026-11-20

---

## 第 1 章 设计哲学与系统边界（Philosophy & Scope Boundaries）

### 1.1 核心设计原则

**一句话总纲：本体归本体（纯粹的数据与维护层），外壳归外壳（同步、服务端、聊天前端后续独立挂接）。**

1. **读写彻底分离（CQRS）**：前台对话只做毫秒级只追加落盘与只读召回；整理、段落标注、索引编译、向量计算与图资产烘焙全部后移到异步后台或离线编辑器。
2. **纯文本可读为主，二进制快照为辅**：角色所有身份、知识、语义指针与对话账本均以人类可读的 Markdown / YAML / JSON(L) 保存在标准 Git 仓库中；向量与河网图仅作为**可随时销毁重烘的只读派生物**存在。
3. **一项目一角色（One Repo Per Persona）**：每个角色是一个独立、自包含的记忆仓（如 `F:\algernon-memory\`）；共享工具箱与离线编辑器（`F:\persona-memo-kit\`）作为无状态引擎服务任意多个角色项目。
4. **离线烘焙 + 只读运行时**：借鉴游戏引擎的“资源烘焙”思路，平时运行态只读挂载 `snapshot/rivermemo.snap/`，零文件监听、零后台写锁、零数据库迁移冲突；定期维护时将角色目录“插回”离线 RiverMemo 编辑器，校验签名、体检标签、调规则并一键烘焙新快照。
5. **非入侵式自动召回**：RiverMemo 全量算法（Topology V3.1）**只影响每轮自动注入的潜意识召回内容（L2）**，不干预前台写入纪律（砍掉边干活边记笔记），也不干预模型主动读取 `wiki/` 与切片查证 `ledger/` 的路径。
6. **双重操作签名与接口解耦**：向量模型与判断模型均以**可插拔 API 服务接口**接入，绝不写死厂商或模型；向量空间严格绑定签名防混用；模型身份无法由宿主自动验证时，严禁模型猜测型号，必须主动提醒用户代签。

### 1.2 显式「不做清单」（Non-Goals）

为防止工程滑向“重写第二个重型服务端”，本规格**明确排除**以下内容：

- ❌ **不做纯网页端（如 AI Studio 粘贴大包）的静态兼容优化**：不再生成与维护全量扁平化单文件大包来适配无本地工具、无中间件的纯网页文本框。
- ❌ **不将 OneRing 多端群聊同步器包入记忆本体**：跨前端同步、群聊发言剥离、Retry 模糊差分是“外壳/网关”职责；本体只通过合并进 `wiki/index.md` 的**叙事型近期脉络（Living Timeline）**解决单角色跨会话中期接茬问题。
- ❌ **不做聊天前端、流式 SSE 兼容层与上下文折叠器**：不维护消息 UI、不改写或重排历史消息数组、不介入宿主工具循环。
- ❌ **不做多角色混库**：不同角色严禁共享同一个 SQLite / Wiki / 快照文件；跨角色协作留待未来外壳层通过标准接口编排。
- ❌ **不将判断模型写死为单一厂商或必选依赖**：`DecisionProvider` 必须走标准 HTTP/API 服务适配接口，并支持无损降级；确定性规则能判断的绝不调用判断模型。

### 1.3 与现有流派的借鉴关系与范式对比

本架构综合吸收了 **Anthropic 四层记忆**、**Cteno**、**Google Cloud OKF（Open Knowledge Format）** 与 **VCPToolBox（RiverMemo / DailyNote / AgentDream / OneRing / JEV）** 的核心工程经验：

| 维度 | Anthropic 四层记忆 | VCPToolBox 现行体系 | 本架构（Persona Memory Vault v1.1） | 借鉴来源与演进依据 |
| :--- | :--- | :--- | :--- | :--- |
| **前台写入纪律** | 保留第 2 层“边干活边记笔记”，虽有做梦但存在历史包袱 | `Dailynote.txt` 要求回复末尾调用工具实时写日记，分散主任务注意力 | **彻底砍掉第 2 层**：前台 100% 专注主任务，不记笔记，仅由框架追加日志 | **借自 Cteno**：消除注意力切分与当轮总结质量波动 |
| **唯一事实来源（SSOT）** | 原始记录 + 笔记并行 | 日记即终稿，写歪或总结失真后难以从原话一键重炼 | **`ledger/sessions/` 为唯一不可变真相**；`ledger/spans/` 与 `wiki/` 均为可重炼派生层 | **借自 Cteno**：根治幻觉滚雪球，且支持精确字节切片查原文 |
| **存储与可读性** | Markdown 笔记 + Wiki + 索引 | 按日期平铺 `.txt` 日记 + 尾行平铺 Tag，久用后盘点困难 | **OKF 目录 + 双轨标签**（受控 `facets` + 有序 `tag_chain`）+ Git 原生 | **借自 Google OKF & RiverMemo**：兼顾人类运维清晰度与河网序关系 |
| **中期衔接与总索引** | 固定目录小索引 | `OneRing` 166KB 多端同步器 + SQLite + Fuzzy Diff | **二合一叙事总索引 `wiki/index.md`**：上段按重要度动态叙事时间线 + 下段常青支柱（≤150 行） | **化繁为简**：消除重复文件，兼具人情味近况与常青全局视野 |
| **查证原话方式** | 搜索或读取原始日志 | `DeepMemo` 关键词扫描聊天历史文件 | **派生语义指针层 `ledger/spans/` + O(1) 字节切片读取**（`searchLedgerSpans` / `readLedgerSpan`） | **工程防爆窗**：先查轻量摘要指针，再按 `byte_offset` 精准切片读原文 |
| **轻量判断路由** | 无独立判断层 | `JEV` 实验版有限选择路由 | **可插拔 `DecisionProvider` 接口**（可选配外部判断服务，支持 `noul/choice/score`，断网/未签自动降级） | **借自 JEV 与现代 System-1 模型**：降噪省钱而不绑定厂商 |
| **记忆演进与安全** | 空闲期后台做梦 | `AgentDream` 产生 `Merge`/`Delete`/`Insight` 并落盘待审 | **按量计数触发做梦** + **`dream_queue/` 高风险审批闸门** + `wiki/archive/` | **借自 Cteno（按量）+ AgentDream（审批）**：防静默篡改核心人格 |
| **前缀缓存友好度** | 新会话带小索引 | 历史消息改尾标、插垫片，易击穿 Prefix KV Cache | **L0/L1 锁死 System Prompt + L2 随当轮 User 注入**，绝不篡改旧轮次 | **工程进步**：吃满现代大模型长上下文缓存折扣 |
| **检索引擎耦合度** | 无原生向量拓扑引擎 | Rust `vexus-lite` + SQLite + Watcher 常驻 VCP 服务端 | **离线 RiverMemo 编辑器定期烘焙**，运行态只挂载干净只读 `.snap` | **借自 VCP `rust-vexus-lite`**：零服务端负担拿到全量 Topology V3.1 |

---

## 第 2 章 仓库拓扑与「一项目一角色」标准（Repository Topology）

### 2.1 双仓库物理布局

```text
F:\
├── persona-memo-kit\             # 【共享工具箱 & 离线编辑器】一套引擎服务所有角色
│   ├── SPEC.md                   #   本架构规格书（唯一设计基准，v1.1）
│   ├── README.md                 #   仓库概览与 CLI 入口说明
│   ├── package.json              #   零外部依赖 Node.js (v22+/v24 ESM) 包定义
│   ├── providers.example.json    #   向量/判断/对话服务配置模板（无真实密钥）
│   ├── providers.local.json      #   本机实际服务端点配置（已 gitignore）
│   ├── bin\pmv.mjs               #   统一 CLI 入口
│   ├── core\                     #   账本、Span指针、OKF/YAML、标签体检、索引构建、判断接口、Runtime
│   ├── native\                   #   封装与引用 VCPToolBox 的 rust-vexus-lite 原生模块（Phase 2）
│   ├── studio\                   #   RiverMemo 离线编辑器（CLI + 本地单页 Web 调试烘焙台，Phase 2）
│   ├── shells\                   #   解耦外壳（Antigravity 插件 / 轻量 API 代理等，Phase 3+）
│   └── tests\                    #   node:test 单元测试与集成测试
│
└── algernon-memory\              # 【1 号角色记忆仓】一个目录 = 一个独立角色（Algernon）
    └── ...                       #   （未来新建角色只需执行 pmv init F:\<other>-memory）
```

### 2.2 单角色记忆仓标准拓扑与读写属性

| 路径 | 读写属性（Mutability） | 核心职责与设计约束 |
| :--- | :--- | :--- |
| `character.manifest.json` | `curated`（人工/签名维护） | 角色 ID 与别名、常用模型签名表（`chat` / `dream` / `embedding` / `decision`）、签名策略、长度预算 |
| `SOUL.md` | `curated`（高受控） | 角色不可变核心人格、职责、价值观、沟通习惯、模型签名诚实协议与双轨查证纪律 |
| `USER_PROFILE.md` | `curated` / `dream-proposed` | 关于主人的长期画像、工作流偏好与忌讳；后台修改必须进 `dream_queue/` 审批 |
| `ledger/sessions/<harness>/` | **`append-only`（只追加）** | 按来源框架与 `session_id` 归档的归一化 JSONL 对话账本；历史行严禁修改或删除 |
| `ledger/docs-mirror/` | **`append-only`（原样镜像）** | 外部重要项目文档/典籍摘录原样副本 + `manifest.json`（来源 URI 与 SHA-256 指纹） |
| `ledger/spans/<harness>/` | **`derived`（可重建指针层）** | `<session_id>.spans.json` 语义段落指针（含 `step_range`、`byte_offset`、`byte_length`、`salience`、`kind`、`gist`） |
| `wiki/index.md` | **`derived`（二合一总索引）** | 【L1 核心地图，≤ 150 行】上段为按重要度浮沉的**近期脉络（Living Timeline）**，下段为**常青支柱（Evergreen Pillars）** |
| `wiki/log.md` | **`append-only`（审计日志）** | 每次做梦同步的账本消费游标（watermark）、操作模型签名、变更页面列表与审批记录 |
| `wiki/projects/` | `derived` / `curated` | 长期推进中的工程/考据项目主页面（OKF Markdown） |
| `wiki/domains/` | `derived` / `curated` | 长期知识与方法论沉淀（前端工程、文学考据、效率工作流等） |
| `wiki/decisions/` | `derived` / `curated` | 关键技术/协作决策与避坑记录（ADR 风格，显式标注 `supersedes` 推翻链） |
| `wiki/episodes/` | `derived` | 原子事件记录（一事一记，彼此并联） |
| `wiki/syntheses/` | `derived` | 跨事件感悟串联与规律抽象页（汇流节点，显式引用来源 `episodes/`） |
| `wiki/archive/` | `archived`（退出活跃召回） | 被合并或被推翻的旧页面，保留完整溯源但烘焙快照与常规索引时跳过 |
| `tags/taxonomy.yaml` | `curated` | 受控一级域 `domains`、细粒度 `facets` 维度定义、同义词归一化 `aliases`、噪音 `blacklist` |
| `tags/index.md` | `derived`（脚本生成） | 由 `lint-tags` 自动生成的标签反查目录（每个标签对应的活跃记忆列表） |
| `tags/chains.md` | `derived`（脚本生成） | 自动汇总的所有活跃页面 `tag_chain` 有序河道视图，供人工巡检概念拓扑 |
| `dream_queue/` | `workflow-queue` | 高风险维护提议 JSON（`pending_review` / `approved` / `rejected`） |
| `snapshot/rivermemo.snap/` | **`baked-snapshot`（只读烘焙）** | 由离线 RiverMemo 编辑器生成的干净只读包（SQLite + 精简 `.vec` + 规则 JSON + 快照签名） |

---

## 第 3 章 四层时间尺度与数据流（Memory Horizons & Data Flow）

### 3.1 四层时间尺度划分

| 时间尺度 | 承载载体 | 注入 / 读取方式 | 解决的核心问题 |
| :--- | :--- | :--- | :--- |
| **短期记忆** | 宿主当前对话窗口（Context Window） | 宿主框架原生管理 | 当前多轮交互的精确上下文（零重复造轮子） |
| **中期记忆 & 全局地图** | **二合一 `wiki/index.md`**（上段近期脉络 + 下段常青支柱） | 随 **L1** 在会话初始化时一次性载入（≤ 150 行） | 既能自然接上最近的高价值工作脉络，又不会因近期闲聊把半年前的老专题挤出视野 |
| **长期记忆（主动查证）** | `wiki/**/*.md` → **`ledger/spans/` 指针** → **`ledger/sessions/` 字节切片** | 先看指针 `gist` 定位，再用 `readLedgerSpan` O(1) 精准切片读原话 | 查 Wiki 求快，查账本求准，同时彻底杜绝将几十万字整份日志塞进上下文 |
| **长期记忆（潜意识自动召回）** | `snapshot/rivermemo.snap/`（Topology V3.1）+ 可选 `DecisionProvider` 门控 | **L2** 在每轮请求前经轻判断门控后紧贴当轮 User 注入 | 不依赖模型主动想起翻目录，按河网拓扑与直接锚点把相关记忆自动推到眼前 |

### 3.2 二合一叙事型总索引：`wiki/index.md` 规范

不再单独设立重复的 `wiki/timeline.md`，而是将近期接续脉络与长期知识版图合并入 `wiki/index.md`（硬性预算 **≤ 150 行**），分为严格两段：

1. **上段 · `## 近期脉络（Living Timeline）`（约占预算 40%）**：
   - 数据来源：`ledger/spans/**/*.spans.json` 与近期变更的 `wiki/` 页面；
   - 排序公式：**`effective_score = salience × exp(-ln(2) × age_days / 14)`**（重要度高、决策密度大的对话段落半衰期更长，琐碎寒暄自动沉底不占位）；
   - 写法风格：用带温度与因果逻辑的简洁叙事写清“最近在做哪几件事、刚拍板了什么、卡点/下一步在哪”，每条附 `span:<span_id>` 指针与关联 Wiki 链接，方便下次新开会话一眼接茬。
2. **下段 · `## 常青支柱（Evergreen Pillars）`（约占预算 60%）**：
   - 按 `projects` / `domains` / `decisions` / `syntheses` 分组，保留所有常青专题与高重要性（`core`/`high`）页面链接与核心锚点；
   - 保证无论近期聊什么，长期底座始终可见。

### 3.3 三条解耦数据流总图

```text
[1] 前台对话流（低延迟、KV Cache 友好、零写笔记干扰）
    SessionStart ──▶ 只读 Runtime 读取 SOUL + PROFILE + 签名协议 + 二合一 wiki/index.md
                         └─▶ 锁死写入 System Prompt（L0 + L1，整场多轮一字不改）
    User 发出提问 ──▶ (可选) DecisionProvider 150ms 门控：needs_recall? + preset?
                         ├─▶ 需召回 ─▶ 只读挂载 snapshot/rivermemo.snap/ 计算 Top-K
                         └─▶ 将 <recalled_memory> + (按需)<signature_notice> 随当轮 User 注入（L2）
    模型按需查证   ──▶ 读 wiki/*.md（求快）
                         └─▶ 需核对确切原话 ─▶ searchLedgerSpans(查 gist) ─▶ readLedgerSpan(按 byte_offset 切片读)
    Turn/会话结束  ──▶ 毫秒级追加 ledger/sessions/ + 递增后台计数

[2] 后台做梦流（按量触发、段落筛选、高风险审批）
    计数器达到阈值 ─▶ (可选) DecisionProvider 批量评估新日志切片（has_lasting_value / salience / kind）
                         └─▶ 产出 ledger/spans/ 并筛选高价值段落喂给 dream 模型
                             ├─▶ 低风险：写入/更新 wiki/{episodes,projects,domains,syntheses}/ + 重编 index.md
                             └─▶ 高风险（改 SOUL/PROFILE、合并/废弃旧页、推翻已验证结论）
                                     └─▶ 代码闸门拦截写入 dream_queue/pending-*.json（等用户审批生效）

[3] 离线编辑烘焙流（定期插回、签名熔断、只读发版）
    插回角色目录 ──▶ RiverMemo Studio 读取 snapshot.manifest.json 向量操作签名
                         ├─▶ 找到同签名向量模型 ─▶ lint-tags 体检 ─▶ 调预设/看 Trace 对比 ─▶ 增量 Bake 新快照
                         └─▶ 未找到同签名模型   ─▶ 硬熔断！请求用户授权重签新向量模型并全量重烘（Full Re-bake）
```

---

## 第 4 章 核心数据契约与文件 Schema（Data Contracts）

### 4.1 角色清单与签名配置：`character.manifest.json`

每个角色仓根目录必须存在 `character.manifest.json`。`preferred_models` 中全部四个槽位（`chat` / `dream` / `embedding` / `decision`）支持独立签名；在角色初始化阶段均以显式 `unsigned` 占位，**严禁工具自动猜填或伪造默认签名**：

```json
{
  "schema": "persona-memory-vault/v1",
  "character": {
    "id": "algernon",
    "name": "Algernon",
    "display_name": "阿尔吉侬",
    "aliases": ["Algernon", "阿尔吉侬"]
  },
  "preferred_models": {
    "chat": {
      "status": "unsigned",
      "provider": null,
      "model_id": null,
      "sign_source": "unsigned",
      "signed_by": null,
      "signed_at": null,
      "note": "对话主力模型签名；无法自动识别时由用户现场代签"
    },
    "dream": {
      "status": "unsigned",
      "provider": null,
      "model_id": null,
      "sign_source": "unsigned",
      "signed_by": null,
      "signed_at": null,
      "note": "后台做梦整理模型签名"
    },
    "embedding": {
      "status": "unsigned",
      "provider": null,
      "model_id": null,
      "dimension": null,
      "normalize": true,
      "model_sig": null,
      "sign_source": "unsigned",
      "signed_by": null,
      "signed_at": null,
      "note": "Phase 1 留空签名位，留待 Phase 2 首次烘焙快照时由用户现场选定并签写"
    },
    "decision": {
      "status": "unsigned",
      "optional": true,
      "provider": null,
      "adapter": null,
      "model_id": null,
      "sign_source": "unsigned",
      "signed_by": null,
      "signed_at": null,
      "note": "可选外部判断服务接口签名（如 gemini-decisions / typesafe-jev / openai-compat-json / custom-http）；未签时无损降级"
    }
  },
  "signature_policy": {
    "forbid_guessed_model_name": true,
    "unknown_values": ["", "auto", "unknown", "default"],
    "on_unverifiable_model": "prompt_user_to_sign",
    "on_embedding_mismatch": "abort_and_request_full_rebake"
  },
  "budgets": {
    "index_max_lines": 150,
    "timeline_section_max_items": 12,
    "timeline_salience_floor": 0.55,
    "recall_top_k": 5
  }
}
```

### 4.2 不可变原始账本与派生语义指针：`ledger/`

#### 4.2.1 会话账本（`ledger/sessions/<harness>/<session_id>.jsonl`）

每行一条独立 JSON 事件，按 `step_index` 单调追加，**严禁原地修改或删除历史行**（重复导入按 `event_id` 幂等跳过）：

```json
{
  "schema": "pmv-ledger-event/v1",
  "event_id": "antigravity:b9ba66bc-97e9-4af5-ae55-a58a8a0ceb3a:28",
  "ts": "2026-11-20T02:35:46+08:00",
  "source_harness": "antigravity",
  "session_id": "b9ba66bc-97e9-4af5-ae55-a58a8a0ceb3a",
  "step_index": 28,
  "role": "user",
  "content": "嗯，那我大概清晰了，onering是个多端同步器...",
  "content_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "model_signature": {
    "provider": "antigravity",
    "model_id": null,
    "raw_reported": "auto"
  },
  "sign_source": "unsigned"
}
```

- `role` 允许值：`user` | `assistant` | `tool_summary` | `system_event`。
- 导入如 Antigravity `transcript.jsonl` 时：`USER_INPUT` 与带有正文的 `PLANNER_RESPONSE` 完整保留；纯工具调用轮次压缩为简洁的 `tool_summary`（附原始 `raw_ref` 指针），跳过巨型 `GENERIC` 工具输出原文以保持账本精炼可读。
- 宿主上报 `"auto"` 或空模型名时，`model_signature.model_id` 必须为 `null`、`sign_source` 必须为 `"unsigned"`。

#### 4.2.2 外部文档镜像（`ledger/docs-mirror/manifest.json`）

记录引入记忆系统的外部参考文档原样副本与 SHA-256 指纹：

```json
{
  "schema": "pmv-docs-mirror/v1",
  "entries": [
    {
      "doc_id": "doc-algernon-agents-origin",
      "mirror_path": "ledger/docs-mirror/AGENTS.md",
      "source_uri": "file:///<USER_HOME>/.gemini/config/plugins/<persona>-identity/rules/AGENTS.md",
      "sha256": "<64-hex-sha256>",
      "mirrored_at": "2026-11-20T02:40:00+08:00",
      "immutable": true
    }
  ]
}
```

#### 4.2.3 派生语义段落指针（`ledger/spans/<harness>/<session_id>.spans.json`）

针对长会话日志的**O(1) 切片检索索引**。可在后台做梦或离线执行 `pmv build-spans` 时由 `DecisionProvider`（优先）或确定性启发式规则自动生成，随时可删掉重建而不伤害不可变 `ledger/sessions/`：

```json
{
  "schema": "pmv-ledger-spans/v1",
  "source_harness": "antigravity",
  "session_id": "b9ba66bc-97e9-4af5-ae55-a58a8a0ceb3a",
  "ledger_path": "ledger/sessions/antigravity/b9ba66bc-97e9-4af5-ae55-a58a8a0ceb3a.jsonl",
  "generated_at": "2026-11-20T03:05:00+08:00",
  "spans": [
    {
      "span_id": "antigravity:b9ba66bc:sp04",
      "session_id": "b9ba66bc-97e9-4af5-ae55-a58a8a0ceb3a",
      "source_harness": "antigravity",
      "step_range": [26, 30],
      "byte_offset": 14820,
      "byte_length": 3120,
      "ts_start": "2026-11-20T02:18:33+08:00",
      "ts_end": "2026-11-20T02:36:18+08:00",
      "kind": "decision",
      "salience": 0.94,
      "gist": "敲定本体不包入 OneRing 多端同步器，只通过二合一 index.md 衔接中期记忆，并把判断模型做成外部服务接口。",
      "entities": ["OneRing", "DecisionProvider", "PersonaMemoryVault"],
      "linked_wiki": ["wiki/projects/pmv-architecture.md"],
      "annotated_by": {
        "model_id": null,
        "provider": "heuristic",
        "sign_source": "unsigned"
      }
    }
  ]
}
```

- **UTF-8 字节精确对齐**：`byte_offset` 与 `byte_length` 严格按 UTF-8 字节计数（严禁用字符长度 `.length` 代替），保证 `readLedgerSpan` 对中文、Emoji 多字节行做 `fs.read` 部分读取时零偏移错位。
- **`kind` 枚举**：`decision` | `insight` | `preference` | `fact` | `code_spec` | `literary_note` | `discussion`。

### 4.3 OKF + RiverMemo 双轨记忆页规范（`wiki/**/*.md`）

每篇记忆页必须是一个合法的 **OKF（Open Knowledge Format）Markdown 文件**，头部为严格 YAML Frontmatter，正文遵守 RiverMemo 闭合与序关系契约：

```markdown
---
id: mem-20261120-pmv-architecture
title: Persona Memory Vault 架构定调与系统边界
type: architecture          # project | concept | decision | episode | synthesis | literary | preference | architecture
status: active              # active | draft | superseded | archived
domain:
  - agent-memory
  - engineering
project:
  - persona-memo-kit
entities:
  - Algernon
  - Cteno
  - OKF
  - RiverMemo
  - DecisionProvider
facets:
  stack: [markdown, yaml, jsonl, rust-napi]
  topic: [记忆架构, 读写分离, 标签治理, 语义切片]
  work: []
importance: core            # core | high | normal | low
confidence: verified        # verified | high | tentative
updated_at: 2026-11-20
supersedes: []
compiled_by:
  model_id: null
  provider: antigravity
  sign_source: unsigned     # runtime_verified | user_signed | unsigned
  signed_by: null
anchors:
  - PersonaMemoryVault
  - 只读RiverMemo快照
tag_chain:
  - Algernon记忆重构
  - Cteno不可变账本
  - 语义Span切片指针
  - OKF双轨记忆页
  - RiverMemo有序标签河道
  - 可插拔判断服务接口
sources:
  - span:antigravity:b9ba66bc:sp04
  - antigravity/b9ba66bc-97e9-4af5-ae55-a58a8a0ceb3a#step1-step35
---

# Persona Memory Vault 架构定调与系统边界

## 核心结论
确立“本体归本体，外壳归外壳”原则：Algernon记忆重构 采用 Cteno不可变账本 配合 语义Span切片指针 兼顾唯一真相与 O(1) 原文抽查；知识层使用 OKF双轨记忆页 组织内容，通过 RiverMemo有序标签河道 烘焙只读召回快照，并将判断能力抽象为 可插拔判断服务接口。
```

#### 字段与写作铁律
1. **`anchors`（直接锚点，1~2 枚）**：高特异性概念或专名，不绕道即可在河网中独立击中。
2. **`tag_chain`（有序河道，建议 3~8 项）**：严格按 **`事件与专名领头 → 机制与概念居中 → 泛化归类殿后`** 排列；相邻节点概念连贯、不重复、不跨步跳跃。
3. **正文闭合铁律（Closure Rule）**：`tag_chain` 与 `anchors` 中的每一项概念，必须在正文语段中真实出现或被清晰阐释——禁止在正文未言及的情况下硬塞标签（“没有闭合的浮桥”）。
4. **原子事件并联 vs 感悟串联**：
   - `episodes/` 一事一记，同一事件续写则更新原页；不同事件各开新篇。
   - 多个事件交汇产生长期方法论或考据结论时，在 `syntheses/` 另开汇流页，正文显式用 Markdown 链接指向来源页，`tag_chain` 从各来源页拾取 1~2 枚核心锚按推演顺序重排，**严禁对来源标签简单取并集**。
5. **冲突显式链**：新结论推翻旧结论时，填写 `supersedes: [<old_id>]`，旧页 `status` 改为 `superseded` 或归档入 `wiki/archive/`，禁止无声覆盖。
6. **精确溯源写法**：`sources` 优先填写 `span:<span_id>`（或同时保留 `<harness>/<session_id>#stepX-stepY` / `docs-mirror/<doc_id>`）。

### 4.4 多维标签治理：`tags/taxonomy.yaml` 与 `lint-tags`

```yaml
schema: pmv-taxonomy/v1
domains:
  - frontend-engineering    # 前端工程、UI/UX、交互与架构
  - literary-criticism      # 文学考据、版本校勘、典故溯源
  - personal-assistant      # 日常效率、习惯、长期项目推进
  - agent-memory            # 记忆系统自身设计与维护
  - engineering             # 通用软件工程与工具链

facets:
  # 前端开发维度
  stack:
    description: 前端技术栈与运行时（如 vue3, typescript, css, canvas, napi）
  repo:
    description: 所属工程或代码仓名
  ui_pattern:
    description: 交互与视觉范式（如 timeline, inspector, node-graph）
  # 文学考据维度
  work:
    description: 涉及的作品、典籍或文献名
  author:
    description: 作者、注家或研究者
  edition:
    description: 版本、印次或译本信息
  motif:
    description: 母题、意象、典故或考据线索
  # 个人助手维度
  habit:
    description: 个人偏好、沟通风格、作息或忌讳
  workflow:
    description: 日常协作工作流（如 spec-first, code-review）
  goal:
    description: 阶段性或长期个人目标

aliases:
  前端: frontend-engineering
  前端开发: frontend-engineering
  Frontend: frontend-engineering
  文学考据: literary-criticism
  考据: literary-criticism
  个人助手: personal-assistant

blacklist:
  - 总结
  - 笔记
  - 对话记录
  - 日记
  - AI生成

tag_chain_rules:
  min_length: 2
  max_length: 8
  require_body_closure: true
```

**`lint-tags` 体检工作流（Preview → Confirm → Fix）**：
1. 扫描所有活跃 `wiki/**/*.md`（跳过 `wiki/index.md`、`wiki/log.md`、`wiki/archive/**`）；
2. 检测并预览问题清单：必填字段缺失、中文/全角标点不规范、命中 `aliases` 的别名、`domain` 越界、命中 `blacklist` 的无效泛词、`tag_chain` 长度或去重异常、**正文未闭合标签**（确定性子串校验优先，可选叠加 `DecisionProvider` 语义软闭合复核）、相对链接与 `supersedes` 断链、孤儿标签；
3. `--fix` 仅应用安全修补（标点规范、别名归并、邻接/集合去重），并重新生成 `tags/index.md` 与 `tags/chains.md`；缺失正文闭合等需语义改写的条目仍显式报告不擅改正文。

### 4.5 审计日志与审批队列：`wiki/log.md` 与 `dream_queue/`

- **`wiki/log.md`**：记录每次做梦或维护的账本消费游标（watermark）、执行模型签名及 `sign_source`、增删改页面清单与审批单号。
- **`dream_queue/pending-YYYYMMDD-<slug>.json`**：以下 5 类高风险操作**禁止后台静默落盘**，必须由代码硬拦截写入待审队列：
  1. `update_soul`（修改 `SOUL.md` 任何条款）
  2. `update_profile`（修改 `USER_PROFILE.md` 核心偏好）
  3. `merge_pages`（合并多篇记忆并将旧页迁入 `wiki/archive/`）
  4. `deprecate_page`（将活跃页面标记为 `archived` 或 `superseded`）
  5. `resolve_conflict`（裁决已有记忆间的事实冲突）

---

## 第 5 章 双重「操作签名」、外部服务抽象与「人工代签」协议

### 5.1 向量操作签名：自动寻签与失配全量重烘熔断

1. **不统一向量模型**：不同角色仓允许自由签名各自偏好的向量模型；所有本地可用端点注册在 `F:\persona-memo-kit\providers.local.json`（`embedding_providers`）。
2. **快照清单 `snapshot/rivermemo.snap/snapshot.manifest.json`** 记录固化后的 `embedding` 签名（`provider`, `model_id`, `dimension`, `normalize`, `model_sig`, `baked_at`, `signed_by`, `sign_source`）、`river_config_hash`、`artifact_sig`、`preset` 与计数。
3. **三分支维护状态机**：
   - **状态 A — 初始未签（`preferred_models.embedding.status === "unsigned"`）**：引导用户从 `providers.local.json` 中现场选定并签署初始向量模型，写回 `character.manifest.json` 后执行首次烘焙。
   - **状态 B — 命中同签名模型（`model_sig + dimension` 完全一致）**：自动绑定对应服务执行增量向量化与快照更新。
   - **状态 C — 签名失配**：**硬熔断（`abort_and_request_full_rebake`）**，严禁静默写入异构向量！向用户发起明确请求，经授权切换签名并执行全量重烘（Full Re-bake）后才可继续。

### 5.2 角色常用模型签名与无法自签时的提醒协议

1. **`sign_source` 三态枚举**：`runtime_verified`（宿主或 API 响应确切返回）| `user_signed`（用户人工代签）| `unsigned`（暂未签）。
2. **禁止猜签原则**：宿主上报 `"auto"` / `"unknown"` / 空值（见 Antigravity `hooks.md`）时，`model_id` 置 `null`、`sign_source` 记 `"unsigned"`，**严禁模型猜测自身型号**。
3. **提醒触发链**：运行时检测到未验证或与角色 `preferred_models.chat` 不一致时，随 L2 注入 `<signature_notice>`，L0 宪法规则要求模型顺口提醒用户代签。

### 5.3 可插拔「判断模型（`DecisionProvider`）」服务接口规格

与向量模型完全同构，**判断模型不写死在工具箱代码里，而是通过标准 HTTP/API 服务接口与 `providers.local.json` 配置挂载**。

1. **配置声明（`providers.local.json` 中的 `decision_providers`）**：支持 `gemini-decisions`、`typesafe-jev`、`openai-compat-json`、`custom-http` 四种标准适配器；密钥仅通过 `api_key_env` 引用环境变量，绝不硬编码明文密钥。
2. **统一三原语调用契约**：
   - 输入：`evaluate({ state, questions, timeoutMs })`，其中 `questions` 映射为三种标准判断原语之一：
     - `noul`（是/否校准概率 `0..1`）
     - `choice`（闭集选项单选 + 概率分布 + 置信度）
     - `score`（有序等级打分 + 加权分 + 置信度）
   - 输出：`{ degraded: boolean, reason?: string, model?: string, answers: { [key]: { type, noul|choice|score, confidence, probabilities } } }`。
3. **四大精确落点 & 确定性优先纪律**：
   - **落点 1 · 后台做梦前置切片打分**：筛选账本段落 `has_lasting_value`、`salience`、`kind`，直接喂给 `ledger/spans/` 与 `wiki/index.md` 上段排序，省去向主推理模型投喂大量水话；
   - **落点 2 · 前台 L2 召回门控与预设路由**：判定当轮用户输入是否需要触发 RiverMemo 召回（`needs_recall`）以及切换 `balanced / precision_research / associative_explore` 档位；
   - **落点 3 · 高风险审批代码闸门复核**：对做梦变更做 `modifies_soul_or_profile` / `contradicts_existing` 复核拦截进 `dream_queue/`；
   - **落点 4 · `lint-tags` 软闭合复核（可选）**：对字面未命中正文的边缘标签，可选询问是否已通过同义方式闭合阐释。
   - **强制降级铁律**：未配置、状态为 `unsigned`、接口超时或报错时，统一返回 `{ degraded: true }`，上层无缝切换为确定性启发式或默认策略（如默认走 `balanced` 召回），**永远不阻塞主流程**。

---

## 第 6 章 RiverMemo 离线编辑器与只读快照规格（Offline Editor & Snapshot Spec）

### 6.1 复用 `rust-vexus-lite` 原生能力映射

Phase 2 在 Windows（及 macOS/Linux）可通过环境变量 `PMV_VEXUS_LITE_PATH` 或 `kit/native/vexus-lite/index.js` 加载 `rust-vexus-lite`（底层单文件 N-API 模块如 `vexus-lite.win32-x64-msvc.node`）：

| 阶段 | 原生类 | 复用的 N-API 接口（见 `rust-vexus-lite/index.d.ts`） | 在本架构中的作用 |
| :--- | :--- | :--- | :--- |
| **存储与投影入库** | `NativeKnowledgeRuntime` | `openAndInitStore`, `commitIngestionBatch`, `commitDeleteBatch` | 在工作目录初始化 SQLite 事实表，写入 OKF 投影文本、分块向量与 Tag 向量 |
| **Tag 河道一致性** | `NativeKnowledgeRuntime` | `prepareTagConsistency`, `commitTagConsistency` | 保持文档有序 Tag 序列、位置权重与全局 Tag 索引严格对齐 |
| **图资产与几何预计算** | `VexusIndex` | `computeMemoGeometry`, `rebuildMemoArtifact` | 原生编译 Tag 共现、方向不对称矩阵、虫洞边与 Topology V3 图资产 |
| **双槽索引维护与瘦身** | `NativeKnowledgeRuntime` | `restoreGlobalTagIndex`, `checkpointGlobalTagIndex`, `restoreDiaryIndex`, `checkpointDiaryIndex`, `pruneNativeMemoArtifacts` | 生成紧凑可用的 `.vec` 索引并清理冗余持久化资产 |
| **运行态只读查询** | `NativeKnowledgeRuntime` + `VexusIndex` | `getNativeMemoManifest`, `runMemoPipeline`, `executeRiverQuery`, `executeRiverQueryHybrid`, `rerankRivermemoTopologyV3`, `hydrateChunksByIds` | 执行完整 EPA + 残差金字塔 + Sense 河网传播 + 双尺度场 + Ω 泛函 + Direct Anchor 重排 |

### 6.2 OKF → RiverMemo 无损投影层与干净只读快照

1. **单向投影**：`wiki/<folder>/`（`projects` / `domains` / `decisions` / `episodes` / `syntheses`）映射为逻辑分区，`wiki/archive/` 与 `status: archived` 跳过；`anchors` + `tag_chain` 依序映射为尾行 `Tag: ...` 供 `build_fact_matrix()` 提取有向边权。
2. **干净只读快照 `snapshot/rivermemo.snap/`**：包含 `snapshot.manifest.json`、`river_rules.json`、`knowledge_base.sqlite`、`index_global_tags.vec`、`index_diary_*.vec`。烘焙末尾必须执行 `pruneNativeMemoArtifacts` + WAL checkpoint + `VACUUM`，彻底删除 `.retired`、`.checkpoint-source*`、`.restore-source*` 等运行期垃圾。

### 6.3 RiverMemo 离线编辑器（Studio）四大功能面

1. **向量签名校验与烘焙控制台**（含签名失配全量重烘熔断）；
2. **标签与河道体检 Diff 面板**（接入 `lint-tags` 预览修复）；
3. **召回规则预设档与过滤器**（`balanced` / `precision_research` / `associative_explore` + 域/时间过滤；底层 Topology V3 数学参数默认折叠并加红标警告，借鉴 `RiverMemoV3ControlPanel.vue`）；
4. **固定测试问题集 + 河网 Trace 对比台**（改配置先对比 Top-K、Ω 值与边流贡献，满意再一键 Bake 发版）。

---

## 第 7 章 运行时注入协议与外壳适配契约（Runtime Injection & Shell Contracts）

### 7.1 三层注入架构（KV Cache 零击穿）

| 层级 | 内容组成 | 注入位置 | 生命周期与缓存属性 |
| :--- | :--- | :--- | :--- |
| **L0 · 灵魂宪法与协议** | `SOUL.md` + `USER_PROFILE.md` + 角色常用模型签名状态 + 禁止猜签/提醒代签协议 + 双轨查证与 Span 切片查询纪律 | **System Prompt 前段** | 会话期间绝对不变，跨轮次/跨会话复用 KV Cache |
| **L1 · 二合一叙事地图** | **`wiki/index.md`（≤150 行：上段近期脉络 + 下段常青支柱）** + 核心标签概览 | **System Prompt 后段** | 单次会话内一字不改，**100% 保住整场前缀缓存** |
| **L2 · 动态潜意识召回** | 经可选 `DecisionProvider` 门控后由 RiverMemo 快照算出的 Top-K 结果 + 按需 `<signature_notice>` | **附着在当轮 User 消息前**（绝不修改 System Prompt，绝不回头篡改历史轮次） | 紧贴当前提问，近因注意力最强且零缓存击穿 |

```xml
<recalled_memory snapshot_sig="openai-compat::qwen3-embedding-4b::2560" preset="balanced">
  <item id="mem-20261120-pmv-architecture"
        path="wiki/projects/pmv-architecture.md"
        score="0.892"
        anchors="PersonaMemoryVault, 只读RiverMemo快照"
        tag_chain="Algernon记忆重构 -> Cteno不可变账本 -> 语义Span切片指针"
        sources="span:antigravity:b9ba66bc:sp04">
    <excerpt>
      核心决定：本体只保留纯文本角色仓与离线快照编辑器；判断模型走标准外部服务接口，原文核对通过 spans 指针 O(1) 字节切片读取。
    </excerpt>
  </item>
</recalled_memory>
```

### 7.2 标准只读与切片查证 Runtime API 契约

所有未来外壳（Antigravity 插件、透明 API 代理、独立多端同步器、自研聊天前端）只允许通过以下 **6 个标准接口** 与角色记忆仓交互：

1. `loadVault(vaultPath)` — 校验角色仓、`character.manifest.json` 与只读快照清单。
2. `composeSystemPrefix(vault, runtimeMeta)` — 拼装并返回会话内锁定的 **L0 + L1 System Prompt** 及签名诊断状态。
3. `recallForUserTurn(vault, userText, options)` — （可选经 `DecisionProvider` 门控与选档）+ 只读 `rivermemo.snap` 执行 Topology V3.1 召回，返回 `<recalled_memory>` 与 Trace；未烘焙或无服务时优雅降级为空。
4. `searchLedgerSpans(vault, queryOptions)` — 仅检索轻量的 `ledger/spans/**/*.spans.json` 索引（`query` / `kind` / `minSalience` / `sessionId`），绝不加载整份原始日志。
5. `readLedgerSpan(vault, spanId, { padSteps })` — 根据 `span_id` 定位 `byte_offset` 与 `byte_length`，**O(1) 精准切片读取对应对话步骤原文**（支持上下各补 `padSteps` 步防断章取义）。
6. `appendLedgerEvent(vault, event)` — 以幂等只追加方式写入 `ledger/sessions/<harness>/<session_id>.jsonl` 并携带签名溯源。

---

## 第 8 章 分期施工路线图与验收标准（Phased Roadmap）

| 阶段 | 核心交付物 | 明确验收标准（Done Definition） |
| :--- | :--- | :--- |
| **Phase 0（已完成）** | `F:\persona-memo-kit\SPEC.md` 定稿为 `v1.1` + 双仓 Git 初始化 | 二合一 `index.md`、`spans` 切片、`DecisionProvider` 接口三项设计落地规格书 |
| **Phase 1（本阶段实施）** | ① `persona-memo-kit` 零依赖 Node.js ESM 核心工具链与 CLI（`pmv`）：`yaml-lite`、`manifest`、`decision-provider` 接口、`ledger`（含 Antigravity `transcript.jsonl` 导入器 & `mirror-doc`）、`spans`（UTF-8 字节精确切片与检索）、`tags`（`lint-tags` Preview/Fix + 生成 `tags/index.md` & `chains.md`）、`index-builder`（二合一 `wiki/index.md` ≤150 行）<br>② 完整 `node --test` 单元测试与集成测试<br>③ 初始化 1 号角色仓 `F:\algernon-memory`（迁移 `SOUL.md`、镜像 `AGENTS.md`、导入本机 Antigravity 历史会话并建 spans 与 index） | ① `npm test` 100% 通过；<br>② 本机历史 Antigravity 会话幂等导入 `ledger/`，`readLedgerSpan` 精确切出中文原话无乱码偏移；<br>③ 4 个模型签名槽位保持诚实 `unsigned`；<br>④ `lint-tags --fix` 无错误，`wiki/index.md` 严格 `<= 150` 行 |
| **Phase 2（下一阶段）** | ① `vexus-lite` Node.js 原生桥接与 OKF 投影层<br>② 向量操作签名自动寻签 + 失配全量重烘熔断交互流<br>③ 离线 RiverMemo Studio（CLI + 本地单页 Web 调试台）：规则预设、测试集 Trace 对比、一键 Bake 干净只读快照 | ① 首次烘焙引导用户现场签写 `embedding` 签名；<br>② 签名失配时硬熔断并请求全量重烘；<br>③ 产出的 `rivermemo.snap/` 干净无 `.retired` 垃圾，能返回真实 Topology V3.1 Trace |
| **Phase 3** | ① 完整 Runtime 6 接口挂载<br>② Antigravity 全局插件 `algernon-memory`（`SessionStart`/`PreInvocation`/`Stop` + 代签提醒）与可选透明 Gemini API 代理外壳<br>③ 后台 `dream-runner`（接入可插拔 `DecisionProvider` 预筛）+ `dream_queue/` 审批流 | ① L0/L1 锁 System Prompt、L2 随 User 注入；<br>② `"auto"` 模型时发 `[SIGNATURE_NOTICE]`；<br>③ 高风险修改进 `dream_queue/` 待审 |
| **Phase 4+** | 独立多端同步器（OneRing 类外壳）与自研聊天前端 | 完全外置消费 Runtime 接口，零反向污染本体 |

---

## 第 9 章 v1.1 冻结决策摘要（Frozen Decisions）

1. **二合一导航地图**：取消独立 `wiki/timeline.md`，`wiki/index.md` 采用“上段按 `salience × time_decay` 排序的叙事型近期脉络 + 下段常青支柱”结构，总行数硬限制 **≤ 150 行**。
2. **O(1) 账本原文查证**：引入派生指针层 `ledger/spans/<harness>/<session_id>.spans.json`（UTF-8 `byte_offset` + `byte_length`），先查 `gist` 再精准切片读取，禁止全量读长日志。
3. **服务接口级解耦**：不仅向量模型按服务接口 + 操作签名解耦，**判断模型（`DecisionProvider`）同样按外部 HTTP/API 服务接口抽象**（不写死任何厂商或模型），支持 `noul / choice / score` 三原语并在未配置或未签名时 100% 优雅降级。
4. **诚实签名基线**：初始化角色仓时 `chat`、`dream`、`embedding`、`decision` 全部显式留作 `unsigned`，绝不猜填模型型号；`embedding` 等到 Phase 2 首次烘焙由用户现场签名。
5. **Phase 1 导入范围**：优先打通本机 Antigravity `transcript.jsonl` 幂等导入与 `docs-mirror` 原样镜像；未来需要导入 VCP 旧日记时，作为独立 adapter 插件增补进 `core/ledger/`。
