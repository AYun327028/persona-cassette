# Starter Persona Cassette (`starter-persona`)

这是一张开箱即用的**空白角色记忆卡带模板**（符合 Persona Memory Vault `SPEC v1.1`），不包含任何私人记忆数据。

## 如何定制你的角色卡带

1. **直接修改这张模板卡带**：
   - 编辑 [character.manifest.json](./character.manifest.json) 里的 `character.id` / `name` / `display_name`；
   - 编辑 [SOUL.md](./SOUL.md) 写下角色人格与规则；
   - 编辑 [USER_PROFILE.md](./USER_PROFILE.md) 写下你的长期偏好。
2. **或新建多张独立卡带（一目录一角色）**：
   ```bash
   node ../../kit/bin/pmv.mjs init ../my-character --id mychar --name MyChar --display "我的角色"
   ```
   引擎会自动扫描 `cassettes/` 目录，无需修改代码即可插卡切换。

## 目录说明

- `character.manifest.json` — 角色元数据、模型签名槽位与 `context_assembly` 上下文拼装策略
- `SOUL.md` / `USER_PROFILE.md` — 不可变核心人格与长期用户画像
- `ledger/sessions/` — 只追加不可变对话账本（唯一事实来源）
- `ledger/spans/` — 语义段落指针（支持按 UTF-8 字节偏移做 O(1) 原文切片）
- `wiki/` — OKF 纯文本知识库与二合一叙事总索引 `wiki/index.md`（≤150 行）
- `tags/taxonomy.yaml` — 受控标签词表、别名与黑名单治理规则
- `dream_queue/` — 后台做梦高风险修改审批队列
- `snapshot/` — （可选）离线烘焙生成的只读 RiverMemo 向量快照
