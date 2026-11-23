/**
 * @fileoverview Cartridge-owned Context Assembly, Session Baseline Freeze,
 * Chronicle Board Delta Hot-Update, and Turn Commit runtime.
 *
 * Architecture:
 * - Session Baseline Freeze (Swarm-board inspired):
 *   On `beginSession` (or first `assembleTurn` for a `sessionId`), the cartridge
 *   freezes the full L0+L1 `system` prompt (`SOUL + USER_PROFILE + L0 + opening
 *   wiki/index.md`) and stores a lightweight baseline/cursor outside the vault.
 *   Subsequent turns reuse `frozen_system` byte-for-byte (100% Prefix KV-Cache
 *   lock) and inject ONLY real external deltas via `<chronicle_board_update>`
 *   when other harnesses, background `dream`, or approved profile/soul changes
 *   mutate the vault. Zero external change = 0 extra tokens.
 * - History Boundary:
 *   - `< history_backfill_turns` (default 10): backfills from `ledger/sessions/`
 *     up to 10 turns (prioritizing current `sessionId`, then newest sessions).
 *   - `>= history_backfill_turns`: passed through untouched; long-context
 *     compression belongs to the frontend.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './ledger.mjs';
import {
  evaluateRuntimeSignature,
  formatSignatureNoticeXml,
  resolveContextAssemblyConfig
} from './manifest.mjs';
import {
  formatRecalledMemoryXml,
  openSnapshotReader,
  readSnapshotManifest
} from './rivermemo-snapshot.mjs';
import { computeShortSessionId, searchLedgerSpans } from './spans.mjs';
import {
  appendLedgerEvent,
  loadVault,
  readLiveTimelineXml,
  recallForUserTurn
} from './runtime.mjs';

const DEFAULT_KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_STATE_SCHEMA = 'pmv-session-baseline/v1';
const BASELINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BASELINES_PER_VAULT = 200;

const cachedReaders = new Map();
const activeDreamRuns = new Map();

const INJECTED_TAG_PATTERNS = [
  /<chronicle_board_update\b[^>]*>[\s\S]*?<\/chronicle_board_update>/gi,
  /<cartridge_hot_update\b[^>]*>[\s\S]*?<\/cartridge_hot_update>/gi,
  /<living_chronicle\b[^>]*>[\s\S]*?<\/living_chronicle>/gi,
  /<recalled_memory\b[^>]*>[\s\S]*?<\/recalled_memory>/gi,
  /<signature_notice\b[^>]*>[\s\S]*?<\/signature_notice>/gi
];

/**
 * Get or warm-cache a native RiverMemo snapshot reader for a vault path,
 * automatically refreshing whenever `snapshot_version` changes.
 *
 * @param {string} vaultPath
 */
export async function getCachedSnapshotReader(vaultPath) {
  const snap = await readSnapshotManifest(vaultPath);
  if (!snap) return null;
  const cached = cachedReaders.get(vaultPath);
  if (cached && cached.version === snap.snapshot_version) {
    return cached.reader;
  }
  if (cached) {
    try {
      cached.reader.close();
    } catch {
      // Ignore close error on stale handle.
    }
  }
  const reader = await openSnapshotReader(vaultPath);
  cachedReaders.set(vaultPath, { version: snap.snapshot_version, reader });
  return reader;
}

/**
 * Close and release all cached native snapshot readers (for graceful shutdown/tests).
 */
export function closeAllCachedReaders() {
  for (const entry of cachedReaders.values()) {
    try {
      entry.reader.close();
    } catch {
      // Ignore close error.
    }
  }
  cachedReaders.clear();
}

function formatLocalIsoNow(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const tzMin = -date.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const absTz = Math.abs(tzMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absTz / 60))}:${pad(absTz % 60)}`
  );
}

function extractTextContent(rawContent) {
  if (typeof rawContent === 'string') return rawContent;
  if (Array.isArray(rawContent)) {
    return rawContent
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

/**
 * Strip cartridge-injected XML blocks (`<chronicle_board_update>`,
 * `<living_chronicle>`, `<recalled_memory>`, `<signature_notice>`) and orphan
 * leading `---` separators so frontend history stays clean.
 *
 * @param {unknown} rawContent
 * @returns {{ text: string, changed: boolean }}
 */
export function stripInjectedBlocks(rawContent) {
  const original = extractTextContent(rawContent);
  let text = original;
  let changed = false;

  for (const re of INJECTED_TAG_PATTERNS) {
    const next = text.replace(re, '');
    if (next !== text) {
      changed = true;
      text = next;
    }
  }

  if (changed) {
    text = text.replace(/^\s*(?:---\s*(?:\r?\n)+)+/, '');
    text = text.replace(/\n{3,}/g, '\n\n');
  }

  text = text.trim();
  return { text, changed };
}

/**
 * Scan raw (pre-stripped) history messages within the last `windowTurns` user
 * turns to collect memory IDs already present in `<recalled_memory>` blocks.
 *
 * Naturally self-adaptive across all frontends:
 * - Ephemeral chat frontends strip `<recalled_memory>` from history -> returns empty Set -> normal injection.
 * - Append-only hosts (e.g., Antigravity) keep `<recalled_memory>` in trajectory -> returns recent IDs -> skips duplicates within 10 turns!
 *
 * @param {Array<{ role?: string, content?: any }>} rawHistory
 * @param {number} [windowTurns]
 * @param {string} [currentUserText]
 * @returns {Set<string>}
 */
export function extractRecentRecalledKeys(rawHistory, windowTurns = 10, currentUserText = '') {
  const keys = new Set();
  if (!Array.isArray(rawHistory) || rawHistory.length === 0 || windowTurns <= 0) {
    return keys;
  }

  let endIdx = rawHistory.length - 1;
  const normCur = normalizeFingerprintText(currentUserText);
  if (
    normCur &&
    endIdx >= 0 &&
    rawHistory[endIdx]?.role === 'user' &&
    normalizeFingerprintText(stripInjectedBlocks(rawHistory[endIdx].content).text) === normCur
  ) {
    endIdx -= 1;
  }

  let seenUserTurns = 0;
  for (let i = endIdx; i >= 0; i -= 1) {
    const msg = rawHistory[i];
    if (!msg) continue;
    if (msg.role === 'user') {
      seenUserTurns += 1;
      if (seenUserTurns > windowTurns) break;
    }

    if (msg.role !== 'system' && msg.role !== 'user') continue;
    const rawText = extractTextContent(msg.content);
    if (!rawText || !rawText.includes('<recalled_memory')) continue;

    const blockRe = /<recalled_memory\b[^>]*>([\s\S]*?)<\/recalled_memory>/gi;
    let blockMatch;
    while ((blockMatch = blockRe.exec(rawText)) !== null) {
      const inner = blockMatch[1] || '';

      const itemRe = /<item\b([^>]*)>/gi;
      let itemMatch;
      while ((itemMatch = itemRe.exec(inner)) !== null) {
        const attrs = itemMatch[1] || '';
        const idM = attrs.match(/\bid="([^"]+)"/i);
        if (!idM) continue;
        const id = idM[1].trim();
        const updM = attrs.match(/\bupdated_at="([^"]+)"/i);
        const upd = updM ? updM[1].trim() : '*';
        keys.add(`item:${id}::${upd}`);
        if (upd === '*' || upd === 'unknown') keys.add(`item:${id}::*`);
      }

      const spanRe = /^-\s*\[([^\]]+)\]/gm;
      let spanMatch;
      while ((spanMatch = spanRe.exec(inner)) !== null) {
        const spId = spanMatch[1].trim();
        if (spId) keys.add(`span:${spId}`);
      }
    }
  }

  return keys;
}

function isRecalledItemInHistory(item, recentKeys) {
  if (!recentKeys || recentKeys.size === 0 || !item?.id) return false;
  const id = String(item.id).trim();
  const upd = String(item.updated_at || 'unknown').trim();
  return recentKeys.has(`item:${id}::${upd}`) || recentKeys.has(`item:${id}::*`);
}

/**
 * Group normalized `user`/`assistant` messages into conversational turns.
 *
 * @param {Array<{ role: 'user' | 'assistant', content: string, tsMs?: number }>} messages
 */
export function groupMessagesIntoTurns(messages) {
  const turns = [];
  let current = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      current = {
        user: { role: 'user', content: msg.content },
        assistants: [],
        tsMs: Number(msg.tsMs || 0)
      };
      turns.push(current);
    } else if (msg.role === 'assistant') {
      if (!current) {
        current = {
          user: null,
          assistants: [{ role: 'assistant', content: msg.content }],
          tsMs: Number(msg.tsMs || 0)
        };
        turns.push(current);
      } else {
        current.assistants.push({ role: 'assistant', content: msg.content });
        if (!current.tsMs && msg.tsMs) current.tsMs = Number(msg.tsMs);
      }
    }
  }

  return turns;
}

/**
 * Flatten structured turns back into standard OpenAI `messages[]`.
 *
 * @param {ReturnType<typeof groupMessagesIntoTurns>} turns
 */
export function flattenTurnsToMessages(turns) {
  const out = [];
  for (const t of turns) {
    if (t.user) out.push({ role: 'user', content: t.user.content });
    for (const a of t.assistants) {
      out.push({ role: 'assistant', content: a.content });
    }
  }
  return out;
}

function normalizeFingerprintText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function turnFingerprint(turn) {
  const u = normalizeFingerprintText(turn.user?.content || '');
  const a = normalizeFingerprintText(turn.assistants.map((x) => x.content).join('\n'));
  return `${u}\0${a}`;
}

function sanitizeSegment(segment) {
  return String(segment || '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function truncateBackfillContent(text, maxChars) {
  const str = String(text || '');
  if (!maxChars || str.length <= maxChars) return str;
  const head = Math.max(120, Math.floor(maxChars * 0.7));
  const tail = Math.max(60, maxChars - head - 24);
  return `${str.slice(0, head).trimEnd()}\n...[历史记录过长已截断]...\n${str.slice(-tail).trimStart()}`;
}

/**
 * Read up to `limitTurns` recent clean conversational turns from `ledger/sessions/`
 * to backfill frontends supplying fewer than `history_backfill_turns` turns.
 *
 * @param {string} vaultPath
 * @param {{
 *   sessionId?: string | null,
 *   limitTurns?: number,
 *   maxMsgChars?: number,
 *   excludeTurns?: ReturnType<typeof groupMessagesIntoTurns>
 * }} [options]
 */
export async function readRecentLedgerTurns(vaultPath, options = {}) {
  const limitTurns = Math.max(0, Number(options.limitTurns ?? 10));
  if (limitTurns === 0) return [];

  const maxMsgChars = Number(options.maxMsgChars ?? 2400);
  const safeSessionId = options.sessionId ? sanitizeSegment(options.sessionId) : '';
  const excludeTurnKeys = new Set();
  const excludeMsgKeys = new Set();

  for (const t of options.excludeTurns || []) {
    excludeTurnKeys.add(turnFingerprint(t));
    if (t.user?.content) {
      excludeMsgKeys.add(`u:${normalizeFingerprintText(t.user.content)}`);
    }
    for (const a of t.assistants || []) {
      if (a.content) excludeMsgKeys.add(`a:${normalizeFingerprintText(a.content)}`);
    }
  }

  const sessionsRoot = path.join(vaultPath, 'ledger', 'sessions');
  let harnesses = [];
  try {
    harnesses = (await fs.readdir(sessionsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const candidateFiles = [];
  for (const harness of harnesses) {
    const hDir = path.join(sessionsRoot, harness);
    let names = [];
    try {
      names = (await fs.readdir(hDir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const absPath = path.join(hDir, name);
      try {
        const st = await fs.stat(absPath);
        const fileSession = name.slice(0, -'.jsonl'.length);
        candidateFiles.push({
          absPath,
          harness,
          sessionId: fileSession,
          isSameSession: Boolean(safeSessionId && fileSession === safeSessionId),
          mtimeMs: st.mtimeMs
        });
      } catch {
        // Skip unreadable file.
      }
    }
  }

  candidateFiles.sort((a, b) => {
    if (a.isSameSession !== b.isSameSession) return a.isSameSession ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  });

  const collected = [];
  const seenKeys = new Set(excludeTurnKeys);

  for (const file of candidateFiles) {
    if (collected.length >= limitTurns) break;
    let raw = '';
    try {
      raw = await fs.readFile(file.absPath, 'utf8');
    } catch {
      continue;
    }

    const msgs = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (ev?.role !== 'user' && ev?.role !== 'assistant') continue;
      const { text } = stripInjectedBlocks(ev.content);
      if (!text) continue;
      const tsMs = Date.parse(ev.ts || '') || file.mtimeMs;
      msgs.push({ role: ev.role, content: text, tsMs });
    }

    if (msgs.length === 0) continue;
    const turns = groupMessagesIntoTurns(msgs);

    const pickedFromFile = [];
    for (let i = turns.length - 1; i >= 0 && collected.length + pickedFromFile.length < limitTurns; i -= 1) {
      const turn = turns[i];
      const fp = turnFingerprint(turn);
      if (seenKeys.has(fp)) continue;
      if (
        file.isSameSession &&
        turn.user?.content &&
        excludeMsgKeys.has(`u:${normalizeFingerprintText(turn.user.content)}`)
      ) {
        continue;
      }
      seenKeys.add(fp);
      const mergedAssistant = turn.assistants
        .map((a) => a.content)
        .filter(Boolean)
        .join('\n\n');
      pickedFromFile.push({
        user: turn.user
          ? { role: 'user', content: truncateBackfillContent(turn.user.content, maxMsgChars) }
          : null,
        assistants: mergedAssistant
          ? [{ role: 'assistant', content: truncateBackfillContent(mergedAssistant, maxMsgChars) }]
          : [],
        tsMs: turn.tsMs
      });
    }

    collected.push(...pickedFromFile);
  }

  collected.reverse();
  collected.sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));
  return collected.slice(-limitTurns);
}

// ==================== Session Baseline & Chronicle Board Delta ====================

function resolveBaselineRootDir(vaultPath, stateDir = null) {
  const base = stateDir || process.env.PMV_SESSION_STATE_DIR || path.join(os.tmpdir(), 'pmv-session-baselines');
  const vaultHash = sha256(path.resolve(vaultPath).toLowerCase()).slice(0, 16);
  return path.join(base, vaultHash);
}

function getBaselineFilePath(vaultPath, sessionId, stateDir = null) {
  const dir = resolveBaselineRootDir(vaultPath, stateDir);
  const safeSess = sanitizeSegment(sessionId).slice(0, 80) || 'default';
  const suffix = sha256(String(sessionId)).slice(0, 8);
  return path.join(dir, `${safeSess}-${suffix}.json`);
}

function isPlaceholderBullet(line) {
  return /^-\s*（[^）]*(?:尚无|初始化占位|当前会话)[^）]*）\s*$/.test(line);
}

/**
 * Parse `wiki/index.md` into structured timeline bullets and evergreen pillar bullets.
 *
 * @param {string} indexMd
 */
export function parseIndexSections(indexMd) {
  const timelineLines = [];
  const evergreenLines = [];
  let section = 'none';

  for (const rawLine of String(indexMd || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('## 近期脉络')) {
      section = 'timeline';
      continue;
    }
    if (line.startsWith('## 常青支柱')) {
      section = 'evergreen';
      continue;
    }
    if (line.startsWith('## ')) {
      section = 'other';
      continue;
    }
    if (!line.startsWith('- ') || isPlaceholderBullet(line)) continue;
    if (section === 'timeline') timelineLines.push(line);
    else if (section === 'evergreen') evergreenLines.push(line);
  }

  return { timeline_lines: timelineLines, evergreen_lines: evergreenLines };
}

function captureVaultState(vault) {
  const soulText = String(vault.soul || '').trim();
  const profileText = String(vault.userProfile || '').trim();
  const indexText = String(vault.indexMd || '').trim();
  const parsed = parseIndexSections(indexText);
  return {
    soul_sha256: sha256(soulText),
    profile_sha256: sha256(profileText),
    index_sha256: sha256(indexText),
    timeline_lines: parsed.timeline_lines,
    evergreen_lines: parsed.evergreen_lines
  };
}

async function readSessionBaseline(vaultPath, sessionId, stateDir = null) {
  if (!sessionId) return null;
  const filePath = getBaselineFilePath(vaultPath, sessionId, stateDir);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== SESSION_STATE_SCHEMA) return null;
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return null;
  }
}

async function pruneOldBaselines(dir) {
  try {
    const names = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    if (names.length <= MAX_BASELINES_PER_VAULT) return;
    const stats = [];
    const now = Date.now();
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const st = await fs.stat(full);
        if (now - st.mtimeMs > BASELINE_TTL_MS) {
          await fs.rm(full, { force: true });
        } else {
          stats.push({ full, mtimeMs: st.mtimeMs });
        }
      } catch {
        // Ignore race.
      }
    }
    if (stats.length > MAX_BASELINES_PER_VAULT) {
      stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const old of stats.slice(0, stats.length - MAX_BASELINES_PER_VAULT)) {
        await fs.rm(old.full, { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // Non-critical housekeeping.
  }
}

async function writeSessionBaseline(vaultPath, sessionId, record, stateDir = null) {
  const filePath = getBaselineFilePath(vaultPath, sessionId, stateDir);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await pruneOldBaselines(dir);
  return filePath;
}

/**
 * Remove the persisted session baseline for `sessionId` (useful for tests or manual reset).
 *
 * @param {string} vaultPath
 * @param {string} sessionId
 * @param {{ stateDir?: string | null }} [options]
 */
export async function clearSessionBaseline(vaultPath, sessionId, options = {}) {
  if (!sessionId) return;
  const filePath = getBaselineFilePath(vaultPath, sessionId, options.stateDir || null);
  await fs.rm(filePath, { force: true }).catch(() => undefined);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLineFromSession(line, sessionId) {
  if (!sessionId) return false;
  const shortSession = computeShortSessionId(sanitizeSegment(sessionId));
  if (shortSession.length < 4) return false;
  const spanRe = new RegExp(`\`span:[^:\`]+:${escapeRegExp(shortSession)}:sp\\d+\``);
  return spanRe.test(line);
}

function filterCurrentSessionFromTimeline(liveTimelineXml, sessionId) {
  if (!liveTimelineXml || !sessionId) return liveTimelineXml;
  const lines = liveTimelineXml.split('\n');
  const out = [];
  let inTimeline = false;
  let keptTimelineItems = 0;
  let removedCount = 0;

  for (const line of lines) {
    if (line.startsWith('## 近期脉络')) {
      inTimeline = true;
      out.push(line);
      continue;
    }
    if (inTimeline && line.startsWith('## ')) {
      if (keptTimelineItems === 0 && removedCount > 0) {
        out.push('- （当前会话近期对话已在上方上下文原文中）');
        out.push('');
      }
      inTimeline = false;
      out.push(line);
      continue;
    }
    if (inTimeline && line.startsWith('- ') && isLineFromSession(line, sessionId)) {
      removedCount += 1;
      continue;
    }
    if (inTimeline && line.startsWith('- ')) {
      keptTimelineItems += 1;
    }
    out.push(line);
  }

  return out.join('\n');
}

function computeChronicleBoardDelta({
  vault,
  current,
  reference,
  sessionId,
  dedupSelf,
  skipSelfSpans
}) {
  const refTimeline = new Set(reference?.timeline_lines || []);
  const refEvergreen = new Set(reference?.evergreen_lines || []);

  const addedTimeline = (current.timeline_lines || []).filter((line) => {
    if (refTimeline.has(line)) return false;
    if (dedupSelf && skipSelfSpans && isLineFromSession(line, sessionId)) return false;
    return true;
  });

  const addedEvergreen = (current.evergreen_lines || []).filter(
    (line) => !refEvergreen.has(line)
  );

  const soulChanged = Boolean(
    reference?.soul_sha256 && current.soul_sha256 !== reference.soul_sha256 && vault.soul?.trim()
  );
  const profileChanged = Boolean(
    reference?.profile_sha256 &&
      current.profile_sha256 !== reference.profile_sha256 &&
      vault.userProfile?.trim()
  );

  const hasUpdate =
    addedTimeline.length > 0 || addedEvergreen.length > 0 || soulChanged || profileChanged;

  if (!hasUpdate) {
    return {
      has_update: false,
      xml: '',
      timeline_added: 0,
      evergreen_added: 0,
      soul_changed: false,
      profile_changed: false
    };
  }

  const sections = [];
  if (addedTimeline.length > 0) {
    sections.push(`## 新增近期脉络\n${addedTimeline.join('\n')}`);
  }
  if (addedEvergreen.length > 0) {
    sections.push(`## 常青知识库变更\n${addedEvergreen.join('\n')}`);
  }
  if (soulChanged) {
    sections.push(`## 人格设定热更新（SOUL.md）\n${vault.soul.trim()}`);
  }
  if (profileChanged) {
    sections.push(`## 用户画像热更新（USER_PROFILE.md）\n${vault.userProfile.trim()}`);
  }

  const xml =
    `<chronicle_board_update now="${formatLocalIsoNow()}" mode="delta">\n` +
    `${sections.join('\n\n')}\n` +
    '</chronicle_board_update>';

  return {
    has_update: true,
    xml,
    timeline_added: addedTimeline.length,
    evergreen_added: addedEvergreen.length,
    soul_changed: soulChanged,
    profile_changed: profileChanged
  };
}

function formatSpansFallbackXml(spans) {
  if (!Array.isArray(spans) || spans.length === 0) return '';
  const lines = [`<recalled_memory mode="spans_fallback" count="${spans.length}">`];
  for (const sp of spans) {
    const gist = String(sp.gist || '').replace(/\s+/g, ' ').trim();
    const scoreStr = sp.salience !== undefined ? `, s=${sp.salience}` : '';
    lines.push(`- [${sp.span_id}] (${sp.kind || 'discussion'}${scoreStr}) ${gist}`);
  }
  lines.push('</recalled_memory>');
  return lines.join('\n');
}

function composeStableSystemPrompt(vault, config, reportedModel) {
  const sigEval = evaluateRuntimeSignature(vault.manifest, reportedModel);
  const models = vault.manifest.preferred_models || {};
  const sigSummary = Object.entries(models)
    .map(([slot, cfg]) => `${slot}=${cfg?.model_id || 'unsigned'}(${cfg?.sign_source || 'unsigned'})`)
    .join(', ');

  const parts = [];
  for (const section of config.system_sections) {
    if (section === 'soul' && vault.soul?.trim()) {
      parts.push(vault.soul.trim());
    } else if (section === 'user_profile' && vault.userProfile?.trim()) {
      const profileText = vault.userProfile.trim();
      parts.push(
        /^#\s/.test(profileText)
          ? profileText
          : `## 用户长期画像（USER_PROFILE）\n\n${profileText}`
      );
    } else if (section === 'l0_contract') {
      parts.push(
        [
          '## 运行时记忆与信息板契约（L0 纪律）',
          `- **角色常用模型签名**：${sigSummary}`,
          '- **诚实签名**：严禁靠训练记忆猜测自身真实模型型号；出现 `<signature_notice>` 时请在合适时机顺口提醒用户代签或更新常用签名。',
          '- **记忆与热更新阅读规范**：系统前缀中已固化会话开局基线记忆；后续轮次若出现 `<chronicle_board_update>`（跨端/后台实时新增信息板帖）或 `<recalled_memory>`（当轮潜意识召回线索），请自然融汇吸收并以最新热更新为准，勿在回复中机械复述 XML 标签。'
        ].join('\n')
      );
    } else if (section === 'index' && vault.indexMd?.trim()) {
      parts.push(vault.indexMd.trim());
    }
  }

  return {
    system: parts.join('\n\n---\n\n'),
    signatureStatus: sigEval
  };
}

/**
 * Explicitly start a session: build and freeze the immutable L0+L1 `system`
 * prompt (including the opening `wiki/index.md` Chronicle Board baseline) and
 * persist the initial read cursor for delta hot-updates.
 *
 * Ideal for `SessionStart` hooks (e.g., Antigravity) or explicit session init.
 *
 * @param {string | { vaultPath: string } | null} vaultOrId
 * @param {{
 *   sessionId: string,
 *   model?: string | null,
 *   kitRoot?: string,
 *   stateDir?: string | null,
 *   assemblyOverrides?: Record<string, any>,
 *   forceReset?: boolean
 * }} options
 */
export async function beginSession(vaultOrId, options) {
  const sessionId = String(options?.sessionId || '').trim();
  if (!sessionId) {
    throw new Error('beginSession requires a non-empty sessionId');
  }

  const kitRoot = options?.kitRoot || DEFAULT_KIT_ROOT;
  const stateDir = options?.stateDir || null;
  const vault =
    vaultOrId && typeof vaultOrId === 'object' && vaultOrId.vaultPath && vaultOrId.manifest
      ? vaultOrId
      : await loadVault(vaultOrId, { kitRoot });

  const config = resolveContextAssemblyConfig(vault.manifest, options?.assemblyOverrides);
  const existing = options?.forceReset
    ? null
    : await readSessionBaseline(vault.vaultPath, sessionId, stateDir);

  if (existing) {
    const sigEval = evaluateRuntimeSignature(vault.manifest, options?.model ?? null);
    return {
      session_id: sessionId,
      cartridge_id: vault.manifest?.character?.id || null,
      vault_path: vault.vaultPath,
      system: existing.frozen_system,
      signature_status: sigEval,
      signature_notice_xml: formatSignatureNoticeXml(sigEval),
      baseline: existing.baseline,
      created: false
    };
  }

  const { system, signatureStatus } = composeStableSystemPrompt(
    vault,
    config,
    options?.model ?? null
  );
  const snapshot = captureVaultState(vault);
  const nowIso = new Date().toISOString();
  const record = {
    schema: SESSION_STATE_SCHEMA,
    session_id: sessionId,
    cartridge_id: vault.manifest?.character?.id || null,
    created_at: nowIso,
    updated_at: nowIso,
    frozen_system: system,
    baseline: snapshot,
    delivered: {
      ...snapshot,
      timeline_lines: [...snapshot.timeline_lines],
      evergreen_lines: [...snapshot.evergreen_lines]
    }
  };
  await writeSessionBaseline(vault.vaultPath, sessionId, record, stateDir);

  return {
    session_id: sessionId,
    cartridge_id: vault.manifest?.character?.id || null,
    vault_path: vault.vaultPath,
    system,
    signature_status: signatureStatus,
    signature_notice_xml: formatSignatureNoticeXml(signatureStatus),
    baseline: snapshot,
    created: true
  };
}

/**
 * Cartridge-owned unified context assembler with Session Baseline Freeze +
 * Chronicle Board Delta Hot-Update.
 *
 * @param {string | { vaultPath: string } | null} vaultOrId
 * @param {{
 *   userText: string,
 *   history?: Array<{ role: string, content: any }> | null,
 *   sessionId?: string | null,
 *   model?: string | null,
 *   deliveryMode?: 'ephemeral' | 'persistent',
 *   preset?: string,
 *   topK?: number,
 *   kitRoot?: string,
 *   stateDir?: string | null,
 *   assemblyOverrides?: Record<string, any>,
 *   providersConfig?: Record<string, any>,
 *   decisionClient?: any,
 *   embeddingClient?: any,
 *   reader?: any
 * }} input
 */
export async function assembleTurn(vaultOrId, input) {
  const kitRoot = input?.kitRoot || DEFAULT_KIT_ROOT;
  const stateDir = input?.stateDir || null;
  const vault =
    vaultOrId && typeof vaultOrId === 'object' && vaultOrId.vaultPath && vaultOrId.manifest
      ? vaultOrId
      : await loadVault(vaultOrId, { kitRoot });

  const config = resolveContextAssemblyConfig(vault.manifest, input?.assemblyOverrides);
  const deliveryMode =
    input?.deliveryMode === 'persistent' || input?.deliveryMode === 'ephemeral'
      ? input.deliveryMode
      : config.delivery_mode;

  const rawUserText = extractTextContent(input?.userText ?? '');
  const cleanUserText = config.strip_injected_tags_from_history
    ? stripInjectedBlocks(rawUserText).text
    : rawUserText.trim();

  if (!cleanUserText) {
    throw new Error('assembleTurn requires a non-empty userText');
  }

  const sessionId = input?.sessionId ? String(input.sessionId).trim() : null;
  const reportedModel = input?.model ?? null;
  const recallTopK = Number(input?.topK ?? vault.manifest?.budgets?.recall_top_k ?? 5);

  // 1. Scan raw history for recently injected <recalled_memory> items BEFORE stripping,
  //    then normalize & sanitize frontend-supplied history (NEVER compresses >= 10 turns).
  const rawHistory = Array.isArray(input?.history) ? input.history : [];
  const recentRecalledKeys = extractRecentRecalledKeys(
    rawHistory,
    config.recall_dedup_window_turns,
    cleanUserText
  );
  const cleanHistoryMsgs = [];
  let strippedMessages = 0;

  for (const msg of rawHistory) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    if (config.strip_injected_tags_from_history) {
      const { text, changed } = stripInjectedBlocks(msg.content);
      if (changed) strippedMessages += 1;
      if (!text) continue;
      cleanHistoryMsgs.push({ role: msg.role, content: text });
    } else {
      const text = extractTextContent(msg.content).trim();
      if (!text) continue;
      cleanHistoryMsgs.push({ role: msg.role, content: text });
    }
  }

  if (
    cleanHistoryMsgs.length > 0 &&
    cleanHistoryMsgs[cleanHistoryMsgs.length - 1].role === 'user' &&
    normalizeFingerprintText(cleanHistoryMsgs[cleanHistoryMsgs.length - 1].content) ===
      normalizeFingerprintText(cleanUserText)
  ) {
    cleanHistoryMsgs.pop();
  }

  const frontendTurns = groupMessagesIntoTurns(cleanHistoryMsgs);
  let backfilledTurns = [];
  let effectiveTurns = frontendTurns;
  let historyAction = 'passthrough';

  if (config.backfill_from_ledger && frontendTurns.length < config.history_backfill_turns) {
    const deficit = config.history_backfill_turns - frontendTurns.length;
    backfilledTurns = await readRecentLedgerTurns(vault.vaultPath, {
      sessionId,
      limitTurns: deficit,
      maxMsgChars: config.backfill_max_msg_chars,
      excludeTurns: frontendTurns
    });
    effectiveTurns = [...backfilledTurns, ...frontendTurns];
    historyAction = backfilledTurns.length > 0 ? 'backfilled' : 'frontend_only';
  }

  const effectiveHistoryMessages = flattenTurnsToMessages(effectiveTurns);

  // 2. Session Baseline Freeze + Chronicle Board Delta Hot-Update
  const currentState = captureVaultState(vault);
  const signatureStatus = evaluateRuntimeSignature(vault.manifest, reportedModel);

  let system = '';
  let baselineInitialized = false;
  let boardUpdate = {
    has_update: false,
    xml: '',
    timeline_added: 0,
    evergreen_added: 0,
    soul_changed: false,
    profile_changed: false
  };

  if (sessionId) {
    const existing = await readSessionBaseline(vault.vaultPath, sessionId, stateDir);
    if (!existing) {
      // First turn of this session: freeze full L0+L1 system prompt & baseline.
      const built = composeStableSystemPrompt(vault, config, reportedModel);
      system = built.system;
      baselineInitialized = true;
      const nowIso = new Date().toISOString();
      await writeSessionBaseline(
        vault.vaultPath,
        sessionId,
        {
          schema: SESSION_STATE_SCHEMA,
          session_id: sessionId,
          cartridge_id: vault.manifest?.character?.id || null,
          created_at: nowIso,
          updated_at: nowIso,
          frozen_system: system,
          baseline: currentState,
          delivered: {
            ...currentState,
            timeline_lines: [...currentState.timeline_lines],
            evergreen_lines: [...currentState.evergreen_lines]
          }
        },
        stateDir
      );
    } else {
      // Reuse frozen_system byte-for-byte so Prefix KV-Cache stays 100% locked!
      system = existing.frozen_system;
      const reference =
        deliveryMode === 'persistent'
          ? existing.delivered || existing.baseline
          : existing.baseline;
      const skipSelfSpans = effectiveTurns.length > 0 || deliveryMode === 'persistent';

      boardUpdate = computeChronicleBoardDelta({
        vault,
        current: currentState,
        reference,
        sessionId,
        dedupSelf: config.dedup_current_session_timeline,
        skipSelfSpans
      });

      // In persistent trajectory hosts (e.g., Antigravity), advance cursor once delivered.
      if (deliveryMode === 'persistent' && boardUpdate.has_update) {
        existing.delivered = {
          ...currentState,
          timeline_lines: [...currentState.timeline_lines],
          evergreen_lines: [...currentState.evergreen_lines]
        };
        existing.updated_at = new Date().toISOString();
        await writeSessionBaseline(vault.vaultPath, sessionId, existing, stateDir);
      }
    }
  } else {
    system = composeStableSystemPrompt(vault, config, reportedModel).system;
  }

  // 3. Execute L2 recall (RiverMemo snapshot with automatic spans fallback).
  const reader = input?.reader || (await getCachedSnapshotReader(vault.vaultPath));
  const recall = await recallForUserTurn(vault, cleanUserText, {
    kitRoot,
    reportedModel,
    preset: input?.preset,
    topK: recallTopK,
    providersConfig: input?.providersConfig,
    decisionClient: input?.decisionClient,
    embeddingClient: input?.embeddingClient,
    reader
  });

  let recallMode = recall.skipped ? 'skipped' : 'rivermemo';
  let recalledXml = recall.xmlBlock || '';
  let recalledItems = recall.items || [];
  let recallDedupedCount = 0;

  if (recallMode === 'rivermemo' && recalledItems.length > 0) {
    const seenThisTurn = new Set();
    const freshItems = [];
    for (const item of recalledItems) {
      const id = String(item?.id || '').trim();
      if (id && seenThisTurn.has(id)) {
        recallDedupedCount += 1;
        continue;
      }
      if (isRecalledItemInHistory(item, recentRecalledKeys)) {
        recallDedupedCount += 1;
        continue;
      }
      if (id) seenThisTurn.add(id);
      freshItems.push(item);
    }

    if (recallDedupedCount > 0) {
      recalledItems = freshItems;
      recalledXml =
        freshItems.length > 0
          ? formatRecalledMemoryXml({
              snapshotManifest: vault.snapshotManifest,
              preset: recall.preset || 'balanced',
              items: freshItems
            })
          : '';
      if (freshItems.length === 0) {
        recallMode = 'deduped_empty';
      }
    }
  }

  if (
    !recalledXml &&
    recallMode !== 'deduped_empty' &&
    config.fallback_to_spans &&
    recall.reason !== 'decision_gate_skip'
  ) {
    const rawSpans = await searchLedgerSpans(vault.vaultPath, {
      query: cleanUserText,
      limit: recallTopK + 5
    });
    const nonSelfSpans =
      (frontendTurns.length > 0 || deliveryMode === 'persistent') && sessionId
        ? rawSpans.filter((sp) => sp.session_id !== sessionId)
        : rawSpans;
    const filteredSpans = [];
    for (const sp of nonSelfSpans) {
      if (recentRecalledKeys.has(`span:${sp.span_id}`)) {
        recallDedupedCount += 1;
        continue;
      }
      filteredSpans.push(sp);
      if (filteredSpans.length >= recallTopK) break;
    }
    if (filteredSpans.length > 0) {
      recallMode = 'spans_fallback';
      recalledItems = filteredSpans;
      recalledXml = formatSpansFallbackXml(filteredSpans);
    } else if (recallDedupedCount > 0) {
      recallMode = 'deduped_empty';
    }
  }

  // Optional legacy full-timeline block if a custom cartridge explicitly asks for `living_chronicle`.
  let fullLiveTimelineXml = '';
  if (config.user_injection_order.includes('living_chronicle')) {
    fullLiveTimelineXml = recall.liveTimelineXml ?? (await readLiveTimelineXml(vault.vaultPath));
    if (
      fullLiveTimelineXml &&
      config.dedup_current_session_timeline &&
      (effectiveTurns.length > 0 || deliveryMode === 'persistent') &&
      sessionId
    ) {
      fullLiveTimelineXml = filterCurrentSessionFromTimeline(fullLiveTimelineXml, sessionId);
    }
  }

  // 4. Assemble active-turn prefix in cartridge-defined order.
  const blockMap = {
    chronicle_board_update: boardUpdate.xml,
    hot_update: boardUpdate.xml,
    living_chronicle: fullLiveTimelineXml,
    recalled_memory: recalledXml,
    signature_notice: recall.signatureNoticeXml || ''
  };
  const dynamicBlocks = [];
  const emittedValues = new Set();
  for (const key of config.user_injection_order) {
    const val = blockMap[key];
    const trimmed = val ? String(val).trim() : '';
    if (trimmed && !emittedValues.has(trimmed)) {
      emittedValues.add(trimmed);
      dynamicBlocks.push(trimmed);
    }
  }

  const userPrefix = dynamicBlocks.join('\n\n');
  const augmentedUser = userPrefix
    ? `${userPrefix}${config.user_separator}${cleanUserText}`
    : cleanUserText;

  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...effectiveHistoryMessages,
    { role: 'user', content: augmentedUser }
  ];

  return {
    system,
    user_prefix: userPrefix,
    augmented_user: augmentedUser,
    messages,
    meta: {
      cartridge_id: vault.manifest?.character?.id || null,
      display_name: vault.manifest?.character?.display_name || null,
      vault_path: vault.vaultPath,
      session_id: sessionId,
      delivery_mode: deliveryMode,
      history: {
        frontend_turns: frontendTurns.length,
        backfilled_turns: backfilledTurns.length,
        effective_turns: effectiveTurns.length,
        backfill_cap: config.history_backfill_turns,
        action: historyAction,
        stripped_messages: strippedMessages
      },
      board_update: {
        has_update: boardUpdate.has_update,
        baseline_initialized: baselineInitialized,
        delivery_mode: deliveryMode,
        timeline_added: boardUpdate.timeline_added,
        evergreen_added: boardUpdate.evergreen_added,
        soul_changed: boardUpdate.soul_changed,
        profile_changed: boardUpdate.profile_changed
      },
      recall: {
        mode: recallMode,
        degraded: Boolean(recall.degraded),
        reason: recall.reason || null,
        preset: recall.preset || null,
        count: recalledItems.length,
        deduped_count: recallDedupedCount,
        dedup_window_turns: config.recall_dedup_window_turns,
        items: recalledItems.map((it) => ({
          id: it.id || it.span_id || null,
          title: it.title || it.gist || null,
          score: it.score ?? it.salience ?? null
        }))
      },
      timeline_injected: Boolean(boardUpdate.has_update || fullLiveTimelineXml),
      signature_status: signatureStatus
    }
  };
}

async function getNextStepIndex(vaultPath, harness, sessionId) {
  const safeHarness = sanitizeSegment(harness || 'cassette-client') || 'cassette-client';
  const safeSession = sanitizeSegment(sessionId || 'default') || 'default';
  const filePath = path.join(vaultPath, 'ledger', 'sessions', safeHarness, `${safeSession}.jsonl`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    let maxStep = -1;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (Number.isFinite(Number(ev.step_index))) {
          maxStep = Math.max(maxStep, Number(ev.step_index));
        }
      } catch {
        // Skip malformed line.
      }
    }
    return maxStep + 1;
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * Commit a completed clean user/assistant turn into the cartridge's immutable
 * ledger, hot-refresh `wiki/index.md` (Chronicle Board), and optionally trigger
 * background dreaming when `dream_due` is reached.
 *
 * @param {string | { vaultPath: string } | null} vaultOrId
 * @param {{
 *   sessionId?: string | null,
 *   userText: string,
 *   assistantText?: string | null,
 *   model?: string | null,
 *   harness?: string | null,
 *   stepIndex?: number | null,
 *   refreshTimeline?: boolean,
 *   autoDream?: boolean,
 *   kitRoot?: string
 * }} input
 */
export async function commitTurn(vaultOrId, input) {
  const kitRoot = input?.kitRoot || DEFAULT_KIT_ROOT;
  const vault =
    vaultOrId && typeof vaultOrId === 'object' && vaultOrId.vaultPath && vaultOrId.manifest
      ? vaultOrId
      : await loadVault(vaultOrId, { kitRoot });

  const config = resolveContextAssemblyConfig(vault.manifest);
  const harness = String(input?.harness || 'cassette-client').trim() || 'cassette-client';
  const sessionId = String(input?.sessionId || `sess-${crypto.randomUUID().slice(0, 8)}`).trim();
  const cleanUser = stripInjectedBlocks(input?.userText ?? '').text;
  const cleanAssistant = stripInjectedBlocks(input?.assistantText ?? '').text;

  if (!cleanUser && !cleanAssistant) {
    throw new Error('commitTurn requires non-empty userText or assistantText');
  }

  const reportedModel = input?.model ? String(input.model).trim() : null;
  const modelSignature = {
    provider: reportedModel ? 'openai-compat' : harness,
    model_id: reportedModel || null,
    raw_reported: reportedModel || 'auto'
  };
  const signSource = reportedModel ? 'runtime_verified' : 'unsigned';
  const refreshTimeline = input?.refreshTimeline !== false;

  let nextStep = Number.isFinite(Number(input?.stepIndex))
    ? Number(input.stepIndex)
    : await getNextStepIndex(vault.vaultPath, harness, sessionId);

  let totalAdded = 0;
  let lastActivity = null;
  const nowIso = new Date().toISOString();

  if (cleanUser) {
    const resUser = await appendLedgerEvent(
      vault,
      {
        event_id: `${harness}:${sessionId}:${nextStep}:user:${crypto.randomUUID().slice(0, 8)}`,
        ts: nowIso,
        source_harness: harness,
        session_id: sessionId,
        step_index: nextStep,
        role: 'user',
        content: cleanUser,
        model_signature: modelSignature,
        sign_source: signSource
      },
      { kitRoot, refreshTimeline: refreshTimeline && !cleanAssistant }
    );
    totalAdded += resUser.added;
    lastActivity = resUser.activity;
    nextStep += 1;
  }

  if (cleanAssistant) {
    const resAsst = await appendLedgerEvent(
      vault,
      {
        event_id: `${harness}:${sessionId}:${nextStep}:assistant:${crypto.randomUUID().slice(0, 8)}`,
        ts: new Date().toISOString(),
        source_harness: harness,
        session_id: sessionId,
        step_index: nextStep,
        role: 'assistant',
        content: cleanAssistant,
        model_signature: modelSignature,
        sign_source: signSource
      },
      { kitRoot, refreshTimeline }
    );
    totalAdded += resAsst.added;
    lastActivity = resAsst.activity;
  }

  const shouldAutoDream = input?.autoDream === true || config.auto_dream_on_commit === true;
  let dreamTriggered = false;
  let dreamStatus = null;

  if (shouldAutoDream && lastActivity?.dream_due && !activeDreamRuns.has(vault.vaultPath)) {
    dreamTriggered = true;
    dreamStatus = 'scheduled_async';
    const task = import('./dream-runner.mjs')
      .then(({ runDream }) => runDream(vault.vaultPath, { kitRoot }))
      .catch(() => undefined)
      .finally(() => {
        activeDreamRuns.delete(vault.vaultPath);
      });
    activeDreamRuns.set(vault.vaultPath, task);
  }

  return {
    ok: true,
    cartridge_id: vault.manifest?.character?.id || null,
    vault_path: vault.vaultPath,
    harness,
    session_id: sessionId,
    added: totalAdded,
    activity: lastActivity,
    dream_due: Boolean(lastActivity?.dream_due),
    dream_triggered: dreamTriggered,
    dream_status: dreamStatus
  };
}
