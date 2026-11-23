/**
 * @fileoverview Standard 6-method Read-Only & Append Runtime API (SPEC v1.1 Ch 7.2)
 * shared across Antigravity, DeepSeek Harness, VCPToolBox, and the MCP server.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCartridgePath } from './cartridges.mjs';
import {
  createDecisionClient,
  loadProvidersConfig,
  resolveDecisionProvider
} from './decision-provider.mjs';
import {
  createEmbeddingClient,
  resolveEmbeddingProvider
} from './embedding-provider.mjs';
import { buildIndex } from './index-builder.mjs';
import { appendLedgerEvent as rawAppendLedgerEvent } from './ledger.mjs';
import {
  evaluateRuntimeSignature,
  formatSignatureNoticeXml,
  loadManifest
} from './manifest.mjs';
import {
  formatRecalledMemoryXml,
  openSnapshotReader,
  readSnapshotManifest
} from './rivermemo-snapshot.mjs';
import {
  buildAllSpans,
  readLedgerSpan as rawReadLedgerSpan,
  searchLedgerSpans as rawSearchLedgerSpans
} from './spans.mjs';
import { parseFrontmatter } from './yaml-lite.mjs';
import { RIVER_PRESETS } from '../native/vexus-bridge.mjs';

const DEFAULT_KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_SCHEMA = 'pmv-dream-state/v1';

async function readTextOptional(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
}

async function resolveVaultInput(vaultOrId, kitRoot = DEFAULT_KIT_ROOT) {
  if (vaultOrId && typeof vaultOrId === 'object' && vaultOrId.vaultPath) {
    return vaultOrId.vaultPath;
  }
  const { vaultPath } = await resolveCartridgePath(kitRoot, vaultOrId || null);
  return vaultPath;
}

/**
 * Load and validate a Persona Memory Vault handle (read-only metadata + texts).
 *
 * @param {string | null} [vaultPathOrId]
 * @param {{ kitRoot?: string }} [options]
 */
export async function loadVault(vaultPathOrId = null, options = {}) {
  const kitRoot = options.kitRoot || DEFAULT_KIT_ROOT;
  const { vaultPath } = await resolveCartridgePath(kitRoot, vaultPathOrId);
  const manifest = await loadManifest(vaultPath);
  const [soul, userProfile, indexMd, snapshotManifest] = await Promise.all([
    readTextOptional(path.join(vaultPath, 'SOUL.md')),
    readTextOptional(path.join(vaultPath, 'USER_PROFILE.md')),
    readTextOptional(path.join(vaultPath, 'wiki', 'index.md')),
    readSnapshotManifest(vaultPath)
  ]);

  return Object.freeze({
    vaultPath,
    manifest,
    soul,
    userProfile,
    indexMd,
    snapshotManifest
  });
}

/**
 * Compose immutable L0 + L1 System Prompt prefix for session initialization
 * (KV-Cache safe; never varies per user turn).
 *
 * @param {Awaited<ReturnType<typeof loadVault>>} vault
 * @param {{ reportedModel?: string | null }} [runtimeMeta]
 */
export function composeSystemPrefix(vault, runtimeMeta = {}) {
  const sigEval = evaluateRuntimeSignature(vault.manifest, runtimeMeta.reportedModel);
  const models = vault.manifest.preferred_models || {};
  const sigSummary = Object.entries(models)
    .map(([slot, cfg]) => `${slot}=${cfg?.model_id || 'unsigned'}(${cfg?.sign_source || 'unsigned'})`)
    .join(', ');

  const l0Parts = [
    vault.soul.trim(),
    vault.userProfile.trim(),
    '## 运行时记忆与签名契约（L0 纪律）',
    `- **角色常用模型签名**：${sigSummary}`,
    '- **诚实签名**：严禁靠训练记忆猜测自身真实模型型号；出现 `<signature_notice>` 时请在合适时机顺口提醒用户代签或更新常用签名。',
    '- **双轨查证**：对话时随 User 注入的 `<recalled_memory>` 仅作潜意识参考线索；核实精确原文或项目细节请主动调用 `pmv_read_wiki` 或先 `pmv_search_spans` 再 `pmv_read_span` 切片读取，切勿整份读入原始长日志。'
  ].filter(Boolean);

  const l0 = l0Parts.join('\n\n');
  const l1 = vault.indexMd.trim();
  const systemPrefix = l1 ? `${l0}\n\n---\n\n${l1}` : l0;

  return {
    l0,
    l1,
    systemPrefix,
    signatureStatus: sigEval,
    signatureNoticeXml: formatSignatureNoticeXml(sigEval)
  };
}

/**
 * Execute L2 per-user-turn RiverMemo recall with optional DecisionProvider gate
 * and strict graceful degradation. Never mutates System Prompt.
 *
 * @param {Awaited<ReturnType<typeof loadVault>>} vault
 * @param {string} userText
 * @param {{
 *   kitRoot?: string,
 *   reportedModel?: string | null,
 *   preset?: string,
 *   topK?: number,
 *   providersConfig?: Record<string, any>,
 *   decisionClient?: any,
 *   embeddingClient?: any,
 *   reader?: any,
 *   includeTrace?: boolean
 * }} [options]
 */
export async function recallForUserTurn(vault, userText, options = {}) {
  const kitRoot = options.kitRoot || DEFAULT_KIT_ROOT;
  const signatureStatus = evaluateRuntimeSignature(vault.manifest, options.reportedModel);
  const signatureNoticeXml = formatSignatureNoticeXml(signatureStatus);
  const providers = options.providersConfig || (await loadProvidersConfig(kitRoot));

  const cleanQuery = String(userText || '').trim();
  if (!cleanQuery) {
    return {
      skipped: true,
      degraded: false,
      reason: 'empty_user_text',
      preset: null,
      items: [],
      trace: {},
      xmlBlock: '',
      signatureStatus,
      signatureNoticeXml
    };
  }

  let activePreset = options.preset;
  let decisionRes = null;

  const decisionClient = options.decisionClient
    || createDecisionClient(resolveDecisionProvider(vault.manifest, providers).config);

  if (decisionClient && decisionClient.isActive()) {
    decisionRes = await decisionClient.evaluate({
      state: cleanQuery.slice(0, 3000),
      questions: {
        needs_recall: {
          type: 'noul',
          instructions: 'Does this user turn benefit from recalling long-term character memories?'
        },
        recall_preset: {
          type: 'choice',
          instructions: 'Select optimal recall preset for this user query.',
          criteria: {
            balanced: 'General balanced recall',
            precision_research: 'Exact facts, specs, citations, literary/code verification',
            associative_explore: 'Brainstorming, cross-domain analogy, open reflection'
          }
        }
      }
    });

    if (!decisionRes.degraded) {
      const needsRecall = Number(decisionRes.answers?.needs_recall?.noul);
      if (Number.isFinite(needsRecall) && needsRecall < 0.35) {
        return {
          skipped: true,
          degraded: false,
          reason: 'decision_gate_skip',
          preset: null,
          items: [],
          trace: { decision: decisionRes },
          xmlBlock: '',
          signatureStatus,
          signatureNoticeXml
        };
      }
      const chosen = decisionRes.answers?.recall_preset?.choice;
      if (!activePreset && typeof chosen === 'string' && RIVER_PRESETS[chosen]) {
        activePreset = chosen;
      }
    }
  }

  const liveTimelineXml = await readLiveTimelineXml(vault.vaultPath);

  const snapshotManifest = vault.snapshotManifest || (await readSnapshotManifest(vault.vaultPath));
  if (!snapshotManifest) {
    return {
      skipped: true,
      degraded: true,
      reason: 'no_snapshot_baked',
      preset: activePreset || null,
      items: [],
      trace: { decision: decisionRes },
      xmlBlock: '',
      liveTimelineXml,
      signatureStatus,
      signatureNoticeXml
    };
  }

  let embeddingClient = options.embeddingClient || null;
  if (!embeddingClient) {
    const embStatus = resolveEmbeddingProvider(vault.manifest, snapshotManifest, providers);
    if (embStatus.state !== 'matched' || !embStatus.providerConfig) {
      return {
        skipped: true,
        degraded: true,
        reason: `embedding_${embStatus.state}`,
        preset: activePreset || null,
        items: [],
        trace: { decision: decisionRes, embedding_status: embStatus.state },
        xmlBlock: '',
        liveTimelineXml,
        signatureStatus,
        signatureNoticeXml
      };
    }
    embeddingClient = createEmbeddingClient(embStatus.providerConfig);
  } else if (
    embeddingClient.model_sig &&
    snapshotManifest.embedding?.model_sig &&
    embeddingClient.model_sig !== snapshotManifest.embedding.model_sig
  ) {
    return {
      skipped: true,
      degraded: true,
      reason: 'embedding_mismatch',
      preset: activePreset || null,
      items: [],
      trace: { decision: decisionRes },
      xmlBlock: '',
      liveTimelineXml,
      signatureStatus,
      signatureNoticeXml
    };
  }

  let queryVec;
  try {
    queryVec = await embeddingClient.embedOne(cleanQuery);
  } catch (err) {
    return {
      skipped: true,
      degraded: true,
      reason: `embedding_error:${err?.message || String(err)}`,
      preset: activePreset || null,
      items: [],
      trace: { decision: decisionRes, error: err?.message || String(err) },
      xmlBlock: '',
      liveTimelineXml,
      signatureStatus,
      signatureNoticeXml
    };
  }

  const ownedReader = !options.reader;
  let reader = null;
  try {
    reader = options.reader || (await openSnapshotReader(vault.vaultPath));
    const queryResult = await reader.query({
      text: cleanQuery,
      vector: queryVec,
      preset: activePreset,
      topK: options.topK,
      includeTrace: options.includeTrace !== false
    });
    const xmlBlock = formatRecalledMemoryXml(queryResult);
    return {
      skipped: false,
      degraded: false,
      preset: queryResult.preset,
      items: queryResult.items,
      trace: { ...queryResult.trace, decision: decisionRes },
      xmlBlock,
      liveTimelineXml,
      signatureStatus,
      signatureNoticeXml
    };
  } catch (err) {
    return {
      skipped: true,
      degraded: true,
      reason: `snapshot_query_error:${err?.message || String(err)}`,
      preset: activePreset || null,
      items: [],
      trace: { decision: decisionRes, error: err?.message || String(err) },
      xmlBlock: '',
      liveTimelineXml,
      signatureStatus,
      signatureNoticeXml
    };
  } finally {
    if (ownedReader && reader) {
      try {
        reader.close();
      } catch {
        // Ignore close error.
      }
    }
  }
}

/**
 * Search lightweight semantic span pointers without reading full session logs.
 */
export async function searchLedgerSpans(vaultOrId, queryOptions = {}, options = {}) {
  const vaultPath = await resolveVaultInput(vaultOrId, options.kitRoot);
  return rawSearchLedgerSpans(vaultPath, queryOptions);
}

/**
 * O(1) UTF-8 byte-range partial read of a semantic span from the immutable ledger.
 */
export async function readLedgerSpan(vaultOrId, spanId, readOptions = {}, options = {}) {
  const vaultPath = await resolveVaultInput(vaultOrId, options.kitRoot);
  return rawReadLedgerSpan(vaultPath, spanId, readOptions);
}

/**
 * Read a single OKF Markdown page strictly confined inside `<vaultPath>/wiki/`.
 *
 * @param {string | { vaultPath: string }} vaultOrId
 * @param {string} relPath
 * @param {{ kitRoot?: string }} [options]
 */
export async function readWikiPage(vaultOrId, relPath, options = {}) {
  const vaultPath = await resolveVaultInput(vaultOrId, options.kitRoot);
  const wikiRoot = path.resolve(vaultPath, 'wiki');
  const cleanRel = String(relPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  if (!cleanRel) throw new Error('readWikiPage requires a relative wiki path');

  const subPath = cleanRel.startsWith('wiki/') ? cleanRel.slice('wiki/'.length) : cleanRel;
  const absTarget = path.resolve(wikiRoot, subPath);
  const relativeCheck = path.relative(wikiRoot, absTarget);
  if (!relativeCheck || relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    const err = new Error(`Path escapes wiki directory: ${relPath}`);
    err.code = 'PATH_TRAVERSAL_FORBIDDEN';
    throw err;
  }

  const raw = await fs.readFile(absTarget, 'utf8');
  const fm = parseFrontmatter(raw);
  return {
    relPath: `wiki/${subPath.replace(/\\/g, '/')}`,
    frontmatter: fm.data,
    body: fm.body,
    raw
  };
}

/**
 * Read persisted dreaming/activity counter state (`dream_queue/.state.json`).
 *
 * @param {string} vaultPath
 */
export async function readActivityState(vaultPath) {
  const statePath = path.join(vaultPath, 'dream_queue', '.state.json');
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return {
      schema: STATE_SCHEMA,
      turns_since_dream: Number(parsed.turns_since_dream || 0),
      events_since_dream: Number(parsed.events_since_dream || 0),
      dream_threshold_turns: Number(parsed.dream_threshold_turns || 12),
      last_event_at: parsed.last_event_at || null,
      last_dream_at: parsed.last_dream_at || null,
      session_watermarks:
        parsed.session_watermarks && typeof parsed.session_watermarks === 'object'
          ? { ...parsed.session_watermarks }
          : {},
      dream_digests: Array.isArray(parsed.dream_digests) ? parsed.dream_digests : []
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        schema: STATE_SCHEMA,
        turns_since_dream: 0,
        events_since_dream: 0,
        dream_threshold_turns: 12,
        last_event_at: null,
        last_dream_at: null,
        session_watermarks: {},
        dream_digests: []
      };
    }
    throw err;
  }
}

export async function writeActivityState(vaultPath, state) {
  const statePath = path.join(vaultPath, 'dream_queue', '.state.json');
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

/**
 * Increment activity volume counters used for Cteno-style volume-triggered dreaming.
 *
 * @param {string} vaultPath
 * @param {{ eventsAdded?: number, turnsAdded?: number }} [delta]
 */
export async function recordActivityDelta(vaultPath, delta = {}) {
  const state = await readActivityState(vaultPath);
  const eventsAdded = Math.max(0, Number(delta.eventsAdded || 0));
  const turnsAdded = Math.max(0, Number(delta.turnsAdded || 0));
  if (eventsAdded > 0 || turnsAdded > 0) {
    state.events_since_dream += eventsAdded;
    state.turns_since_dream += turnsAdded;
    state.last_event_at = new Date().toISOString();
    await writeActivityState(vaultPath, state);
  }
  return {
    ...state,
    dream_due: state.turns_since_dream >= state.dream_threshold_turns
  };
}

const refreshLocks = new Map();

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

/**
 * Cartridge-native live timeline refresh: rebuilds span pointers and compiles
 * `wiki/index.md` serially per vault so any harness sees newly logged turns immediately.
 *
 * @param {string | { vaultPath: string }} vaultOrId
 * @param {{ kitRoot?: string }} [options]
 */
export async function refreshChronicle(vaultOrId, options = {}) {
  const vaultPath = await resolveVaultInput(vaultOrId, options.kitRoot);
  const prev = refreshLocks.get(vaultPath) || Promise.resolve();
  const task = prev
    .catch(() => undefined)
    .then(async () => {
      const spans = await buildAllSpans(vaultPath);
      const index = await buildIndex(vaultPath);
      return { spans, index };
    });
  refreshLocks.set(vaultPath, task);
  try {
    return await task;
  } finally {
    if (refreshLocks.get(vaultPath) === task) {
      refreshLocks.delete(vaultPath);
    }
  }
}

/**
 * Read the latest Living Timeline & Evergreen Chronicle directly from disk as
 * a compact XML block for real-time hot injection across any harness.
 *
 * @param {string | { vaultPath: string }} vaultOrId
 * @param {{ kitRoot?: string }} [options]
 */
export async function readLiveTimelineXml(vaultOrId, options = {}) {
  const vaultPath = await resolveVaultInput(vaultOrId, options.kitRoot);
  const indexPath = path.join(vaultPath, 'wiki', 'index.md');
  let raw = '';
  try {
    raw = (await fs.readFile(indexPath, 'utf8')).trim();
  } catch {
    return '';
  }
  if (!raw) return '';
  return `<living_chronicle now="${formatLocalIsoNow()}">\n${raw}\n</living_chronicle>`;
}

/**
 * Idempotently append a single ledger event, update activity counters, and
 * hot-refresh the cartridge's Living Chronicle unless opted out.
 *
 * @param {string | { vaultPath: string }} vaultOrId
 * @param {Record<string, any>} event
 * @param {{ kitRoot?: string, refreshTimeline?: boolean }} [options]
 */
export async function appendLedgerEvent(vaultOrId, event, options = {}) {
  const vaultPath = await resolveVaultInput(vaultOrId, options.kitRoot);
  const res = await rawAppendLedgerEvent(vaultPath, event);
  let activity = await readActivityState(vaultPath);
  if (res.added > 0) {
    activity = await recordActivityDelta(vaultPath, {
      eventsAdded: res.added,
      turnsAdded: event?.role === 'user' ? 1 : 0
    });
    if (options.refreshTimeline !== false) {
      await refreshChronicle(vaultPath).catch(() => undefined);
    }
  }
  return { ...res, activity };
}

export {
  assembleTurn,
  beginSession,
  clearSessionBaseline,
  closeAllCachedReaders,
  commitTurn,
  extractRecentRecalledKeys,
  flattenTurnsToMessages,
  getCachedSnapshotReader,
  groupMessagesIntoTurns,
  parseIndexSections,
  readRecentLedgerTurns,
  stripInjectedBlocks
} from './context-assembler.mjs';
