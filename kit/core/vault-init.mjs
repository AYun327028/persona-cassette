/**
 * @fileoverview Initializes a standard Persona Memory Vault directory tree
 * conforming to SPEC v1.1 (one directory = one character).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createDefaultManifest } from './manifest.mjs';
import { DOCS_MIRROR_SCHEMA } from './ledger.mjs';
import { stringifyYaml } from './yaml-lite.mjs';

const DEFAULT_TAXONOMY = {
  schema: 'pmv-taxonomy/v1',
  domains: ['general', 'agent-memory', 'engineering'],
  facets: {
    topic: { description: '主题关键词维度' },
    workflow: { description: '日常协作工作流维度' }
  },
  aliases: {},
  blacklist: ['总结', '笔记', '对话记录', '日记', 'AI生成'],
  tag_chain_rules: {
    min_length: 2,
    max_length: 8,
    require_body_closure: true
  }
};

async function writeIfMissing(filePath, content, overwrite) {
  if (!overwrite) {
    try {
      await fs.access(filePath);
      return false;
    } catch {
      // Does not exist yet; proceed to write.
    }
  }
  await fs.writeFile(filePath, content, 'utf8');
  return true;
}

/**
 * Initialize a Persona Memory Vault skeleton at `vaultPath`.
 *
 * @param {string} vaultPath
 * @param {{ id: string, name?: string, displayName?: string, aliases?: string[], overwrite?: boolean }} options
 */
export async function initVault(vaultPath, options) {
  const { id, name, displayName, aliases, overwrite = false } = options;
  if (!id) throw new Error('initVault requires a non-empty --id');

  const dirs = [
    'ledger/sessions',
    'ledger/docs-mirror',
    'ledger/spans',
    'wiki/projects',
    'wiki/domains',
    'wiki/decisions',
    'wiki/episodes',
    'wiki/syntheses',
    'wiki/archive',
    'tags',
    'dream_queue',
    'snapshot'
  ];

  for (const rel of dirs) {
    await fs.mkdir(path.join(vaultPath, rel), { recursive: true });
  }

  const manifest = createDefaultManifest({ id, name, displayName, aliases });
  const charLabel = manifest.character.display_name || manifest.character.name;

  await writeIfMissing(
    path.join(vaultPath, 'character.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    overwrite
  );

  await writeIfMissing(
    path.join(vaultPath, 'SOUL.md'),
    `# ${charLabel} 核心灵魂设定（SOUL）\n\n- **身份**：${charLabel}\n- **签名纪律**：严禁猜测或伪造模型型号，宿主无法验证时请提醒用户代签。\n- **双轨查证**：查 Wiki 求快，查账本通过 \`searchLedgerSpans\` + \`readLedgerSpan\` 切片求准。\n`,
    overwrite
  );

  await writeIfMissing(
    path.join(vaultPath, 'USER_PROFILE.md'),
    `# 用户长期画像（USER_PROFILE）\n\n- 待补充用户长期协作偏好与工作流习惯。\n`,
    overwrite
  );

  await writeIfMissing(
    path.join(vaultPath, 'ledger/docs-mirror/manifest.json'),
    `${JSON.stringify({ schema: DOCS_MIRROR_SCHEMA, entries: [] }, null, 2)}\n`,
    overwrite
  );

  await writeIfMissing(
    path.join(vaultPath, 'wiki/index.md'),
    `# ${charLabel} 记忆总索引（Living Chronicle）\n\n## 近期脉络（Living Timeline）\n\n- （初始化占位）\n\n## 常青支柱（Evergreen Pillars）\n\n- （初始化占位）\n`,
    overwrite
  );

  await writeIfMissing(
    path.join(vaultPath, 'wiki/log.md'),
    `# Wiki 维护与做梦审计日志\n\n- ${new Date().toISOString()} | 初始化角色仓 \`${manifest.character.id}\`（SPEC v1.1）\n`,
    overwrite
  );

  await writeIfMissing(
    path.join(vaultPath, 'tags/taxonomy.yaml'),
    stringifyYaml(DEFAULT_TAXONOMY),
    overwrite
  );

  return { vaultPath, character: manifest.character };
}
