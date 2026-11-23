/**
 * @fileoverview Antigravity Stop hook layered on `harness-connector`:
 * - Assistant Mode (including unregistered drop-in workspace cartridges):
 *   syncs Antigravity transcript events to immutable `ledger/sessions/antigravity/`
 *   and hot-refreshes `wiki/index.md`.
 * - Work Mode (including Multi-Cartridge Interlock): returns `{}` silently.
 */

import fs from 'node:fs/promises';
import { resolveCartridgePath } from '../../kit/core/cartridges.mjs';
import { appendLedgerBatch, parseAntigravityTranscript } from '../../kit/core/ledger.mjs';
import { recordActivityDelta, refreshChronicle } from '../../kit/core/runtime.mjs';
import { DEFAULT_KIT_ROOT, resolveConversationMode } from './mode-router.mjs';

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  const payload = await readStdinJson();
  const resolved = await resolveConversationMode(payload);

  if (resolved.mode !== 'assistant') {
    process.stdout.write('{}\n');
    return;
  }

  const transcriptPath = payload.transcriptPath;
  const sessionId = String(payload.conversationId || '').trim();
  if (!transcriptPath || !sessionId) {
    process.stdout.write('{}\n');
    return;
  }

  const raw = await fs.readFile(transcriptPath, 'utf8');
  const parsed = parseAntigravityTranscript(raw, sessionId, { includeTools: 'summary' });
  if (parsed.events.length === 0) {
    process.stdout.write('{}\n');
    return;
  }

  const kitRoot = process.env.PMV_KIT_ROOT || DEFAULT_KIT_ROOT;
  const { vaultPath } = await resolveCartridgePath(
    kitRoot,
    resolved.cartridge_path || resolved.cartridge || null
  );

  const res = await appendLedgerBatch(vaultPath, parsed.events);
  if (res.added > 0) {
    const userTurns = parsed.events.filter((e) => e.role === 'user').length;
    await recordActivityDelta(vaultPath, {
      eventsAdded: res.added,
      turnsAdded: Math.min(res.added, Math.max(1, userTurns > 0 ? 1 : 0))
    });
    await refreshChronicle(vaultPath, { kitRoot }).catch(() => undefined);
  }

  process.stdout.write('{}\n');
}

main().catch((err) => {
  process.stderr.write(`[ag-tuned Stop] ${err?.message || err}\n`);
  process.stdout.write('{}\n');
});
