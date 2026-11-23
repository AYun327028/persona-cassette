/**
 * @fileoverview Host-agnostic Top-Level Workspace Rules Renderer
 * (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or any custom rule filename).
 *
 * Renders a managed Markdown block inside a workspace's top-level rules file
 * using Prefix KV-Cache monotonic ordering (least volatile at top -> rotating
 * tail at bottom):
 *   1. SOUL.md (static)
 *   2. USER_PROFILE.md (static)
 *   3. Compact L0 runtime contract (static)
 *   4. Evergreen Pillars from wiki/index.md (rarely changes)
 *   5. Living Timeline from wiki/index.md (rotates at bottom on sync/refresh)
 *
 * Strictly preserves all user-authored rules outside the managed markers.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../kit/core/ledger.mjs';
import { loadVault } from '../kit/core/runtime.mjs';
import { DEFAULT_KIT_ROOT, normalizeRawDir, resolveConnectorCartridge } from './slot-scanner.mjs';

export const DEFAULT_RULE_FILENAMES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
const HEADER_RE = /<!--\s*pmv-top-rules\b([^>]*)-->/i;
const END_MARKER = '<!-- PMV_TOP_RULES_END -->';

function parseMarkerAttributes(attrText) {
  const attrs = {};
  const re = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(String(attrText || ''))) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

export function computePersonaRulesHash(vault) {
  const soul = String(vault?.soul || '').trim();
  const profile = String(vault?.userProfile || '').trim();
  return sha256(`${soul}\0${profile}`);
}

export function computeIndexHash(vault) {
  return sha256(String(vault?.indexMd || '').trim());
}

/**
 * Reorder `wiki/index.md` into KV-Cache monotonic order:
 * Evergreen Pillars (stable) FIRST, Living Timeline (rotating) LAST.
 *
 * @param {string} indexMd
 */
export function formatIndexForTopRules(indexMd) {
  const raw = String(indexMd || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';

  const lines = raw.split('\n');
  const preamble = [];
  const timeline = [];
  const evergreen = [];
  const other = [];
  let bucket = 'preamble';

  for (const line of lines) {
    if (/^##\s+.*(?:近期脉络|Living Timeline)/i.test(line)) {
      bucket = 'timeline';
      timeline.push(line);
      continue;
    }
    if (/^##\s+.*(?:常青支柱|Evergreen Pillars)/i.test(line)) {
      bucket = 'evergreen';
      evergreen.push(line);
      continue;
    }
    if (/^##\s+/.test(line)) {
      bucket = 'other';
      other.push(line);
      continue;
    }

    if (bucket === 'preamble') preamble.push(line);
    else if (bucket === 'timeline') timeline.push(line);
    else if (bucket === 'evergreen') evergreen.push(line);
    else other.push(line);
  }

  if (timeline.length === 0 || evergreen.length === 0) {
    return raw;
  }

  const parts = [];
  const preText = preamble.join('\n').trim();
  const evText = evergreen.join('\n').trim();
  const otherText = other.join('\n').trim();
  const tlText = timeline.join('\n').trim();

  if (preText) parts.push(preText);
  if (evText) parts.push(evText);
  if (otherText) parts.push(otherText);
  if (tlText) parts.push(tlText);
  return parts.join('\n\n');
}

/**
 * Build the managed top-level rules block.
 *
 * @param {Awaited<ReturnType<typeof loadVault>>} vault
 * @param {{ includeIndex?: boolean, maxBytes?: number | null }} [options]
 */
export function buildTopRulesBlock(vault, options = {}) {
  const includeIndex = options.includeIndex !== false;
  const maxBytes =
    options.maxBytes !== undefined && options.maxBytes !== null && Number(options.maxBytes) > 0
      ? Math.floor(Number(options.maxBytes))
      : null;

  const cartridgeId = String(vault?.manifest?.character?.id || 'default').trim();
  const soulHash = computePersonaRulesHash(vault);
  const indexHash = computeIndexHash(vault);
  const soul = String(vault?.soul || '').trim();
  const profile = String(vault?.userProfile || '').trim();
  const orderedIndex = includeIndex ? formatIndexForTopRules(vault?.indexMd || '') : '';

  const models = vault?.manifest?.preferred_models || {};
  const sigSummary = Object.entries(models)
    .map(([slot, cfg]) => `${slot}=${cfg?.model_id || 'unsigned'}(${cfg?.sign_source || 'unsigned'})`)
    .join(', ');

  const staticSections = [];
  if (soul) staticSections.push(soul);
  if (profile) {
    staticSections.push(/^#\s/.test(profile) ? profile : `## 用户长期画像（USER_PROFILE）\n\n${profile}`);
  }
  staticSections.push(
    [
      '## 运行时记忆与双轨查证契约（L0 纪律）',
      `- **卡带身份**：\`${cartridgeId}\`（模型签名：${sigSummary || 'unsigned'}）`,
      '- **诚实签名**：严禁靠训练记忆猜测自身真实模型型号；出现 `<signature_notice>` 时顺口提醒用户代签或更新签名。',
      '- **双轨查证与热更新**：本文件按 Prefix KV-Cache 稳定度排布（静态人设在上、开局脉络在下）；盘中新增动态与召回通过 `<chronicle_board_update>` / `<recalled_memory>` 补充，核实精确原文请调用 `pmv_read_wiki` 或先 `pmv_search_spans` 再 `pmv_read_span`。'
    ].join('\n')
  );

  const header =
    `<!-- pmv-top-rules cartridge="${cartridgeId}" sha256="${soulHash}"` +
    ` include_index="${includeIndex ? 'true' : 'false'}"` +
    (includeIndex ? ` index_sha256="${indexHash}"` : '') +
    ' managed="true" -->';
  const note = includeIndex
    ? '> 由 `harness-connector` 自动拼装自角色卡带（`SOUL.md` + `USER_PROFILE.md` + 开局 `wiki/index.md`，常青支柱在上、近期脉络在下），锁定在工作区顶部规则中；请勿手动修改起止标记内的内容，自定义规则请写在结束标记下方。'
    : '> 由 `harness-connector` 自动同步自角色卡带（`SOUL.md` + `USER_PROFILE.md`），锁定在工作区顶部规则中；请勿手动修改起止标记内的内容。';

  const allSections = [...staticSections];
  if (orderedIndex) allSections.push(orderedIndex);

  let block = `${header}\n${note}\n\n${allSections.join('\n\n---\n\n')}\n${END_MARKER}`;
  let truncated = false;

  if (maxBytes && Buffer.byteLength(block, 'utf8') > maxBytes) {
    truncated = true;
    const footer = `\n\n> [pmv-top-rules trimmed from tail to fit ${maxBytes}-byte rule limit]\n${END_MARKER}`;
    const budget = maxBytes - Buffer.byteLength(footer, 'utf8');
    const lines = block.split('\n');
    const kept = [];
    let used = 0;
    for (const line of lines) {
      const add = Buffer.byteLength(`${line}\n`, 'utf8');
      if (used + add > budget) break;
      kept.push(line);
      used += add;
    }
    block = `${kept.join('\n')}${footer}`;
  }

  return {
    cartridge: cartridgeId,
    sha256: soulHash,
    index_sha256: indexHash,
    include_index: includeIndex && Boolean(orderedIndex),
    block,
    bytes: Buffer.byteLength(block, 'utf8'),
    maxBytes,
    truncated
  };
}

function mergeManagedBlockIntoExisting(existingText, managedBlock) {
  const existing = String(existingText || '');
  if (!existing.trim()) {
    return `${managedBlock}\n`;
  }

  const headerMatch = existing.match(HEADER_RE);
  const endIdx = existing.indexOf(END_MARKER);
  if (headerMatch && endIdx !== -1 && endIdx > headerMatch.index) {
    const before = existing.slice(0, headerMatch.index).trimEnd();
    const after = existing.slice(endIdx + END_MARKER.length).trimStart();
    const parts = [];
    if (before) parts.push(before);
    parts.push(managedBlock);
    if (after) parts.push(after);
    return `${parts.join('\n\n')}\n`;
  }

  return `${managedBlock}\n\n${existing.trimStart()}`;
}

/**
 * Sync or refresh a workspace top-level rules file (`AGENTS.md`, `CLAUDE.md`,
 * `GEMINI.md`, or custom filename) from a persona cartridge.
 *
 * @param {string} workspaceDir
 * @param {string | null} [cartridgeOrVaultPath]
 * @param {{
 *   kitRoot?: string,
 *   fileName?: string,
 *   includeIndex?: boolean,
 *   maxBytes?: number | null,
 *   createPersonaMarker?: boolean
 * }} [options]
 */
export async function syncWorkspaceRulesFile(workspaceDir, cartridgeOrVaultPath = null, options = {}) {
  const resolvedWs = normalizeRawDir(workspaceDir);
  if (!resolvedWs) {
    throw new Error('syncWorkspaceRulesFile requires a non-empty workspaceDir');
  }

  const kitRoot = options.kitRoot || DEFAULT_KIT_ROOT;
  const vault = await loadVault(cartridgeOrVaultPath, { kitRoot });
  const includeIndex = options.includeIndex !== false;
  const maxBytes = options.maxBytes !== undefined ? options.maxBytes : null;
  const built = buildTopRulesBlock(vault, { includeIndex, maxBytes });
  const fileName = path.basename(String(options.fileName || 'AGENTS.md').trim() || 'AGENTS.md');
  const filePath = path.join(resolvedWs, fileName);

  await fs.mkdir(resolvedWs, { recursive: true });

  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const nextContent = mergeManagedBlockIntoExisting(existing, built.block);
  const changed = nextContent !== existing;
  if (changed) {
    await fs.writeFile(filePath, nextContent, 'utf8');
  }

  let markerCreated = false;
  if (options.createPersonaMarker === true) {
    const markerPath = path.join(resolvedWs, '.persona');
    try {
      await fs.access(markerPath);
    } catch {
      await fs.writeFile(
        markerPath,
        `${JSON.stringify({ cartridge: built.cartridge }, null, 2)}\n`,
        'utf8'
      );
      markerCreated = true;
    }
  }

  const finalBytes = Buffer.byteLength(nextContent, 'utf8');
  return {
    synced: true,
    changed,
    workspace: resolvedWs,
    fileName,
    filePath,
    cartridge: built.cartridge,
    vaultPath: vault.vaultPath,
    sha256: built.sha256,
    index_sha256: built.index_sha256,
    include_index: built.include_index,
    bytes: finalBytes,
    maxBytes,
    withinLimit: maxBytes ? finalBytes <= maxBytes : true,
    truncated: built.truncated,
    markerCreated
  };
}

/**
 * Inspect workspace directories (walking up to repo root) for a managed
 * `pmv-top-rules` block in any candidate rule filename (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`).
 *
 * @param {string[]} candidateDirs
 * @param {string | null} [targetCartridge]
 * @param {{
 *   kitRoot?: string,
 *   cartridgeRef?: string | null,
 *   fileNames?: string[],
 *   maxBytes?: number | null,
 *   autoRefresh?: boolean,
 *   refreshIndex?: boolean,
 *   maxDepth?: number
 * }} [options]
 */
export async function detectWorkspaceRulesFile(candidateDirs, targetCartridge = null, options = {}) {
  const dirs = Array.isArray(candidateDirs) ? candidateDirs.filter(Boolean) : [];
  if (dirs.length === 0) {
    return {
      active: false,
      filePath: null,
      fileName: null,
      workspace: null,
      cartridge: null,
      sha256: null,
      index_sha256: null,
      include_index: false,
      refreshed: false
    };
  }

  const fileNames =
    Array.isArray(options.fileNames) && options.fileNames.length > 0
      ? options.fileNames
      : DEFAULT_RULE_FILENAMES;
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 6;
  const visited = new Set();

  for (const rawDir of dirs) {
    let cur = normalizeRawDir(rawDir);
    if (!cur) continue;

    for (let depth = 0; depth <= maxDepth; depth += 1) {
      const key = process.platform === 'win32' ? cur.toLowerCase() : cur;
      if (visited.has(key)) break;
      visited.add(key);

      for (const name of fileNames) {
        const candidateFile = path.join(cur, name);
        let text = '';
        try {
          text = await fs.readFile(candidateFile, 'utf8');
        } catch {
          continue;
        }
        const match = text.match(HEADER_RE);
        if (!match) continue;
        const attrs = parseMarkerAttributes(match[1]);
        const foundCartridge = String(attrs.cartridge || '').trim();
        if (!foundCartridge) continue;
        if (targetCartridge && foundCartridge !== String(targetCartridge).trim()) {
          continue;
        }

        const includeIndex = attrs.include_index === 'true';
        let refreshed = false;
        let currentSoulHash = attrs.sha256 || null;
        let currentIndexHash = attrs.index_sha256 || null;

        if (options.autoRefresh !== false && (options.kitRoot || options.cartridgeRef)) {
          try {
            const vaultRef = options.cartridgeRef || foundCartridge;
            const vault = await loadVault(vaultRef, { kitRoot: options.kitRoot || DEFAULT_KIT_ROOT });
            const liveSoulHash = computePersonaRulesHash(vault);
            const liveIndexHash = computeIndexHash(vault);
            const soulChanged = liveSoulHash !== attrs.sha256;
            const indexChanged =
              Boolean(options.refreshIndex) && includeIndex && liveIndexHash !== attrs.index_sha256;

            if (soulChanged || indexChanged) {
              await syncWorkspaceRulesFile(cur, vaultRef, {
                kitRoot: options.kitRoot || DEFAULT_KIT_ROOT,
                fileName: name,
                includeIndex,
                maxBytes: options.maxBytes ?? null,
                createPersonaMarker: false
              });
              refreshed = true;
              currentSoulHash = liveSoulHash;
              currentIndexHash = liveIndexHash;
            }
          } catch {
            // Best-effort refresh must never break host hooks.
          }
        }

        return {
          active: true,
          filePath: candidateFile,
          fileName: name,
          workspace: cur,
          cartridge: foundCartridge,
          sha256: currentSoulHash,
          index_sha256: currentIndexHash,
          include_index: includeIndex,
          refreshed
        };
      }

      try {
        await fs.access(path.join(cur, '.git'));
        break;
      } catch {
        // Climb one parent level.
      }

      const parent = path.dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
  }

  return {
    active: false,
    filePath: null,
    fileName: null,
    workspace: null,
    cartridge: null,
    sha256: null,
    index_sha256: null,
    include_index: false,
    refreshed: false
  };
}

/**
 * Cleanly remove ONLY the managed PMV block from `<workspaceDir>/<fileName>`,
 * preserving any custom user-authored rules outside the markers.
 *
 * @param {string} workspaceDir
 * @param {{ fileName?: string, removePersonaMarker?: boolean }} [options]
 */
export async function removeWorkspaceRulesFile(workspaceDir, options = {}) {
  const resolvedWs = normalizeRawDir(workspaceDir);
  if (!resolvedWs) {
    throw new Error('removeWorkspaceRulesFile requires a non-empty workspaceDir');
  }

  const fileName = path.basename(String(options.fileName || 'AGENTS.md').trim() || 'AGENTS.md');
  const filePath = path.join(resolvedWs, fileName);

  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { removed: false, reason: 'file_not_found', filePath, deletedFile: false };
    }
    throw err;
  }

  const headerMatch = existing.match(HEADER_RE);
  const endIdx = existing.indexOf(END_MARKER);
  if (!headerMatch || endIdx === -1 || endIdx <= headerMatch.index) {
    return { removed: false, reason: 'no_managed_block', filePath, deletedFile: false };
  }

  const before = existing.slice(0, headerMatch.index).trimEnd();
  const after = existing.slice(endIdx + END_MARKER.length).trimStart();
  const remaining = [before, after].filter(Boolean).join('\n\n').trim();

  let deletedFile = false;
  if (!remaining) {
    await fs.rm(filePath, { force: true });
    deletedFile = true;
  } else {
    await fs.writeFile(filePath, `${remaining}\n`, 'utf8');
  }

  let markerRemoved = false;
  if (options.removePersonaMarker) {
    await fs.rm(path.join(resolvedWs, '.persona'), { force: true }).catch(() => undefined);
    markerRemoved = true;
  }

  return {
    removed: true,
    workspace: resolvedWs,
    fileName,
    filePath,
    deletedFile,
    preservedUserContent: Boolean(remaining),
    markerRemoved
  };
}

const isCliEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCliEntrypoint) {
  const args = process.argv.slice(2);
  let fileName = 'AGENTS.md';
  let maxBytes = null;
  let noIndex = false;
  const pos = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--file' && args[i + 1]) {
      fileName = args[++i];
    } else if (a === '--max-bytes' && args[i + 1]) {
      maxBytes = Number(args[++i]);
    } else if (a === '--no-index') {
      noIndex = true;
    } else {
      pos.push(a);
    }
  }
  const [action = 'sync', workspaceDir, cartridgeArg] = pos;
  (async () => {
    const kitRoot = process.env.PMV_KIT_ROOT || DEFAULT_KIT_ROOT;
    if (action === 'sync' && workspaceDir) {
      const target = await resolveConnectorCartridge({
        cartridge: cartridgeArg || null,
        workspacePath: workspaceDir,
        kitRoot
      });
      const res = await syncWorkspaceRulesFile(workspaceDir, target.cartridgeRef, {
        kitRoot,
        fileName,
        maxBytes,
        includeIndex: !noIndex
      });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (action === 'remove' && workspaceDir) {
      const res = await removeWorkspaceRulesFile(workspaceDir, { fileName });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(
      'Usage:\n' +
        '  node harness-connector/rules-renderer.mjs sync <workspaceDir> [cartridgeId] [--file AGENTS.md|CLAUDE.md|GEMINI.md] [--max-bytes 24000] [--no-index]\n' +
        '  node harness-connector/rules-renderer.mjs remove <workspaceDir> [--file AGENTS.md]'
    );
  })().catch((err) => {
    console.error(`[harness-connector rules error] ${err?.message || err}`);
    process.exit(1);
  });
}
