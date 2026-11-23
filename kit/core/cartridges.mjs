/**
 * @fileoverview Local character cartridge registry (`cartridges.local.json`)
 * with automatic shelf-directory discovery (`cartridges_dir`, `PMV_CARTRIDGES_DIR`,
 * or sibling `../cassettes`). Allows all harness adapters to switch/mount
 * character vaults without code changes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CARTRIDGES_SCHEMA = 'pmv-cartridges/v1';
const DEFAULT_KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function discoverCartridgesInDir(cartridgesDir) {
  const discovered = {};
  if (!cartridgesDir) return discovered;
  const absDir = path.resolve(String(cartridgesDir));
  let entries = [];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return discovered;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const vaultPath = path.join(absDir, entry.name);
    const manifestPath = path.join(vaultPath, 'character.manifest.json');
    try {
      const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const charId = String(parsed?.character?.id || entry.name).trim();
      if (charId) discovered[charId] = vaultPath;
    } catch {
      // Skip non-cartridge directories.
    }
  }
  return discovered;
}

function resolveRelativeToKit(kitRoot, rawPath) {
  const str = String(rawPath || '').trim();
  if (!str) return '';
  return path.isAbsolute(str) ? path.resolve(str) : path.resolve(kitRoot, str);
}

/**
 * Load `cartridges.local.json` from `kitRoot`, merging any auto-discovered
 * cartridges from `PMV_CARTRIDGES_DIR` / `cartridges_dir` (or sibling `../cassettes`
 * when `cartridges.local.json` does not exist).
 *
 * @param {string} [kitRoot]
 */
export async function loadCartridgesRegistry(kitRoot = DEFAULT_KIT_ROOT) {
  const filePath = path.join(kitRoot, 'cartridges.local.json');
  const envShelfDir = process.env.PMV_CARTRIDGES_DIR
    ? resolveRelativeToKit(kitRoot, process.env.PMV_CARTRIDGES_DIR)
    : null;

  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const cartridgesDir =
      envShelfDir ||
      (parsed.cartridges_dir ? resolveRelativeToKit(kitRoot, parsed.cartridges_dir) : null);
    const discovered = cartridgesDir ? await discoverCartridgesInDir(cartridgesDir) : {};
    const explicit = {};
    if (parsed.cartridges && typeof parsed.cartridges === 'object') {
      for (const [id, p] of Object.entries(parsed.cartridges)) {
        explicit[id] = resolveRelativeToKit(kitRoot, p);
      }
    }
    const merged = { ...discovered, ...explicit };
    const defaultId = parsed.default_cartridge
      ? String(parsed.default_cartridge)
      : Object.keys(merged)[0] || null;
    return {
      schema: CARTRIDGES_SCHEMA,
      cartridges_dir: cartridgesDir,
      default_cartridge: defaultId,
      cartridges: merged
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      const shelfDir = envShelfDir || path.resolve(kitRoot, '..', 'cassettes');
      const discovered = await discoverCartridgesInDir(shelfDir);
      const ids = Object.keys(discovered);
      return {
        schema: CARTRIDGES_SCHEMA,
        cartridges_dir: ids.length > 0 || envShelfDir ? shelfDir : null,
        default_cartridge: ids.length > 0 ? ids[0] : null,
        cartridges: discovered
      };
    }
    throw err;
  }
}

/**
 * Persist `cartridges.local.json` to disk cleanly.
 *
 * @param {string} kitRoot
 * @param {{ schema?: string, cartridges_dir?: string | null, default_cartridge: string | null, cartridges: Record<string, string> }} registry
 */
export async function saveCartridgesRegistry(kitRoot = DEFAULT_KIT_ROOT, registry) {
  const filePath = path.join(kitRoot, 'cartridges.local.json');
  const payload = {
    schema: CARTRIDGES_SCHEMA,
    ...(registry.cartridges_dir ? { cartridges_dir: registry.cartridges_dir } : {}),
    default_cartridge: registry.default_cartridge || null,
    cartridges: registry.cartridges || {}
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

/**
 * Register or update a character cartridge ID -> vaultPath mapping.
 *
 * @param {string} kitRoot
 * @param {{ id: string, vaultPath: string, setDefault?: boolean }} options
 */
export async function registerCartridge(kitRoot = DEFAULT_KIT_ROOT, options) {
  const id = String(options?.id || '').trim();
  if (!id) throw new Error('registerCartridge requires a non-empty id');
  const absVault = path.resolve(String(options.vaultPath || ''));

  const registry = await loadCartridgesRegistry(kitRoot);
  registry.cartridges[id] = absVault;
  if (options.setDefault || !registry.default_cartridge) {
    registry.default_cartridge = id;
  }
  return saveCartridgesRegistry(kitRoot, registry);
}

/**
 * Update the default cartridge ID in `cartridges.local.json`.
 *
 * @param {string} kitRoot
 * @param {string} id
 */
export async function setDefaultCartridge(kitRoot = DEFAULT_KIT_ROOT, id) {
  const cleanId = String(id || '').trim();
  const registry = await loadCartridgesRegistry(kitRoot);
  if (!registry.cartridges[cleanId]) {
    throw new Error(`Cartridge "${cleanId}" is not registered in cartridges.local.json`);
  }
  registry.default_cartridge = cleanId;
  return saveCartridgesRegistry(kitRoot, registry);
}

function looksLikePath(val) {
  return /[\\/:]/.test(val) || val.startsWith('.');
}

/**
 * Resolve either a registered cartridge ID, an explicit filesystem path, or
 * the default cartridge (`PMV_DEFAULT_CARTRIDGE` / `default_cartridge`).
 *
 * @param {string} [kitRoot]
 * @param {string | null} [idOrPath]
 * @returns {Promise<{ id: string | null, vaultPath: string }>}
 */
export async function resolveCartridgePath(kitRoot = DEFAULT_KIT_ROOT, idOrPath = null) {
  const registry = await loadCartridgesRegistry(kitRoot);
  const candidate = idOrPath ? String(idOrPath).trim() : '';

  if (candidate) {
    if (registry.cartridges[candidate]) {
      return { id: candidate, vaultPath: path.resolve(registry.cartridges[candidate]) };
    }
    if (looksLikePath(candidate)) {
      const resolved = path.resolve(candidate);
      const matchedEntry = Object.entries(registry.cartridges).find(
        ([, p]) => path.resolve(p).toLowerCase() === resolved.toLowerCase()
      );
      return { id: matchedEntry ? matchedEntry[0] : null, vaultPath: resolved };
    }
    throw new Error(`Cartridge "${candidate}" is not registered in cartridges.local.json`);
  }

  const defaultId = process.env.PMV_DEFAULT_CARTRIDGE || registry.default_cartridge;
  if (defaultId && registry.cartridges[defaultId]) {
    return { id: defaultId, vaultPath: path.resolve(registry.cartridges[defaultId]) };
  }

  throw new Error('No cartridge ID provided and no default_cartridge configured');
}
