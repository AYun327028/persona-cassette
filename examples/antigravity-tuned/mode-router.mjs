/**
 * @fileoverview Antigravity-specific Dual-Mode Router & Session Concentration
 * State Machine layered cleanly on top of `harness-connector/slot-scanner.mjs`.
 *
 * Reuses `scanWorkspaceCartridges` & `resolveCartridgeToken` from the universal
 * connector, and adds ONLY Antigravity Hook state:
 * - Per-conversation `/persona on [id]` / `/persona off` / `/persona boost` / `/persona status`
 * - `.persona` / `.no-persona` workspace overrides & `work_workspaces` isolation
 * - Dynamic Persona Concentration counters (`baseline_checkpoint_step`, `turns_since_baseline`)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../kit/core/ledger.mjs';
import {
  DEFAULT_KIT_ROOT,
  normalizeDirKey,
  normalizeRawDir,
  resolveCartridgeToken,
  scanWorkspaceCartridges
} from '../../harness-connector/slot-scanner.mjs';

export { DEFAULT_KIT_ROOT, resolveCartridgeToken, scanWorkspaceCartridges };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODE_CONFIG_PATH = path.join(__dirname, 'mode.config.json');
const DEFAULT_MODE_STATE_FILE = path.join(os.tmpdir(), 'pmv-ag-session-modes.json');
const MODE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const VALID_CARTRIDGE_TOKEN = /^[a-zA-Z0-9_-]{1,64}$/;

export const ANTIGRAVITY_MAX_RULE_BYTES = 24000;
export const ANTIGRAVITY_RULE_FILENAMES = Object.freeze(['AGENTS.md', 'GEMINI.md']);

const FALLBACK_CONFIG = Object.freeze({
  default_cartridge: 'starter',
  default_mode_without_workspace: 'work',
  assistant_workspaces: [],
  work_workspaces: [
    path.resolve(__dirname, '../../kit'),
    path.resolve(__dirname, '../../harness-connector')
  ],
  persona_concentration: {
    reboost_on_compaction: true,
    reboost_interval_turns: 20
  }
});

function resolveConfigDir(rawPath, baseDir) {
  const str = String(rawPath || '').trim();
  if (!str) return '';
  return path.isAbsolute(str) ? path.resolve(str) : path.resolve(baseDir, str);
}

function isSameOrSubPath(targetDir, rootDir) {
  const normTarget = normalizeDirKey(targetDir);
  const normRoot = normalizeDirKey(rootDir);
  if (!normTarget || !normRoot) return false;
  if (normTarget === normRoot) return true;
  const sep = process.platform === 'win32' ? '\\' : path.sep;
  return normTarget.startsWith(`${normRoot}${sep}`);
}

function splitEnvPaths(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBoolEnv(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const norm = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(norm)) return true;
  if (['0', 'false', 'no', 'off'].includes(norm)) return false;
  return fallback;
}

function parseNonNegInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export async function loadModeConfig(configPath = null) {
  const target = configPath || process.env.PMV_MODE_CONFIG || DEFAULT_MODE_CONFIG_PATH;
  const baseDir = path.dirname(path.resolve(target));
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    fileCfg = {};
  }

  const envAssistant = splitEnvPaths(process.env.PMV_ASSISTANT_WORKSPACES);
  const envWork = splitEnvPaths(process.env.PMV_WORK_WORKSPACES);
  const fileConc = fileCfg.persona_concentration || {};

  return {
    default_cartridge: String(
      process.env.PMV_CARTRIDGE || fileCfg.default_cartridge || FALLBACK_CONFIG.default_cartridge
    ).trim(),
    default_mode_without_workspace:
      fileCfg.default_mode_without_workspace === 'assistant' ? 'assistant' : 'work',
    assistant_workspaces:
      envAssistant.length > 0
        ? envAssistant
        : Array.isArray(fileCfg.assistant_workspaces)
          ? fileCfg.assistant_workspaces.map((p) => resolveConfigDir(p, baseDir)).filter(Boolean)
          : [...FALLBACK_CONFIG.assistant_workspaces],
    work_workspaces:
      envWork.length > 0
        ? envWork
        : Array.isArray(fileCfg.work_workspaces)
          ? fileCfg.work_workspaces.map((p) => resolveConfigDir(p, baseDir)).filter(Boolean)
          : [...FALLBACK_CONFIG.work_workspaces],
    persona_concentration: {
      reboost_on_compaction: parseBoolEnv(
        process.env.PMV_REBOOST_ON_COMPACTION,
        fileConc.reboost_on_compaction !== undefined
          ? Boolean(fileConc.reboost_on_compaction)
          : FALLBACK_CONFIG.persona_concentration.reboost_on_compaction
      ),
      reboost_interval_turns: parseNonNegInt(
        process.env.PMV_REBOOST_INTERVAL_TURNS,
        parseNonNegInt(
          fileConc.reboost_interval_turns,
          FALLBACK_CONFIG.persona_concentration.reboost_interval_turns
        )
      )
    }
  };
}

function getModeStateFile() {
  return process.env.PMV_MODE_STATE_FILE || DEFAULT_MODE_STATE_FILE;
}

async function readModeStateMap() {
  try {
    const parsed = JSON.parse(await fs.readFile(getModeStateFile(), 'utf8'));
    const now = Date.now();
    const cleaned = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      if (v && typeof v === 'object' && now - Number(v.updated_at || 0) < MODE_TTL_MS) {
        cleaned[k] = v;
      }
    }
    return cleaned;
  } catch {
    return {};
  }
}

async function writeModeStateMap(map) {
  const entries = Object.entries(map).slice(-200);
  const filePath = getModeStateFile();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, 'utf8');
}

export async function getConversationModeOverride(conversationId) {
  if (!conversationId) return null;
  const map = await readModeStateMap();
  return map[String(conversationId)] || null;
}

export async function setConversationModeOverride(conversationId, entry) {
  if (!conversationId) return null;
  const map = await readModeStateMap();
  const key = String(conversationId);
  const prev = map[key] || {};
  const record = {
    mode: entry.mode === 'assistant' ? 'assistant' : 'work',
    explicit_override: true,
    cartridge:
      entry.cartridge !== undefined
        ? entry.cartridge
          ? String(entry.cartridge).trim()
          : null
        : prev.cartridge || null,
    cartridge_path:
      entry.cartridge_path !== undefined
        ? entry.cartridge_path
          ? String(entry.cartridge_path).trim()
          : null
        : prev.cartridge_path || null,
    baseline_injected:
      entry.baseline_injected !== undefined
        ? entry.baseline_injected === true
        : prev.baseline_injected === true,
    baseline_checkpoint_step:
      entry.baseline_checkpoint_step !== undefined
        ? Number(entry.baseline_checkpoint_step)
        : Number.isFinite(Number(prev.baseline_checkpoint_step))
          ? Number(prev.baseline_checkpoint_step)
          : -1,
    turns_since_baseline:
      entry.turns_since_baseline !== undefined
        ? Number(entry.turns_since_baseline)
        : Number.isFinite(Number(prev.turns_since_baseline))
          ? Number(prev.turns_since_baseline)
          : 0,
    top_rules_active:
      entry.top_rules_active !== undefined
        ? entry.top_rules_active === true
        : prev.top_rules_active === true,
    updated_at: Date.now()
  };
  map[key] = record;
  await writeModeStateMap(map);
  return record;
}

export async function recordSessionTracking(conversationId, patch = {}) {
  if (!conversationId) return null;
  const map = await readModeStateMap();
  const key = String(conversationId);
  const prev = map[key] || null;
  const record = {
    mode: prev?.mode || (patch.mode === 'assistant' ? 'assistant' : 'work'),
    explicit_override: prev ? prev.explicit_override !== false : false,
    cartridge:
      patch.cartridge !== undefined
        ? patch.cartridge
          ? String(patch.cartridge).trim()
          : null
        : prev?.cartridge || null,
    cartridge_path:
      patch.cartridge_path !== undefined
        ? patch.cartridge_path
          ? String(patch.cartridge_path).trim()
          : null
        : prev?.cartridge_path || null,
    baseline_injected:
      patch.baseline_injected !== undefined
        ? patch.baseline_injected === true
        : prev?.baseline_injected === true,
    baseline_checkpoint_step:
      patch.baseline_checkpoint_step !== undefined
        ? Number(patch.baseline_checkpoint_step)
        : Number.isFinite(Number(prev?.baseline_checkpoint_step))
          ? Number(prev.baseline_checkpoint_step)
          : -1,
    turns_since_baseline:
      patch.turns_since_baseline !== undefined
        ? Number(patch.turns_since_baseline)
        : Number.isFinite(Number(prev?.turns_since_baseline))
          ? Number(prev.turns_since_baseline)
          : 0,
    top_rules_active:
      patch.top_rules_active !== undefined
        ? patch.top_rules_active === true
        : prev?.top_rules_active === true,
    updated_at: Date.now()
  };
  map[key] = record;
  await writeModeStateMap(map);
  return record;
}

async function readMarkerFile(wsDir) {
  try {
    await fs.access(path.join(wsDir, '.no-persona'));
    return { mode: 'work', source: 'marker:.no-persona', cartridge: null };
  } catch {
    // No .no-persona marker.
  }

  try {
    const raw = (await fs.readFile(path.join(wsDir, '.persona'), 'utf8')).trim();
    let cartridge = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.cartridge) cartridge = String(parsed.cartridge).trim();
      } catch {
        if (VALID_CARTRIDGE_TOKEN.test(raw)) cartridge = raw;
      }
    }
    return { mode: 'assistant', source: 'marker:.persona', cartridge };
  } catch {
    return null;
  }
}

export async function parsePersonaCommand(rawText, kitRoot, options = {}) {
  const trimmed = String(rawText || '').trim();
  const match = trimmed.match(/^\/persona(?:\s+(on|off|status|boost))(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const action = match[1].toLowerCase();
  const rest = (match[2] || '').trim();

  if (action === 'off' || action === 'status' || action === 'boost') {
    return { action, cartridge: null, cartridgePath: null, restText: rest };
  }
  if (!rest) {
    return { action: 'on', cartridge: null, cartridgePath: null, restText: '' };
  }

  const firstSpace = rest.search(/\s/);
  const firstToken = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  const remainder = firstSpace === -1 ? '' : rest.slice(firstSpace).trim();

  if (VALID_CARTRIDGE_TOKEN.test(firstToken)) {
    const hit = await resolveCartridgeToken(firstToken, {
      kitRoot,
      workspaceScan: options.workspaceScan || null
    });
    if (hit) {
      return {
        action: 'on',
        cartridge: hit.id,
        cartridgePath: hit.vaultPath,
        restText: remainder
      };
    }
  }

  return { action: 'on', cartridge: null, cartridgePath: null, restText: rest };
}

function extractCandidateDirs(payload = {}) {
  const rawWorkspaces = Array.isArray(payload.workspacePaths)
    ? payload.workspacePaths.filter(Boolean)
    : [];
  if (rawWorkspaces.length > 0) return rawWorkspaces;
  if (payload.cwd) return [payload.cwd];
  return [];
}

function extractTracking(savedRecord) {
  return {
    baseline_injected: savedRecord?.baseline_injected === true,
    baseline_checkpoint_step: Number.isFinite(Number(savedRecord?.baseline_checkpoint_step))
      ? Number(savedRecord.baseline_checkpoint_step)
      : -1,
    turns_since_baseline: Number.isFinite(Number(savedRecord?.turns_since_baseline))
      ? Number(savedRecord.turns_since_baseline)
      : 0,
    top_rules_active: savedRecord?.top_rules_active === true
  };
}

export async function resolveConversationMode(payload = {}, options = {}) {
  const cfg = await loadModeConfig(options.configPath || null);
  const conversationId = String(payload.conversationId || '').trim() || null;
  const candidateDirs = extractCandidateDirs(payload);
  const workspaceScan = await scanWorkspaceCartridges(candidateDirs);

  const saved = await getConversationModeOverride(conversationId);
  const tracking = extractTracking(saved);

  const baseMeta = {
    candidate_dirs: candidateDirs,
    workspace_scan: workspaceScan,
    interlocked: false,
    interlocked_cartridges: [],
    slot_workspace: null,
    cartridge_path: null,
    ...tracking,
    config: cfg
  };

  if (saved && saved.explicit_override !== false) {
    return {
      ...baseMeta,
      mode: saved.mode,
      cartridge: saved.cartridge || cfg.default_cartridge,
      cartridge_path: saved.cartridge_path || null,
      source: 'session_override'
    };
  }

  const forceMode = String(process.env.PMV_FORCE_MODE || '').trim().toLowerCase();
  if (forceMode === 'assistant' || forceMode === 'work') {
    return {
      ...baseMeta,
      mode: forceMode,
      cartridge: cfg.default_cartridge,
      source: 'env_force_mode'
    };
  }

  if (candidateDirs.length > 0) {
    for (const dir of candidateDirs) {
      const marker = await readMarkerFile(dir);
      if (marker && marker.mode === 'work') {
        return {
          ...baseMeta,
          mode: 'work',
          cartridge: cfg.default_cartridge,
          source: marker.source
        };
      }
      if (cfg.work_workspaces.some((w) => isSameOrSubPath(dir, w))) {
        return {
          ...baseMeta,
          mode: 'work',
          cartridge: cfg.default_cartridge,
          source: 'work_workspace'
        };
      }
    }

    for (const dir of candidateDirs) {
      const marker = await readMarkerFile(dir);
      if (marker && marker.mode === 'assistant') {
        const wsMatch = marker.cartridge
          ? workspaceScan.cartridges.find((c) => c.id === marker.cartridge)
          : workspaceScan.primary;
        return {
          ...baseMeta,
          mode: 'assistant',
          cartridge: marker.cartridge || wsMatch?.id || cfg.default_cartridge,
          cartridge_path: wsMatch?.vaultPath || null,
          slot_workspace: normalizeRawDir(dir),
          source: marker.source
        };
      }
    }

    if (workspaceScan.status === 'single' && workspaceScan.primary) {
      return {
        ...baseMeta,
        mode: 'assistant',
        cartridge: workspaceScan.primary.id,
        cartridge_path: workspaceScan.primary.vaultPath,
        slot_workspace: workspaceScan.primary.workspace,
        source: 'workspace_cartridge_slot'
      };
    }

    if (workspaceScan.status === 'interlocked') {
      return {
        ...baseMeta,
        mode: 'work',
        cartridge: null,
        cartridge_path: null,
        interlocked: true,
        interlocked_cartridges: workspaceScan.cartridges.map((c) => ({
          id: c.id,
          vaultPath: c.vaultPath,
          placement: c.placement
        })),
        source: 'workspace_multi_cartridge_interlock'
      };
    }

    for (const dir of candidateDirs) {
      if (cfg.assistant_workspaces.some((a) => isSameOrSubPath(dir, a))) {
        return {
          ...baseMeta,
          mode: 'assistant',
          cartridge: cfg.default_cartridge,
          slot_workspace: normalizeRawDir(dir),
          source: 'assistant_workspace'
        };
      }
    }

    return {
      ...baseMeta,
      mode: 'work',
      cartridge: cfg.default_cartridge,
      source: 'default_code_workspace'
    };
  }

  if (process.env.PMV_CARTRIDGE && payload.workspacePaths === undefined) {
    return {
      ...baseMeta,
      mode: 'assistant',
      cartridge: String(process.env.PMV_CARTRIDGE).trim(),
      source: 'env_cartridge'
    };
  }

  return {
    ...baseMeta,
    mode: cfg.default_mode_without_workspace,
    cartridge: cfg.default_cartridge,
    source: 'default_no_workspace'
  };
}

export function buildTurnDedupKey(sessionId, userText, initialNumSteps = null, isCommand = false) {
  if (isCommand && initialNumSteps !== null && initialNumSteps !== undefined) {
    return sha256(`${sessionId || 'none'}\0cmd\0${initialNumSteps}\0${userText}`);
  }
  return sha256(`${sessionId || 'none'}\0${userText}`);
}
