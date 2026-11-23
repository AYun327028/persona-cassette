/**
 * @fileoverview Pluggable EmbeddingProvider abstraction and strict operation
 * signature state machine (auto-match -> mismatch circuit-breaker -> full rebake).
 */

import { loadManifest, saveManifest } from './manifest.mjs';

/**
 * Compute canonical embedding operation signature string.
 *
 * @param {{ provider?: string, model_id?: string, dimension?: number }} cfg
 * @returns {string | null}
 */
export function computeModelSig(cfg) {
  if (!cfg?.provider || !cfg?.model_id || !Number.isFinite(Number(cfg?.dimension))) {
    return null;
  }
  return `${String(cfg.provider).trim()}::${String(cfg.model_id).trim()}::${Number(cfg.dimension)}`;
}

/**
 * L2-normalize a numeric vector into a Float32Array.
 *
 * @param {ArrayLike<number>} vec
 * @returns {Float32Array}
 */
export function l2Normalize(vec) {
  const out = new Float32Array(vec.length);
  let sumSq = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const val = Number(vec[i]);
    if (!Number.isFinite(val)) {
      throw new TypeError(`Embedding vector contains non-finite value at index ${i}`);
    }
    out[i] = val;
    sumSq += val * val;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 1e-12) {
    for (let i = 0; i < out.length; i += 1) {
      out[i] /= norm;
    }
  }
  return out;
}

/**
 * Resolve available local embedding providers against the vault manifest and
 * existing RiverMemo snapshot signature using a strict 3-state machine:
 * - `unsigned`: neither snapshot nor manifest has signed an embedding model yet.
 * - `matched`: a configured local provider matches `model_sig + dimension` exactly.
 * - `mismatch`: hard circuit-breaker; requires explicit full re-bake approval.
 *
 * @param {Record<string, any>} manifest
 * @param {Record<string, any> | null} snapshotManifest
 * @param {{ embedding_providers?: Array<Record<string, any>> }} providersConfig
 */
export function resolveEmbeddingProvider(manifest, snapshotManifest, providersConfig) {
  const candidates = (providersConfig?.embedding_providers || []).map((p) => ({
    ...p,
    model_sig: computeModelSig(p)
  }));

  const snapEmb = snapshotManifest?.embedding || null;
  const manifestEmb = manifest?.preferred_models?.embedding || null;
  const hasSignedManifest = manifestEmb?.status === 'signed' && Boolean(manifestEmb?.model_sig);

  const expectedSignature = snapEmb?.model_sig || (hasSignedManifest ? manifestEmb.model_sig : null);
  const expectedDimension = snapEmb?.dimension || (hasSignedManifest ? manifestEmb.dimension : null);

  if (!expectedSignature) {
    return {
      state: 'unsigned',
      expectedSignature: null,
      expectedDimension: null,
      providerConfig: null,
      candidates,
      requiresFullRebakeConfirmation: false,
      message: '尚未签写向量模型操作签名，请从可用提供方中现场选定并签名后再首次烘焙快照。'
    };
  }

  const matched = candidates.find(
    (c) => c.model_sig === expectedSignature && Number(c.dimension) === Number(expectedDimension)
  );

  if (matched) {
    return {
      state: 'matched',
      expectedSignature,
      expectedDimension: Number(expectedDimension),
      providerConfig: matched,
      candidates,
      requiresFullRebakeConfirmation: false,
      message: `已自动匹配向量操作签名：${expectedSignature}`
    };
  }

  return {
    state: 'mismatch',
    expectedSignature,
    expectedDimension: expectedDimension ? Number(expectedDimension) : null,
    providerConfig: null,
    candidates,
    requiresFullRebakeConfirmation: true,
    message: `操作签名失配熔断：需要 ${expectedSignature}（${expectedDimension} 维），本机未找到匹配服务；切换模型须用户确认并全量重烘。`
  };
}

/**
 * Sign/update `preferred_models.embedding` in `character.manifest.json`.
 *
 * @param {string} vaultPath
 * @param {Record<string, any>} providerConfig
 * @param {{ signedBy?: string, signSource?: string }} [options]
 */
export async function signEmbeddingModel(vaultPath, providerConfig, options = {}) {
  const modelSig = computeModelSig(providerConfig);
  if (!modelSig) {
    throw new Error('Cannot sign embedding model: provider, model_id, and numeric dimension are required');
  }

  const manifest = await loadManifest(vaultPath);
  manifest.preferred_models = manifest.preferred_models || {};
  manifest.preferred_models.embedding = {
    status: 'signed',
    provider: String(providerConfig.provider),
    model_id: String(providerConfig.model_id),
    dimension: Number(providerConfig.dimension),
    normalize: providerConfig.normalize !== false,
    model_sig: modelSig,
    sign_source: String(options.signSource || 'user_signed'),
    signed_by: String(options.signedBy || 'user'),
    signed_at: new Date().toISOString(),
    note: providerConfig.note || `已签署向量模型 ${modelSig}`
  };

  await saveManifest(vaultPath, manifest);
  return manifest.preferred_models.embedding;
}

function deterministicHashVector(text, dimension) {
  const vec = new Float32Array(dimension);
  const str = String(text || '').toLowerCase();
  if (!str) {
    vec[0] = 1;
    return vec;
  }

  // Combine word/CJK tokens and character trigrams for genuine lexical-semantic overlap.
  const tokens = str.match(/[a-z0-9_.-]+|[\u4e00-\u9fff]+/g) || [str];
  const features = [];
  for (const tok of tokens) {
    features.push(`w:${tok}`);
    if (/^[\u4e00-\u9fff]+$/.test(tok)) {
      for (let i = 0; i < tok.length; i += 1) {
        features.push(`c1:${tok[i]}`);
        if (i + 1 < tok.length) features.push(`c2:${tok.slice(i, i + 2)}`);
      }
    } else if (tok.length >= 4) {
      for (let i = 0; i <= tok.length - 3; i += 1) {
        features.push(`g3:${tok.slice(i, i + 3)}`);
      }
    }
  }

  for (const feat of features) {
    let h1 = 2166136261;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < feat.length; i += 1) {
      const ch = feat.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ ch, 2246822519) >>> 0;
    }
    const bucket = h1 % dimension;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    const weight = feat.startsWith('w:') ? 2.0 : 1.0;
    vec[bucket] += sign * weight;
  }

  return l2Normalize(vec);
}

function resolveApiKey(cfg) {
  if (cfg.api_key) return String(cfg.api_key);
  if (cfg.api_key_env) return process.env[cfg.api_key_env] || '';
  return '';
}

function inferAdapter(cfg) {
  if (cfg.adapter) return cfg.adapter;
  if (cfg.provider === 'gemini') return 'gemini';
  if (cfg.provider === 'openai' || cfg.provider === 'openai-compat') return 'openai-compat';
  return 'custom-http';
}

/**
 * Create a pluggable EmbeddingClient supporting `openai-compat`, `gemini`,
 * `custom-http`, and explicit `deterministic-hash` (for offline tests only).
 *
 * @param {Record<string, any>} providerConfig
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createEmbeddingClient(providerConfig, options = {}) {
  if (!providerConfig) {
    throw new Error('createEmbeddingClient requires a providerConfig');
  }
  const dimension = Number(providerConfig.dimension);
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`Invalid embedding dimension: ${providerConfig.dimension}`);
  }
  const normalize = providerConfig.normalize !== false;
  const adapter = inferAdapter(providerConfig);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const modelSig = computeModelSig(providerConfig);

  const finalizeVector = (rawVec, idx) => {
    if (!rawVec || rawVec.length !== dimension) {
      throw new RangeError(
        `Embedding vector #${idx} length mismatch: expected ${dimension}, got ${rawVec?.length}`
      );
    }
    return normalize ? l2Normalize(rawVec) : Float32Array.from(rawVec, Number);
  };

  async function embedBatch(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
    if (list.length === 0) return [];

    if (adapter === 'deterministic-hash') {
      return list.map((t) => deterministicHashVector(t, dimension));
    }

    if (!providerConfig.base_url || typeof fetchImpl !== 'function') {
      throw new Error(`Embedding provider "${modelSig}" lacks base_url or fetch implementation`);
    }

    const apiKey = resolveApiKey(providerConfig);
    if (providerConfig.api_key_env && !apiKey && !providerConfig.allow_unauthenticated) {
      throw new Error(`Missing environment variable ${providerConfig.api_key_env} for ${modelSig}`);
    }

    const headers = {
      'Content-Type': 'application/json',
      ...(providerConfig.headers || {})
    };

    if (adapter === 'openai-compat') {
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const maxBatch = Number.isInteger(Number(providerConfig.max_batch_size)) && Number(providerConfig.max_batch_size) > 0
        ? Number(providerConfig.max_batch_size)
        : list.length;
      const allVecs = [];
      for (let offset = 0; offset < list.length; offset += maxBatch) {
        const chunk = list.slice(offset, offset + maxBatch);
        const reqBody = { model: providerConfig.model_id, input: chunk };
        if (providerConfig.send_dimensions === true) {
          reqBody.dimensions = dimension;
        }
        const timeoutMs = Number(providerConfig.timeout_ms) > 0 ? Number(providerConfig.timeout_ms) : 8000;
        const res = await fetchImpl(providerConfig.base_url, {
          method: 'POST',
          headers,
          body: JSON.stringify(reqBody),
          signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(timeoutMs)
            : undefined
        });
        if (!res.ok) throw new Error(`Embedding HTTP ${res.status}: ${await res.text()}`);
        const json = await res.json();
        const sorted = [...(json.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (sorted.length !== chunk.length) {
          throw new Error(`Expected ${chunk.length} embeddings, got ${sorted.length}`);
        }
        for (let i = 0; i < sorted.length; i += 1) {
          allVecs.push(finalizeVector(sorted[i].embedding, offset + i));
        }
      }
      return allVecs;
    }

    if (adapter === 'gemini') {
      if (apiKey) headers['x-goog-api-key'] = apiKey;
      const results = [];
      for (let i = 0; i < list.length; i += 1) {
        const res = await fetchImpl(providerConfig.base_url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: `models/${providerConfig.model_id}`,
            content: { parts: [{ text: list[i] }] },
            outputDimensionality: dimension
          })
        });
        if (!res.ok) throw new Error(`Gemini Embedding HTTP ${res.status}: ${await res.text()}`);
        const json = await res.json();
        const values = json.embedding?.values || json.embeddings?.[0]?.values;
        results.push(finalizeVector(values, i));
      }
      return results;
    }

    if (adapter === 'custom-http') {
      if (apiKey && !headers.Authorization) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetchImpl(providerConfig.base_url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: providerConfig.model_id,
          input: list,
          dimension
        })
      });
      if (!res.ok) throw new Error(`Custom Embedding HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const vecs = json.embeddings || (json.data || []).map((d) => d.embedding);
      if (!Array.isArray(vecs) || vecs.length !== list.length) {
        throw new Error(`Expected ${list.length} embeddings from custom-http`);
      }
      return vecs.map((v, i) => finalizeVector(v, i));
    }

    throw new Error(`Unsupported embedding adapter "${adapter}"`);
  }

  return {
    provider: providerConfig.provider,
    model_id: providerConfig.model_id,
    dimension,
    normalize,
    model_sig: modelSig,
    adapter,
    embedBatch,
    async embedOne(text) {
      const [vec] = await embedBatch([text]);
      return vec;
    }
  };
}
