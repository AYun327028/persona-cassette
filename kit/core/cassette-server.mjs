/**
 * @fileoverview Headless Cartridge Context Protocol HTTP Server.
 *
 * Exposes cartridge memory recall, unified context assembly, and ledger commit
 * over localhost HTTP without proxying LLM APIs or touching user LLM API keys.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /cartridges
 *   POST /cartridges/:id/assemble
 *   POST /cartridges/:id/commit
 *   POST /cartridges/:id/dream
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCartridgesRegistry, resolveCartridgePath } from './cartridges.mjs';
import {
  assembleTurn,
  beginSession,
  closeAllCachedReaders,
  commitTurn
} from './context-assembler.mjs';
import { runDream } from './dream-runner.mjs';
import { readSnapshotManifest } from './rivermemo-snapshot.mjs';
import { loadVault, readActivityState } from './runtime.mjs';

const DEFAULT_KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 8 * 1024 * 1024) {
      throw new Error('Request body exceeds 8MB limit');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function listCartridgesSummary(kitRoot) {
  const registry = await loadCartridgesRegistry(kitRoot);
  const items = [];
  for (const [id, vaultPath] of Object.entries(registry.cartridges || {})) {
    try {
      const vault = await loadVault(vaultPath, { kitRoot });
      const snap = await readSnapshotManifest(vaultPath);
      const activity = await readActivityState(vaultPath);
      items.push({
        id,
        display_name: vault.manifest?.character?.display_name || id,
        vault_path: vaultPath,
        is_default: registry.default_cartridge === id,
        has_snapshot: Boolean(snap),
        snapshot_version: snap?.snapshot_version || null,
        context_assembly: vault.manifest?.context_assembly || null,
        dream_due: activity.turns_since_dream >= activity.dream_threshold_turns,
        turns_since_dream: activity.turns_since_dream
      });
    } catch (err) {
      items.push({
        id,
        vault_path: vaultPath,
        is_default: registry.default_cartridge === id,
        error: err?.message || String(err)
      });
    }
  }
  return {
    kit_root: kitRoot,
    cartridges_dir: registry.cartridges_dir || null,
    default_cartridge: registry.default_cartridge || null,
    cartridges: items
  };
}

/**
 * Start the headless Cartridge Context Protocol server.
 *
 * @param {{
 *   kitRoot?: string,
 *   host?: string,
 *   port?: number,
 *   providersConfig?: Record<string, any>,
 *   decisionClient?: any,
 *   embeddingClient?: any
 * }} [options]
 */
export async function startCassetteServer(options = {}) {
  const kitRoot = path.resolve(options.kitRoot || DEFAULT_KIT_ROOT);
  const host = options.host || '127.0.0.1';
  const port = options.port !== undefined ? Number(options.port) : 3891;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${host}:${port || 80}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { ok: true, service: 'pmv-cassette-protocol', kit_root: kitRoot });
      }

      if (req.method === 'GET' && pathname === '/cartridges') {
        const data = await listCartridgesSummary(kitRoot);
        return sendJson(res, 200, data);
      }

      const sessionStartMatch = pathname.match(/^\/cartridges\/([^/]+)\/session\/start$/);
      if (req.method === 'POST' && sessionStartMatch) {
        const rawId = decodeURIComponent(sessionStartMatch[1]);
        const cartridgeTarget = rawId === 'default' ? null : rawId;
        const body = await readJsonBody(req);
        const result = await beginSession(cartridgeTarget, {
          ...body,
          kitRoot,
          stateDir: options.stateDir
        });
        return sendJson(res, 200, result);
      }

      const actionMatch = pathname.match(/^\/cartridges\/([^/]+)\/(assemble|commit|dream)$/);
      if (req.method === 'POST' && actionMatch) {
        const rawId = decodeURIComponent(actionMatch[1]);
        const action = actionMatch[2];
        const cartridgeTarget = rawId === 'default' ? null : rawId;
        const body = await readJsonBody(req);

        if (action === 'assemble') {
          const result = await assembleTurn(cartridgeTarget, {
            ...body,
            kitRoot,
            stateDir: options.stateDir,
            providersConfig: options.providersConfig,
            decisionClient: options.decisionClient,
            embeddingClient: options.embeddingClient
          });
          return sendJson(res, 200, result);
        }

        if (action === 'commit') {
          const result = await commitTurn(cartridgeTarget, {
            ...body,
            kitRoot
          });
          return sendJson(res, 200, result);
        }

        if (action === 'dream') {
          const { vaultPath } = await resolveCartridgePath(kitRoot, cartridgeTarget);
          const result = await runDream(vaultPath, {
            kitRoot,
            dryRun: body.dryRun === true,
            minSalience: body.minSalience !== undefined ? Number(body.minSalience) : 0.45,
            providerId: body.providerId ? String(body.providerId) : null
          });
          return sendJson(res, 200, result);
        }
      }

      return sendJson(res, 404, { error: `Not found: ${req.method} ${pathname}` });
    } catch (err) {
      const msg = err?.message || String(err);
      const status = /not registered|requires|non-empty|JSON/i.test(msg) ? 400 : 500;
      return sendJson(res, status, { error: msg });
    }
  });

  server.on('close', () => {
    closeAllCachedReaders();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`
  };
}
