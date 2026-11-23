#!/usr/bin/env node
/**
 * @fileoverview Universal Plug-and-Play Stdio MCP Server (`harness-connector`).
 *
 * 100% host-agnostic — plug directly into Claude Desktop, Claude Code, Cursor,
 * Windsurf, Codex, Cherry Studio, DeepSeek Harness, or Antigravity with zero
 * host-specific hooks required:
 *
 * - **6 Core Read Tools** (from `kit/bin/pmv-mcp.mjs`, enriched with `workspace_path`
 *   for physical single-cartridge auto-read & multi-cartridge interlock protection):
 *   `pmv_status`, `pmv_read_index`, `pmv_read_wiki`, `pmv_search_spans`,
 *   `pmv_read_span`, `pmv_query_memory`.
 * - **3 Universal Connector Tools**:
 *   - `pmv_slot_status`: inspect workspace drop-in cartridge slot, interlock state,
 *     fixed cartridge repository inventory, and top-level rules sync status.
 *   - `pmv_sync_rules`: mount, refresh, or cleanly remove managed persona rules
 *     in ANY host's top-level rules file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, etc.).
 *   - `pmv_commit_turn`: persist a turn directly into immutable `ledger/` and
 *     refresh `wiki/index.md` (enables memory persistence even on MCP clients
 *     without lifecycle `Stop` hooks).
 */

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  MCP_TOOLS as CORE_MCP_TOOLS,
  handleMcpMessage as handleCoreMcpMessage
} from '../kit/bin/pmv-mcp.mjs';
import { loadCartridgesRegistry } from '../kit/core/cartridges.mjs';
import { commitTurn, loadVault } from '../kit/core/runtime.mjs';
import {
  DEFAULT_RULE_FILENAMES,
  computeIndexHash,
  computePersonaRulesHash,
  detectWorkspaceRulesFile,
  removeWorkspaceRulesFile,
  syncWorkspaceRulesFile
} from './rules-renderer.mjs';
import {
  DEFAULT_KIT_ROOT,
  resolveConnectorCartridge,
  scanWorkspaceCartridges
} from './slot-scanner.mjs';

const PROTOCOL_VERSION = '2024-11-05';

export const ENRICHED_CORE_TOOLS = CORE_MCP_TOOLS.map((tool) => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: {
      ...(tool.inputSchema?.properties || {}),
      workspace_path: {
        type: 'string',
        description:
          'Optional workspace directory containing a drop-in persona cartridge (`character.manifest.json`). Auto-uses it when exactly 1 cartridge exists; triggers multi-cartridge interlock when >=2.'
      }
    }
  }
}));

export const CONNECTOR_MCP_TOOLS = [
  {
    name: 'pmv_slot_status',
    description:
      'Inspect workspace physical cartridge slot discovery (single auto-mount vs multi-cartridge interlock), fixed cartridge repository inventory, and top-level rules file (`AGENTS.md` / `CLAUDE.md` / `GEMINI.md`) sync status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_path: {
          type: 'string',
          description: 'Optional workspace directory to scan for drop-in cartridges and managed rules files.'
        },
        cartridge: {
          type: 'string',
          description: 'Optional cartridge ID or vault path to inspect.'
        }
      }
    }
  },
  {
    name: 'pmv_sync_rules',
    description:
      'Mount, refresh, or cleanly unmount managed persona rules (`SOUL.md` + `USER_PROFILE.md` + opening `wiki/index.md`) in any host rule file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or custom). Preserves all user-written rules outside markers and respects multi-cartridge interlock.',
    inputSchema: {
      type: 'object',
      required: ['workspace_path'],
      properties: {
        workspace_path: {
          type: 'string',
          description: 'Target workspace directory.'
        },
        action: {
          type: 'string',
          enum: ['sync', 'remove'],
          description: '"sync" (default) renders/refreshes managed block; "remove" strips only the managed block.'
        },
        cartridge: {
          type: 'string',
          description: 'Optional cartridge ID or vault path (auto-detected if workspace holds 1 cartridge; required if >=2 cartridges trigger interlock).'
        },
        file_name: {
          type: 'string',
          description: 'Target rule filename, e.g. AGENTS.md (default), CLAUDE.md, GEMINI.md.'
        },
        include_index: {
          type: 'boolean',
          description: 'Include opening wiki/index.md (Evergreen Pillars above, Living Timeline at bottom; default: true).'
        },
        max_bytes: {
          type: 'number',
          description: 'Optional per-file byte budget (e.g. 24000 for hosts with a 24KB cap; omitted = unlimited).'
        },
        create_marker: {
          type: 'boolean',
          description: 'When syncing, optionally write `.persona` marker if absent (default: false).'
        },
        remove_marker: {
          type: 'boolean',
          description: 'When removing, also remove `.persona` marker (default: false).'
        }
      }
    }
  },
  {
    name: 'pmv_commit_turn',
    description:
      'Commit a conversation turn (`user_text` + `assistant_text`) into the cartridge immutable `ledger/sessions/` and hot-refresh `wiki/index.md`. Useful on standard MCP clients without automated Stop hooks.',
    inputSchema: {
      type: 'object',
      required: ['user_text', 'assistant_text'],
      properties: {
        user_text: { type: 'string', description: 'User message text.' },
        assistant_text: { type: 'string', description: 'Assistant reply text.' },
        session_id: { type: 'string', description: 'Optional session identifier (defaults to mcp-session).' },
        harness: { type: 'string', description: 'Optional client/harness name (defaults to mcp).' },
        cartridge: { type: 'string', description: 'Optional cartridge ID or vault path.' },
        workspace_path: { type: 'string', description: 'Optional workspace directory for drop-in single-cartridge resolution.' }
      }
    }
  }
];

export const ALL_CONNECTOR_MCP_TOOLS = [...ENRICHED_CORE_TOOLS, ...CONNECTOR_MCP_TOOLS];
const CONNECTOR_TOOL_NAMES = new Set(CONNECTOR_MCP_TOOLS.map((t) => t.name));

async function executeConnectorTool(name, args = {}, kitRoot = DEFAULT_KIT_ROOT) {
  if (name === 'pmv_slot_status') {
    const wsPath = args.workspace_path ? String(args.workspace_path).trim() : '';
    const workspaceScan = wsPath
      ? await scanWorkspaceCartridges([wsPath])
      : { status: 'none', cartridges: [], primary: null };

    let registry = null;
    try {
      registry = await loadCartridgesRegistry(kitRoot);
    } catch {
      registry = null;
    }

    const usageMode =
      workspaceScan.status === 'interlocked'
        ? 'workspace_multi_cartridge_interlock'
        : workspaceScan.status === 'single'
          ? 'workspace_cartridge_slot'
          : 'cartridge_repository';

    let activeCartridge = args.cartridge ? String(args.cartridge).trim() : null;
    let activeRef = null;
    if (activeCartridge) {
      const resolved = await resolveConnectorCartridge({
        cartridge: activeCartridge,
        workspacePath: wsPath,
        kitRoot
      });
      activeRef = resolved.cartridgeRef;
      activeCartridge = resolved.cartridgeId || activeCartridge;
    } else if (workspaceScan.status === 'single' && workspaceScan.primary) {
      activeCartridge = workspaceScan.primary.id;
      activeRef = workspaceScan.primary.vaultPath;
    } else if (workspaceScan.status === 'none') {
      activeCartridge = registry?.default_cartridge || null;
      activeRef = activeCartridge && registry?.cartridges?.[activeCartridge]
        ? registry.cartridges[activeCartridge]
        : null;
    }

    const rulesInfo = wsPath
      ? await detectWorkspaceRulesFile([wsPath], activeCartridge, {
          kitRoot,
          cartridgeRef: activeRef,
          fileNames: DEFAULT_RULE_FILENAMES,
          autoRefresh: false
        })
      : { active: false, filePath: null, fileName: null, cartridge: null, include_index: false };

    let soulInSync = null;
    let indexInSync = null;
    if (rulesInfo.active) {
      try {
        const vault = await loadVault(activeRef || rulesInfo.cartridge, { kitRoot });
        soulInSync = computePersonaRulesHash(vault) === rulesInfo.sha256;
        if (rulesInfo.include_index) {
          indexInSync = computeIndexHash(vault) === rulesInfo.index_sha256;
        }
      } catch {
        soulInSync = null;
        indexInSync = null;
      }
    }

    return {
      usage_mode: usageMode,
      interlocked: workspaceScan.status === 'interlocked',
      workspace_cartridges: workspaceScan.cartridges,
      active_cartridge: activeCartridge,
      active_cartridge_path: activeRef,
      workspace_rules_file: {
        active: rulesInfo.active,
        file_name: rulesInfo.fileName,
        file_path: rulesInfo.filePath,
        cartridge: rulesInfo.cartridge,
        include_index: rulesInfo.include_index,
        soul_in_sync: soulInSync,
        index_in_sync: indexInSync
      },
      cartridge_repository: {
        dir: registry?.cartridges_dir || null,
        default_cartridge: registry?.default_cartridge || null,
        cartridges: registry?.cartridges ? Object.keys(registry.cartridges) : []
      }
    };
  }

  if (name === 'pmv_sync_rules') {
    const wsPath = String(args.workspace_path || '').trim();
    if (!wsPath) throw new Error('pmv_sync_rules requires workspace_path');
    const action = String(args.action || 'sync').trim().toLowerCase();
    const fileName = String(args.file_name || 'AGENTS.md').trim() || 'AGENTS.md';

    if (action === 'remove') {
      return removeWorkspaceRulesFile(wsPath, {
        fileName,
        removePersonaMarker: Boolean(args.remove_marker)
      });
    }

    const target = await resolveConnectorCartridge({
      cartridge: args.cartridge || null,
      workspacePath: wsPath,
      kitRoot
    });
    return syncWorkspaceRulesFile(wsPath, target.cartridgeRef, {
      kitRoot,
      fileName,
      includeIndex: args.include_index !== false,
      maxBytes: args.max_bytes !== undefined ? Number(args.max_bytes) : null,
      createPersonaMarker: Boolean(args.create_marker)
    });
  }

  if (name === 'pmv_commit_turn') {
    const target = await resolveConnectorCartridge({
      cartridge: args.cartridge || null,
      workspacePath: args.workspace_path || null,
      kitRoot
    });
    return commitTurn(target.cartridgeRef, {
      sessionId: args.session_id ? String(args.session_id) : 'mcp-session',
      harness: args.harness ? String(args.harness) : 'mcp',
      userText: String(args.user_text || ''),
      assistantText: String(args.assistant_text || ''),
      kitRoot
    });
  }

  throw new Error(`Unknown connector MCP tool: ${name}`);
}

/**
 * Handle a single JSON-RPC 2.0 MCP message for the universal plug-and-play
 * `harness-connector` server (6 core read tools + 3 universal connector tools).
 *
 * @param {Record<string, any>} msg
 * @param {{ kitRoot?: string }} [options]
 */
export async function handleConnectorMcpMessage(msg, options = {}) {
  const kitRoot = options.kitRoot || DEFAULT_KIT_ROOT;
  if (!msg || typeof msg !== 'object') {
    return handleCoreMcpMessage(msg, { kitRoot });
  }

  const hasId = msg.id !== undefined && msg.id !== null;
  if (msg.method === 'notifications/initialized' || !hasId) {
    return null;
  }

  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'persona-cassette-harness-connector',
          version: '1.0.0'
        }
      }
    };
  }

  if (msg.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: ALL_CONNECTOR_MCP_TOOLS }
    };
  }

  if (msg.method === 'tools/call') {
    const toolName = msg.params?.name;
    const toolArgs = msg.params?.arguments || {};

    if (CONNECTOR_TOOL_NAMES.has(toolName)) {
      try {
        const payload = await executeConnectorTool(toolName, toolArgs, kitRoot);
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
            content: [{ type: 'text', text: `[harness-connector mcp error] ${err?.message || err}` }],
            isError: true
          }
        };
      }
    }

    // Core 6 tools: enrich with workspace single-cartridge auto-read + multi-cartridge interlock!
    if (toolArgs.workspace_path) {
      try {
        const resolved = await resolveConnectorCartridge({
          cartridge: toolArgs.cartridge || null,
          workspacePath: toolArgs.workspace_path,
          kitRoot
        });
        const forwardedArgs = { ...toolArgs };
        delete forwardedArgs.workspace_path;
        if (resolved.cartridgeRef) {
          forwardedArgs.cartridge = resolved.cartridgeRef;
        }
        return handleCoreMcpMessage(
          { ...msg, params: { ...msg.params, arguments: forwardedArgs } },
          { kitRoot }
        );
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `[harness-connector mcp error] ${err?.message || err}` }],
            isError: true
          }
        };
      }
    }
  }

  return handleCoreMcpMessage(msg, { kitRoot });
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
      const reply = await handleConnectorMcpMessage(parsed, {
        kitRoot: process.env.PMV_KIT_ROOT || DEFAULT_KIT_ROOT
      });
      if (reply) {
        process.stdout.write(`${JSON.stringify(reply)}\n`);
      }
    } catch (err) {
      process.stderr.write(`[harness-connector mcp fatal] ${err?.stack || err}\n`);
    }
  });
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  startStdioTransport();
}
