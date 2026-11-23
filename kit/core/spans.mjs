/**
 * @fileoverview UTF-8 byte-accurate semantic span indexing and O(1) partial-read
 * slicing over immutable session ledgers (`ledger/spans/`).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const SPANS_SCHEMA = 'pmv-ledger-spans/v1';

/**
 * Derive a short, collision-resistant session identifier for `span_id`.
 * Strips verbose `session-` prefixes (such as DSH `session-<uuid>`) so
 * distinct sessions do not all collapse to `"session-"`.
 *
 * @param {string} sessionId
 */
export function computeShortSessionId(sessionId) {
  const raw = String(sessionId || '').trim();
  const stripped = raw.replace(/^session[-_]+/i, '');
  const base = stripped.length >= 4 ? stripped : raw;
  return base.slice(0, 8);
}

const TRIVIAL_FILLER_RE = /^(?:好的|嗯+|哦+|收到|谢谢|感谢|明白|了解|ok|okay|yes|no|continue|继续|开始吧)[。.!！?？]*$/i;

const KIND_KEYWORDS = [
  {
    kind: 'decision',
    words: ['决定', '敲定', '拍板', '定调', '选择', '采用', '砍掉', '放弃', '架构', '方案', 'phase', 'spec', '决定使用', '不采用']
  },
  {
    kind: 'preference',
    words: ['我喜欢', '我希望', '我不喜欢', '偏好', '习惯', '不要', '以后都', '以后请', '阿尔吉侬', '我的名字']
  },
  {
    kind: 'literary_note',
    words: ['文学', '考据', '版本', '校勘', '典故', '红楼', '唐诗', '宋词', '原著', '文本细读', '文献', '译本']
  },
  {
    kind: 'code_spec',
    words: ['接口', 'schema', 'api', 'hook', 'cli', 'test', 'typescript', 'javascript', 'vue', 'react', 'css', 'json', 'yaml', 'utf-8', 'sqlite', 'napi']
  },
  {
    kind: 'insight',
    words: ['本质', '为什么', '发现', '核心', '区别', '对比', '原则', '启发', '洞见', '总结']
  }
];

const HIGH_SIGNAL_TERMS = [
  'algernon', '阿尔吉侬', 'rivermemo', 'tagmemo', 'onering', 'cteno', 'okf',
  'decisionprovider', 'antigravity', 'vcp', 'gemini', 'spec', 'ledger', 'spans',
  '记忆', '标签', '快照', '签名', '架构', '前端', '考据'
];

/**
 * Parse a ledger JSONL file into line records with exact UTF-8 byte offsets.
 *
 * @param {Buffer} buf
 * @returns {Array<{ lineIndex: number, byteOffset: number, byteLength: number, event: Record<string, any> }>}
 */
function parseLedgerLinesWithOffsets(buf) {
  const lines = [];
  let offset = 0;
  let lineIndex = 0;

  while (offset < buf.length) {
    const nlIdx = buf.indexOf(0x0a, offset);
    const end = nlIdx === -1 ? buf.length : nlIdx + 1;
    const slice = buf.subarray(offset, end);
    const trimmed = slice.toString('utf8').trim();
    if (trimmed) {
      try {
        const event = JSON.parse(trimmed);
        lines.push({
          lineIndex,
          byteOffset: offset,
          byteLength: end - offset,
          event
        });
        lineIndex += 1;
      } catch {
        // Ignore malformed lines without breaking offset tracking of valid lines.
      }
    }
    offset = end;
  }

  return lines;
}

/**
 * Group consecutive ledger lines into bounded conversational exchange spans.
 *
 * @param {ReturnType<typeof parseLedgerLinesWithOffsets>} lineRecords
 */
function groupIntoCandidateSpans(lineRecords) {
  const groups = [];
  let current = [];
  let currentChars = 0;
  let hasAssistant = false;

  const flush = () => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
      currentChars = 0;
      hasAssistant = false;
    }
  };

  for (const rec of lineRecords) {
    const role = rec.event.role;
    const textLen = String(rec.event.content || '').length;

    const shouldStartNew =
      current.length > 0 &&
      (current.length >= 8 ||
        currentChars + textLen > 4500 ||
        (role === 'user' && (hasAssistant || current.length >= 3)));

    if (shouldStartNew) {
      flush();
    }

    current.push(rec);
    currentChars += textLen;
    if (role === 'assistant') hasAssistant = true;
  }
  flush();

  return groups;
}

function stripHostEnvelope(text) {
  return String(text || '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, ' ')
    .replace(/<\/?USER_REQUEST>/gi, ' ');
}

function cleanSnippet(text, maxLen = 110) {
  const singleLine = stripHostEnvelope(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen - 3)}...`;
}

function extractEntities(text) {
  const cleaned = stripHostEnvelope(text);
  const found = new Set();
  const pascalOrCamel = cleaned.match(/\b[A-Z][A-Za-z0-9_.-]{2,32}\b/g) || [];
  for (const tok of pascalOrCamel) {
    if (!['The', 'This', 'That', 'Step', 'User', 'Note', 'True', 'False'].includes(tok)) {
      found.add(tok);
    }
    if (found.size >= 6) break;
  }
  const lower = cleaned.toLowerCase();
  for (const term of HIGH_SIGNAL_TERMS) {
    if (found.size >= 8) break;
    if (lower.includes(term)) found.add(term);
  }
  return [...found];
}

function scoreHeuristicSpan(group) {
  const userTexts = group
    .filter((r) => r.event.role === 'user')
    .map((r) => stripHostEnvelope(r.event.content || ''));
  const assistantTexts = group
    .filter((r) => r.event.role === 'assistant')
    .map((r) => stripHostEnvelope(r.event.content || ''));
  const combined = [...userTexts, ...assistantTexts].join('\n').trim();
  const primaryText = combined || group.map((r) => String(r.event.content || '')).join('\n');
  const lower = primaryText.toLowerCase();

  let score = 0.34;
  if (userTexts.length > 0 && userTexts.every((t) => TRIVIAL_FILLER_RE.test(t.trim()))) {
    score -= 0.16;
  }
  if (primaryText.length > 180) score += 0.12;
  if (primaryText.length > 700) score += 0.12;
  if (userTexts.length > 0 && assistantTexts.length > 0) score += 0.08;

  let bestKind = 'discussion';
  let bestHits = 0;
  for (const entry of KIND_KEYWORDS) {
    let hits = 0;
    for (const w of entry.words) {
      if (lower.includes(w)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestKind = entry.kind;
    }
    score += Math.min(hits, 3) * 0.06;
  }

  let signalHits = 0;
  for (const term of HIGH_SIGNAL_TERMS) {
    if (lower.includes(term)) signalHits += 1;
  }
  score += Math.min(signalHits, 4) * 0.04;

  const salience = Number(Math.max(0.05, Math.min(0.98, score)).toFixed(3));
  const userPart = cleanSnippet(userTexts[0] || group[0]?.event?.content || '', 70);
  const assistantPart = cleanSnippet(assistantTexts[assistantTexts.length - 1] || '', 75);
  let gist = userPart;
  if (assistantPart && assistantPart !== userPart) {
    gist = `${userPart} => ${assistantPart}`;
  }
  if (gist.length > 160) gist = `${gist.slice(0, 157)}...`;

  return {
    kind: bestKind,
    salience,
    gist,
    entities: extractEntities(primaryText)
  };
}

async function maybeRefineWithDecisionClient(group, heuristic, decisionClient) {
  if (!decisionClient || !decisionClient.isActive()) {
    return {
      ...heuristic,
      annotated_by: { model_id: null, provider: 'heuristic', sign_source: 'unsigned' }
    };
  }

  const previewText = group
    .map((r) => `[${r.event.role}] ${String(r.event.content || '').slice(0, 800)}`)
    .join('\n')
    .slice(0, 4000);

  const res = await decisionClient.evaluate({
    state: previewText,
    questions: {
      has_lasting_value: {
        type: 'noul',
        instructions: 'Does this conversation segment contain lasting decisions, user preferences, insights, or reusable facts?'
      },
      salience_level: {
        type: 'score',
        instructions: 'Rate long-term memory salience of this segment.',
        criteria: ['Noise', 'Low', 'Notable', 'High', 'Core']
      },
      kind: {
        type: 'choice',
        instructions: 'Classify the dominant memory type.',
        criteria: {
          decision: 'Architectural or workflow decision',
          insight: 'Analysis, comparison, or conceptual insight',
          preference: 'User preference, habit, or persona boundary',
          fact: 'Concrete factual or technical discovery',
          code_spec: 'Implementation specification or API design',
          literary_note: 'Literary criticism, text analysis, or source research',
          discussion: 'General ongoing discussion'
        }
      }
    }
  });

  if (res.degraded || !res.answers) {
    return {
      ...heuristic,
      annotated_by: { model_id: null, provider: 'heuristic', sign_source: 'unsigned' }
    };
  }

  const lasting = Number(res.answers.has_lasting_value?.noul);
  const level = Number(res.answers.salience_level?.score);
  const chosenKind = res.answers.kind?.choice;
  let salience = heuristic.salience;
  if (Number.isFinite(level)) {
    const normalizedLevel = Math.max(0, Math.min(1, level / 4));
    salience = Number.isFinite(lasting)
      ? Number((0.65 * normalizedLevel + 0.35 * Math.max(0, Math.min(1, lasting))).toFixed(3))
      : Number(normalizedLevel.toFixed(3));
  }

  return {
    kind: typeof chosenKind === 'string' && chosenKind ? chosenKind : heuristic.kind,
    salience,
    gist: heuristic.gist,
    entities: heuristic.entities,
    annotated_by: {
      model_id: res.model || decisionClient.model_id || null,
      provider: decisionClient.provider || 'external',
      sign_source: 'runtime_verified'
    }
  };
}

/**
 * Build `ledger/spans/<harness>/<sessionId>.spans.json` with exact UTF-8 byte offsets.
 *
 * @param {string} vaultPath
 * @param {string} harness
 * @param {string} sessionId
 * @param {{ decisionClient?: ReturnType<import('./decision-provider.mjs').createDecisionClient> | null }} [options]
 */
export async function indexSessionSpans(vaultPath, harness, sessionId, options = {}) {
  const relLedger = `ledger/sessions/${harness}/${sessionId}.jsonl`;
  const absLedger = path.join(vaultPath, 'ledger', 'sessions', harness, `${sessionId}.jsonl`);
  const buf = await fs.readFile(absLedger);
  const records = parseLedgerLinesWithOffsets(buf);
  const groups = groupIntoCandidateSpans(records);

  const shortSession = computeShortSessionId(sessionId);
  const spans = [];

  for (let idx = 0; idx < groups.length; idx += 1) {
    const group = groups[idx];
    const first = group[0];
    const last = group[group.length - 1];
    const byteOffset = first.byteOffset;
    const byteLength = (last.byteOffset + last.byteLength) - first.byteOffset;

    const heuristic = scoreHeuristicSpan(group);
    const refined = await maybeRefineWithDecisionClient(group, heuristic, options.decisionClient);

    const spanNo = String(idx + 1).padStart(2, '0');
    spans.push({
      span_id: `${harness}:${shortSession}:sp${spanNo}`,
      session_id: sessionId,
      source_harness: harness,
      step_range: [
        Number(first.event.step_index ?? first.lineIndex),
        Number(last.event.step_index ?? last.lineIndex)
      ],
      byte_offset: byteOffset,
      byte_length: byteLength,
      ts_start: first.event.ts || null,
      ts_end: last.event.ts || null,
      kind: refined.kind,
      salience: refined.salience,
      gist: refined.gist,
      entities: refined.entities,
      linked_wiki: [],
      annotated_by: refined.annotated_by
    });
  }

  const outDir = path.join(vaultPath, 'ledger', 'spans', harness);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${sessionId}.spans.json`);
  const doc = {
    schema: SPANS_SCHEMA,
    source_harness: harness,
    session_id: sessionId,
    ledger_path: relLedger,
    generated_at: new Date().toISOString(),
    spans
  };
  await fs.writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return { outPath, spanCount: spans.length, spans };
}

/**
 * Rebuild span indexes across all (or one specified) session ledger files.
 *
 * @param {string} vaultPath
 * @param {{ sessionId?: string | null, decisionClient?: any }} [options]
 */
export async function buildAllSpans(vaultPath, options = {}) {
  const sessionsRoot = path.join(vaultPath, 'ledger', 'sessions');
  let harnesses = [];
  try {
    harnesses = (await fs.readdir(sessionsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (err?.code === 'ENOENT') return { sessionsProcessed: 0, totalSpans: 0 };
    throw err;
  }

  let sessionsProcessed = 0;
  let totalSpans = 0;

  for (const harness of harnesses) {
    const hDir = path.join(sessionsRoot, harness);
    const files = (await fs.readdir(hDir))
      .filter((f) => f.endsWith('.jsonl'))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      const sessionId = file.slice(0, -'.jsonl'.length);
      if (options.sessionId && sessionId !== options.sessionId) continue;
      const res = await indexSessionSpans(vaultPath, harness, sessionId, options);
      sessionsProcessed += 1;
      totalSpans += res.spanCount;
    }
  }

  return { sessionsProcessed, totalSpans };
}

async function loadAllSpanDocs(vaultPath) {
  const spansRoot = path.join(vaultPath, 'ledger', 'spans');
  const docs = [];
  let harnesses = [];
  try {
    harnesses = (await fs.readdir(spansRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (err?.code === 'ENOENT') return docs;
    throw err;
  }

  for (const harness of harnesses) {
    const hDir = path.join(spansRoot, harness);
    const files = (await fs.readdir(hDir)).filter((f) => f.endsWith('.spans.json'));
    for (const file of files) {
      const raw = await fs.readFile(path.join(hDir, file), 'utf8');
      docs.push(JSON.parse(raw));
    }
  }
  return docs;
}

/**
 * Search lightweight `.spans.json` metadata without loading full raw session logs.
 *
 * @param {string} vaultPath
 * @param {{ query?: string, kind?: string | null, minSalience?: number, sessionId?: string | null, limit?: number }} [options]
 */
export async function searchLedgerSpans(vaultPath, options = {}) {
  const {
    query = '',
    kind = null,
    minSalience = 0,
    sessionId = null,
    limit = 10
  } = options;

  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const docs = await loadAllSpanDocs(vaultPath);
  const candidates = [];

  for (const doc of docs) {
    if (sessionId && doc.session_id !== sessionId) continue;
    for (const span of doc.spans || []) {
      if (kind && span.kind !== kind) continue;
      if ((span.salience ?? 0) < minSalience) continue;

      const haystack = `${span.gist || ''} ${(span.entities || []).join(' ')} ${span.kind || ''}`.toLowerCase();
      let termHits = 0;
      for (const term of terms) {
        if (haystack.includes(term)) termHits += 1;
      }
      if (terms.length > 0 && termHits === 0) continue;

      const rankScore = (span.salience ?? 0) + termHits * 0.5;
      candidates.push({
        ...span,
        ledger_path: doc.ledger_path,
        rank_score: Number(rankScore.toFixed(3))
      });
    }
  }

  candidates.sort((a, b) => b.rank_score - a.rank_score);
  return candidates.slice(0, Math.max(1, limit));
}

async function readByteRange(filePath, offset, length) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * O(1) partial read of a single semantic span from its immutable JSONL ledger.
 * Never loads the full session log into memory.
 *
 * @param {string} vaultPath
 * @param {string} spanId
 * @param {{ padSteps?: number }} [options]
 */
export async function readLedgerSpan(vaultPath, spanId, options = {}) {
  const padSteps = Math.max(0, Number(options.padSteps ?? 1));
  const docs = await loadAllSpanDocs(vaultPath);

  let foundDoc = null;
  let foundIdx = -1;
  for (const doc of docs) {
    const idx = (doc.spans || []).findIndex((s) => s.span_id === spanId);
    if (idx >= 0) {
      foundDoc = doc;
      foundIdx = idx;
      break;
    }
  }

  if (!foundDoc || foundIdx === -1) {
    throw new Error(`Span not found: ${spanId}`);
  }

  const spans = foundDoc.spans;
  const target = spans[foundIdx];
  const absLedger = path.join(vaultPath, foundDoc.ledger_path);

  if (padSteps === 0) {
    const slice = await readByteRange(absLedger, target.byte_offset, target.byte_length);
    const events = parseLedgerLinesWithOffsets(slice).map((r) => ({
      ...r.event,
      is_target: true
    }));
    return { span: target, ledger_path: foundDoc.ledger_path, pad_steps: 0, events };
  }

  // Use adjacent span offsets so our partial read starts/ends on exact UTF-8 line boundaries.
  const stat = await fs.stat(absLedger);
  const MAX_PAD_BYTES = 64 * 1024;
  const prevSpan = foundIdx > 0 ? spans[foundIdx - 1] : null;
  const nextSpan = foundIdx + 1 < spans.length ? spans[foundIdx + 1] : null;

  let readStart = prevSpan ? prevSpan.byte_offset : 0;
  let alignedAtLineStart = true;
  if (target.byte_offset - readStart > MAX_PAD_BYTES) {
    readStart = Math.max(0, target.byte_offset - MAX_PAD_BYTES);
    alignedAtLineStart = readStart === 0;
  }

  const targetEnd = target.byte_offset + target.byte_length;
  let readEnd = nextSpan ? (nextSpan.byte_offset + nextSpan.byte_length) : stat.size;
  if (readEnd - targetEnd > MAX_PAD_BYTES) {
    readEnd = Math.min(stat.size, targetEnd + MAX_PAD_BYTES);
  }

  const windowBuf = await readByteRange(absLedger, readStart, readEnd - readStart);
  let scanBuf = windowBuf;
  let baseOffset = readStart;

  if (!alignedAtLineStart) {
    const firstNl = windowBuf.indexOf(0x0a);
    if (firstNl !== -1 && readStart + firstNl + 1 <= target.byte_offset) {
      scanBuf = windowBuf.subarray(firstNl + 1);
      baseOffset = readStart + firstNl + 1;
    }
  }

  const windowed = parseLedgerLinesWithOffsets(scanBuf).map((r) => ({
    ...r,
    absOffset: baseOffset + r.byteOffset
  }));

  const firstTargetIdx = windowed.findIndex((r) => r.absOffset >= target.byte_offset);
  let lastTargetIdx = windowed.length - 1;
  for (let i = windowed.length - 1; i >= 0; i -= 1) {
    if (windowed[i].absOffset < targetEnd) {
      lastTargetIdx = i;
      break;
    }
  }

  if (firstTargetIdx === -1 || lastTargetIdx < firstTargetIdx) {
    // Fallback to exact target slice if window boundaries differed unexpectedly.
    const exactSlice = await readByteRange(absLedger, target.byte_offset, target.byte_length);
    return {
      span: target,
      ledger_path: foundDoc.ledger_path,
      pad_steps: 0,
      events: parseLedgerLinesWithOffsets(exactSlice).map((r) => ({ ...r.event, is_target: true }))
    };
  }

  const sliceStart = Math.max(0, firstTargetIdx - padSteps);
  const sliceEnd = Math.min(windowed.length - 1, lastTargetIdx + padSteps);
  const events = [];
  for (let i = sliceStart; i <= sliceEnd; i += 1) {
    events.push({
      ...windowed[i].event,
      is_target: i >= firstTargetIdx && i <= lastTargetIdx
    });
  }

  return {
    span: target,
    ledger_path: foundDoc.ledger_path,
    pad_steps: padSteps,
    events
  };
}
