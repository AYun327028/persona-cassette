/**
 * @fileoverview Asynchronous dreaming engine (`runDream`) and high-risk approval
 * queue (`listDreamQueue`, `reviewDreamOp`) conforming to SPEC v1.1.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDecisionClient,
  loadProvidersConfig,
  resolveDecisionProvider
} from './decision-provider.mjs';
import {
  createEmbeddingClient,
  resolveEmbeddingProvider
} from './embedding-provider.mjs';
import { buildIndex } from './index-builder.mjs';
import { loadManifest } from './manifest.mjs';
import { bakeSnapshot, readSnapshotManifest } from './rivermemo-snapshot.mjs';
import { readActivityState, writeActivityState } from './runtime.mjs';
import { buildAllSpans, indexSessionSpans } from './spans.mjs';
import { lintTags } from './tags.mjs';
import { parseFrontmatter, serializeFrontmatter } from './yaml-lite.mjs';

export const DREAM_OP_SCHEMA = 'pmv-dream-op/v1';
export const HIGH_RISK_OP_TYPES = new Set([
  'update_soul',
  'update_profile',
  'merge_pages',
  'deprecate_page',
  'resolve_conflict'
]);
export const LOW_RISK_OP_TYPES = new Set(['create_wiki_page', 'append_wiki_page']);

const ALLOWED_WIKI_FOLDERS = new Set(['projects', 'domains', 'decisions', 'episodes', 'syntheses']);
const DEFAULT_KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveDreamLlmConfig(manifest, providersConfig, explicitProviderId = null) {
  const list = providersConfig?.llm_providers || [];
  if (explicitProviderId) {
    return list.find((p) => p.id === explicitProviderId || p.model_id === explicitProviderId) || null;
  }
  const slot = manifest?.preferred_models?.dream;
  if (!slot || slot.status === 'unsigned' || !slot.model_id) return null;
  return (
    list.find(
      (p) => p.model_id === slot.model_id && (!slot.provider || p.provider === slot.provider)
    ) || null
  );
}

function buildDreamPromptPayload({ manifest, indexMd, taxonomyRaw, candidateSpans }) {
  const sys =
    'You are the offline Dream Consolidation Engine for a Persona Memory Vault (SPEC v1.1). ' +
    'Given candidate conversation spans, the current Living Chronicle index, and taxonomy.yaml, ' +
    'propose structured memory operations in JSON: {"operations":[...]}. ' +
    'Low-risk ops: "create_wiki_page" | "append_wiki_page" (targeting wiki/{projects,domains,decisions,episodes,syntheses}/*.md, strictly obeying OKF YAML frontmatter fields id, title, type, status, domain, anchors, tag_chain, sources, updated_at, and RiverMemo body closure). ' +
    'High-risk ops (always routed to human review): "update_soul" | "update_profile" | "merge_pages" | "deprecate_page" | "resolve_conflict".';

  const user = JSON.stringify({
    character: manifest.character,
    index_md: indexMd.slice(0, 5000),
    taxonomy_yaml: taxonomyRaw.slice(0, 3000),
    candidate_spans: candidateSpans.map((s) => ({
      span_id: s.span_id,
      kind: s.kind,
      salience: s.salience,
      gist: s.gist,
      entities: s.entities,
      step_range: s.step_range
    }))
  });

  return { sys, user };
}

/**
 * Create a pluggable LLM client for offline dream consolidation.
 *
 * @param {Record<string, any> | null} providerConfig
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createDreamLlmClient(providerConfig, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    provider: providerConfig?.provider || null,
    model_id: providerConfig?.model_id || null,
    isActive() {
      return Boolean(providerConfig && providerConfig.base_url && providerConfig.model_id);
    },

    async propose({ manifest, indexMd, taxonomyRaw, candidateSpans }) {
      if (!this.isActive() || typeof fetchImpl !== 'function') {
        throw new Error('Dream LLM provider is not configured');
      }
      const apiKey = providerConfig.api_key
        || (providerConfig.api_key_env ? process.env[providerConfig.api_key_env] || '' : '');
      if (providerConfig.api_key_env && !apiKey && !providerConfig.allow_unauthenticated) {
        throw new Error(`Missing API key env ${providerConfig.api_key_env} for dream LLM`);
      }

      const { sys, user } = buildDreamPromptPayload({ manifest, indexMd, taxonomyRaw, candidateSpans });
      const headers = {
        'Content-Type': 'application/json',
        ...(providerConfig.headers || {})
      };

      const adapter = providerConfig.adapter || (providerConfig.provider === 'gemini' ? 'gemini' : 'openai-compat');
      let url = String(providerConfig.base_url);
      let body;

      if (adapter === 'gemini') {
        if (apiKey) headers['x-goog-api-key'] = apiKey;
        const cleanBase = url.replace(/\/+$/, '');
        if (!cleanBase.includes(':generateContent')) {
          url = `${cleanBase}/models/${providerConfig.model_id}:generateContent`;
        }
        body = {
          systemInstruction: { parts: [{ text: sys }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
        };
      } else if (adapter === 'openai-compat') {
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const cleanBase = url.replace(/\/+$/, '');
        url = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
        body = {
          model: providerConfig.model_id,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user }
          ]
        };
      } else {
        if (apiKey && !headers.Authorization) headers.Authorization = `Bearer ${apiKey}`;
        body = { model: providerConfig.model_id, system: sys, prompt: user };
      }

      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        throw new Error(`Dream LLM HTTP ${res.status}: ${await res.text()}`);
      }
      const json = await res.json();

      let parsedContent;
      if (adapter === 'gemini') {
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        parsedContent = JSON.parse(text);
      } else if (adapter === 'openai-compat') {
        const text = json.choices?.[0]?.message?.content || '{}';
        parsedContent = JSON.parse(text);
      } else {
        parsedContent = typeof json.operations === 'object' ? json : JSON.parse(json.text || '{}');
      }

      return {
        provider: providerConfig.provider,
        model: json.modelVersion || json.model || providerConfig.model_id,
        sign_source: 'runtime_verified',
        operations: Array.isArray(parsedContent?.operations) ? parsedContent.operations : []
      };
    }
  };
}

async function listSessionFiles(vaultPath) {
  const root = path.join(vaultPath, 'ledger', 'sessions');
  const results = [];
  let harnesses = [];
  try {
    harnesses = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (err?.code === 'ENOENT') return results;
    throw err;
  }

  for (const harness of harnesses) {
    const hDir = path.join(root, harness);
    const files = (await fs.readdir(hDir)).filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      const absPath = path.join(hDir, f);
      const raw = await fs.readFile(absPath, 'utf8');
      const eventCount = raw.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
      results.push({
        harness,
        sessionId: f.slice(0, -'.jsonl'.length),
        absPath,
        eventCount
      });
    }
  }
  return results;
}

function isSafeWikiTargetPath(relPath) {
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const match = norm.match(/^wiki\/([a-z]+)\/[^/]+\.md$/);
  return Boolean(match && ALLOWED_WIKI_FOLDERS.has(match[1]));
}

async function classifyRisk(op, vaultPath, soulText, decisionClient) {
  const type = String(op?.type || '');
  if (HIGH_RISK_OP_TYPES.has(type)) {
    return { highRisk: true, reason: `high_risk_type:${type}` };
  }
  if (!LOW_RISK_OP_TYPES.has(type)) {
    return { highRisk: true, reason: `unknown_op_type:${type}` };
  }

  const target = String(op.target_path || op.output_path || '');
  const normTarget = target.replace(/\\/g, '/').toLowerCase();
  if (normTarget.includes('soul.md') || normTarget.includes('user_profile.md')) {
    return { highRisk: true, reason: 'touches_soul_or_profile' };
  }
  if (!isSafeWikiTargetPath(target)) {
    return { highRisk: true, reason: `unsafe_target_path:${target}` };
  }

  if (decisionClient && decisionClient.isActive()) {
    const res = await decisionClient.evaluate({
      state: JSON.stringify({
        op,
        soul_excerpt: soulText.slice(0, 800)
      }),
      questions: {
        modifies_soul_or_profile: {
          type: 'noul',
          instructions: 'Does this operation alter core persona identity (SOUL) or user profile preferences?'
        },
        contradicts_existing: {
          type: 'noul',
          instructions: 'Does this operation contradict or supersede an established decision?'
        }
      }
    });
    if (!res.degraded) {
      const mSoul = Number(res.answers?.modifies_soul_or_profile?.noul || 0);
      const contra = Number(res.answers?.contradicts_existing?.noul || 0);
      if (mSoul >= 0.7 || contra >= 0.7) {
        return {
          highRisk: true,
          reason: `decision_gate_escalated(soul=${mSoul.toFixed(2)},contradict=${contra.toFixed(2)})`
        };
      }
    }
  }

  return { highRisk: false, reason: 'low_risk_wiki_addition' };
}

function normalizeFrontmatterForLowRiskOp(op, compilerSig) {
  const nowDate = new Date().toISOString().slice(0, 10);
  const fm = op.frontmatter && typeof op.frontmatter === 'object' ? { ...op.frontmatter } : {};
  const fallbackSlug = path.basename(String(op.target_path || 'page.md'), '.md');
  return {
    id: String(fm.id || `mem-${nowDate.replace(/-/g, '')}-${fallbackSlug}`),
    title: String(fm.title || op.title || fallbackSlug),
    type: String(fm.type || 'episode'),
    status: String(fm.status || 'active'),
    domain: Array.isArray(fm.domain) && fm.domain.length > 0 ? fm.domain : ['agent-memory'],
    importance: String(fm.importance || 'normal'),
    confidence: String(fm.confidence || 'high'),
    updated_at: String(fm.updated_at || nowDate),
    supersedes: Array.isArray(fm.supersedes) ? fm.supersedes : [],
    compiled_by: {
      model_id: compilerSig.model_id ?? null,
      provider: compilerSig.provider ?? null,
      sign_source: compilerSig.sign_source || 'unsigned',
      signed_by: compilerSig.signed_by ?? null
    },
    anchors: Array.isArray(fm.anchors) ? fm.anchors : [],
    tag_chain: Array.isArray(fm.tag_chain) ? fm.tag_chain : [],
    sources: Array.isArray(fm.sources) ? fm.sources : (Array.isArray(op.evidence_sources) ? op.evidence_sources : [])
  };
}

async function applyLowRiskWikiOp(vaultPath, op, compilerSig) {
  const normRel = String(op.target_path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const absPath = path.resolve(vaultPath, normRel);
  await fs.mkdir(path.dirname(absPath), { recursive: true });

  if (op.type === 'append_wiki_page') {
    let existingRaw = null;
    try {
      existingRaw = await fs.readFile(absPath, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    if (existingRaw !== null) {
      const parsed = parseFrontmatter(existingRaw);
      const data = { ...parsed.data };
      data.updated_at = new Date().toISOString().slice(0, 10);
      if (Array.isArray(op.evidence_sources)) {
        data.sources = [...new Set([...(Array.isArray(data.sources) ? data.sources : []), ...op.evidence_sources])];
      }
      const nextBody = `${parsed.body.trimEnd()}\n\n${String(op.body || '').trim()}\n`;
      await fs.writeFile(absPath, serializeFrontmatter(data, nextBody), 'utf8');
      return normRel;
    }
  }

  const fm = normalizeFrontmatterForLowRiskOp(op, compilerSig);
  const body = String(op.body || '').trim();
  await fs.writeFile(absPath, serializeFrontmatter(fm, `${body}\n`), 'utf8');
  return normRel;
}

async function enqueueHighRiskOp(vaultPath, op, compilerSig, riskReason, idx) {
  const queueDir = path.join(vaultPath, 'dream_queue');
  await fs.mkdir(queueDir, { recursive: true });
  const dateCompact = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const opId = op.op_id || `op-${dateCompact}-${String(idx + 1).padStart(3, '0')}-${crypto.randomBytes(2).toString('hex')}`;
  const fileName = `pending-${dateCompact}-${opId}.json`;
  const payload = {
    schema: DREAM_OP_SCHEMA,
    op_id: opId,
    type: String(op.type),
    status: 'pending_review',
    created_at: new Date().toISOString(),
    risk_reason: riskReason,
    proposed_by: {
      model_id: compilerSig.model_id ?? null,
      provider: compilerSig.provider ?? null,
      sign_source: compilerSig.sign_source || 'unsigned'
    },
    target_path: op.target_path || null,
    target_paths: Array.isArray(op.target_paths) ? op.target_paths : [],
    output_path: op.output_path || null,
    frontmatter: op.frontmatter || null,
    proposed_content: op.proposed_content ?? op.body ?? '',
    rationale: String(op.rationale || ''),
    evidence_sources: Array.isArray(op.evidence_sources) ? op.evidence_sources : []
  };

  await fs.writeFile(path.join(queueDir, fileName), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { op_id: opId, fileName, type: payload.type, risk_reason: riskReason };
}

/**
 * Run incremental asynchronous dream consolidation with double risk gating.
 *
 * @param {string} vaultPath
 * @param {{
 *   kitRoot?: string,
 *   dryRun?: boolean,
 *   minSalience?: number,
 *   maxSpans?: number,
 *   providerId?: string | null,
 *   decisionClient?: any,
 *   llmClient?: any,
 *   proposer?: Function | null
 * }} [options]
 */
export async function runDream(vaultPath, options = {}) {
  const kitRoot = options.kitRoot || DEFAULT_KIT_ROOT;
  const dryRun = options.dryRun === true;
  const minSalience = Number(options.minSalience ?? 0.45);
  const maxSpans = Math.max(1, Number(options.maxSpans ?? 12));

  const manifest = await loadManifest(vaultPath);
  const providers = await loadProvidersConfig(kitRoot);
  const decisionClient = options.decisionClient
    || createDecisionClient(resolveDecisionProvider(manifest, providers).config);

  const state = await readActivityState(vaultPath);
  const sessionFiles = await listSessionFiles(vaultPath);

  const sessionsNeedingDream = [];
  const nextWatermarks = { ...(state.session_watermarks || {}) };
  const candidateSpans = [];

  for (const sess of sessionFiles) {
    const prevCount = Number(state.session_watermarks?.[sess.sessionId] || 0);
    if (sess.eventCount <= prevCount) continue;

    sessionsNeedingDream.push(sess);
    nextWatermarks[sess.sessionId] = sess.eventCount;

    const spanJsonPath = path.join(vaultPath, 'ledger', 'spans', sess.harness, `${sess.sessionId}.spans.json`);
    let spans = [];
    if (dryRun) {
      try {
        const parsed = JSON.parse(await fs.readFile(spanJsonPath, 'utf8'));
        spans = parsed.spans || [];
      } catch {
        spans = [];
      }
    } else {
      const built = await indexSessionSpans(vaultPath, sess.harness, sess.sessionId, { decisionClient });
      spans = built.spans || [];
    }

    for (const sp of spans) {
      if ((sp.salience ?? 0) >= minSalience) candidateSpans.push(sp);
    }
  }

  candidateSpans.sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
  const selectedSpans = candidateSpans.slice(0, maxSpans);

  if (dryRun) {
    return {
      dryRun: true,
      sessionsScanned: sessionFiles.length,
      sessionsNeedingDream: sessionsNeedingDream.length,
      candidateSpans: selectedSpans,
      watermarkPreview: nextWatermarks
    };
  }

  if (sessionsNeedingDream.length === 0 || selectedSpans.length === 0) {
    return {
      status: 'up_to_date',
      sessionsScanned: sessionFiles.length,
      sessionsNeedingDream: sessionsNeedingDream.length,
      appliedLowRisk: [],
      queuedHighRisk: []
    };
  }

  let llmClient = options.llmClient || null;
  if (!llmClient && !options.proposer) {
    const llmCfg = resolveDreamLlmConfig(manifest, providers, options.providerId);
    if (llmCfg) llmClient = createDreamLlmClient(llmCfg);
  }

  if (!options.proposer && (!llmClient || !llmClient.isActive())) {
    return {
      status: 'no_llm_configured',
      sessionsScanned: sessionFiles.length,
      sessionsNeedingDream: sessionsNeedingDream.length,
      candidateSpans: selectedSpans,
      message: '未配置或未签写可用的 dream LLM 服务；候选切片已统计但暂不推进水线。'
    };
  }

  const indexMd = await fs.readFile(path.join(vaultPath, 'wiki', 'index.md'), 'utf8').catch(() => '');
  const taxonomyRaw = await fs.readFile(path.join(vaultPath, 'tags', 'taxonomy.yaml'), 'utf8').catch(() => '');
  const soulText = await fs.readFile(path.join(vaultPath, 'SOUL.md'), 'utf8').catch(() => '');

  const proposal = options.proposer
    ? await options.proposer({ vaultPath, manifest, indexMd, taxonomyRaw, candidateSpans: selectedSpans, state })
    : await llmClient.propose({ manifest, indexMd, taxonomyRaw, candidateSpans: selectedSpans });

  const compilerSig = {
    model_id: proposal?.model ?? null,
    provider: proposal?.provider ?? llmClient?.provider ?? null,
    sign_source: proposal?.sign_source || (proposal?.model ? 'runtime_verified' : 'unsigned')
  };

  const operations = Array.isArray(proposal?.operations) ? proposal.operations : [];
  const appliedLowRisk = [];
  const queuedHighRisk = [];

  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i];
    const risk = await classifyRisk(op, vaultPath, soulText, decisionClient);
    if (risk.highRisk) {
      const queued = await enqueueHighRiskOp(vaultPath, op, compilerSig, risk.reason, i);
      queuedHighRisk.push(queued);
    } else {
      const writtenPath = await applyLowRiskWikiOp(vaultPath, op, compilerSig);
      appliedLowRisk.push({ type: op.type, path: writtenPath });
    }
  }

  const lintRes = await lintTags(vaultPath, { fix: true, decisionClient });
  const indexRes = await buildIndex(vaultPath);

  const updatedState = {
    ...state,
    turns_since_dream: 0,
    events_since_dream: 0,
    last_dream_at: new Date().toISOString(),
    session_watermarks: nextWatermarks
  };
  await writeActivityState(vaultPath, updatedState);

  await fs.appendFile(
    path.join(vaultPath, 'wiki', 'log.md'),
    `- ${updatedState.last_dream_at} | 异步做梦整理 | model=\`${compilerSig.model_id ?? 'null'}\` (${compilerSig.sign_source}) | low_risk_applied=${appliedLowRisk.length} | high_risk_queued=${queuedHighRisk.length}\n`,
    'utf8'
  );

  return {
    status: 'completed',
    sessionsScanned: sessionFiles.length,
    sessionsNeedingDream: sessionsNeedingDream.length,
    candidateSpanCount: selectedSpans.length,
    compilerSig,
    appliedLowRisk,
    queuedHighRisk,
    lint: { errors: lintRes.errors, warnings: lintRes.warnings },
    indexLines: indexRes.lineCount
  };
}

/**
 * List queued dream review operations from `dream_queue/`.
 *
 * @param {string} vaultPath
 * @param {{ status?: string }} [options]
 */
export async function listDreamQueue(vaultPath, options = {}) {
  const filterStatus = options.status ?? 'pending_review';
  const queueDir = path.join(vaultPath, 'dream_queue');
  let entries = [];
  try {
    entries = await fs.readdir(queueDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const items = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json') || e.name.startsWith('.')) continue;
    const raw = JSON.parse(await fs.readFile(path.join(queueDir, e.name), 'utf8'));
    if (filterStatus !== 'all' && raw.status !== filterStatus) continue;
    items.push({ fileName: e.name, ...raw });
  }
  items.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return items;
}

async function archiveWikiPage(vaultPath, relPath) {
  const clean = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const srcAbs = path.resolve(vaultPath, clean);
  const wikiRoot = path.resolve(vaultPath, 'wiki');
  const relFromWiki = path.relative(wikiRoot, srcAbs);
  if (!relFromWiki || relFromWiki.startsWith('..') || path.isAbsolute(relFromWiki)) {
    throw new Error(`Archive source escapes wiki/: ${relPath}`);
  }

  const raw = await fs.readFile(srcAbs, 'utf8');
  const fm = parseFrontmatter(raw);
  const nextData = { ...(fm.data || {}), status: 'archived', updated_at: new Date().toISOString().slice(0, 10) };

  const archiveDir = path.join(wikiRoot, 'archive');
  await fs.mkdir(archiveDir, { recursive: true });
  let destName = path.basename(srcAbs);
  const destAbsCandidate = path.join(archiveDir, destName);
  if (await fs.access(destAbsCandidate).then(() => true).catch(() => false)) {
    const ext = path.extname(destName);
    destName = `${path.basename(destName, ext)}-${Date.now()}${ext}`;
  }

  const destAbs = path.join(archiveDir, destName);
  await fs.writeFile(destAbs, serializeFrontmatter(nextData, fm.body), 'utf8');
  await fs.rm(srcAbs, { force: true });
  return `wiki/archive/${destName}`;
}

/**
 * Approve or reject a queued high-risk dream operation. Never physically
 * deletes superseded pages; archives them into `wiki/archive/`.
 *
 * @param {string} vaultPath
 * @param {string} opId
 * @param {{ decision: 'approve' | 'reject', reviewedBy?: string, note?: string }} options
 */
export async function reviewDreamOp(vaultPath, opId, options) {
  const decision = options?.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error('reviewDreamOp requires decision="approve" or "reject"');
  }

  const all = await listDreamQueue(vaultPath, { status: 'all' });
  const found = all.find((it) => it.op_id === opId);
  if (!found) {
    throw new Error(`Dream queue operation not found: ${opId}`);
  }
  if (found.status !== 'pending_review') {
    throw new Error(`Operation ${opId} is already "${found.status}"`);
  }

  const opFilePath = path.join(vaultPath, 'dream_queue', found.fileName);
  const nowIso = new Date().toISOString();
  const reviewedBy = String(options.reviewedBy || 'user');
  const note = String(options.note || '');

  const archived = [];
  let written = null;

  if (decision === 'approve') {
    if (found.type === 'update_soul') {
      await fs.writeFile(path.join(vaultPath, 'SOUL.md'), String(found.proposed_content || ''), 'utf8');
      written = 'SOUL.md';
    } else if (found.type === 'update_profile') {
      await fs.writeFile(path.join(vaultPath, 'USER_PROFILE.md'), String(found.proposed_content || ''), 'utf8');
      written = 'USER_PROFILE.md';
    } else if (found.type === 'merge_pages' || found.type === 'resolve_conflict') {
      const outRel = found.output_path || found.target_path;
      if (outRel && isSafeWikiTargetPath(outRel)) {
        const compilerSig = found.proposed_by || { model_id: null, provider: null, sign_source: 'unsigned' };
        written = await applyLowRiskWikiOp(
          vaultPath,
          {
            type: 'create_wiki_page',
            target_path: outRel,
            frontmatter: found.frontmatter || {},
            body: found.proposed_content || '',
            evidence_sources: found.evidence_sources || []
          },
          compilerSig
        );
      }
      for (const p of found.target_paths || []) {
        if (p && p !== written) {
          archived.push(await archiveWikiPage(vaultPath, p));
        }
      }
    } else if (found.type === 'deprecate_page') {
      const list = [...new Set([found.target_path, ...(found.target_paths || [])].filter(Boolean))];
      for (const p of list) {
        archived.push(await archiveWikiPage(vaultPath, p));
      }
    }

    await lintTags(vaultPath, { fix: true });
    await buildIndex(vaultPath);
  }

  const nextRecord = {
    ...found,
    status: decision === 'approve' ? 'approved' : 'rejected',
    reviewed_by: reviewedBy,
    reviewed_at: nowIso,
    review_note: note,
    ...(written ? { written_path: written } : {}),
    ...(archived.length > 0 ? { archived_paths: archived } : {})
  };
  delete nextRecord.fileName;

  await fs.writeFile(opFilePath, `${JSON.stringify(nextRecord, null, 2)}\n`, 'utf8');
  await fs.appendFile(
    path.join(vaultPath, 'wiki', 'log.md'),
    `- ${nowIso} | 审批梦境操作 \`${opId}\` (${found.type}): **${nextRecord.status}** | written=${written || '-'} | archived=${archived.join(',') || '-'}\n`,
    'utf8'
  );

  return nextRecord;
}

/**
 * Finalize a dream session conducted by an external Agent (such as an
 * Antigravity Scheduled Automation): rebuilds spans, lints tags, records an
 * optional narrative timeline digest, updates watermarks & resets dream turn
 * counters, rebuilds `wiki/index.md`, logs to `wiki/log.md`, and optionally
 * incrementally bakes `snapshot/rivermemo.snap/`.
 *
 * @param {string} vaultPath
 * @param {{
 *   kitRoot?: string,
 *   summary?: string | null,
 *   model?: string | null,
 *   provider?: string | null,
 *   signSource?: string | null,
 *   bake?: boolean,
 *   providerId?: string | null,
 *   embeddingClient?: any,
 *   embeddingProviderConfig?: Record<string, any> | null
 * }} [options]
 */
export async function commitDreamSession(vaultPath, options = {}) {
  const kitRoot = options.kitRoot || DEFAULT_KIT_ROOT;
  const manifest = await loadManifest(vaultPath);
  const state = await readActivityState(vaultPath);

  await buildAllSpans(vaultPath);
  const sessionFiles = await listSessionFiles(vaultPath);
  const nextWatermarks = { ...(state.session_watermarks || {}) };
  for (const sess of sessionFiles) {
    nextWatermarks[sess.sessionId] = sess.eventCount;
  }

  const lintRes = await lintTags(vaultPath, { fix: true });

  const nowIso = new Date().toISOString();
  const cleanSummary = String(options.summary || '').replace(/\s+/g, ' ').trim();
  const nextDigests = Array.isArray(state.dream_digests) ? [...state.dream_digests] : [];
  if (cleanSummary) {
    const duplicate = nextDigests.some((d) => d?.text === cleanSummary);
    if (!duplicate) {
      nextDigests.push({
        ts: nowIso,
        text: cleanSummary,
        model: options.model || null
      });
    }
  }
  const trimmedDigests = nextDigests.slice(-3);

  const updatedState = {
    ...state,
    turns_since_dream: 0,
    events_since_dream: 0,
    last_dream_at: nowIso,
    session_watermarks: nextWatermarks,
    dream_digests: trimmedDigests
  };
  await writeActivityState(vaultPath, updatedState);

  const indexRes = await buildIndex(vaultPath);

  const modelLabel = options.model ? String(options.model).trim() : 'agent-dream';
  const signSource = options.signSource || (options.model ? 'runtime_verified' : 'agent_session');
  const digestNote = cleanSummary ? ` | digest="${cleanSummary.slice(0, 60)}"` : '';
  await fs.appendFile(
    path.join(vaultPath, 'wiki', 'log.md'),
    `- ${nowIso} | Agent 做梦收尾 (dream-commit) | model=\`${modelLabel}\` (${signSource}) | sessions=${sessionFiles.length} | index_lines=${indexRes.lineCount}${digestNote}\n`,
    'utf8'
  );

  let bakeResult = null;
  if (options.bake === true) {
    try {
      let embClient = options.embeddingClient || null;
      let providerCfg = options.embeddingProviderConfig || null;
      if (!embClient || !providerCfg) {
        const providers = await loadProvidersConfig(kitRoot);
        const snapManifest = await readSnapshotManifest(vaultPath);
        if (options.providerId) {
          providerCfg = (providers.embedding_providers || []).find(
            (p) => p.id === options.providerId || p.model_id === options.providerId
          ) || null;
        } else {
          const resolved = resolveEmbeddingProvider(manifest, snapManifest, providers);
          providerCfg = resolved.providerConfig || null;
        }
        if (providerCfg) {
          embClient = createEmbeddingClient(providerCfg);
        }
      }

      if (embClient && providerCfg) {
        const res = await bakeSnapshot(vaultPath, {
          embeddingClient: embClient,
          providerConfig: providerCfg
        });
        bakeResult = {
          baked: true,
          snapshot_version: res.snapshot_version,
          total_docs: res.total_docs ?? res.counts?.total ?? null
        };
      } else {
        bakeResult = { baked: false, reason: 'no_matching_embedding_provider' };
      }
    } catch (err) {
      bakeResult = { baked: false, reason: err?.message || String(err) };
    }
  }

  return {
    status: 'committed',
    vault_path: vaultPath,
    committed_at: nowIso,
    sessions_watermarked: sessionFiles.length,
    digest_added: Boolean(cleanSummary),
    digest_count: trimmedDigests.length,
    lint: { errors: lintRes.errors, warnings: lintRes.warnings },
    index: {
      lineCount: indexRes.lineCount,
      digestCount: indexRes.digestCount,
      timelineCount: indexRes.timelineCount,
      evergreenCount: indexRes.evergreenCount
    },
    ...(bakeResult ? { bake: bakeResult } : {})
  };
}
