'use strict';

/**
 * VCPToolBox `hybridservice` direct plugin adapter for Persona Memory Vault.
 * Bridges CommonJS VCP runtime to ESM `persona-memo-kit` via dynamic `import()`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let runtimeConfig = {
  PMV_KIT_ROOT: path.resolve(__dirname, '../..'),
  PMV_DEFAULT_CARTRIDGE: 'starter',
  PMV_RECORD_LEDGER: 'true',
  PMV_AUTO_ATTACH: 'false'
};

let modulesPromise = null;
const readerCache = new Map();

function loadEsmModules(kitRoot) {
  if (!modulesPromise) {
    const codeRoot = fs.existsSync(path.resolve(kitRoot, 'core', 'runtime.mjs'))
      ? kitRoot
      : path.resolve(__dirname, '../..');
    const toUrl = (rel) => pathToFileURL(path.resolve(codeRoot, rel)).href;
    modulesPromise = Promise.all([
      import(toUrl('core/runtime.mjs')),
      import(toUrl('core/ledger.mjs')),
      import(toUrl('core/rivermemo-snapshot.mjs'))
    ]).then(([runtime, ledger, snap]) => ({ runtime, ledger, snap }));
  }
  return modulesPromise;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

function prependBlockToMessage(msg, block) {
  if (!block) return msg;
  if (typeof msg.content === 'string') {
    return { ...msg, content: `${block}\n\n${msg.content}` };
  }
  if (Array.isArray(msg.content)) {
    return { ...msg, content: [{ type: 'text', text: `${block}\n\n` }, ...msg.content] };
  }
  return msg;
}

async function getCachedReader(snapMod, vaultPath) {
  const snapManifest = await snapMod.readSnapshotManifest(vaultPath);
  if (!snapManifest) return null;
  const cached = readerCache.get(vaultPath);
  if (cached && cached.version === snapManifest.snapshot_version) {
    return cached.reader;
  }
  if (cached) cached.reader.close();
  const reader = await snapMod.openSnapshotReader(vaultPath);
  readerCache.set(vaultPath, { version: snapManifest.snapshot_version, reader });
  return reader;
}

function detectTrigger(systemContent, defaultCartridge) {
  if (typeof systemContent !== 'string') return null;
  const tagMatch = systemContent.match(/\[\[PMV::([a-zA-Z0-9_-]+)\]\]/);
  if (tagMatch) {
    return { cartridge: tagMatch[1], token: tagMatch[0] };
  }
  const phMatch = systemContent.match(/\{\{PMV_SYSTEM_PREFIX(?:::([a-zA-Z0-9_-]+))?\}\}/);
  if (phMatch) {
    return { cartridge: phMatch[1] || defaultCartridge, token: phMatch[0] };
  }
  return null;
}

module.exports = {
  async initialize(config = {}) {
    runtimeConfig = { ...runtimeConfig, ...(config || {}) };
    modulesPromise = null;
    await loadEsmModules(runtimeConfig.PMV_KIT_ROOT);
  },

  async getPlaceholderValue(placeholder, context = {}) {
    const kitRoot = context.PMV_KIT_ROOT || runtimeConfig.PMV_KIT_ROOT;
    const { runtime } = await loadEsmModules(kitRoot);
    const match = String(placeholder || '').match(/\{\{PMV_SYSTEM_PREFIX(?:::([a-zA-Z0-9_-]+))?\}\}/);
    const cartridge = match?.[1] || context.cartridge || runtimeConfig.PMV_DEFAULT_CARTRIDGE;
    const vault = await runtime.loadVault(cartridge, { kitRoot });
    return runtime.composeSystemPrefix(vault, { reportedModel: context.model }).systemPrefix;
  },

  async processMessages(messages, config = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const kitRoot = config.PMV_KIT_ROOT || runtimeConfig.PMV_KIT_ROOT;
    const defaultCartridge = config.PMV_DEFAULT_CARTRIDGE || runtimeConfig.PMV_DEFAULT_CARTRIDGE;
    const autoAttach = String(config.PMV_AUTO_ATTACH ?? runtimeConfig.PMV_AUTO_ATTACH) === 'true';
    const recordLedger = String(config.PMV_RECORD_LEDGER ?? runtimeConfig.PMV_RECORD_LEDGER) !== 'false';

    const nextMessages = messages.map((m) => ({ ...m }));
    const sysIdx = nextMessages.findIndex((m) => m.role === 'system');
    const trigger = sysIdx >= 0 ? detectTrigger(nextMessages[sysIdx].content, defaultCartridge) : null;

    if (!trigger && !autoAttach) {
      return messages;
    }

    const cartridge = trigger?.cartridge || defaultCartridge;
    const { runtime, ledger, snap } = await loadEsmModules(kitRoot);
    const vault = await runtime.loadVault(cartridge, { kitRoot });

    if (trigger && sysIdx >= 0) {
      const prefix = runtime.composeSystemPrefix(vault, { reportedModel: config.model });
      nextMessages[sysIdx].content = nextMessages[sysIdx].content.replace(trigger.token, prefix.systemPrefix);
    }

    let lastUserIdx = -1;
    for (let i = nextMessages.length - 1; i >= 0; i -= 1) {
      if (nextMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx >= 0) {
      const userText = extractText(nextMessages[lastUserIdx].content).trim();
      if (userText) {
        const reader = await getCachedReader(snap, vault.vaultPath);
        const recall = await runtime.recallForUserTurn(vault, userText, {
          kitRoot,
          reportedModel: config.model,
          reader
        });
        const blocks = [recall.xmlBlock, recall.signatureNoticeXml].filter(Boolean);
        if (blocks.length > 0) {
          nextMessages[lastUserIdx] = prependBlockToMessage(
            nextMessages[lastUserIdx],
            blocks.join('\n\n')
          );
        }

        if (recordLedger) {
          const sessionId = String(config.sessionId || config.conversationId || 'vcp-default');
          await runtime.appendLedgerEvent(
            vault,
            {
              event_id: `vcp:${ledger.sha256(`${sessionId}\0${lastUserIdx}\0${userText}`).slice(0, 24)}`,
              ts: new Date().toISOString(),
              source_harness: 'vcp',
              session_id: sessionId,
              step_index: lastUserIdx,
              role: 'user',
              content: userText,
              model_signature: {
                provider: 'vcp',
                model_id: config.model || null,
                raw_reported: config.model || 'auto'
              },
              sign_source: config.model ? 'runtime_verified' : 'unsigned'
            },
            { kitRoot }
          );
        }
      }
    }

    return nextMessages;
  },

  async processToolCall(args = {}) {
    try {
      const kitRoot = args.PMV_KIT_ROOT || runtimeConfig.PMV_KIT_ROOT;
      const cartridge = args.cartridge || runtimeConfig.PMV_DEFAULT_CARTRIDGE;
      const command = String(args.command || args.tool_name || '').trim();
      const { runtime } = await loadEsmModules(kitRoot);

      if (command === 'PMV_Status') {
        const vault = await runtime.loadVault(cartridge, { kitRoot });
        const activity = await runtime.readActivityState(vault.vaultPath);
        return {
          status: 'success',
          result: JSON.stringify({
            character: vault.manifest.character,
            preferred_models: vault.manifest.preferred_models,
            snapshot: vault.snapshotManifest,
            activity
          })
        };
      }

      if (command === 'PMV_SearchSpans') {
        const spans = await runtime.searchLedgerSpans(
          cartridge,
          {
            query: args.query || '',
            kind: args.kind || null,
            minSalience: Number(args.min_salience || 0),
            limit: Number(args.limit || 8)
          },
          { kitRoot }
        );
        return { status: 'success', result: JSON.stringify(spans) };
      }

      if (command === 'PMV_ReadSpan') {
        if (!args.span_id) throw new Error('PMV_ReadSpan requires span_id');
        const slice = await runtime.readLedgerSpan(
          cartridge,
          String(args.span_id),
          { padSteps: Number(args.pad_steps ?? 1) },
          { kitRoot }
        );
        return { status: 'success', result: JSON.stringify(slice) };
      }

      if (command === 'PMV_ReadWiki') {
        if (!args.path) throw new Error('PMV_ReadWiki requires path');
        const page = await runtime.readWikiPage(cartridge, String(args.path), { kitRoot });
        return { status: 'success', result: JSON.stringify(page) };
      }

      return { status: 'error', error: `Unknown PersonaMemoryVault command: ${command}` };
    } catch (err) {
      return { status: 'error', error: err?.message || String(err) };
    }
  },

  async shutdown() {
    for (const entry of readerCache.values()) {
      entry.reader.close();
    }
    readerCache.clear();
  }
};
