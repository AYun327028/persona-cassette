/**
 * @fileoverview Universal Physical Cartridge Slot Scanner & Two-Mode Resolver
 * (100% host-agnostic; zero dependency on Antigravity or any specific client).
 *
 * Two clean physical usage modes:
 * 1. **Workspace Drop-In Cartridge Slot** (`character.manifest.json` in workspace
 *    root or direct 1st-level subdirectories):
 *    - Exactly 1 cartridge -> auto-selected (zero registration needed).
 *    - >= 2 cartridges -> **Multi-Cartridge Interlock** (refuses to guess;
 *      caller must pass an explicit `cartridge` ID or path).
 * 2. **Fixed Cartridge Repository** (`cartridges_dir`, `PMV_CARTRIDGES_DIR`,
 *    `cartridges.local.json`, or sibling `cassettes/`):
 *    Auto-discovers every cartridge folder inside the shelf directory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCartridgesRegistry } from '../kit/core/cartridges.mjs';

export const DEFAULT_KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../kit');

const SKIP_SCAN_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
  '.git',
  '.agents',
  '.agent',
  '.gemini',
  '.vscode'
]);

export function normalizeRawDir(p) {
  if (!p) return '';
  let str = String(p).trim();
  if (/^file:\/\//i.test(str)) {
    try {
      str = fileURLToPath(str);
    } catch {
      // Keep raw string if malformed URI.
    }
  }
  return path.resolve(str).replace(/[\\/]+$/, '');
}

export function normalizeDirKey(p) {
  const resolved = normalizeRawDir(p);
  if (!resolved) return '';
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function looksLikePath(val) {
  const str = String(val || '').trim();
  return /[\\/:]/.test(str) || str.startsWith('.');
}

async function readCartridgeManifestAt(dirPath) {
  const manifestPath = path.join(dirPath, 'character.manifest.json');
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const isPmvSchema =
      typeof parsed.schema === 'string' && parsed.schema.startsWith('pmv-character-manifest');
    const charId = String(parsed.character?.id || '').trim();
    if (!isPmvSchema && !charId) return null;
    return {
      id: charId || path.basename(dirPath),
      name: String(
        parsed.character?.display_name || parsed.character?.name || charId || path.basename(dirPath)
      ),
      vaultPath: dirPath
    };
  } catch {
    return null;
  }
}

/**
 * Scan one or more workspace directories for physical persona cartridges
 * (`character.manifest.json`) at workspace root OR direct 1st-level subdirectories.
 *
 * Never recurses into nested template/example folders (`cassettes/`, `examples/`, `tests/`).
 *
 * @param {string[]} candidateDirs
 */
export async function scanWorkspaceCartridges(candidateDirs) {
  const dirs = Array.isArray(candidateDirs) ? candidateDirs.filter(Boolean) : [];
  const seenVaults = new Set();
  const found = [];

  for (const rawDir of dirs) {
    const wsDir = normalizeRawDir(rawDir);
    if (!wsDir) continue;

    // 1. Workspace root itself is a cartridge
    const rootHit = await readCartridgeManifestAt(wsDir);
    if (rootHit) {
      const key = normalizeDirKey(rootHit.vaultPath);
      if (!seenVaults.has(key)) {
        seenVaults.add(key);
        found.push({ ...rootHit, workspace: wsDir, placement: 'workspace_root' });
      }
    }

    // 2. Direct 1st-level subdirectories of the workspace
    let entries = [];
    try {
      entries = await fs.readdir(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_SCAN_DIRS.has(entry.name)) continue;
      const subDir = path.join(wsDir, entry.name);
      const subHit = await readCartridgeManifestAt(subDir);
      if (!subHit) continue;
      const key = normalizeDirKey(subHit.vaultPath);
      if (!seenVaults.has(key)) {
        seenVaults.add(key);
        found.push({ ...subHit, workspace: wsDir, placement: 'workspace_subdir' });
      }
    }
  }

  if (found.length === 0) {
    return { status: 'none', cartridges: [], primary: null };
  }
  if (found.length === 1) {
    return { status: 'single', cartridges: found, primary: found[0] };
  }
  return { status: 'interlocked', cartridges: found, primary: null };
}

/**
 * Resolve a cartridge ID token against BOTH workspace-discovered cartridges
 * (including interlocked multi-cartridge workspaces) and the fixed cartridge
 * repository (`cartridges_dir` / `cartridges.local.json`).
 *
 * @param {string | null} token
 * @param {{ kitRoot?: string, workspaceScan?: Awaited<ReturnType<typeof scanWorkspaceCartridges>> | null }} [options]
 */
export async function resolveCartridgeToken(token, options = {}) {
  const clean = token ? String(token).trim() : '';
  if (!clean) return null;

  const wsCarts = options.workspaceScan?.cartridges || [];
  const wsHit = wsCarts.find((c) => c.id === clean);
  if (wsHit) {
    return { id: wsHit.id, vaultPath: wsHit.vaultPath, source: 'workspace' };
  }

  try {
    const registry = await loadCartridgesRegistry(options.kitRoot || DEFAULT_KIT_ROOT);
    if (registry?.cartridges && Object.prototype.hasOwnProperty.call(registry.cartridges, clean)) {
      return { id: clean, vaultPath: path.resolve(registry.cartridges[clean]), source: 'repository' };
    }
  } catch {
    // Ignore registry load failure.
  }

  return null;
}

/**
 * Unified cartridge resolver for any plug-and-play connector or MCP tool:
 * 1. Explicit `cartridge` (path, workspace cartridge ID, or repository ID)
 * 2. Workspace scan when `workspacePath` is supplied:
 *    - `single` -> returns that cartridge's `vaultPath`
 *    - `interlocked` -> throws a clear interlock error listing conflicting IDs
 *    - `none` -> falls back to fixed cartridge repository default
 *
 * @param {{ cartridge?: string | null, workspacePath?: string | null, kitRoot?: string }} [options]
 */
export async function resolveConnectorCartridge(options = {}) {
  const kitRoot = options.kitRoot || DEFAULT_KIT_ROOT;
  const wsPath = options.workspacePath ? String(options.workspacePath).trim() : '';
  const workspaceScan = wsPath
    ? await scanWorkspaceCartridges([wsPath])
    : { status: 'none', cartridges: [], primary: null };
  const explicit = options.cartridge ? String(options.cartridge).trim() : '';

  if (explicit) {
    if (looksLikePath(explicit)) {
      return {
        cartridgeRef: path.resolve(explicit),
        cartridgeId: null,
        workspaceScan,
        source: 'explicit_path'
      };
    }
    const tokenHit = await resolveCartridgeToken(explicit, { kitRoot, workspaceScan });
    if (tokenHit) {
      return {
        cartridgeRef: tokenHit.vaultPath,
        cartridgeId: tokenHit.id,
        workspaceScan,
        source: tokenHit.source
      };
    }
    return {
      cartridgeRef: explicit,
      cartridgeId: explicit,
      workspaceScan,
      source: 'explicit_id'
    };
  }

  if (workspaceScan.status === 'interlocked') {
    const ids = workspaceScan.cartridges.map((c) => c.id).join(', ');
    throw new Error(
      `Multi-cartridge interlock active in workspace "${wsPath}": found ${workspaceScan.cartridges.length} cartridges (${ids}). Pass "cartridge" explicitly to select one.`
    );
  }

  if (workspaceScan.status === 'single' && workspaceScan.primary) {
    return {
      cartridgeRef: workspaceScan.primary.vaultPath,
      cartridgeId: workspaceScan.primary.id,
      workspaceScan,
      source: 'workspace_cartridge_slot'
    };
  }

  return {
    cartridgeRef: null,
    cartridgeId: null,
    workspaceScan,
    source: 'cartridge_repository'
  };
}
