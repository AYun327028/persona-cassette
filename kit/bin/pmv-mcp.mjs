#!/usr/bin/env node
/**
 * @fileoverview Shared zero-dependency Stdio MCP Server (JSON-RPC 2.0) for
 * Antigravity and DeepSeek Harness. NEVER writes non-JSON text to stdout.
 */

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  loadVault,
  readActivityState,
  readLedgerSpan,
  readWikiPage,
  recallForUserTurn,
  searchLedgerSpans
} from '../core/runtime.mjs';

const DEFAULT_KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL_VERSION = '2024-11-05';

export const MCP_TOOLS = [
  {
    name: 'pmv_status',
    description: 'Inspect character vault status, 4 model signature slots, snapshot status, and dream counters.',
    inputSchema: {
      type: 'object',
      properties: {
        cartridge: { type: 'string', description: 'Optional cartridge ID or vault path (defaults to default_cartridge).' }
      }
    }
  },
  {
    name: 'pmv_read_index',
    description: 'Read the two-part Living Chronicle (wiki/index.md) for the active character cartridge.',
    inputSchema: {
      type: 'object',
      properties: {
        cartridge: { type: 'string', description: 'Optional cartridge ID or vault path.' }
      }
    }
  },
  {
    name: 'pmv_read_wiki',
    description: 'Read a specific OKF Markdown page inside wiki/ (e.g., projects/pmv-architecture.md).',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Relative path inside wiki/.' },
        cartridge: { type: 'string', description: 'Optional cartridge ID or vault path.' }
      }
    }
  },
  {
    name: 'pmv_search_spans',
    description: 'Search lightweight semantic span pointers in ledger/spans/ without reading raw session logs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to match span gist and entities.' },
        kind: { type: 'string', description: 'Optional span kind filter (decision, insight, preference, fact, code_spec, literary_note, discussion).' },
        min_salience: { type: 'number', description: 'Minimum salience score (0..1).' },
        session_id: { type: 'string', description: 'Optional session ID filter.' },
        limit: { type: 'number', description: 'Maximum results (default 8).' },
        cartridge: { type: 'string', description: 'Optional cartridge ID or vault path.' }
      }
    }
  },
  {
    name: 'pmv_read_span',
    description: 'O(1) UTF-8 byte-range partial read of an exact span from the immutable session ledger.',
    inputSchema: {
      type: 'object',
      required: ['span_id'],
      properties: {
        span_id: { type: 'string', description: 'Span identifier (e.g., antigravity:b9ba66bc:sp04).' },
        pad_steps: { type: 'number', description: 'Neighboring steps before/after to include (default 1).' },
        cartridge: { type: 'string', description: 'Optional cartridge ID or vault path.' }
      }
    }
  },
  {
    name: 'pmv_query_memory',
    description: 'Query the read-only RiverMemo Topology V3.1 snapshot (if baked and embedding signature matches).',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Query text.' },
        preset: { type: 'string', description: 'Optional preset (balanced, precision_research, associative_explore).' },
        top_k: { type: 'number', description: 'Optional top-K count.' },
        cartridge: { type: 'string', description: 'Optional cartridge ID or vault path.' }
      }
    }
  }
];

async function executeMcpTool(name, args = {}, kitRoot = DEFAULT_KIT_ROOT) {
  const cartridge = args.cartridge || null;

  if (name === 'pmv_status') {
    const vault = await loadVault(cartridge, { kitRoot });
    const activity = await readActivityState(vault.vaultPath);
    return {
      vaultPath: vault.vaultPath,
      character: vault.manifest.character,
      preferred_models: vault.manifest.preferred_models,
      snapshot: vault.snapshotManifest
        ? {
            version: vault.snapshotManifest.snapshot_version,
            model_sig: vault.snapshotManifest.embedding?.model_sig,
            preset: vault.snapshotManifest.preset,
            counts: vault.snapshotManifest.counts
          }
        : null,
      activity
    };
  }

  if (name === 'pmv_read_index') {
    const vault = await loadVault(cartridge, { kitRoot });
    return { vaultPath: vault.vaultPath, index: vault.indexMd };
  }

  if (name === 'pmv_read_wiki') {
    const page = await readWikiPage(cartridge, args.path, { kitRoot });
    return page;
  }

  if (name === 'pmv_search_spans') {
    const spans = await searchLedgerSpans(
      cartridge,
      {
        query: args.query ?? '',
        kind: args.kind ?? null,
        minSalience: args.min_salience ?? 0,
        sessionId: args.session_id ?? null,
        limit: args.limit ?? 8
      },
      { kitRoot }
    );
    return { count: spans.length, spans };
  }

  if (name === 'pmv_read_span') {
    if (!args.span_id) throw new Error('pmv_read_span requires span_id');
    return readLedgerSpan(
      cartridge,
      String(args.span_id),
      { padSteps: args.pad_steps ?? 1 },
      { kitRoot }
    );
  }

  if (name === 'pmv_query_memory') {
    if (!args.query) throw new Error('pmv_query_memory requires query');
    const vault = await loadVault(cartridge, { kitRoot });
    return recallForUserTurn(vault, String(args.query), {
      kitRoot,
      preset: args.preset,
      topK: args.top_k
    });
  }

  throw new Error(`Unknown MCP tool: ${name}`);
}

/**
 * Process a single parsed JSON-RPC 2.0 MCP message and return a response object
 * (or `null` for notifications).
 *
 * @param {Record<string, any>} msg
 * @param {{ kitRoot?: string }} [options]
 */
export async function handleMcpMessage(msg, options = {}) {
  const kitRoot = options.kitRoot || DEFAULT_KIT_ROOT;
  if (!msg || typeof msg !== 'object') {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' }
    };
  }

  const hasId = msg.id !== undefined && msg.id !== null;
  const method = msg.method;

  if (method === 'notifications/initialized' || !hasId) {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'persona-memory-vault',
          version: '0.3.0'
        }
      }
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id: msg.id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: MCP_TOOLS }
    };
  }

  if (method === 'tools/call') {
    const toolName = msg.params?.name;
    const toolArgs = msg.params?.arguments || {};
    try {
      const payload = await executeMcpTool(toolName, toolArgs, kitRoot);
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text }],
          isError: false
        }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `[pmv-mcp error] ${err?.message || err}` }],
          isError: true
        }
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

function startStdioTransport() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${err.message}` }
        })}\n`
      );
      return;
    }

    try {
      const reply = await handleMcpMessage(parsed, { kitRoot: DEFAULT_KIT_ROOT });
      if (reply) {
        process.stdout.write(`${JSON.stringify(reply)}\n`);
      }
    } catch (err) {
      process.stderr.write(`[pmv-mcp fatal] ${err?.stack || err}\n`);
    }
  });
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  startStdioTransport();
}
