/**
 * @fileoverview Vendor-agnostic pluggable DecisionProvider HTTP service client
 * (gemini-decisions, typesafe-jev, openai-compat-json, custom-http, noop)
 * with mandatory graceful degradation when unconfigured, unsigned, or failing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Normalize either an array or object map of provider definitions into an array.
 *
 * @param {unknown} raw
 * @returns {Array<Record<string, any>>}
 */
function normalizeProviderList(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((item) => item && typeof item === 'object');
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([id, cfg]) => ({ id, ...(cfg || {}) }));
  }
  return [];
}

/**
 * Load `providers.local.json` from kitRoot if it exists; never fails if missing.
 *
 * @param {string} kitRoot
 * @returns {Promise<{
 *   found: boolean,
 *   embedding_providers: Array<Record<string, any>>,
 *   decision_providers: Array<Record<string, any>>,
 *   llm_providers: Array<Record<string, any>>
 * }>}
 */
export async function loadProvidersConfig(kitRoot) {
  const filePath = path.join(kitRoot, 'providers.local.json');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      found: true,
      embedding_providers: normalizeProviderList(parsed.embedding_providers),
      decision_providers: normalizeProviderList(parsed.decision_providers),
      llm_providers: normalizeProviderList(parsed.llm_providers)
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        found: false,
        embedding_providers: [],
        decision_providers: [],
        llm_providers: []
      };
    }
    throw err;
  }
}

/**
 * Resolve the character manifest's signed `decision` slot against available
 * configured decision providers.
 *
 * @param {Record<string, any>} manifest
 * @param {Awaited<ReturnType<typeof loadProvidersConfig>>} providersConfig
 * @returns {{ status: 'unsigned' | 'unconfigured' | 'mismatch' | 'ready', reason: string, config: Record<string, any> | null }}
 */
export function resolveDecisionProvider(manifest, providersConfig) {
  const slot = manifest?.preferred_models?.decision;
  if (!slot || slot.status === 'unsigned' || !slot.model_id) {
    return {
      status: 'unsigned',
      reason: 'Decision model signature is unsigned in character.manifest.json',
      config: null
    };
  }

  const list = normalizeProviderList(providersConfig?.decision_providers);
  if (list.length === 0) {
    return {
      status: 'unconfigured',
      reason: 'No decision_providers configured in providers.local.json',
      config: null
    };
  }

  const matched = list.find((entry) => {
    const sameModel = entry.model_id === slot.model_id;
    const sameProvider = !slot.provider || entry.provider === slot.provider;
    const sameAdapter = !slot.adapter || entry.adapter === slot.adapter;
    return sameModel && sameProvider && sameAdapter;
  });

  if (!matched) {
    return {
      status: 'mismatch',
      reason: `No local decision provider matching ${slot.provider || '*'}::${slot.model_id}`,
      config: null
    };
  }

  return {
    status: 'ready',
    reason: 'Matched signed decision provider',
    config: matched
  };
}

function resolveApiKey(providerConfig) {
  if (providerConfig.api_key) return String(providerConfig.api_key);
  if (providerConfig.api_key_env) {
    return process.env[providerConfig.api_key_env] || '';
  }
  return '';
}

function normalizeAnswers(rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== 'object') return {};
  const out = {};
  for (const [key, item] of Object.entries(rawAnswers)) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type || (
      'noul' in item ? 'noul' : 'choice' in item ? 'choice' : 'score' in item ? 'score' : 'unknown'
    );
    const normalized = { type };
    if (type === 'noul') normalized.noul = Number(item.noul);
    if (type === 'choice') normalized.choice = item.choice;
    if (type === 'score') normalized.score = Number(item.score);
    if (item.confidence !== undefined) normalized.confidence = Number(item.confidence);
    if (item.probabilities && typeof item.probabilities === 'object') {
      normalized.probabilities = item.probabilities;
    }
    out[key] = normalized;
  }
  return out;
}

function buildOpenAiCompatBody(modelId, state, questions) {
  const systemPrompt =
    'You are a strict structured judgment engine. Evaluate the given state against each question ' +
    'and return ONLY valid JSON of shape {"answers": {<key>: ...}}. ' +
    'For type="noul" return {"type":"noul","noul":<0..1 number>,"confidence":<0..1>}. ' +
    'For type="choice" return {"type":"choice","choice":<one exact candidate key>,"confidence":<0..1>}. ' +
    'For type="score" return {"type":"score","score":<0..levels-1 number>,"confidence":<0..1>}.';
  const userPayload = JSON.stringify({ state, questions });
  return {
    model: modelId,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPayload }
    ]
  };
}

function buildAdapterRequest(providerConfig, apiKey, state, questions) {
  const adapter = providerConfig.adapter || 'custom-http';
  const headers = {
    'Content-Type': 'application/json',
    ...(providerConfig.headers || {})
  };
  let url = providerConfig.base_url;
  let body;

  if (adapter === 'gemini-decisions') {
    if (apiKey) {
      if (providerConfig.auth_scheme === 'bearer') {
        headers.Authorization = `Bearer ${apiKey}`;
      } else {
        headers['x-goog-api-key'] = apiKey;
      }
    }
    body = { model: providerConfig.model_id, input: state, questions };
  } else if (adapter === 'typesafe-jev') {
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    body = { model: providerConfig.model_id, state, questions };
  } else if (adapter === 'openai-compat-json') {
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const trimmed = String(url || '').replace(/\/+$/, '');
    url = trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
    body = buildOpenAiCompatBody(providerConfig.model_id, state, questions);
  } else if (adapter === 'custom-http') {
    if (apiKey && !headers.Authorization) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    body = { model: providerConfig.model_id, state, questions };
  } else {
    throw new Error(`Unsupported decision adapter: ${adapter}`);
  }

  return { adapter, url, headers, body };
}

function extractAnswersFromResponse(adapter, payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (adapter === 'openai-compat-json') {
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      const parsed = JSON.parse(content);
      return normalizeAnswers(parsed.answers || parsed);
    }
  }
  return normalizeAnswers(payload.answers || payload.results || {});
}

/**
 * Create a DecisionProvider client implementing `evaluate({ state, questions, timeoutMs })`.
 * Guarantees graceful degradation (`{ degraded: true, answers: {} }`) on missing config,
 * missing API keys, timeouts, HTTP errors, or malformed responses.
 *
 * @param {Record<string, any> | null} providerConfig
 * @param {{ fetchImpl?: typeof fetch, defaultTimeoutMs?: number }} [options]
 */
export function createDecisionClient(providerConfig, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
  const adapter = providerConfig?.adapter || 'noop';
  const modelId = providerConfig?.model_id || null;
  const providerName = providerConfig?.provider || 'none';

  return {
    provider: providerName,
    adapter,
    model_id: modelId,
    isActive() {
      return Boolean(providerConfig && adapter !== 'noop' && providerConfig.base_url);
    },

    /**
     * Evaluate closed-set judgment primitives (`noul`, `choice`, `score`).
     *
     * @param {{ state: unknown, questions: Record<string, any>, timeoutMs?: number }} params
     */
    async evaluate({ state, questions, timeoutMs }) {
      if (!this.isActive() || typeof fetchImpl !== 'function') {
        return {
          degraded: true,
          reason: 'decision_provider_inactive',
          provider: providerName,
          model: modelId,
          answers: {}
        };
      }

      const apiKey = resolveApiKey(providerConfig);
      if (providerConfig.api_key_env && !apiKey && !providerConfig.allow_unauthenticated) {
        return {
          degraded: true,
          reason: `missing_env_${providerConfig.api_key_env}`,
          provider: providerName,
          model: modelId,
          answers: {}
        };
      }

      const effectiveTimeout = Number(timeoutMs ?? providerConfig.timeout_ms ?? defaultTimeoutMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(100, effectiveTimeout));

      try {
        const req = buildAdapterRequest(providerConfig, apiKey, state, questions);
        const res = await fetchImpl(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: controller.signal
        });
        if (!res.ok) {
          return {
            degraded: true,
            reason: `http_${res.status}`,
            provider: providerName,
            model: modelId,
            answers: {}
          };
        }
        const json = await res.json();
        const answers = extractAnswersFromResponse(req.adapter, json);
        return {
          degraded: false,
          provider: providerName,
          adapter: req.adapter,
          model: json.model || modelId,
          answers
        };
      } catch (err) {
        return {
          degraded: true,
          reason: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'request_failed'),
          provider: providerName,
          model: modelId,
          answers: {}
        };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
