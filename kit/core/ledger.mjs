/**
 * @fileoverview Immutable append-only session ledger, Antigravity transcript
 * importer, and original document mirroring with SHA-256 fingerprints.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LEDGER_EVENT_SCHEMA = 'pmv-ledger-event/v1';
export const DOCS_MIRROR_SCHEMA = 'pmv-docs-mirror/v1';

/**
 * Compute lowercase hex SHA-256 digest of a UTF-8 string or Buffer.
 *
 * @param {string | Buffer} input
 * @returns {string}
 */
export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sanitizeSegment(segment, fallback = 'default') {
  const cleaned = String(segment || fallback).replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned || fallback;
}

function getSessionLedgerPath(vaultPath, harness, sessionId) {
  const safeHarness = sanitizeSegment(harness, 'unknown');
  const safeSession = sanitizeSegment(sessionId, 'session');
  return path.join(vaultPath, 'ledger', 'sessions', safeHarness, `${safeSession}.jsonl`);
}

async function readExistingEventIds(filePath) {
  const ids = new Set();
  let endsWithNewline = true;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (raw.length > 0) {
      endsWithNewline = raw.endsWith('\n');
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.event_id) ids.add(String(parsed.event_id));
      } catch {
        // Preserve immutable file without failing on an unrelated malformed line.
      }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return { ids, endsWithNewline };
}

function normalizeLedgerEvent(rawEvent) {
  const sourceHarness = String(rawEvent.source_harness || 'unknown');
  const sessionId = String(rawEvent.session_id || 'unknown');
  const stepIndex = Number(rawEvent.step_index ?? 0);
  const content = String(rawEvent.content ?? '');
  const eventId = String(
    rawEvent.event_id || `${sourceHarness}:${sessionId}:${stepIndex}`
  );
  return {
    schema: LEDGER_EVENT_SCHEMA,
    event_id: eventId,
    ts: String(rawEvent.ts || new Date().toISOString()),
    source_harness: sourceHarness,
    session_id: sessionId,
    step_index: stepIndex,
    role: String(rawEvent.role || 'user'),
    content,
    content_sha256: rawEvent.content_sha256 || sha256(content),
    ...(rawEvent.raw_ref ? { raw_ref: String(rawEvent.raw_ref) } : {}),
    model_signature: {
      provider: rawEvent.model_signature?.provider ?? sourceHarness,
      model_id: rawEvent.model_signature?.model_id ?? null,
      raw_reported: rawEvent.model_signature?.raw_reported ?? 'auto'
    },
    sign_source: String(rawEvent.sign_source || 'unsigned')
  };
}

/**
 * Idempotently append multiple events belonging to a single session ledger file.
 * Existing lines are never modified or rewritten.
 *
 * @param {string} vaultPath
 * @param {Array<Record<string, any>>} events
 * @returns {Promise<{ added: number, skipped: number, filePath: string | null }>}
 */
export async function appendLedgerBatch(vaultPath, events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { added: 0, skipped: 0, filePath: null };
  }

  const first = normalizeLedgerEvent(events[0]);
  const filePath = getSessionLedgerPath(vaultPath, first.source_harness, first.session_id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const { ids, endsWithNewline } = await readExistingEventIds(filePath);
  const linesToAppend = [];
  let skipped = 0;

  for (const raw of events) {
    const normalized = normalizeLedgerEvent(raw);
    if (ids.has(normalized.event_id)) {
      skipped += 1;
      continue;
    }
    ids.add(normalized.event_id);
    linesToAppend.push(JSON.stringify(normalized));
  }

  if (linesToAppend.length > 0) {
    const prefix = endsWithNewline ? '' : '\n';
    await fs.appendFile(filePath, `${prefix}${linesToAppend.join('\n')}\n`, 'utf8');
  }

  return { added: linesToAppend.length, skipped, filePath };
}

/**
 * Append a single event to the immutable session ledger idempotently.
 *
 * @param {string} vaultPath
 * @param {Record<string, any>} event
 */
export async function appendLedgerEvent(vaultPath, event) {
  return appendLedgerBatch(vaultPath, [event]);
}

function summarizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  const parts = [];
  for (const tc of toolCalls) {
    const name = String(tc?.name || 'tool');
    let hint = '';
    const args = tc?.args;
    if (args && typeof args === 'object') {
      const candidate =
        args.Path || args.CommandLine || args.query || args.url || args.Action || args.Role;
      if (candidate !== undefined && candidate !== null) {
        hint = String(candidate).replace(/\s+/g, ' ').trim();
      }
    } else if (typeof args === 'string') {
      hint = args.replace(/\s+/g, ' ').trim();
    }
    if (hint.length > 60) hint = `${hint.slice(0, 57)}...`;
    parts.push(hint ? `${name}(${hint})` : name);
  }
  const summary = `[tools] ${parts.join('; ')}`;
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

/**
 * Convert an Antigravity `transcript.jsonl` entry list into normalized ledger events.
 *
 * @param {string} rawJsonl
 * @param {string} sessionId
 * @param {{ includeTools?: 'summary' | 'none' }} [options]
 */
export function parseAntigravityTranscript(rawJsonl, sessionId, options = {}) {
  const includeTools = options.includeTools ?? 'summary';
  const events = [];
  let parseErrors = 0;

  const lines = String(rawJsonl || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      parseErrors += 1;
      continue;
    }

    const stepIndex = Number.isFinite(Number(entry.step_index)) ? Number(entry.step_index) : i;
    const ts = entry.created_at || new Date().toISOString();
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';

    if (entry.type === 'USER_INPUT' && entry.source === 'USER_EXPLICIT' && content) {
      events.push({
        event_id: `antigravity:${sessionId}:${stepIndex}`,
        ts,
        source_harness: 'antigravity',
        session_id: sessionId,
        step_index: stepIndex,
        role: 'user',
        content,
        model_signature: { provider: 'antigravity', model_id: null, raw_reported: 'auto' },
        sign_source: 'unsigned'
      });
      continue;
    }

    if (entry.type === 'PLANNER_RESPONSE') {
      if (content) {
        events.push({
          event_id: `antigravity:${sessionId}:${stepIndex}`,
          ts,
          source_harness: 'antigravity',
          session_id: sessionId,
          step_index: stepIndex,
          role: 'assistant',
          content,
          model_signature: { provider: 'antigravity', model_id: null, raw_reported: 'auto' },
          sign_source: 'unsigned'
        });
      }

      if (includeTools === 'summary' && Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
        const toolSummary = summarizeToolCalls(entry.tool_calls);
        if (toolSummary) {
          events.push({
            event_id: content
              ? `antigravity:${sessionId}:${stepIndex}:tools`
              : `antigravity:${sessionId}:${stepIndex}`,
            ts,
            source_harness: 'antigravity',
            session_id: sessionId,
            step_index: stepIndex,
            role: 'tool_summary',
            content: toolSummary,
            raw_ref: `transcript_full.jsonl#step${stepIndex}`,
            model_signature: { provider: 'antigravity', model_id: null, raw_reported: 'auto' },
            sign_source: 'unsigned'
          });
        }
      }
    }
  }

  return { events, parseErrors };
}

/**
 * Scan `<brainDir>/<sessionId>/.system_generated/logs/transcript.jsonl` and
 * idempotently ingest all conversational events into `ledger/sessions/antigravity/`.
 *
 * @param {string} vaultPath
 * @param {{ brainDir: string, includeTools?: 'summary' | 'none', limitSessions?: number | null }} options
 */
export async function ingestAntigravityTranscripts(vaultPath, options) {
  const { brainDir, includeTools = 'summary', limitSessions = null } = options;
  let dirEntries = [];
  try {
    dirEntries = await fs.readdir(brainDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        sessionsScanned: 0,
        sessionsUpdated: 0,
        eventsAdded: 0,
        eventsSkipped: 0,
        parseErrors: 0
      };
    }
    throw err;
  }

  const sessionDirs = dirEntries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  const targetDirs = Number.isFinite(limitSessions) && limitSessions > 0
    ? sessionDirs.slice(0, limitSessions)
    : sessionDirs;

  let sessionsScanned = 0;
  let sessionsUpdated = 0;
  let eventsAdded = 0;
  let eventsSkipped = 0;
  let parseErrors = 0;

  for (const sessionId of targetDirs) {
    const transcriptPath = path.join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
    let raw;
    try {
      raw = await fs.readFile(transcriptPath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }

    sessionsScanned += 1;
    const parsed = parseAntigravityTranscript(raw, sessionId, { includeTools });
    parseErrors += parsed.parseErrors;

    if (parsed.events.length === 0) continue;
    const res = await appendLedgerBatch(vaultPath, parsed.events);
    if (res.added > 0) sessionsUpdated += 1;
    eventsAdded += res.added;
    eventsSkipped += res.skipped;
  }

  return { sessionsScanned, sessionsUpdated, eventsAdded, eventsSkipped, parseErrors };
}

/**
 * Verbatim mirror an external file into `ledger/docs-mirror/` and record its
 * SHA-256 fingerprint in `ledger/docs-mirror/manifest.json`.
 *
 * @param {string} vaultPath
 * @param {string} sourceFilePath
 * @param {{ docId?: string }} [options]
 */
export async function mirrorDoc(vaultPath, sourceFilePath, options = {}) {
  const absSource = path.resolve(sourceFilePath);
  const bytes = await fs.readFile(absSource);
  const digest = sha256(bytes);

  const mirrorDir = path.join(vaultPath, 'ledger', 'docs-mirror');
  await fs.mkdir(mirrorDir, { recursive: true });
  const manifestPath = path.join(mirrorDir, 'manifest.json');

  let manifest = { schema: DOCS_MIRROR_SCHEMA, entries: [] };
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.entries)) manifest.entries = [];
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const baseName = path.basename(absSource);
  const docId = options.docId || `doc-${sanitizeSegment(path.basename(baseName, path.extname(baseName)))}`;
  const existingById = manifest.entries.find((e) => e.doc_id === docId);

  if (existingById && existingById.sha256 === digest) {
    return { status: 'unchanged', entry: existingById };
  }

  let targetName = baseName;
  const targetCollision = manifest.entries.find(
    (e) => e.mirror_path === `ledger/docs-mirror/${targetName}` && e.doc_id !== docId
  );
  if (targetCollision) {
    const ext = path.extname(baseName);
    const stem = path.basename(baseName, ext);
    targetName = `${stem}-${digest.slice(0, 8)}${ext}`;
  }

  const destPath = path.join(mirrorDir, targetName);
  await fs.writeFile(destPath, bytes);

  const entry = {
    doc_id: docId,
    mirror_path: `ledger/docs-mirror/${targetName}`,
    source_uri: pathToFileURL(absSource).href,
    sha256: digest,
    mirrored_at: new Date().toISOString(),
    immutable: true
  };

  const idx = manifest.entries.findIndex((e) => e.doc_id === docId);
  if (idx >= 0) {
    manifest.entries[idx] = entry;
  } else {
    manifest.entries.push(entry);
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { status: idx >= 0 ? 'updated' : 'mirrored', entry };
}
