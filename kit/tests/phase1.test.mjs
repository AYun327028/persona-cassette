import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createDecisionClient,
  resolveDecisionProvider
} from '../core/decision-provider.mjs';
import { buildIndex } from '../core/index-builder.mjs';
import { ingestAntigravityTranscripts, mirrorDoc } from '../core/ledger.mjs';
import {
  evaluateRuntimeSignature,
  formatSignatureNoticeXml,
  loadManifest
} from '../core/manifest.mjs';
import {
  buildAllSpans,
  indexSessionSpans,
  readLedgerSpan,
  searchLedgerSpans
} from '../core/spans.mjs';
import { lintTags } from '../core/tags.mjs';
import { initVault } from '../core/vault-init.mjs';
import {
  parseFrontmatter,
  parseYaml,
  serializeFrontmatter,
  stringifyYaml
} from '../core/yaml-lite.mjs';

async function withTempDir(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmv-test-'));
  try {
    return await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('1. yaml-lite round-trips Chinese OKF frontmatter and taxonomy.yaml cleanly', () => {
  const sampleObj = {
    id: 'mem-20261120-test',
    title: '中文标题: 含冒号与测试',
    type: 'architecture',
    status: 'active',
    domain: ['agent-memory', 'literary-criticism'],
    facets: {
      stack: ['markdown', 'yaml', 'rust-napi'],
      work: ['《红楼梦》', '脂砚斋评本']
    },
    compiled_by: {
      model_id: null,
      provider: 'antigravity',
      sign_source: 'unsigned'
    },
    anchors: ['PersonaMemoryVault', '只读RiverMemo快照'],
    tag_chain: ['Algernon记忆重构', '语义Span切片指针', 'OKF双轨记忆页'],
    sources: ['antigravity/b9ba66bc#step1-step35']
  };

  const md = serializeFrontmatter(sampleObj, '# 正文标题\n\n这里讨论 PersonaMemoryVault 与 语义Span切片指针。\n');
  const parsed = parseFrontmatter(md);
  assert.equal(parsed.hasFrontmatter, true);
  assert.deepEqual(parsed.data, sampleObj);
  assert.match(parsed.body, /# 正文标题/);

  const yamlWithComments = `
schema: pmv-taxonomy/v1 # version tag
domains:
  - frontend-engineering # comment
  - literary-criticism
aliases:
  前端: frontend-engineering
  "含:冒号": engineering
blacklist: [总结, 笔记]
`;
  const parsedTax = parseYaml(yamlWithComments);
  assert.equal(parsedTax.schema, 'pmv-taxonomy/v1');
  assert.deepEqual(parsedTax.domains, ['frontend-engineering', 'literary-criticism']);
  assert.equal(parsedTax.aliases['前端'], 'frontend-engineering');
  assert.equal(parsedTax.aliases['含:冒号'], 'engineering');
  assert.deepEqual(parsedTax.blacklist, ['总结', '笔记']);

  const roundTripTax = parseYaml(stringifyYaml(parsedTax));
  assert.deepEqual(roundTripTax, parsedTax);
});

test('2. initVault creates clean skeleton with all 4 model signatures unsigned', async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await initVault(vaultDir, {
      id: 'algernon',
      name: 'Algernon',
      displayName: '阿尔吉侬'
    });

    const manifest = await loadManifest(vaultDir);
    assert.equal(manifest.schema, 'persona-memory-vault/v1');
    assert.equal(manifest.character.display_name, '阿尔吉侬');

    for (const slot of ['chat', 'dream', 'embedding', 'decision']) {
      assert.equal(manifest.preferred_models[slot].status, 'unsigned');
      assert.equal(manifest.preferred_models[slot].model_id, null);
      assert.equal(manifest.preferred_models[slot].sign_source, 'unsigned');
    }

    const autoEval = evaluateRuntimeSignature(manifest, 'auto');
    assert.equal(autoEval.verified, false);
    assert.equal(autoEval.needsUserSign, true);
    assert.equal(autoEval.sign_source, 'unsigned');
    assert.match(formatSignatureNoticeXml(autoEval), /<signature_notice status="unverified"/);

    manifest.preferred_models.chat.model_id = 'gemini-3-pro';
    const mismatchEval = evaluateRuntimeSignature(manifest, 'gemini-2.5-flash');
    assert.equal(mismatchEval.verified, true);
    assert.equal(mismatchEval.needsUserSign, true);
    assert.equal(mismatchEval.reason, 'differs_from_preferred_chat');
  });
});

test('3. ingestAntigravityTranscripts is idempotent, summarizes tool_calls, skips GENERIC blobs, and mirrors docs', async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    const brainDir = path.join(tmpDir, 'brain');
    const sessionDir = path.join(brainDir, 'sess-001', '.system_generated', 'logs');
    await fs.mkdir(sessionDir, { recursive: true });
    await initVault(vaultDir, { id: 'algernon', name: 'Algernon' });

    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-20T01:00:00Z', content: '请帮我设计记忆系统架构。' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-20T01:00:02Z', content: '', tool_calls: [{ name: 'read_file', args: { Path: 'F:\\SPEC.md' } }] }),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-20T01:00:03Z', content: 'HUGE RAW TOOL OUTPUT BLOB '.repeat(50) }),
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-20T01:00:10Z', content: '我们决定采用只追加 ledger 与只读快照方案。' })
    ];
    await fs.writeFile(path.join(sessionDir, 'transcript.jsonl'), `${lines.join('\n')}\n`, 'utf8');

    const first = await ingestAntigravityTranscripts(vaultDir, { brainDir });
    assert.equal(first.sessionsScanned, 1);
    assert.equal(first.sessionsUpdated, 1);
    assert.equal(first.eventsAdded, 3);
    assert.equal(first.parseErrors, 0);

    const ledgerContent = await fs.readFile(
      path.join(vaultDir, 'ledger', 'sessions', 'antigravity', 'sess-001.jsonl'),
      'utf8'
    );
    assert.doesNotMatch(ledgerContent, /HUGE RAW TOOL OUTPUT BLOB/);
    const parsedEvents = ledgerContent.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(parsedEvents[0].sign_source, 'unsigned');
    assert.equal(parsedEvents[0].model_signature.model_id, null);
    assert.equal(parsedEvents[1].role, 'tool_summary');
    assert.match(parsedEvents[1].content, /\[tools\] read_file/);

    // Re-running must be strictly idempotent.
    const second = await ingestAntigravityTranscripts(vaultDir, { brainDir });
    assert.equal(second.eventsAdded, 0);
    assert.equal(second.eventsSkipped, 3);

    const sampleDoc = path.join(tmpDir, 'ORIGIN.md');
    await fs.writeFile(sampleDoc, '# Origin Doc\n中文内容测试\n', 'utf8');
    const mirrored = await mirrorDoc(vaultDir, sampleDoc, { docId: 'doc-origin' });
    assert.equal(mirrored.status, 'mirrored');
    const mirroredAgain = await mirrorDoc(vaultDir, sampleDoc, { docId: 'doc-origin' });
    assert.equal(mirroredAgain.status, 'unchanged');
  });
});

test('4. spans indexing and readLedgerSpan perform UTF-8 byte-accurate O(1) slicing with CJK and Emoji', async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    const brainDir = path.join(tmpDir, 'brain');
    const sessionDir = path.join(brainDir, 'sess-cjk-utf8', '.system_generated', 'logs');
    await fs.mkdir(sessionDir, { recursive: true });
    await initVault(vaultDir, { id: 'algernon', name: 'Algernon' });

    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-20T01:00:00Z', content: '第一轮：你好 🌟' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-20T01:00:05Z', content: '你好！有什么可以帮你的？' }),
      JSON.stringify({ step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-20T01:05:00Z', content: '第二轮拍板决定：引入 语义Span切片指针 与 RiverMemo 快照，避免全量读日志 📚。' }),
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-20T01:05:10Z', content: '收到，我们按 UTF-8 byte_offset 精准切片读取！' }),
      JSON.stringify({ step_index: 4, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-20T01:10:00Z', content: '第三轮：测试红楼梦版本考据线索。' }),
      JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-20T01:10:10Z', content: '已记录脂砚斋评本相关考据条目。' })
    ];
    await fs.writeFile(path.join(sessionDir, 'transcript.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    await ingestAntigravityTranscripts(vaultDir, { brainDir });

    const spanRes = await buildAllSpans(vaultDir);
    assert.equal(spanRes.sessionsProcessed, 1);
    assert.equal(spanRes.totalSpans, 3);

    const hits = await searchLedgerSpans(vaultDir, { query: '语义Span切片指针', limit: 5 });
    assert.ok(hits.length >= 1);
    const targetSpan = hits[0];
    assert.equal(targetSpan.kind, 'decision');

    // Verify exact target slice (padSteps=0) returns steps 2..3 with intact UTF-8 CJK + emoji.
    const exactRead = await readLedgerSpan(vaultDir, targetSpan.span_id, { padSteps: 0 });
    assert.deepEqual(exactRead.events.map((e) => e.step_index), [2, 3]);
    assert.match(exactRead.events[0].content, /📚/);

    // Verify padded slice (padSteps=1) includes immediate neighbors without loading unrelated spans arbitrarily.
    const paddedRead = await readLedgerSpan(vaultDir, targetSpan.span_id, { padSteps: 1 });
    assert.deepEqual(paddedRead.events.map((e) => e.step_index), [1, 2, 3, 4]);
    assert.equal(paddedRead.events[0].is_target, false);
    assert.equal(paddedRead.events[1].is_target, true);
    assert.equal(paddedRead.events[3].is_target, false);
  });
});

test('5. lintTags catches aliases/blacklist/unclosed/broken links in preview mode and applies safe fixes', async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await initVault(vaultDir, { id: 'algernon', name: 'Algernon' });

    const taxPath = path.join(vaultDir, 'tags', 'taxonomy.yaml');
    await fs.writeFile(taxPath, `schema: pmv-taxonomy/v1
domains:
  - frontend-engineering
  - agent-memory
aliases:
  前端: frontend-engineering
  旧标签: 新标签
blacklist:
  - 总结
tag_chain_rules:
  min_length: 2
  max_length: 4
  require_body_closure: true
`, 'utf8');

    const badWiki = serializeFrontmatter({
      id: 'mem-bad-01',
      title: '测试页',
      type: 'concept',
      status: 'active',
      domain: ['前端'],
      anchors: ['总结', '核心锚点'],
      tag_chain: ['旧标签', '旧标签', '未闭合词', '额外1', '额外2', '额外3'],
      sources: ['span:test:sp01'],
      updated_at: '2026-11-20',
      compiled_by: { model_id: null, provider: 'antigravity', sign_source: 'unsigned' }
    }, '# 测试页\n\n正文只写了 核心锚点 与 新标签，完全未提及那个缺失概念。\n\n见 [不存在](./missing.md)。\n');

    const wikiFile = path.join(vaultDir, 'wiki', 'domains', 'test-bad.md');
    await fs.writeFile(wikiFile, badWiki, 'utf8');

    const preview = await lintTags(vaultDir, { fix: false });
    assert.equal(preview.filesScanned, 1);
    assert.ok(preview.plannedFixes.length >= 3);
    assert.ok(preview.issues.some((i) => i.code === 'blacklisted_tag'));
    assert.ok(preview.issues.some((i) => i.code === 'unclosed_tag' && i.message.includes('未闭合词')));
    assert.ok(preview.issues.some((i) => i.code === 'broken_link'));
    assert.ok(preview.issues.some((i) => i.code === 'tag_chain_length'));

    // Apply safe fixes; verify aliases & dedup were written back while unclosed error remains reported.
    const fixed = await lintTags(vaultDir, { fix: true });
    assert.ok(fixed.appliedFixes >= 3);
    const updatedFm = parseFrontmatter(await fs.readFile(wikiFile, 'utf8'));
    assert.deepEqual(updatedFm.data.domain, ['frontend-engineering']);
    assert.deepEqual(updatedFm.data.tag_chain, ['新标签', '未闭合词', '额外1', '额外2', '额外3']);

    const tagsIndex = await fs.readFile(path.join(vaultDir, 'tags', 'index.md'), 'utf8');
    const tagsChains = await fs.readFile(path.join(vaultDir, 'tags', 'chains.md'), 'utf8');
    assert.match(tagsIndex, /核心锚点/);
    assert.match(tagsChains, /新标签 -> 未闭合词/);
  });
});

test('6. DecisionProvider gracefully degrades when unconfigured/failing and integrates with custom/gemini/jev HTTP contracts', async () => {
  const noopClient = createDecisionClient(null);
  const degraded = await noopClient.evaluate({ state: 'hello', questions: { q: { type: 'noul' } } });
  assert.equal(degraded.degraded, true);
  assert.deepEqual(degraded.answers, {});

  const resolvedUnsigned = resolveDecisionProvider(
    { preferred_models: { decision: { status: 'unsigned', model_id: null } } },
    { decision_providers: [] }
  );
  assert.equal(resolvedUnsigned.status, 'unsigned');

  const receivedRequests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      receivedRequests.push({ url: req.url, headers: req.headers, body: parsed });

      if (req.url === '/broken') {
        res.writeHead(503);
        res.end('Service Unavailable');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/gemini') {
        res.end(JSON.stringify({
          model: 'gemini-decision-1',
          answers: {
            has_lasting_value: { type: 'noul', noul: 0.91 },
            salience_level: { type: 'score', score: 3.6 },
            kind: { type: 'choice', choice: 'decision', confidence: 0.88 }
          }
        }));
      } else if (req.url === '/jev') {
        res.end(JSON.stringify({
          model: 'jev-latest',
          answers: {
            needs_recall: { type: 'noul', noul: 0.85, confidence: 0.9 }
          }
        }));
      } else {
        res.end(JSON.stringify({
          model: 'custom-v1',
          answers: {
            gate: { type: 'choice', choice: 'precision_research', confidence: 0.92 }
          }
        }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const geminiClient = createDecisionClient({
      provider: 'gemini',
      adapter: 'gemini-decisions',
      model_id: 'gemini-decision-1',
      base_url: `${base}/gemini`,
      api_key: 'test-gemini-key'
    });
    const gRes = await geminiClient.evaluate({
      state: '决定架构方案',
      questions: { has_lasting_value: { type: 'noul' } }
    });
    assert.equal(gRes.degraded, false);
    assert.equal(gRes.answers.kind.choice, 'decision');
    assert.equal(receivedRequests[0].headers['x-goog-api-key'], 'test-gemini-key');
    assert.equal(receivedRequests[0].body.input, '决定架构方案');

    const jevClient = createDecisionClient({
      provider: 'typesafe',
      adapter: 'typesafe-jev',
      model_id: 'jev-latest',
      base_url: `${base}/jev`,
      api_key: 'test-jev-key'
    });
    const jRes = await jevClient.evaluate({
      state: '查找旧决策',
      questions: { needs_recall: { type: 'noul' } }
    });
    assert.equal(jRes.degraded, false);
    assert.equal(jRes.answers.needs_recall.noul, 0.85);
    assert.equal(receivedRequests[1].headers.authorization, 'Bearer test-jev-key');
    assert.equal(receivedRequests[1].body.state, '查找旧决策');

    const customClient = createDecisionClient({
      provider: 'custom',
      adapter: 'custom-http',
      model_id: 'custom-v1',
      base_url: `${base}/custom`,
      allow_unauthenticated: true
    });
    const cRes = await customClient.evaluate({
      state: '考据细节',
      questions: { gate: { type: 'choice', criteria: { balanced: 'b', precision_research: 'p' } } }
    });
    assert.equal(cRes.degraded, false);
    assert.equal(cRes.answers.gate.choice, 'precision_research');

    // Broken endpoint degrades safely without throwing.
    const brokenClient = createDecisionClient({
      provider: 'custom',
      adapter: 'custom-http',
      model_id: 'broken-v1',
      base_url: `${base}/broken`,
      allow_unauthenticated: true
    });
    const bRes = await brokenClient.evaluate({ state: 'x', questions: {} });
    assert.equal(bRes.degraded, true);
    assert.equal(bRes.reason, 'http_503');

    // Also verify indexSessionSpans consumes active DecisionProvider cleanly.
    await withTempDir(async (tmpDir) => {
      const vaultDir = path.join(tmpDir, 'vault');
      await initVault(vaultDir, { id: 'algernon', name: 'Algernon' });
      const sessDir = path.join(vaultDir, 'ledger', 'sessions', 'antigravity');
      await fs.mkdir(sessDir, { recursive: true });
      const evt = {
        schema: 'pmv-ledger-event/v1',
        event_id: 'antigravity:s1:0',
        ts: '2026-11-20T02:00:00Z',
        source_harness: 'antigravity',
        session_id: 's1',
        step_index: 0,
        role: 'user',
        content: '测试判断模型注入 span',
        content_sha256: 'abc',
        model_signature: { provider: 'antigravity', model_id: null, raw_reported: 'auto' },
        sign_source: 'unsigned'
      };
      await fs.writeFile(path.join(sessDir, 's1.jsonl'), `${JSON.stringify(evt)}\n`, 'utf8');
      const sp = await indexSessionSpans(vaultDir, 'antigravity', 's1', { decisionClient: geminiClient });
      assert.equal(sp.spans[0].annotated_by.model_id, 'gemini-decision-1');
      assert.equal(sp.spans[0].annotated_by.sign_source, 'runtime_verified');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('7. buildIndex generates two-part Living Chronicle strictly within budgets.index_max_lines (<= 150)', async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await initVault(vaultDir, { id: 'algernon', name: 'Algernon', displayName: '阿尔吉侬' });

    // Seed 20 spans across 20 sessions and 160 wiki pages to stress-test the <= 150 line ceiling.
    const spansDir = path.join(vaultDir, 'ledger', 'spans', 'antigravity');
    await fs.mkdir(spansDir, { recursive: true });
    for (let i = 1; i <= 20; i += 1) {
      await fs.writeFile(path.join(spansDir, `sess-${i}.spans.json`), JSON.stringify({
        schema: 'pmv-ledger-spans/v1',
        source_harness: 'antigravity',
        session_id: `sess-${i}`,
        ledger_path: `ledger/sessions/antigravity/sess-${i}.jsonl`,
        spans: [{
          span_id: `antigravity:sess-${i}:sp01`,
          session_id: `sess-${i}`,
          source_harness: 'antigravity',
          step_range: [0, 1],
          byte_offset: 0,
          byte_length: 100,
          ts_end: `2026-11-${String(Math.min(20, i)).padStart(2, '0')}T02:00:00Z`,
          kind: 'decision',
          salience: 0.8,
          gist: `重要进展 #${i}`
        }]
      }), 'utf8');
    }

    for (let i = 1; i <= 160; i += 1) {
      await fs.writeFile(
        path.join(vaultDir, 'wiki', 'domains', `topic-${i}.md`),
        serializeFrontmatter({
          id: `mem-${i}`,
          title: `专题 ${i}`,
          type: 'concept',
          status: 'active',
          domain: ['agent-memory'],
          importance: i <= 3 ? 'core' : 'normal',
          anchors: [`锚点${i}`],
          tag_chain: [`锚点${i}`, '测试专题'],
          sources: ['span:antigravity:sess-1:sp01'],
          updated_at: '2026-11-20',
          compiled_by: { model_id: null, provider: 'antigravity', sign_source: 'unsigned' }
        }, `# 专题 ${i}\n\n锚点${i} 与 测试专题。\n`),
        'utf8'
      );
    }

    const res = await buildIndex(vaultDir, { nowMs: Date.parse('2026-11-20T03:00:00Z') });
    assert.ok(res.lineCount <= 150, `Expected <= 150 lines, got ${res.lineCount}`);

    const rawIndex = await fs.readFile(res.outPath, 'utf8');
    assert.match(rawIndex, /## 近期脉络（Living Timeline）/);
    assert.match(rawIndex, /## 常青支柱（Evergreen Pillars）/);
    assert.match(rawIndex, /\[core\]/);
  });
});
