/**
 * @fileoverview DeepSeek Harness Cordis plugin entrypoint registering Persona
 * Memory Vault against `assistantCards.registerMemory`.
 *
 * Bridges async RiverMemo recall into `dsh-assistant-mode`'s synchronous
 * `memoryRecall({ cardId, query })` hook by prefetching during `agent/pre-step`.
 */

import { loadDshMemoryLibraries } from './core.mjs';

export const inject = ['assistantCards'];

function extractHumanQuery(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((m) => m?.source?.kind === 'user')
    .map((m) =>
      Array.isArray(m?.content)
        ? m.content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
        : typeof m?.content === 'string'
          ? m.content
          : ''
    )
    .filter(Boolean)
    .join('\n')
    .slice(-4000);
}

export async function apply(ctx, config = {}) {
  const assistantCards = ctx.assistantCards;
  if (typeof assistantCards?.registerMemory !== 'function') {
    throw new Error('dsh-pmv-memory requires assistantCards.registerMemory(libraries)');
  }

  const libraries = await loadDshMemoryLibraries(config);
  const recallCache = new Map();
  const CACHE_TTL_MS = 60_000;

  const cacheKey = (cardId, query) => `${cardId}\0${String(query || '').trim()}`;

  const getCachedRecall = (cardId, query) => {
    const key = cacheKey(cardId, query);
    const hit = recallCache.get(key);
    if (!hit) return '';
    if (Date.now() - hit.ts > CACHE_TTL_MS) {
      recallCache.delete(key);
      return '';
    }
    return hit.text;
  };

  const setCachedRecall = (cardId, query, text) => {
    const key = cacheKey(cardId, query);
    recallCache.set(key, { text: String(text || ''), ts: Date.now() });
    if (recallCache.size > 32) {
      const oldest = recallCache.keys().next().value;
      if (oldest !== undefined) recallCache.delete(oldest);
    }
  };

  const isCordisRuntime = typeof ctx.on === 'function';

  // In live DSH Cordis runtime, `runtime.js` invokes `memoryRecall` synchronously
  // inside `systemPrompt.section.text`. Prefetch asynchronously in `agent/pre-step`.
  if (isCordisRuntime) {
    ctx.on(
      'agent/pre-step',
      async ({ agent, messages }, next) => {
        try {
          const state = agent?.session ? assistantCards.effective?.(agent.session) : null;
          const cardId = state?.cardId;
          if (cardId && libraries.hasCartridgeForCard(cardId)) {
            const query = extractHumanQuery(messages);
            if (query) {
              const text = await libraries.recall({ cardId, query });
              setCachedRecall(cardId, query, text);
            }
          }
        } catch {
          // Non-fatal: never block the user turn if memory recall fails.
        }
        return next();
      },
      { prepend: true }
    );

    // Also capture assistant replies into the immutable ledger when a turn settles,
    // since `dsh-assistant-mode/runtime.js` only forwards user messages to memoryIngest.
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || !agent?.session) return;
      try {
        const state = assistantCards.effective?.(agent.session);
        const cardId = state?.cardId;
        if (!cardId || !libraries.hasCartridgeForCard(cardId)) return;
        const events = typeof agent.session.snapshotEvents === 'function'
          ? agent.session.snapshotEvents()
          : [];
        const assistantMsgs = [];
        for (const ev of events) {
          if (ev?.type !== 'assistant/message') continue;
          const msg = ev.data?.message || ev.data;
          if (!msg || typeof msg !== 'object') continue;
          const id = msg.id ?? `assistant-seq-${ev.seq ?? assistantMsgs.length}`;
          const modelId = msg.model || ev.data?.model || null;
          assistantMsgs.push({
            id,
            role: 'assistant',
            content: msg.content,
            step_index: Number(ev.seq ?? assistantMsgs.length),
            ts: ev.ts || ev.timestamp || msg.ts || new Date().toISOString(),
            model_id: typeof modelId === 'string' && modelId.trim() ? modelId.trim() : null
          });
        }
        if (assistantMsgs.length > 0) {
          libraries.ingest({
            cardId,
            sessionId: agent.session.id,
            messages: assistantMsgs
          }).catch(() => undefined);
        }
      } catch {
        // Non-fatal: never disturb DSH session lifecycle.
      }
    });
  }

  const provider = isCordisRuntime
    ? {
        recall({ cardId, query }) {
          if (!cardId || !libraries.hasCartridgeForCard(cardId)) return '';
          return getCachedRecall(cardId, query);
        },
        ingest(input) {
          if (!input?.cardId || !libraries.hasCartridgeForCard(input.cardId)) return undefined;
          return libraries.ingest(input).catch(() => undefined);
        },
        close() {
          recallCache.clear();
          return libraries.close();
        }
      }
    : libraries;

  const unregister = assistantCards.registerMemory(provider);

  ctx.effect(() => () => {
    recallCache.clear();
    if (typeof unregister === 'function') unregister();
    return libraries.close();
  });
}
