import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  registerCartridge,
  resolveCartridgePath,
  setDefaultCartridge
} from '../core/cartridges.mjs';
import { createDecisionClient } from '../core/decision-provider.mjs';
import { listDreamQueue, reviewDreamOp, runDream } from '../core/dream-runner.mjs';
import { createEmbeddingClient } from '../core/embedding-provider.mjs';
import { buildIndex } from '../core/index-builder.mjs';
import { bakeSnapshot } from '../core/rivermemo-snapshot.mjs';
import {
  appendLedgerEvent,
  composeSystemPrefix,
  loadVault,
  readWikiPage,
  recallForUserTurn
} from '../core/runtime.mjs';
import { buildAllSpans } from '../core/spans.mjs';
import { initVault } from '../core/vault-init.mjs';
import { parseFrontmatter, serializeFrontmatter } from '../core/yaml-lite.mjs';
import { apply as applyDshPlugin } from '../adapters/dsh/host.js';
import { hasVexusLite } from '../native/vexus-bridge.mjs';

const SKIP_NO_VEXUS = hasVexusLite() ? false : 'Optional native rust-vexus-lite not installed';

const require = createRequire(import.meta.url);
const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HASH_PROVIDER_64 = {
  id: 'hash-64',
  provider: 'local-hash',
  adapter: 'deterministic-hash',
  model_id: 'hash-v1',
  dimension: 64,
  normalize: true
};

async function withTempDir(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmv-phase3-'));
  try {
    return await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function seedRichVault(vaultDir) {
  await initVault(vaultDir, { id: 'algernon', name: 'Algernon', displayName: '阿尔吉侬' });
  await fs.writeFile(
    path.join(vaultDir, 'tags', 'taxonomy.yaml'),
    `schema: pmv-taxonomy/v1
domains: [agent-memory, engineering, literary-criticism]
blacklist: [总结, 笔记]
tag_chain_rules:
  min_length: 2
  max_length: 8
  require_body_closure: true
`,
    'utf8'
  );

  const pages = [
    {
      rel: 'wiki/projects/pmv-core.md',
      meta: {
        id: 'mem-pmv-core',
        title: 'Persona Memory Vault 架构',
        type: 'architecture',
        status: 'active',
        domain: ['agent-memory', 'engineering'],
        importance: 'core',
        updated_at: '2026-11-20',
        compiled_by: { model_id: null, provider: 'antigravity', sign_source: 'unsigned' },
        anchors: ['PersonaMemoryVault', '读写分离'],
        tag_chain: ['Cteno不可变账本', '只读RiverMemo快照'],
        sources: ['span:antigravity:s1:sp01']
      },
      body: '# Persona Memory Vault 架构\n\n采用 PersonaMemoryVault 读写分离，配合 Cteno不可变账本 与 只读RiverMemo快照。'
    },
    {
      rel: 'wiki/domains/literary-notes.md',
      meta: {
        id: 'mem-lit-01',
        title: '脂评本异文考据备忘',
        type: 'literary',
        status: 'active',
        domain: ['literary-criticism'],
        importance: 'high',
        updated_at: '2026-11-20',
        compiled_by: { model_id: null, provider: 'antigravity', sign_source: 'unsigned' },
        anchors: ['脂砚斋评本', '庚辰本异文'],
        tag_chain: ['红楼梦考据', '脂砚斋评本', '庚辰本异文'],
        sources: ['span:antigravity:s1:sp02']
      },
      body: '# 脂评本异文考据备忘\n\n进行 红楼梦考据 时重点比勘 脂砚斋评本 与 庚辰本异文。'
    }
  ];

  for (const p of pages) {
    await fs.writeFile(path.join(vaultDir, p.rel), serializeFrontmatter(p.meta, p.body), 'utf8');
  }
  await buildIndex(vaultDir);
}

function runScriptWithStdin(scriptPath, stdinData, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

test('1. cartridge registry + runtime 6 methods + DecisionProvider gate skip & preset routing', { skip: SKIP_NO_VEXUS }, async () => {
  await withTempDir(async (tmpDir) => {
    const kitDir = path.join(tmpDir, 'kit');
    const vaultDir = path.join(tmpDir, 'algernon-vault');
    const vault2 = path.join(tmpDir, 'other-vault');
    await fs.mkdir(kitDir, { recursive: true });
    await seedRichVault(vaultDir);
    await initVault(vault2, { id: 'shiori', name: 'Shiori', displayName: '汐里' });

    await registerCartridge(kitDir, { id: 'algernon', vaultPath: vaultDir, setDefault: true });
    await registerCartridge(kitDir, { id: 'shiori', vaultPath: vault2 });
    const defRes = await resolveCartridgePath(kitDir, null);
    assert.equal(defRes.id, 'algernon');
    assert.equal(defRes.vaultPath, path.resolve(vaultDir));

    await setDefaultCartridge(kitDir, 'shiori');
    assert.equal((await resolveCartridgePath(kitDir, null)).id, 'shiori');
    await setDefaultCartridge(kitDir, 'algernon');

    // Before baking snapshot: graceful degradation + honest signature notice on "auto".
    const unbakedVault = await loadVault('algernon', { kitRoot: kitDir });
    const prefix = composeSystemPrefix(unbakedVault, { reportedModel: 'auto' });
    assert.match(prefix.systemPrefix, /阿尔吉侬/);
    assert.match(prefix.signatureNoticeXml, /<signature_notice status="unverified"/);

    const degradedRecall = await recallForUserTurn(unbakedVault, '查看读写分离架构', {
      kitRoot: kitDir,
      reportedModel: 'auto'
    });
    assert.equal(degradedRecall.skipped, true);
    assert.equal(degradedRecall.degraded, true);
    assert.equal(degradedRecall.reason, 'no_snapshot_baked');

    // Bake snapshot with deterministic-hash and test DecisionProvider gate + routing.
    const embClient = createEmbeddingClient(HASH_PROVIDER_64);
    await bakeSnapshot(vaultDir, { embeddingClient: embClient, providerConfig: HASH_PROVIDER_64 });
    await fs.writeFile(
      path.join(kitDir, 'providers.local.json'),
      JSON.stringify({ embedding_providers: [HASH_PROVIDER_64], decision_providers: [] }),
      'utf8'
    );

    let mode = 'skip';
    const decisionSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (mode === 'skip') {
          res.end(JSON.stringify({
            model: 'mock-decider',
            answers: { needs_recall: { type: 'noul', noul: 0.12 }, recall_preset: { type: 'choice', choice: 'balanced' } }
          }));
        } else {
          res.end(JSON.stringify({
            model: 'mock-decider',
            answers: { needs_recall: { type: 'noul', noul: 0.94 }, recall_preset: { type: 'choice', choice: 'precision_research' } }
          }));
        }
      });
    });
    await new Promise((r) => decisionSrv.listen(0, '127.0.0.1', r));
    try {
      const { port } = decisionSrv.address();
      const decClient = createDecisionClient({
        provider: 'custom',
        adapter: 'custom-http',
        model_id: 'mock-decider',
        base_url: `http://127.0.0.1:${port}/decide`,
        allow_unauthenticated: true
      });

      const bakedVault = await loadVault('algernon', { kitRoot: kitDir });
      const skippedRes = await recallForUserTurn(bakedVault, '好的', {
        kitRoot: kitDir,
        decisionClient: decClient
      });
      assert.equal(skippedRes.skipped, true);
      assert.equal(skippedRes.reason, 'decision_gate_skip');

      mode = 'recall';
      const routedRes = await recallForUserTurn(bakedVault, '脂砚斋评本与庚辰本异文怎么比勘？', {
        kitRoot: kitDir,
        decisionClient: decClient,
        reportedModel: 'auto'
      });
      assert.equal(routedRes.skipped, false);
      assert.equal(routedRes.preset, 'precision_research');
      assert.match(routedRes.xmlBlock, /<recalled_memory/);
      assert.match(routedRes.signatureNoticeXml, /<signature_notice/);

      // readWikiPage & path traversal protection
      const page = await readWikiPage(bakedVault, 'projects/pmv-core.md');
      assert.equal(page.frontmatter.id, 'mem-pmv-core');
      await assert.rejects(
        () => readWikiPage(bakedVault, '../SOUL.md'),
        (err) => err.code === 'PATH_TRAVERSAL_FORBIDDEN'
      );

      // appendLedgerEvent increments activity counter
      const appRes = await appendLedgerEvent(bakedVault, {
        source_harness: 'cli',
        session_id: 's-cnt',
        step_index: 0,
        role: 'user',
        content: '记录一次会话'
      });
      assert.equal(appRes.added, 1);
      assert.equal(appRes.activity.turns_since_dream, 1);
    } finally {
      await new Promise((r) => decisionSrv.close(r));
    }
  });
});

test('2. shared stdio MCP server (pmv-mcp.mjs) handles initialize, tools/list, tools/call, and path traversal safety', async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await seedRichVault(vaultDir);
    await appendLedgerEvent(vaultDir, {
      source_harness: 'antigravity',
      session_id: 'mcp-s1',
      step_index: 0,
      role: 'user',
      content: '请帮我核对 庚辰本异文 的原话记录。'
    });
    await appendLedgerEvent(vaultDir, {
      source_harness: 'antigravity',
      session_id: 'mcp-s1',
      step_index: 1,
      role: 'assistant',
      content: '已查到脂砚斋评本与庚辰本异文对应条目。'
    });
    await buildAllSpans(vaultDir);

    const mcpPath = path.join(KIT_ROOT, 'bin', 'pmv-mcp.mjs');
    const child = spawn(process.execPath, [mcpPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = [];
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        if (line.trim()) replies.push(JSON.parse(line));
      }
    });

    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pmv_status', arguments: { cartridge: vaultDir } } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pmv_read_wiki', arguments: { cartridge: vaultDir, path: 'projects/pmv-core.md' } } });
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pmv_read_wiki', arguments: { cartridge: vaultDir, path: '../SOUL.md' } } });
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'pmv_search_spans', arguments: { cartridge: vaultDir, query: '庚辰本异文' } } });
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pmv_read_span', arguments: { cartridge: vaultDir, span_id: 'antigravity:mcp-s1:sp01', pad_steps: 0 } } });
    child.stdin.end();

    await new Promise((resolve) => child.on('close', resolve));
    assert.equal(stderr, '', `Unexpected MCP stderr: ${stderr}`);
    assert.equal(replies.length, 7);

    const byId = new Map(replies.map((r) => [r.id, r]));
    assert.equal(byId.get(1).result.serverInfo.name, 'persona-memory-vault');
    assert.equal(byId.get(2).result.tools.length, 6);
    assert.match(byId.get(3).result.content[0].text, /"id": "algernon"/);
    assert.match(byId.get(4).result.content[0].text, /Persona Memory Vault 架构/);
    assert.equal(byId.get(5).result.isError, true);
    assert.match(byId.get(6).result.content[0].text, /antigravity:mcp-s1:sp01/);
    assert.match(byId.get(7).result.content[0].text, /请帮我核对 庚辰本异文/);
  });
});

test('3. dream-runner auto-applies low-risk wiki ops, routes high-risk/Decision-flagged ops to dream_queue, and archives on approve', async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await seedRichVault(vaultDir);
    await appendLedgerEvent(vaultDir, {
      source_harness: 'antigravity',
      session_id: 'dream-s1',
      step_index: 0,
      role: 'user',
      content: '今天拍板了新的前端交互规范与暗色工作台配色。'
    });
    await appendLedgerEvent(vaultDir, {
      source_harness: 'antigravity',
      session_id: 'dream-s1',
      step_index: 1,
      role: 'assistant',
      content: '好的，已经记录前端暗色工作台规范与长期架构合并方案。'
    });

    // Dry run must leave dream_queue and watermarks untouched.
    const dry = await runDream(vaultDir, { dryRun: true, minSalience: 0.1 });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.sessionsNeedingDream, 1);
    assert.equal((await listDreamQueue(vaultDir, { status: 'all' })).length, 0);

    // DecisionProvider escalates an apparent create_wiki_page that contradicts existing docs.
    const decSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (parsed.questions?.contradicts_existing) {
          const isContradictory = String(parsed.state || '').includes('CONFLICT_FLAG');
          res.end(JSON.stringify({
            model: 'mock-judge',
            answers: {
              modifies_soul_or_profile: { type: 'noul', noul: 0.05 },
              contradicts_existing: { type: 'noul', noul: isContradictory ? 0.92 : 0.05 }
            }
          }));
        } else {
          res.end(JSON.stringify({
            model: 'mock-judge',
            answers: {
              has_lasting_value: { type: 'noul', noul: 0.9 },
              salience_level: { type: 'score', score: 3.5 },
              kind: { type: 'choice', choice: 'decision' }
            }
          }));
        }
      });
    });
    await new Promise((r) => decSrv.listen(0, '127.0.0.1', r));
    try {
      const { port } = decSrv.address();
      const decClient = createDecisionClient({
        provider: 'custom',
        adapter: 'custom-http',
        model_id: 'mock-judge',
        base_url: `http://127.0.0.1:${port}/decide`,
        allow_unauthenticated: true
      });

      const res = await runDream(vaultDir, {
        minSalience: 0.1,
        decisionClient: decClient,
        proposer: async () => ({
          provider: 'mock-llm',
          model: 'gemini-3-pro',
          sign_source: 'runtime_verified',
          operations: [
            {
              type: 'create_wiki_page',
              target_path: 'wiki/episodes/ep-ui-workbench.md',
              frontmatter: {
                id: 'mem-ep-ui-wb',
                title: '前端暗色工作台配色记录',
                type: 'episode',
                domain: ['engineering'],
                anchors: ['暗色工作台UI'],
                tag_chain: ['暗色工作台UI', '前端交互规范'],
                sources: ['span:antigravity:dream-s1:sp01']
              },
              body: '# 前端暗色工作台配色记录\n\n采用 暗色工作台UI 与 前端交互规范。'
            },
            {
              type: 'create_wiki_page',
              target_path: 'wiki/decisions/contradicting-draft.md',
              body: '# 冲突草稿\n\nCONFLICT_FLAG 推翻旧架构。'
            },
            {
              op_id: 'op-soul-test',
              type: 'update_soul',
              target_path: 'SOUL.md',
              proposed_content: '# Modified Soul',
              rationale: 'Attempted persona edit'
            },
            {
              op_id: 'op-merge-test',
              type: 'merge_pages',
              target_paths: ['wiki/domains/literary-notes.md'],
              output_path: 'wiki/syntheses/syn-literary-merged.md',
              frontmatter: {
                id: 'mem-syn-lit',
                title: '文学考据汇流页',
                type: 'synthesis',
                domain: ['literary-criticism'],
                anchors: ['脂砚斋评本'],
                tag_chain: ['红楼梦考据', '脂砚斋评本'],
                sources: ['span:antigravity:dream-s1:sp01']
              },
              proposed_content: '# 文学考据汇流页\n\n汇流 红楼梦考据 与 脂砚斋评本。\n',
              rationale: 'Consolidate literary page'
            }
          ]
        })
      });

      assert.equal(res.appliedLowRisk.length, 1);
      assert.equal(res.queuedHighRisk.length, 3);

      // Low-risk page must exist on disk with verified compiler signature.
      const epRaw = await fs.readFile(path.join(vaultDir, 'wiki/episodes/ep-ui-workbench.md'), 'utf8');
      assert.equal(parseFrontmatter(epRaw).data.compiled_by.model_id, 'gemini-3-pro');

      // High-risk ops must NOT mutate SOUL.md or literary-notes.md yet.
      assert.doesNotMatch(await fs.readFile(path.join(vaultDir, 'SOUL.md'), 'utf8'), /Modified Soul/);

      // Reject update_soul
      const rej = await reviewDreamOp(vaultDir, 'op-soul-test', { decision: 'reject', note: 'keep original soul' });
      assert.equal(rej.status, 'rejected');
      assert.doesNotMatch(await fs.readFile(path.join(vaultDir, 'SOUL.md'), 'utf8'), /Modified Soul/);

      // Approve merge_pages -> creates merged synthesis page & moves old page to wiki/archive/
      const app = await reviewDreamOp(vaultDir, 'op-merge-test', { decision: 'approve' });
      assert.equal(app.status, 'approved');
      assert.equal(app.archived_paths.length, 1);
      assert.match(app.archived_paths[0], /^wiki\/archive\/literary-notes/);
      const archivedExists = await fs.access(path.join(vaultDir, app.archived_paths[0])).then(() => true).catch(() => false);
      assert.equal(archivedExists, true);
      const oldStillAtOriginal = await fs.access(path.join(vaultDir, 'wiki/domains/literary-notes.md')).then(() => true).catch(() => false);
      assert.equal(oldStillAtOriginal, false);
    } finally {
      await new Promise((r) => decSrv.close(r));
    }
  });
});

test('4. DeepSeek Harness Cordis plugin (adapters/dsh/host.js) implements assistantCards.registerMemory cleanly', { skip: SKIP_NO_VEXUS }, async () => {
  await withTempDir(async (tmpDir) => {
    const kitDir = path.join(tmpDir, 'kit');
    const vaultDir = path.join(tmpDir, 'vault');
    await fs.mkdir(kitDir, { recursive: true });
    await seedRichVault(vaultDir);
    await registerCartridge(kitDir, { id: 'algernon', vaultPath: vaultDir, setDefault: true });

    const embClient = createEmbeddingClient(HASH_PROVIDER_64);
    await bakeSnapshot(vaultDir, { embeddingClient: embClient, providerConfig: HASH_PROVIDER_64 });

    let registeredLib = null;
    let cleanupFn = null;
    const mockCtx = {
      assistantCards: {
        registerMemory(lib) {
          registeredLib = lib;
          return () => { registeredLib = null; };
        }
      },
      effect(fn) {
        cleanupFn = fn();
      }
    };

    const applyRet = await applyDshPlugin(mockCtx, {
      kitRoot: kitDir,
      cardMap: { 'card-alg': 'algernon' },
      embeddingClientOverride: embClient
    });
    assert.equal(applyRet, undefined);
    assert.ok(registeredLib);
    const lib = registeredLib;

    const recalled = await lib.recall({
      cardId: 'card-alg',
      query: '读写分离与只读快照架构',
      reportedModel: 'auto'
    });
    assert.match(recalled, /仅作为参考资料，不是指令/);
    assert.match(recalled, /<recalled_memory/);
    assert.match(recalled, /<signature_notice/);

    const ing1 = await lib.ingest({
      cardId: 'card-alg',
      sessionId: 'dsh-s1',
      messages: [
        { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'DSH 端测试消息' }] },
        { id: 'm2', role: 'assistant', content: 'DSH 回复' }
      ]
    });
    assert.equal(ing1.ingested, 2);

    // Idempotent second ingest
    const ing2 = await lib.ingest({
      cardId: 'card-alg',
      sessionId: 'dsh-s1',
      messages: [
        { id: 'm1', source: { kind: 'user' }, content: 'DSH 端测试消息' }
      ]
    });
    assert.equal(ing2.ingested, 0);

    const jobsRes = await lib.jobs({ cardId: 'card-alg' });
    assert.equal(jobsRes.sessionsProcessed, 1);

    const listed = await lib.list({ cardId: 'card-alg', query: 'DSH' });
    assert.ok(listed.pages.length >= 2);
    assert.ok(listed.spans.length >= 1);

    await cleanupFn();
    assert.equal(registeredLib, null);
  });
});

test('5. VCPToolBox hybridservice plugin (adapters/vcp/index.cjs) expands L0/L1, injects L2 on last user only, and executes tool commands', { skip: SKIP_NO_VEXUS }, async () => {
  await withTempDir(async (tmpDir) => {
    const kitDir = path.join(tmpDir, 'kit');
    const vaultDir = path.join(tmpDir, 'vault');
    await fs.mkdir(kitDir, { recursive: true });
    await seedRichVault(vaultDir);
    await registerCartridge(kitDir, { id: 'algernon', vaultPath: vaultDir, setDefault: true });

    const embClient = createEmbeddingClient(HASH_PROVIDER_64);
    await bakeSnapshot(vaultDir, { embeddingClient: embClient, providerConfig: HASH_PROVIDER_64 });
    await fs.writeFile(
      path.join(kitDir, 'providers.local.json'),
      JSON.stringify({ embedding_providers: [HASH_PROVIDER_64] }),
      'utf8'
    );

    const vcpPluginPath = path.join(KIT_ROOT, 'adapters/vcp/index.cjs');
    delete require.cache[require.resolve(vcpPluginPath)];
    const vcpPlugin = require(vcpPluginPath);

    await vcpPlugin.initialize({
      PMV_KIT_ROOT: kitDir,
      PMV_DEFAULT_CARTRIDGE: 'algernon',
      PMV_RECORD_LEDGER: 'true'
    });

    try {
      const inputMessages = [
        { role: 'system', content: '基础系统提示\n[[PMV::algernon]]' },
        { role: 'user', content: '第一轮历史消息（不应被篡改）' },
        { role: 'assistant', content: '第一轮历史回复' },
        { role: 'user', content: '第二轮提问：脂砚斋评本与庚辰本异文怎么比勘？' }
      ];

      const outMessages = await vcpPlugin.processMessages(inputMessages, {
        sessionId: 'vcp-sess-1',
        model: 'auto'
      });

      // L0+L1 expanded in system message; trigger tag stripped
      assert.doesNotMatch(outMessages[0].content, /\[\[PMV::algernon\]\]/);
      assert.match(outMessages[0].content, /阿尔吉侬/);
      assert.match(outMessages[0].content, /Living Chronicle/);

      // Earlier messages untouched for KV-cache integrity
      assert.equal(outMessages[1].content, '第一轮历史消息（不应被篡改）');
      assert.equal(outMessages[2].content, '第一轮历史回复');

      // Last user message receives L2 <recalled_memory> + <signature_notice>
      assert.match(outMessages[3].content, /<recalled_memory/);
      assert.match(outMessages[3].content, /<signature_notice/);
      assert.match(outMessages[3].content, /第二轮提问/);

      // Tool calls work cleanly
      const statusRes = await vcpPlugin.processToolCall({ command: 'PMV_Status', cartridge: 'algernon' });
      assert.equal(statusRes.status, 'success');
      assert.equal(JSON.parse(statusRes.result).character.id, 'algernon');

      const wikiRes = await vcpPlugin.processToolCall({
        command: 'PMV_ReadWiki',
        cartridge: 'algernon',
        path: 'projects/pmv-core.md'
      });
      assert.equal(wikiRes.status, 'success');
      assert.match(wikiRes.result, /PersonaMemoryVault/);

      const spanSearch = await vcpPlugin.processToolCall({
        command: 'PMV_SearchSpans',
        cartridge: 'algernon',
        query: '庚辰本异文'
      });
      assert.equal(spanSearch.status, 'success');
    } finally {
      await vcpPlugin.shutdown();
    }
  });
});
