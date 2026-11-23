/**
 * @fileoverview Local-only HTTP API and UI server for the offline RiverMemo Studio.
 * Bound strictly to 127.0.0.1.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProvidersConfig } from '../core/decision-provider.mjs';
import {
  computeModelSig,
  createEmbeddingClient,
  resolveEmbeddingProvider
} from '../core/embedding-provider.mjs';
import { loadManifest } from '../core/manifest.mjs';
import {
  bakeSnapshot,
  openSnapshotReader,
  readSnapshotManifest,
  readSnapshotRules,
  RIVER_RULES_SCHEMA
} from '../core/rivermemo-snapshot.mjs';
import { lintTags } from '../core/tags.mjs';
import {
  RIVER_DEFAULTS,
  RIVER_PRESETS,
  resolveRiverRules
} from '../native/vexus-bridge.mjs';

const STUDIO_DIR = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(STUDIO_DIR, '..');

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readRegressionQueries(vaultPath) {
  const filePath = path.join(vaultPath, 'tags', 'regression-queries.json');
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return Array.isArray(parsed?.queries) ? parsed.queries : (Array.isArray(parsed) ? parsed : []);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function computeComparisonDiff(baselineItems, candidateItems) {
  const baseById = new Map(baselineItems.map((it) => [it.id, it]));
  const candById = new Map(candidateItems.map((it) => [it.id, it]));
  const allIds = [...new Set([...candById.keys(), ...baseById.keys()])];

  return allIds.map((id) => {
    const b = baseById.get(id) || null;
    const c = candById.get(id) || null;
    const baseRank = b ? b.rank : null;
    const candRank = c ? c.rank : null;
    const rankDelta = baseRank !== null && candRank !== null ? baseRank - candRank : null;
    const baseScore = b ? b.score : 0;
    const candScore = c ? c.score : 0;
    return {
      id,
      title: (c || b)?.title || id,
      path: (c || b)?.path || '',
      baselineRank: baseRank,
      candidateRank: candRank,
      rankDelta,
      baselineScore: baseScore,
      candidateScore: candScore,
      scoreDelta: Number((candScore - baseScore).toFixed(4)),
      role: (c || b)?.role || '',
      matchedTags: (c || b)?.matchedTags || []
    };
  });
}

/**
 * Create the local RiverMemo Studio HTTP server without automatically binding a port.
 *
 * @param {{ vaultPath: string, kitRoot?: string, providersOverride?: Record<string, any> | null, fetchImpl?: typeof fetch }} options
 */
export function createStudioServer(options) {
  const { vaultPath, kitRoot = KIT_ROOT, providersOverride = null, fetchImpl } = options;

  const getProviders = async () => {
    if (providersOverride) return providersOverride;
    return loadProvidersConfig(kitRoot);
  };

  const resolveProviderByIdOrMatch = (providers, embeddingStatus, providerId) => {
    const candidates = (providers.embedding_providers || []).map((p) => ({
      ...p,
      model_sig: computeModelSig(p)
    }));
    if (providerId) {
      return candidates.find((p) => p.id === providerId || p.model_sig === providerId) || null;
    }
    return embeddingStatus.providerConfig || null;
  };

  return http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = reqUrl.pathname;

      if (req.method === 'GET' && pathname === '/') {
        const html = await fs.readFile(path.join(STUDIO_DIR, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        const manifest = await loadManifest(vaultPath);
        const snapshotManifest = await readSnapshotManifest(vaultPath);
        const savedRulesDoc = await readSnapshotRules(vaultPath);
        const providers = await getProviders();
        const embeddingStatus = resolveEmbeddingProvider(manifest, snapshotManifest, providers);
        const regressionQueries = await readRegressionQueries(vaultPath);
        const presetsMeta = Object.fromEntries(
          Object.entries(RIVER_PRESETS).map(([k, v]) => [k, { label: v.label, description: v.description }])
        );

        sendJson(res, 200, {
          vaultPath,
          manifest,
          snapshotManifest,
          embeddingStatus,
          riverRules: savedRulesDoc || {
            schema: RIVER_RULES_SCHEMA,
            preset: 'balanced',
            rules: resolveRiverRules('balanced')
          },
          presets: presetsMeta,
          defaults: RIVER_DEFAULTS,
          regressionQueries
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/lint') {
        const report = await lintTags(vaultPath, { fix: false });
        sendJson(res, 200, report);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/lint/fix') {
        const report = await lintTags(vaultPath, { fix: true });
        sendJson(res, 200, report);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/rules') {
        const body = await readJsonBody(req);
        const preset = String(body.preset || 'balanced');
        const rulesOverride = body.rulesOverride || {};
        const resolved = resolveRiverRules(preset, rulesOverride);
        const snapManifest = await readSnapshotManifest(vaultPath);
        const payload = { schema: RIVER_RULES_SCHEMA, preset, rules: resolved };

        if (snapManifest) {
          await fs.writeFile(
            path.join(vaultPath, 'snapshot', 'rivermemo.snap', 'river_rules.json'),
            `${JSON.stringify(payload, null, 2)}\n`,
            'utf8'
          );
        }
        sendJson(res, 200, { saved: Boolean(snapManifest), ...payload });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/test-query') {
        const body = await readJsonBody(req);
        const manifest = await loadManifest(vaultPath);
        const snapshotManifest = await readSnapshotManifest(vaultPath);
        if (!snapshotManifest) {
          sendJson(res, 400, { error: 'NO_SNAPSHOT_BAKED', message: '请先烘焙只读快照后再运行召回对比。' });
          return;
        }

        const providers = await getProviders();
        const embeddingStatus = resolveEmbeddingProvider(manifest, snapshotManifest, providers);
        const providerCfg = resolveProviderByIdOrMatch(providers, embeddingStatus, body.providerId);
        if (!providerCfg) {
          sendJson(res, 409, {
            error: 'EMBEDDING_SIGNATURE_MISMATCH',
            expectedSignature: snapshotManifest.embedding?.model_sig,
            message: embeddingStatus.message
          });
          return;
        }

        if (computeModelSig(providerCfg) !== snapshotManifest.embedding?.model_sig) {
          sendJson(res, 409, {
            error: 'EMBEDDING_SIGNATURE_MISMATCH',
            expectedSignature: snapshotManifest.embedding?.model_sig,
            incomingSignature: computeModelSig(providerCfg),
            message: '测试向量模型与当前快照签名不一致，禁止混用向量空间。'
          });
          return;
        }

        const queryList = Array.isArray(body.queries) && body.queries.length > 0
          ? body.queries.map((q) => (typeof q === 'string' ? { text: q } : q))
          : [{ text: String(body.query || '').trim() }];

        if (!queryList[0]?.text) {
          sendJson(res, 400, { error: 'EMPTY_QUERY', message: 'Query text is required' });
          return;
        }

        const client = createEmbeddingClient(providerCfg, { fetchImpl });
        const reader = await openSnapshotReader(vaultPath);
        try {
          const baselinePreset = String(body.baselinePreset || snapshotManifest.preset || 'balanced');
          const candidatePreset = String(body.candidatePreset || baselinePreset);
          const candidateRulesOverride = body.candidateRulesOverride || {};
          const topK = body.topK ? Number(body.topK) : undefined;

          const comparisons = [];
          for (const qItem of queryList) {
            const vec = await client.embedOne(qItem.text);
            const baseline = await reader.query({
              text: qItem.text,
              vector: vec,
              preset: baselinePreset,
              topK,
              includeTrace: true
            });
            const candidate = await reader.query({
              text: qItem.text,
              vector: vec,
              preset: candidatePreset,
              rulesOverride: candidateRulesOverride,
              topK,
              includeTrace: true
            });
            comparisons.push({
              query: qItem.text,
              baseline,
              candidate,
              diff: computeComparisonDiff(baseline.items, candidate.items)
            });
          }

          sendJson(res, 200, {
            ...(comparisons.length === 1 ? comparisons[0] : {}),
            comparisons
          });
        } finally {
          reader.close();
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/bake') {
        const body = await readJsonBody(req);
        const manifest = await loadManifest(vaultPath);
        const snapshotManifest = await readSnapshotManifest(vaultPath);
        const providers = await getProviders();
        const embeddingStatus = resolveEmbeddingProvider(manifest, snapshotManifest, providers);
        const providerCfg = resolveProviderByIdOrMatch(providers, embeddingStatus, body.providerId);

        if (!providerCfg) {
          sendJson(res, 400, {
            error: 'NO_EMBEDDING_PROVIDER',
            message: '请选择或配置一个可用的向量模型服务。'
          });
          return;
        }

        const client = createEmbeddingClient(providerCfg, { fetchImpl });
        try {
          const confirmed = body.confirmFullRebake === true;
          const result = await bakeSnapshot(vaultPath, {
            embeddingClient: client,
            providerConfig: providerCfg,
            preset: String(body.preset || 'balanced'),
            rulesOverride: body.rulesOverride || {},
            forceFullRebake: Boolean(body.forceFullRebake || confirmed),
            allowSignatureSwitch: confirmed,
            signedBy: String(body.signedBy || 'user'),
            signSource: String(body.signSource || 'user_signed')
          });
          sendJson(res, 200, result);
        } catch (err) {
          if (err?.code === 'EMBEDDING_SIGNATURE_MISMATCH') {
            sendJson(res, 409, {
              error: err.code,
              message: err.message,
              ...err.details
            });
            return;
          }
          throw err;
        }
        return;
      }

      sendJson(res, 404, { error: 'NOT_FOUND', path: pathname });
    } catch (err) {
      sendJson(res, 500, {
        error: err?.code || 'INTERNAL_ERROR',
        message: err?.message || String(err)
      });
    }
  });
}

/**
 * Start the RiverMemo Studio HTTP server strictly bound to 127.0.0.1.
 *
 * @param {{ vaultPath: string, kitRoot?: string, port?: number, host?: string }} options
 */
export async function startStudioServer(options) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? 3456);
  const server = createStudioServer(options);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return { server, url: `http://${host}:${actualPort}` };
}
