#!/usr/bin/env node
/**
 * @fileoverview Antigravity Deep-Tuned Stdio MCP Server.
 *
 * Composes ALL 9 universal tools from `harness-connector/mcp-server.mjs`
 * (6 core read tools + `pmv_slot_status` + `pmv_sync_rules` + `pmv_commit_turn`)
 * and adds ONLY the 2 Antigravity Hook-coupled session tools:
 * - `pmv_persona_status`: inspects Antigravity session state (`pmv-ag-session-modes.json`),
 *   concentration counters, workspace slot / interlock, and 24KB `<user_rules>` status.
 * - `pmv_set_persona_mode`: drives Antigravity's per-conversation `on` / `off` / `boost`
 *   state machine directly from model/user tool calls.
 */

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadCartridgesRegistry } from '../../kit/core/cartridges.mjs';
import { beginSession, closeAllCachedReaders, loadVault } from '../../kit/core/runtime.mjs';
import {
  ALL_CONNECTOR_MCP_TOOLS,
  handleConnectorMcpMessage
} from '../../harness-connector/mcp-server.mjs';
import {
  computeIndexHash,
  computePersonaRulesHash,
  detectWorkspaceRulesFile
} from '../../harness-connector/rules-renderer.mjs';
import { resolveConnectorCartridge } from '../../harness-connector/slot-scanner.mjs';
import {
  ANTIGRAVITY_MAX_RULE_BYTES,
  ANTIGRAVITY_RULE_FILENAMES,
  DEFAULT_KIT_ROOT,
  resolveCartridgeToken,
  resolveConversationMode,
  setConversationModeOverride
} from './mode-router.mjs';

const PROTOCOL_VERSION = '2024-11-05';

export const ANTIGRAVITY_ONLY_MCP_TOOLS = [
  {
    name: 'pmv_persona_status',
    description:
      '[Antigravity-tuned] Inspect Antigravity Hook session mode (`assistant`/`work`), multi-cartridge interlock state, 24KB `<user_rules>` sync status, and dynamic Persona Concentration counters.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_path: { type: 'string', description: 'Optional workspace directory.' },
        conversation_id: { type: 'string', description: 'Optional Antigravity conversation ID.' },
        cartridge: { type: 'string', description: 'Optional cartridge ID or vault path.' }
      }
    }
  },
  {
    name: 'pmv_set_persona_mode',
    description:
      '[Antigravity-tuned] Switch Antigravity Hook session state for `conversation_id`: wake ("on"), seal to silent work mode ("off"), or trigger an immediate Persona Concentration Boost ("boost").',
    inputSchema: {
      type: 'object',
      required: ['conversation_id', 'action'],
      properties: {
        conversation_id: { type: 'string', description: 'Current Antigravity conversation ID.' },
        action: { type: 'string', enum: ['on', 'off', 'boost'] },
        cartridge: { type: 'string', description: 'Optional cartridge ID or vault path (required to unlock multi-cartridge interlock).' },
        workspace_path: { type: 'string', description: 'Optional workspace directory.' }
      }
    }
  }
];

export const ALL_ANTIGRAVITY_MCP_TOOLS = [...ALL_CONNECTOR_MCP_TOOLS, ...ANTIGRAVITY_ONLY_MCP_TOOLS];
const AG_TOOL_NAMES = new Set(ANTIGRAVITY_ONLY_MCP_TOOLS.map((t) => t.name));

async function executeAgTool(name, args = {}, kitRoot = DEFAULT_KIT_ROOT) {
  if (name === 'pmv_persona_status') {
    const workspacePaths = args.workspace_path ? [String(args.workspace_path)] : [];
    const resolved = await resolveConversationMode({
      conversationId: args.conversation_id ? String(args.conversation_id) : '',
      workspacePaths
    });

    const activeCartridge = args.cartridge ? String(args.cartridge) : resolved.cartridge;
    let activeRef = resolved.cartridge_path || activeCartridge;
    if (args.cartridge) {
      const hit = await resolveCartridgeToken(String(args.cartridge), {
        kitRoot,
        workspaceScan: resolved.workspace_scan
      });
      activeRef = hit?.vaultPath || String(args.cartridge);
    }

    const topRules = await detectWorkspaceRulesFile(workspacePaths, activeCartridge, {
      kitRoot,
      cartridgeRef: activeRef,
      fileNames: ANTIGRAVITY_RULE_FILENAMES,
      maxBytes: ANTIGRAVITY_MAX_RULE_BYTES,
      autoRefresh: false
    });

    let rulesInSync = null;
    let indexInSync = null;
    if (topRules.active) {
      try {
        const vault = await loadVault(activeRef || topRules.cartridge, { kitRoot });
        rulesInSync = computePersonaRulesHash(vault) === topRules.sha256;
        if (topRules.include_index) indexInSync = computeIndexHash(vault) === topRules.index_sha256;
      } catch {
        rulesInSync = null;
        indexInSync = null;
      }
    }

    let registry = null;
    try {
      registry = await loadCartridgesRegistry(kitRoot);
    } catch {
      registry = null;
    }

    const usageMode =
      resolved.workspace_scan?.status === 'interlocked'
        ? 'workspace_multi_cartridge_interlock'
        : resolved.workspace_scan?.status === 'single'
          ? 'workspace_cartridge_slot'
          : 'cartridge_repository';

    return {
      mode: resolved.mode,
      usage_mode: usageMode,
      routing_source: resolved.source,
      interlocked: Boolean(resolved.interlocked),
      interlocked_cartridges: resolved.interlocked_cartridges || [],
      workspace_cartridges: resolved.workspace_scan?.cartridges || [],
      active_cartridge: activeCartridge,
      active_cartridge_path: activeRef || null,
      injection_channel: topRules.active
        ? topRules.include_index
          ? 'workspace_top_rules_full'
          : 'workspace_top_rules_soul_only'
        : 'dynamic_concentration',
      workspace_top_rules: {
        active: topRules.active,
        file_name: topRules.fileName,
        file_path: topRules.filePath,
        cartridge: topRules.cartridge,
        include_index: topRules.include_index,
        in_sync_with_vault: rulesInSync,
        index_in_sync_with_vault: indexInSync
      },
      persona_concentration: {
        reboost_on_compaction: resolved.config?.persona_concentration?.reboost_on_compaction !== false,
        reboost_interval_turns: resolved.config?.persona_concentration?.reboost_interval_turns ?? 20,
        baseline_injected: resolved.baseline_injected,
        baseline_checkpoint_step: resolved.baseline_checkpoint_step,
        turns_since_baseline: resolved.turns_since_baseline
      },
      cartridge_repository: {
        dir: registry?.cartridges_dir || null,
        default_cartridge: registry?.default_cartridge || null,
        cartridges: registry?.cartridges ? Object.keys(registry.cartridges) : []
      }
    };
  }

  if (name === 'pmv_set_persona_mode') {
    const conversationId = String(args.conversation_id || '').trim();
    if (!conversationId) throw new Error('pmv_set_persona_mode requires conversation_id');
    const action = String(args.action || '').trim().toLowerCase();
    if (!['on', 'off', 'boost'].includes(action)) {
      throw new Error('pmv_set_persona_mode action must be "on", "off", or "boost"');
    }

    const workspacePaths = args.workspace_path ? [String(args.workspace_path)] : [];
    const resolved = await resolveConversationMode({ conversationId, workspacePaths });

    if (action === 'off') {
      const saved = await setConversationModeOverride(conversationId, {
        mode: 'work',
        cartridge: resolved.cartridge,
        cartridge_path: resolved.cartridge_path,
        baseline_injected: resolved.baseline_injected
      });
      return {
        ok: true,
        action: 'off',
        mode: 'work',
        cartridge: saved.cartridge,
        note: 'Conversation sealed to pure work mode.'
      };
    }

    const target = await resolveConnectorCartridge({
      cartridge: args.cartridge || resolved.cartridge_path || resolved.cartridge || null,
      workspacePath: args.workspace_path || null,
      kitRoot
    });

    const topRules = await detectWorkspaceRulesFile(workspacePaths, target.cartridgeId, {
      kitRoot,
      cartridgeRef: target.cartridgeRef,
      fileNames: ANTIGRAVITY_RULE_FILENAMES,
      maxBytes: ANTIGRAVITY_MAX_RULE_BYTES,
      autoRefresh: true,
      refreshIndex: action === 'boost'
    });
    const assemblyOverrides = topRules.active
      ? { system_sections: ['l0_contract', 'index'] }
      : undefined;

    let started;
    try {
      started = await beginSession(target.cartridgeRef, {
        sessionId: conversationId,
        assemblyOverrides,
        forceReset: action === 'boost',
        kitRoot
      });
    } finally {
      closeAllCachedReaders();
    }

    const activeCartridge = started.cartridge_id || target.cartridgeId;
    await setConversationModeOverride(conversationId, {
      mode: 'assistant',
      cartridge: activeCartridge,
      cartridge_path: started.vault_path || target.cartridgeRef || null,
      baseline_injected: true,
      turns_since_baseline: 0,
      top_rules_active: topRules.active
    });

    return {
      ok: true,
      action,
      mode: 'assistant',
      cartridge: activeCartridge,
      vault_path: started.vault_path,
      injection_channel: topRules.active
        ? topRules.include_index
          ? 'workspace_top_rules_full'
          : 'workspace_top_rules_soul_only'
        : 'dynamic_concentration',
      refreshed_context: started.system
    };
  }

  throw new Error(`Unknown Antigravity MCP tool: ${name}`);
}

export async function handleAntigravityMcpMessage(msg, options = {}) {
  const kitRoot = options.kitRoot || DEFAULT_KIT_ROOT;
  if (!msg || typeof msg !== 'object') {
    return handleConnectorMcpMessage(msg, { kitRoot });
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
          name: 'persona-cassette-antigravity-tuned',
          version: '1.0.0'
        }
      }
    };
  }

  if (msg.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: ALL_ANTIGRAVITY_MCP_TOOLS }
    };
  }

  if (msg.method === 'tools/call' && AG_TOOL_NAMES.has(msg.params?.name)) {
    try {
      const payload = await executeAgTool(msg.params.name, msg.params.arguments || {}, kitRoot);
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text }], isError: false }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `[ag-tuned mcp error] ${err?.message || err}` }],
          isError: true
        }
      };
    }
  }

  return handleConnectorMcpMessage(msg, { kitRoot });
}

function startStdioTransport() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err.message}` } })}\n`
      );
      return;
    }
    try {
      const reply = await handleAntigravityMcpMessage(parsed, {
        kitRoot: process.env.PMV_KIT_ROOT || DEFAULT_KIT_ROOT
      });
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    } catch (err) {
      process.stderr.write(`[ag-tuned mcp fatal] ${err?.stack || err}\n`);
    }
  });
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  startStdioTransport();
}
