import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  computeModelSig,
  createEmbeddingClient,
  resolveEmbeddingProvider
} from '../core/embedding-provider.mjs';
import { loadManifest } from '../core/manifest.mjs';
import { projectVaultToRiverDocs } from '../core/okf-projector.mjs';
import {
  bakeSnapshot,
  formatRecalledMemoryXml,
  openSnapshotReader,
  readSnapshotManifest
} from '../core/rivermemo-snapshot.mjs';
import { initVault } from '../core/vault-init.mjs';
import { serializeFrontmatter } from '../core/yaml-lite.mjs';
import { hasVexusLite } from '../native/vexus-bridge.mjs';
import { createStudioServer } from '../studio/server.mjs';

const SKIP_NO_VEXUS = hasVexusLite() ? false : 'Optional native rust-vexus-lite not installed';

const HASH_PROVIDER_64 = {
  id: 'hash-64',
  provider: 'local-hash',
  adapter: 'deterministic-hash',
  model_id: 'hash-v1',
  dimension: 64,
  normalize: true
};

const HASH_PROVIDER_128 = {
  id: 'hash-128',
  provider: 'local-hash',
  adapter: 'deterministic-hash',
  model_id: 'hash-v2',
  dimension: 128,
  normalize: true
};

async function withTempDir(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmv-phase2-'));
  try {
    return await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function seedSampleVault(vaultDir) {
  await initVault(vaultDir, { id: 'algernon', name: 'Algernon', displayName: '阿尔吉侬' });
  await fs.writeFile(
    path.join(vaultDir, 'tags', 'taxonomy.yaml'),
    `schema: pmv-taxonomy/v1
domains:
  - agent-memory
  - engineering
  - frontend-engineering
  - literary-criticism
blacklist: [总结, 笔记]
tag_chain_rules:
  min_length: 2
  max_length: 8
  require_body_closure: true
`,
    'utf8'
  );

  const defaultCompiler = { model_id: null, provider: 'antigravity', sign_source: 'unsigned' };

  const pages = [
    {
      rel: 'wiki/projects/pmv-core.md',
      meta: {
        id: 'mem-pmv-core',
        title: 'Persona Memory Vault 读写分离架构',
        type: 'architecture',
        status: 'active',
        domain: ['agent-memory', 'engineering'],
        importance: 'core',
        updated_at: '2026-11-20',
        anchors: ['PersonaMemoryVault', '读写分离'],
        tag_chain: ['Algernon记忆重构', 'Cteno不可变账本', '只读RiverMemo快照'],
        sources: ['span:antigravity:s1:sp01']
      },
      body: '# Persona Memory Vault 读写分离架构\n\n采用 PersonaMemoryVault 读写分离，通过 Cteno不可变账本 与 只读RiverMemo快照 实现 Algernon记忆重构。'
    },
    {
      rel: 'wiki/domains/frontend-ui.md',
      meta: {
        id: 'mem-frontend-ui',
        title: '现代前端状态与交互设计规范',
        type: 'concept',
        status: 'active',
        domain: ['frontend-engineering'],
        importance: 'high',
        updated_at: '2026-11-20',
        anchors: ['响应式交互面板', '状态单向流'],
        tag_chain: ['前端工程', '响应式交互面板', '暗色编辑台UI'],
        sources: ['span:antigravity:s2:sp01']
      },
      body: '# 现代前端状态与交互设计规范\n\n前端工程强调 状态单向流 与 响应式交互面板，保持 暗色编辑台UI 清爽可维护。'
    },
    {
      rel: 'wiki/domains/literary-honglou.md',
      meta: {
        id: 'mem-literary-honglou',
        title: '《红楼梦》脂评本异文校勘备忘',
        type: 'literary',
        status: 'active',
        domain: ['literary-criticism'],
        importance: 'high',
        updated_at: '2026-11-20',
        anchors: ['脂砚斋评本', '庚辰本异文'],
        tag_chain: ['红楼梦版本考据', '脂砚斋评本', '庚辰本异文', '文学校勘'],
        sources: ['span:antigravity:s3:sp01']
      },
      body: '# 《红楼梦》脂评本异文校勘备忘\n\n围绕 红楼梦版本考据 比勘 庚辰本异文 与 脂砚斋评本 批语脉络，支撑 文学校勘 精确溯源。'
    },
    {
      rel: 'wiki/decisions/adr-no-onering.md',
      meta: {
        id: 'mem-adr-no-onering',
        title: '决策：本体不包入 OneRing 多端同步器',
        type: 'decision',
        status: 'active',
        domain: ['agent-memory'],
        importance: 'core',
        updated_at: '2026-11-20',
        anchors: ['本体外壳分离', 'OneRing外置'],
        tag_chain: ['OneRing外置', '本体外壳分离', '二合一叙事索引'],
        sources: ['span:antigravity:s1:sp02']
      },
      body: '# 决策：本体不包入 OneRing 多端同步器\n\n坚持 本体外壳分离，采取 OneRing外置 策略，本体仅以 二合一叙事索引 承接跨会话脉络。'
    },
    {
      rel: 'wiki/episodes/ep-spans-utf8.md',
      meta: {
        id: 'mem-ep-spans',
        title: 'UTF-8 字节精准切片验证记录',
        type: 'episode',
        status: 'active',
        domain: ['engineering'],
        importance: 'normal',
        updated_at: '2026-11-20',
        anchors: ['UTF8字节切片', 'O1原文核对'],
        tag_chain: ['语义Span指针', 'UTF8字节切片', 'O1原文核对'],
        sources: ['span:antigravity:s4:sp01']
      },
      body: '# UTF-8 字节精准切片验证记录\n\n通过 语义Span指针 的 byte_offset 实现 UTF8字节切片，完成 O1原文核对。'
    },
    {
      rel: 'wiki/archive/old-note.md',
      meta: {
        id: 'mem-archived-01',
        title: '已废弃旧方案',
        type: 'concept',
        status: 'archived',
        domain: ['agent-memory'],
        importance: 'low',
        updated_at: '2026-11-10',
        anchors: ['废弃旧方案'],
        tag_chain: ['废弃旧方案', '归档'],
        sources: ['span:antigravity:s0:sp01']
      },
      body: '# 已废弃旧方案\n\n废弃旧方案 归档。'
    },
    {
      rel: 'wiki/domains/status-archived.md',
      meta: {
        id: 'mem-archived-02',
        title: '状态为 archived 的隐藏页',
        type: 'concept',
        status: 'archived',
        domain: ['agent-memory'],
        importance: 'low',
        updated_at: '2026-11-11',
        anchors: ['隐藏页'],
        tag_chain: ['隐藏页', '归档'],
        sources: ['span:antigravity:s0:sp02']
      },
      body: '# 状态为 archived 的隐藏页\n\n隐藏页 归档。'
    }
  ];

  for (const p of pages) {
    const fullMeta = { compiled_by: defaultCompiler, ...p.meta };
    await fs.writeFile(
      path.join(vaultDir, p.rel),
      serializeFrontmatter(fullMeta, p.body),
      'utf8'
    );
  }
}

test('1. projectVaultToRiverDocs excludes archive/ and status=archived and preserves ordered tag river', async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await seedSampleVault(vaultDir);

    const { docs, diaryNames } = await projectVaultToRiverDocs(vaultDir);
    assert.equal(docs.length, 5);
    assert.deepEqual(
      diaryNames.sort(),
      ['decisions', 'domains', 'episodes', 'projects']
    );

    const honglou = docs.find((d) => d.relPath === 'wiki/domains/literary-honglou.md');
    assert.ok(honglou);
    assert.deepEqual(honglou.orderedTags, [
      '脂砚斋评本',
      '庚辰本异文',
      '红楼梦版本考据',
      '文学校勘'
    ]);
    assert.match(honglou.projectedText, /Tag: 脂砚斋评本, 庚辰本异文, 红楼梦版本考据, 文学校勘\s*$/);
    assert.equal(docs.some((d) => d.relPath.includes('archive') || d.relPath.includes('status-archived')), false);
  });
});

test('2. bakeSnapshot creates clean native vexus-lite snapshot without junk artifacts and signs manifest', { skip: SKIP_NO_VEXUS }, async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await seedSampleVault(vaultDir);

    const client64 = createEmbeddingClient(HASH_PROVIDER_64);
    const res = await bakeSnapshot(vaultDir, {
      embeddingClient: client64,
      providerConfig: HASH_PROVIDER_64,
      preset: 'balanced'
    });

    assert.equal(res.mode, 'full');
    assert.equal(res.filesIngested, 5);
    assert.equal(res.snapshotManifest.embedding.model_sig, 'local-hash::hash-v1::64');
    assert.ok(res.snapshotManifest.artifact_sig);
    assert.equal(res.snapshotManifest.counts.files, 5);
    assert.ok(res.snapshotManifest.counts.tags >= 5);

    const snapDir = path.join(vaultDir, 'snapshot', 'rivermemo.snap');
    const files = await fs.readdir(snapDir);
    assert.ok(files.includes('snapshot.manifest.json'));
    assert.ok(files.includes('river_rules.json'));
    assert.ok(files.includes('okf_metadata.json'));
    assert.ok(files.includes('knowledge_base.sqlite'));
    assert.ok(files.some((f) => f.startsWith('index_global_tags') && f.endsWith('.vec')));
    assert.ok(files.some((f) => f.startsWith('index_diary_') && f.endsWith('.vec')));

    // Hygiene check: ZERO retired/checkpoint/wal/shm files allowed in baked snapshot.
    const junk = files.filter((f) =>
      /(\.retired|\.checkpoint-source|\.restore-source|-wal$|-shm$)/i.test(f)
    );
    assert.deepEqual(junk, []);

    const manifest = await loadManifest(vaultDir);
    assert.equal(manifest.preferred_models.embedding.status, 'signed');
    assert.equal(manifest.preferred_models.embedding.model_sig, 'local-hash::hash-v1::64');
  });
});

test('3. bakeSnapshot performs incremental update when adding and modifying OKF wiki pages', { skip: SKIP_NO_VEXUS }, async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await seedSampleVault(vaultDir);

    const client64 = createEmbeddingClient(HASH_PROVIDER_64);
    await bakeSnapshot(vaultDir, {
      embeddingClient: client64,
      providerConfig: HASH_PROVIDER_64,
      preset: 'balanced'
    });

    // Add 1 new page + modify 1 existing page.
    await fs.writeFile(
      path.join(vaultDir, 'wiki/syntheses/syn-memory-loop.md'),
      serializeFrontmatter({
        id: 'mem-syn-loop',
        title: '跨事件汇流：异步做梦与审批闸门',
        type: 'synthesis',
        status: 'active',
        domain: ['agent-memory'],
        importance: 'core',
        updated_at: '2026-11-20',
        anchors: ['异步做梦审批', '汇流综合'],
        tag_chain: ['异步做梦审批', '高风险审批队列', '汇流综合'],
        sources: ['span:antigravity:s1:sp01']
      }, '# 跨事件汇流\n\n总结 异步做梦审批 与 高风险审批队列 的 汇流综合 规范。'),
      'utf8'
    );

    const modifiedPath = path.join(vaultDir, 'wiki/episodes/ep-spans-utf8.md');
    const oldContent = await fs.readFile(modifiedPath, 'utf8');
    await fs.writeFile(modifiedPath, `${oldContent}\n补充：验证增量烘焙更新路径。\n`, 'utf8');

    const incRes = await bakeSnapshot(vaultDir, {
      embeddingClient: client64,
      providerConfig: HASH_PROVIDER_64,
      preset: 'balanced'
    });

    assert.equal(incRes.mode, 'incremental');
    assert.equal(incRes.filesIngested, 2);
    assert.equal(incRes.snapshotManifest.counts.files, 6);
  });
});

test('4. embedding signature mismatch trips hard circuit-breaker and allows full rebake only when explicitly confirmed', { skip: SKIP_NO_VEXUS }, async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await seedSampleVault(vaultDir);

    const client64 = createEmbeddingClient(HASH_PROVIDER_64);
    await bakeSnapshot(vaultDir, {
      embeddingClient: client64,
      providerConfig: HASH_PROVIDER_64
    });

    const manifest = await loadManifest(vaultDir);
    const snap = await readSnapshotManifest(vaultDir);
    const mismatchStatus = resolveEmbeddingProvider(manifest, snap, {
      embedding_providers: [HASH_PROVIDER_128]
    });
    assert.equal(mismatchStatus.state, 'mismatch');
    assert.equal(mismatchStatus.requiresFullRebakeConfirmation, true);

    const client128 = createEmbeddingClient(HASH_PROVIDER_128);
    await assert.rejects(
      () => bakeSnapshot(vaultDir, {
        embeddingClient: client128,
        providerConfig: HASH_PROVIDER_128
      }),
      (err) => err.code === 'EMBEDDING_SIGNATURE_MISMATCH' && err.details?.requiresFullRebakeConfirmation === true
    );

    // Existing 64-dim snapshot must remain completely untouched after aborted mismatch.
    const untouchedSnap = await readSnapshotManifest(vaultDir);
    assert.equal(untouchedSnap.embedding.model_sig, computeModelSig(HASH_PROVIDER_64));

    // Retry with explicit confirmation & switch flag.
    const rebakeRes = await bakeSnapshot(vaultDir, {
      embeddingClient: client128,
      providerConfig: HASH_PROVIDER_128,
      forceFullRebake: true,
      allowSignatureSwitch: true
    });
    assert.equal(rebakeRes.mode, 'full');
    assert.equal(rebakeRes.snapshotManifest.embedding.model_sig, 'local-hash::hash-v2::128');

    const updatedManifest = await loadManifest(vaultDir);
    assert.equal(updatedManifest.preferred_models.embedding.dimension, 128);
  });
});

test('5. openSnapshotReader executes real native Topology V3.1 recall across all presets and formats L2 XML', { skip: SKIP_NO_VEXUS }, async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await seedSampleVault(vaultDir);

    const client64 = createEmbeddingClient(HASH_PROVIDER_64);
    await bakeSnapshot(vaultDir, {
      embeddingClient: client64,
      providerConfig: HASH_PROVIDER_64,
      preset: 'balanced'
    });

    const reader = await openSnapshotReader(vaultDir);
    try {
      const qText = '脂砚斋评本与庚辰本异文校勘怎么做的？';
      const qVec = await client64.embedOne(qText);

      for (const preset of ['balanced', 'precision_research', 'associative_explore']) {
        const res = await reader.query({
          text: qText,
          vector: qVec,
          preset,
          topK: 3,
          includeTrace: true
        });
        assert.equal(res.preset, preset);
        assert.ok(res.items.length >= 1, `Expected recall items for preset=${preset}`);
        assert.equal(res.items[0].id, 'mem-literary-honglou');
        assert.ok(res.trace.topology.omega !== null);

        const xml = formatRecalledMemoryXml(res);
        assert.match(xml, /<recalled_memory snapshot_sig="local-hash::hash-v1::64"/);
        assert.match(xml, /id="mem-literary-honglou"/);
      }
    } finally {
      reader.close();
    }
  });
});

test('6. Offline RiverMemo Studio HTTP server serves UI, state, lint, regression diff, and 409 mismatch guard', { skip: SKIP_NO_VEXUS }, async () => {
  await withTempDir(async (tmpDir) => {
    const vaultDir = path.join(tmpDir, 'vault');
    await seedSampleVault(vaultDir);

    const client64 = createEmbeddingClient(HASH_PROVIDER_64);
    await bakeSnapshot(vaultDir, {
      embeddingClient: client64,
      providerConfig: HASH_PROVIDER_64
    });

    const server = createStudioServer({
      vaultPath: vaultDir,
      providersOverride: {
        embedding_providers: [HASH_PROVIDER_64, HASH_PROVIDER_128],
        decision_providers: []
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;

      const htmlRes = await fetch(`${base}/`);
      assert.equal(htmlRes.status, 200);
      assert.match(await htmlRes.text(), /RiverMemo 离线编辑器与快照烘焙台/);

      const stateRes = await fetch(`${base}/api/state`);
      assert.equal(stateRes.status, 200);
      const stateJson = await stateRes.json();
      assert.equal(stateJson.embeddingStatus.state, 'matched');

      const lintRes = await fetch(`${base}/api/lint`);
      const lintJson = await lintRes.json();
      assert.equal(lintJson.errors, 0);

      const queryRes = await fetch(`${base}/api/test-query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: '为什么不包入 OneRing 多端同步器？',
          baselinePreset: 'balanced',
          candidatePreset: 'precision_research',
          topK: 3
        })
      });
      assert.equal(queryRes.status, 200);
      const queryJson = await queryRes.json();
      assert.ok(Array.isArray(queryJson.diff) && queryJson.diff.length >= 1);
      assert.ok(
        queryJson.candidate.items.some((it) => it.id === 'mem-adr-no-onering'),
        'Expected mem-adr-no-onering in Studio candidate recall results'
      );

      // Unconfirmed switch to 128-dim provider must return HTTP 409.
      const blockedBake = await fetch(`${base}/api/bake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'hash-128',
          preset: 'balanced',
          confirmFullRebake: false
        })
      });
      assert.equal(blockedBake.status, 409);
      const blockedJson = await blockedBake.json();
      assert.equal(blockedJson.error, 'EMBEDDING_SIGNATURE_MISMATCH');

      // Confirmed switch must succeed with HTTP 200.
      const confirmedBake = await fetch(`${base}/api/bake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'hash-128',
          preset: 'precision_research',
          confirmFullRebake: true
        })
      });
      assert.equal(confirmedBake.status, 200);
      const confirmedJson = await confirmedBake.json();
      assert.equal(confirmedJson.mode, 'full');
      assert.equal(confirmedJson.snapshotManifest.embedding.dimension, 128);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
