/**
 * @fileoverview Builds the unified two-part Living Chronicle `wiki/index.md`
 * strictly adhering to `budgets.index_max_lines` (default <= 150 lines).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadManifest } from './manifest.mjs';
import { parseFrontmatter } from './yaml-lite.mjs';

const HALF_LIFE_DAYS = 14;
const PILLAR_FOLDERS = ['projects', 'domains', 'decisions', 'syntheses', 'episodes'];
const IMPORTANCE_RANK = { core: 4, high: 3, normal: 2, low: 1 };

function formatLocalDateTime(tsStr) {
  const ms = Date.parse(tsStr || '');
  if (!Number.isFinite(ms)) return 'unknown-date';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadSpanCandidates(vaultPath, nowMs) {
  const spansRoot = path.join(vaultPath, 'ledger', 'spans');
  const candidates = [];

  let harnesses = [];
  try {
    harnesses = (await fs.readdir(spansRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (err?.code === 'ENOENT') return candidates;
    throw err;
  }

  for (const harness of harnesses) {
    const hDir = path.join(spansRoot, harness);
    const files = (await fs.readdir(hDir)).filter((f) => f.endsWith('.spans.json'));
    for (const file of files) {
      const doc = JSON.parse(await fs.readFile(path.join(hDir, file), 'utf8'));
      for (const span of doc.spans || []) {
        const tsRaw = span.ts_end || span.ts_start || '';
        const tsMs = Date.parse(tsRaw) || nowMs;
        const ageDays = Math.max(0, (nowMs - tsMs) / (1000 * 60 * 60 * 24));
        const salience = Number(span.salience ?? 0);
        const recencyBoost = ageDays <= 1 ? 0.12 : 0;
        const effectiveScore = Math.min(
          1.05,
          salience * Math.exp((-Math.LN2 * ageDays) / HALF_LIFE_DAYS) + recencyBoost
        );
        candidates.push({
          ...span,
          tsMs,
          ageDays,
          dateStr: formatLocalDateTime(tsRaw),
          effective_score: Number(effectiveScore.toFixed(4))
        });
      }
    }
  }

  candidates.sort((a, b) => b.effective_score - a.effective_score);
  return candidates;
}

function selectLivingTimelineItems(candidates, maxItems, salienceFloor) {
  const selected = [];
  const seenSpanIds = new Set();
  const sessionCounts = new Map();

  // Always reserve up to 4 freshest items so today's lively chats appear live
  // (up to 2 per active session within 24h, 1 per older session).
  const recentQuota = Math.min(4, Math.max(2, Math.floor(maxItems / 3)));
  const byRecency = [...candidates].sort((a, b) => (b.tsMs || 0) - (a.tsMs || 0));
  for (const item of byRecency) {
    if (selected.length >= recentQuota) break;
    const clean = String(item.gist || '').trim();
    if (clean.length < 4) continue;
    const prevCount = sessionCounts.get(item.session_id) || 0;
    const maxForSession = (item.ageDays ?? 99) <= 1 && (item.salience ?? 0) >= 0.45 ? 2 : 1;
    if (prevCount >= maxForSession) continue;
    sessionCounts.set(item.session_id, prevCount + 1);
    seenSpanIds.add(item.span_id);
    selected.push(item);
  }

  const recentFloor = Math.min(salienceFloor, 0.45);
  const aboveFloor = candidates.filter(
    (c) => c.salience >= salienceFloor || ((c.ageDays ?? 99) <= 1 && c.salience >= recentFloor)
  );
  const pool = aboveFloor.length > 0 ? aboveFloor : candidates;

  // Fill remaining slots by top salience x time_decay per session first, then backfill.
  const deferred = [];
  for (const item of pool) {
    if (selected.length >= maxItems) break;
    if (seenSpanIds.has(item.span_id)) continue;
    if ((sessionCounts.get(item.session_id) || 0) === 0) {
      sessionCounts.set(item.session_id, 1);
      seenSpanIds.add(item.span_id);
      selected.push(item);
    } else {
      deferred.push(item);
    }
  }
  for (const item of deferred) {
    if (selected.length >= maxItems) break;
    if (seenSpanIds.has(item.span_id)) continue;
    seenSpanIds.add(item.span_id);
    selected.push(item);
  }
  return selected;
}

async function loadEvergreenPages(vaultPath) {
  const pages = [];
  for (const folder of PILLAR_FOLDERS) {
    const dir = path.join(vaultPath, 'wiki', folder);
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const fullPath = path.join(dir, entry.name);
      const fm = parseFrontmatter(await fs.readFile(fullPath, 'utf8'));
      const data = fm.data || {};
      if (data.status === 'archived') continue;
      pages.push({
        folder,
        relLink: `./${folder}/${entry.name}`,
        title: String(data.title || entry.name),
        importance: String(data.importance || 'normal'),
        importanceRank: IMPORTANCE_RANK[data.importance] || 2,
        anchors: Array.isArray(data.anchors) ? data.anchors : [],
        updatedAt: String(data.updated_at || '')
      });
    }
  }

  pages.sort((a, b) => b.importanceRank - a.importanceRank || b.updatedAt.localeCompare(a.updatedAt));
  return pages;
}

async function loadDreamDigests(vaultPath) {
  const statePath = path.join(vaultPath, 'dream_queue', '.state.json');
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (!Array.isArray(parsed?.dream_digests)) return [];
    return parsed.dream_digests
      .filter((d) => d && typeof d.text === 'string' && d.text.trim())
      .slice(-3)
      .reverse()
      .map((d) => ({
        dateStr: formatLocalDateTime(d.ts),
        text: String(d.text).replace(/\s+/g, ' ').trim()
      }));
  } catch {
    return [];
  }
}

function renderIndexLines({ charName, dreamDigests = [], timelineItems, evergreenPages }) {
  const lines = [
    `# ${charName} 记忆总索引（Living Chronicle）`,
    '',
    '> 每次新会话随 L1 注入：先看上段接续近期工作脉络，再按需查下段常青专题或通过 `span:<id>` 切片核对账本原文。',
    '',
    '## 近期脉络（Living Timeline）',
    ''
  ];

  for (const digest of dreamDigests) {
    lines.push(`- [${digest.dateStr}] (dream_digest) ${digest.text}`);
  }

  if (timelineItems.length === 0 && dreamDigests.length === 0) {
    lines.push('- （尚无已索引的会话语义段落，运行 `pmv ingest-antigravity` 与 `pmv build-spans` 后生成）');
  } else {
    for (const item of timelineItems) {
      const cleanGist = String(item.gist || '').replace(/\s+/g, ' ').trim();
      lines.push(
        `- [${item.dateStr}] (${item.kind}, s=${item.salience}) ${cleanGist} — \`span:${item.span_id}\``
      );
    }
  }

  lines.push('', '## 常青支柱（Evergreen Pillars）', '');
  if (evergreenPages.length === 0) {
    lines.push('- （尚无活跃 Wiki 页面）');
  } else {
    for (const p of evergreenPages) {
      const anchorStr = p.anchors.length > 0 ? ` — 锚点: ${p.anchors.join(', ')}` : '';
      const dateStr = p.updatedAt ? ` [${p.updatedAt}]` : '';
      lines.push(`- \`[${p.importance}]\`${dateStr} [${p.title}](${p.relLink})${anchorStr}`);
    }
  }

  return lines;
}

/**
 * Compile `wiki/index.md` with strict enforcement of `budgets.index_max_lines`.
 *
 * @param {string} vaultPath
 * @param {{ nowMs?: number }} [options]
 */
export async function buildIndex(vaultPath, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const manifest = await loadManifest(vaultPath);
  const budgets = manifest.budgets || {};
  const maxLines = Math.max(20, Number(budgets.index_max_lines ?? 150));
  const maxTimeline = Math.max(1, Number(budgets.timeline_section_max_items ?? 12));
  const salienceFloor = Number(budgets.timeline_salience_floor ?? 0.55);

  const dreamDigests = await loadDreamDigests(vaultPath);
  const spanCandidates = await loadSpanCandidates(vaultPath, nowMs);
  const timelineItems = selectLivingTimelineItems(spanCandidates, maxTimeline, salienceFloor);
  const evergreenPages = await loadEvergreenPages(vaultPath);

  const charName = manifest.character?.display_name || manifest.character?.name || 'Persona';

  let activeDigests = [...dreamDigests];
  let activeTimeline = [...timelineItems];
  let activeEvergreen = [...evergreenPages];
  let lines = renderIndexLines({
    charName,
    dreamDigests: activeDigests,
    timelineItems: activeTimeline,
    evergreenPages: activeEvergreen
  });

  // Enforce hard line budget strictly by trimming lowest-priority items first.
  while (
    lines.length > maxLines &&
    (activeTimeline.length > 0 || activeEvergreen.length > 0 || activeDigests.length > 1)
  ) {
    if (activeTimeline.length > 4 && activeTimeline.length >= activeEvergreen.length) {
      activeTimeline.pop();
    } else if (activeEvergreen.length > 0) {
      activeEvergreen.pop();
    } else if (activeTimeline.length > 0) {
      activeTimeline.pop();
    } else {
      activeDigests.pop();
    }
    lines = renderIndexLines({
      charName,
      dreamDigests: activeDigests,
      timelineItems: activeTimeline,
      evergreenPages: activeEvergreen
    });
  }

  const finalLines = lines.slice(0, maxLines);
  const outPath = path.join(vaultPath, 'wiki', 'index.md');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${finalLines.join('\n')}\n`, 'utf8');

  return {
    outPath,
    lineCount: finalLines.length,
    maxLines,
    digestCount: activeDigests.length,
    timelineCount: activeTimeline.length,
    evergreenCount: activeEvergreen.length
  };
}
