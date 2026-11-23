import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { registerCartridge } from '../core/cartridges.mjs';
import { startCassetteServer } from '../core/cassette-server.mjs';
import { commitDreamSession } from '../core/dream-runner.mjs';
import {
  assembleTurn,
  beginSession,
  closeAllCachedReaders,
  commitTurn,
  extractRecentRecalledKeys,
  readActivityState,
  refreshChronicle,
  stripInjectedBlocks
} from '../core/runtime.mjs';
import { initVault } from '../core/vault-init.mjs';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withTempKitAndVault(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmv-p4-'));
  const kitRoot = path.join(root, 'kit');
  const stateDir = path.join(root, 'baselines');
  const vaultDir = path.join(root, 'cassette', 'demo-memory');
  await fs.mkdir(kitRoot, { recursive: true });
  await initVault(vaultDir, { id: 'demo', name: 'Demo', displayName: '演示角色' });
  await registerCartridge(kitRoot, { id: 'demo', vaultPath: vaultDir, setDefault: true });
  try {
    return await fn({ root, kitRoot, stateDir, vaultDir });
  } finally {
    closeAllCachedReaders();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function seedLedgerTurns(vaultDir, kitRoot, sessionId, count, prefix = '历史', harness = 'seed') {
  for (let i = 1; i <= count; i += 1) {
    await commitTurn(vaultDir, {
      kitRoot,
      sessionId,
      harness,
      userText: `${prefix}问题_${i}`,
      assistantText: `${prefix}回答_${i}`,
      model: 'gpt-4o-mini',
      refreshTimeline: i === count
    });
  }
}

function runScriptWithStdin(scriptPath, stdinText, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

test('1. stripInjectedBlocks cleans chronicle_board_update and legacy injected XML tags', () => {
  const dirty = [
    '<chronicle_board_update now="2026-11-23T22:30:00+08:00" mode="delta">\n## 新增近期脉络\n- 测试\n</chronicle_board_update>',
    '<living_chronicle now="2026-11-23T22:00:00+08:00">\n# 索引\n</living_chronicle>',
    '<recalled_memory mode="spans_fallback" count="1">\n- 线索\n</recalled_memory>',
    '<signature_notice status="unverified">提示</signature_notice>',
    '---',
    '用户真正说的话'
  ].join('\n\n');

  const res = stripInjectedBlocks(dirty);
  assert.equal(res.changed, true);
  assert.equal(res.text, '用户真正说的话');

  const clean = stripInjectedBlocks('纯文本消息');
  assert.equal(clean.changed, false);
  assert.equal(clean.text, '纯文本消息');
});

test('2. assembleTurn backfills <10 turns up to 10, passes >=10 turns untouched, and freezes system baseline', async () => {
  await withTempKitAndVault(async ({ kitRoot, stateDir, vaultDir }) => {
    await seedLedgerTurns(vaultDir, kitRoot, 's-old-001', 8, '旧会话');
    await seedLedgerTurns(vaultDir, kitRoot, 's-cur-002', 6, '当前会话');

    // Case A: Stateless frontend (0 turns passed) -> initializes baseline in system + backfills 10 turns, 0 board delta
    const turn1 = await assembleTurn('demo', {
      kitRoot,
      stateDir,
      sessionId: 's-cur-002',
      userText: '现在测试开局基线冻结与无状态兜底',
      model: 'gpt-4o-mini'
    });
    assert.equal(turn1.meta.history.frontend_turns, 0);
    assert.equal(turn1.meta.history.backfilled_turns, 10);
    assert.equal(turn1.meta.history.effective_turns, 10);
    assert.equal(turn1.meta.history.action, 'backfilled');
    assert.equal(turn1.meta.board_update.baseline_initialized, true);
    assert.equal(turn1.meta.board_update.has_update, false);
    // Opening wiki/index.md is frozen directly inside system prompt
    assert.match(turn1.system, /记忆总索引（Living Chronicle）/);
    assert.doesNotMatch(turn1.user_prefix, /<chronicle_board_update/);
    assert.equal(turn1.messages.length, 22);

    // Case B: Second turn with partial history (3 turns) and NO external vault changes -> 0 board update tokens!
    const partialHistory = [
      { role: 'user', content: '<chronicle_board_update>脏残留</chronicle_board_update>\n\n---\n\n当前会话问题_4' },
      { role: 'assistant', content: '当前会话回答_4' },
      { role: 'user', content: '当前会话问题_5' },
      { role: 'assistant', content: '当前会话回答_5' },
      { role: 'user', content: '当前会话问题_6' },
      { role: 'assistant', content: '当前会话回答_6' }
    ];
    const turn2 = await assembleTurn('demo', {
      kitRoot,
      stateDir,
      sessionId: 's-cur-002',
      history: partialHistory,
      userText: '继续聊第7轮',
      model: 'gpt-4o-mini'
    });
    assert.equal(turn2.meta.history.frontend_turns, 3);
    assert.equal(turn2.meta.history.backfilled_turns, 7);
    assert.equal(turn2.meta.history.effective_turns, 10);
    assert.equal(turn2.meta.history.stripped_messages, 1);
    assert.equal(turn2.meta.board_update.baseline_initialized, false);
    assert.equal(turn2.meta.board_update.has_update, false);
    assert.doesNotMatch(turn2.user_prefix, /<chronicle_board_update/);
    // System prompt is byte-identical across turns (Prefix KV-Cache lock)
    assert.equal(turn2.system, turn1.system);

    // Case C: Frontend passes 13 turns (>= 10) -> untouched passthrough, NO cartridge compression!
    const longHistory = [];
    for (let i = 1; i <= 13; i += 1) {
      longHistory.push({ role: 'user', content: `长对话提问_${i}` });
      longHistory.push({ role: 'assistant', content: `长对话回答_${i}` });
    }
    const longRes = await assembleTurn('demo', {
      kitRoot,
      stateDir,
      sessionId: 's-long-003',
      history: longHistory,
      userText: '第14轮提问',
      model: 'gpt-4o-mini'
    });
    assert.equal(longRes.meta.history.frontend_turns, 13);
    assert.equal(longRes.meta.history.backfilled_turns, 0);
    assert.equal(longRes.meta.history.effective_turns, 13);
    assert.equal(longRes.meta.history.action, 'passthrough');
    assert.equal(longRes.messages.length, 28);
    assert.equal(longRes.messages[1].content, '长对话提问_1');
    assert.equal(longRes.messages[26].content, '长对话回答_13');
  });
});

test('3. Chronicle Board hot-update delivers ONLY external deltas while keeping system frozen (ephemeral & persistent modes)', async () => {
  await withTempKitAndVault(async ({ kitRoot, stateDir, vaultDir }) => {
    await seedLedgerTurns(vaultDir, kitRoot, 'init-0001', 1, '开局前');

    // Start two sessions: one ephemeral (pure-chat), one persistent (Antigravity)
    const ephStart = await beginSession('demo', {
      kitRoot,
      stateDir,
      sessionId: 'eph-1111',
      model: 'gpt-4o-mini'
    });
    const perStart = await beginSession('demo', {
      kitRoot,
      stateDir,
      sessionId: 'per-2222',
      model: 'gpt-4o-mini'
    });
    assert.equal(ephStart.created, true);
    assert.equal(perStart.created, true);

    // Same-session commit on eph-1111 should NOT echo back as an external board update to eph-1111
    await commitTurn(vaultDir, {
      kitRoot,
      sessionId: 'eph-1111',
      harness: 'pure-chat',
      userText: '我们在本会话决定了采用深色主题架构方案',
      assistantText: '好的，本会话已确认深色主题架构方案。',
      model: 'gpt-4o-mini'
    });

    const ephSelfCheck = await assembleTurn('demo', {
      kitRoot,
      stateDir,
      sessionId: 'eph-1111',
      history: [
        { role: 'user', content: '我们在本会话决定了采用深色主题架构方案' },
        { role: 'assistant', content: '好的，本会话已确认深色主题架构方案。' }
      ],
      userText: '顺便问个无关问题',
      model: 'gpt-4o-mini'
    });
    assert.equal(ephSelfCheck.system, ephStart.system);
    assert.equal(ephSelfCheck.meta.board_update.has_update, false);

    // Now an EXTERNAL harness commits a high-salience decision + USER_PROFILE.md updates on disk!
    await commitTurn(vaultDir, {
      kitRoot,
      sessionId: 'ext-9999',
      harness: 'vcp',
      userText: '拍板决定：所有前端统一采用标准 OpenAI 协议对接卡带架构。',
      assistantText: '已确认拍板，卡带架构将统一服务全部前端。',
      model: 'gpt-4o-mini'
    });
    await fs.appendFile(
      path.join(vaultDir, 'USER_PROFILE.md'),
      '\n- 新增偏好：优先使用零依赖精简脚本。\n',
      'utf8'
    );

    // Ephemeral session (eph-1111) keeps frozen system byte-identical, gets compact <chronicle_board_update>
    const ephHot = await assembleTurn('demo', {
      kitRoot,
      stateDir,
      sessionId: 'eph-1111',
      history: [
        { role: 'user', content: '我们在本会话决定了采用深色主题架构方案' },
        { role: 'assistant', content: '好的，本会话已确认深色主题架构方案。' }
      ],
      userText: '刚刚外面有什么新变动？',
      model: 'gpt-4o-mini'
    });
    assert.equal(ephHot.system, ephStart.system); // KV-Cache 100% locked!
    assert.equal(ephHot.meta.board_update.has_update, true);
    assert.ok(ephHot.meta.board_update.timeline_added >= 1);
    assert.equal(ephHot.meta.board_update.profile_changed, true);
    assert.match(ephHot.user_prefix, /<chronicle_board_update/);
    assert.match(ephHot.user_prefix, /标准 OpenAI 协议/);
    assert.match(ephHot.user_prefix, /优先使用零依赖精简脚本/);

    // Persistent session (per-2222, like Antigravity): receives delta ONCE, then advances cursor -> 0 on next turn!
    const perHot1 = await assembleTurn('demo', {
      kitRoot,
      stateDir,
      sessionId: 'per-2222',
      deliveryMode: 'persistent',
      userText: '检查跨端更新第一次',
      model: 'gpt-4o-mini'
    });
    assert.equal(perHot1.system, perStart.system);
    assert.equal(perHot1.meta.board_update.has_update, true);
    assert.match(perHot1.user_prefix, /<chronicle_board_update/);

    const perHot2 = await assembleTurn('demo', {
      kitRoot,
      stateDir,
      sessionId: 'per-2222',
      deliveryMode: 'persistent',
      userText: '检查跨端更新第二次（无新变化）',
      model: 'gpt-4o-mini'
    });
    assert.equal(perHot2.system, perStart.system);
    assert.equal(perHot2.meta.board_update.has_update, false);
    assert.doesNotMatch(perHot2.user_prefix, /<chronicle_board_update/);
  });
});

test('4. Headless HTTP server runs end-to-end with baseline freeze and cross-session delta push', async () => {
  await withTempKitAndVault(async ({ kitRoot, stateDir }) => {
    const srv = await startCassetteServer({ kitRoot, stateDir, port: 0 });
    try {
      const health = await fetch(`${srv.url}/health`).then((r) => r.json());
      assert.equal(health.ok, true);

      const started = await fetch(`${srv.url}/cartridges/demo/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'http-s001', model: 'gpt-4o-mini' })
      }).then((r) => r.json());
      assert.equal(started.created, true);
      assert.match(started.system, /演示角色/);

      const commitRes = await fetch(`${srv.url}/cartridges/demo/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'http-ext-888',
          harness: 'external-client',
          userText: '拍板决定跨端同步启用信息板热更新。',
          assistantText: '已确认启用信息板热更新机制。'
        })
      }).then((r) => r.json());
      assert.equal(commitRes.ok, true);

      const assembled = await fetch(`${srv.url}/cartridges/demo/assemble`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'http-s001',
          userText: '刚才另一个端聊了什么？',
          model: 'gpt-4o-mini'
        })
      }).then((r) => r.json());

      assert.equal(assembled.system, started.system);
      assert.equal(assembled.meta.board_update.has_update, true);
      assert.match(assembled.user_prefix, /<chronicle_board_update/);
      assert.match(assembled.user_prefix, /信息板热更新/);
    } finally {
      await new Promise((resolve) => srv.server.close(resolve));
    }
  });
});

test('5. commitDreamSession writes narrative dream_digest preserved across refreshes and hot-pushes via chronicle_board_update', async () => {
  await withTempKitAndVault(async ({ kitRoot, stateDir, vaultDir }) => {
    await seedLedgerTurns(vaultDir, kitRoot, 's-pre-dream', 2, '做梦前');

    // Start an active foreground session before dream runs
    const started = await beginSession('demo', {
      kitRoot,
      stateDir,
      sessionId: 'fg-live-1',
      model: 'gpt-4o-mini'
    });

    // Background dream agent writes a diary page and finalizes with commitDreamSession
    await fs.writeFile(
      path.join(vaultDir, 'wiki', 'episodes', 'ep-20261123-persona-awake.md'),
      [
        '---',
        'id: mem-20261123-persona-awake',
        'title: 落地 /persona 双模式唤醒与信息板热更新',
        'type: episode',
        'status: active',
        'domain: [agent-memory]',
        'importance: high',
        'updated_at: 2026-11-23',
        'anchors: [Persona双模式, 信息板热更新]',
        'tag_chain: [Persona双模式, 信息板热更新]',
        'sources: [span:seed:s-pre-dr:sp01]',
        '---',
        '',
        '# 落地 /persona 双模式唤醒与信息板热更新',
        '',
        '采用 Persona双模式 与 信息板热更新。'
      ].join('\n') + '\n',
      'utf8'
    );

    const commitRes = await commitDreamSession(vaultDir, {
      kitRoot,
      summary: '今晚完成了 /persona 唤醒关闭双模式分流与后台做梦收尾流。',
      model: 'antigravity-dream'
    });
    assert.equal(commitRes.status, 'committed');
    assert.equal(commitRes.digest_added, true);
    assert.equal(commitRes.index.digestCount, 1);

    const activity = await readActivityState(vaultDir);
    assert.equal(activity.turns_since_dream, 0);
    assert.equal(activity.dream_digests.length, 1);

    // Subsequent foreground rule refresh must NOT clobber the dream_digest
    await refreshChronicle(vaultDir, { kitRoot });
    const indexMd = await fs.readFile(path.join(vaultDir, 'wiki', 'index.md'), 'utf8');
    assert.match(indexMd, /\(dream_digest\) 今晚完成了 \/persona 唤醒关闭双模式分流/);

    // Active foreground session immediately gets the new dream digest + new diary page as delta!
    const assembled = await assembleTurn('demo', {
      kitRoot,
      stateDir,
      sessionId: 'fg-live-1',
      userText: '刚才后台做梦整理了什么？',
      model: 'gpt-4o-mini'
    });
    assert.equal(assembled.system, started.system);
    assert.equal(assembled.meta.board_update.has_update, true);
    assert.match(assembled.user_prefix, /<chronicle_board_update/);
    assert.match(assembled.user_prefix, /今晚完成了 \/persona 唤醒关闭双模式分流/);
    assert.match(assembled.user_prefix, /落地 \/persona 双模式唤醒与信息板热更新/);
  });
});

test('6. 10-turn history-scan recall dedup self-adapts between ephemeral chat frontends and append-only hosts', async () => {
  await withTempKitAndVault(async ({ kitRoot, stateDir, vaultDir }) => {
    const fakeReader = {
      async query() {
        return {
          preset: 'balanced',
          items: [
            {
              id: 'mem-repeat-a',
              path: 'wiki/domains/a.md',
              updated_at: '2026-11-23',
              score: 0.72,
              anchors: ['锚点A'],
              tag_chain: ['锚点A', '测试链'],
              sources: ['s1'],
              excerpt: '重复记忆A内容'
            },
            {
              id: 'mem-fresh-b',
              path: 'wiki/domains/b.md',
              updated_at: '2026-11-23',
              score: 0.65,
              anchors: ['锚点B'],
              tag_chain: ['锚点B', '测试链'],
              sources: ['s2'],
              excerpt: '全新记忆B内容'
            }
          ],
          trace: {},
          snapshotManifest: { embedding: { model_sig: 'test::sig::8' } }
        };
      },
      close() {}
    };

    const fakeEmb = {
      model_sig: 'test::sig::8',
      async embedOne() {
        return new Float32Array(8);
      }
    };

    // Fake snapshot manifest on vault handle so assembleTurn runs RiverMemo path
    const vault = {
      vaultPath: vaultDir,
      manifest: JSON.parse(await fs.readFile(path.join(vaultDir, 'character.manifest.json'), 'utf8')),
      soul: '# Demo Soul',
      userProfile: '# User',
      indexMd: '# Index',
      snapshotManifest: { embedding: { model_sig: 'test::sig::8' } }
    };

    // A. Clean ephemeral chat frontend (no <recalled_memory> in history) -> BOTH A and B inject!
    const cleanHistory = [
      { role: 'user', content: '上一轮干净消息' },
      { role: 'assistant', content: '上一轮干净回复' }
    ];
    const ephRes = await assembleTurn(vault, {
      kitRoot,
      stateDir,
      sessionId: 'dedup-eph',
      history: cleanHistory,
      userText: '测试纯前端不误伤',
      model: 'gpt-4o-mini',
      embeddingClient: fakeEmb,
      reader: fakeReader
    });
    assert.equal(ephRes.meta.recall.count, 2);
    assert.equal(ephRes.meta.recall.deduped_count, 0);
    assert.match(ephRes.user_prefix, /mem-repeat-a/);
    assert.match(ephRes.user_prefix, /mem-fresh-b/);

    // B. Append-only host (Antigravity SYSTEM_MESSAGE within 10 turns already has mem-repeat-a) -> ONLY mem-fresh-b injects!
    const appendOnlyHistory = [
      { role: 'user', content: '3轮前的问题' },
      {
        role: 'system',
        content: '<recalled_memory>\n  <item id="mem-repeat-a" path="wiki/domains/a.md" updated_at="2026-11-23" score="0.720">\n    <excerpt>旧</excerpt>\n  </item>\n</recalled_memory>'
      },
      { role: 'assistant', content: '3轮前的回答' }
    ];
    const perRes = await assembleTurn(vault, {
      kitRoot,
      stateDir,
      sessionId: 'dedup-per',
      history: appendOnlyHistory,
      userText: '测试10轮内查重跳过A只注B',
      model: 'gpt-4o-mini',
      embeddingClient: fakeEmb,
      reader: fakeReader
    });
    assert.equal(perRes.meta.recall.count, 1);
    assert.equal(perRes.meta.recall.deduped_count, 1);
    assert.doesNotMatch(perRes.user_prefix, /mem-repeat-a/);
    assert.match(perRes.user_prefix, /mem-fresh-b/);

    // C. When BOTH A and B already appeared within last 10 turns -> 0 bytes injected!
    const bothPresentHistory = [
      {
        role: 'system',
        content: '<recalled_memory>\n  <item id="mem-repeat-a" updated_at="2026-11-23"></item>\n  <item id="mem-fresh-b" updated_at="2026-11-23"></item>\n</recalled_memory>'
      },
      { role: 'user', content: '刚刚那轮' },
      { role: 'assistant', content: '刚刚回答' }
    ];
    const zeroRes = await assembleTurn(vault, {
      kitRoot,
      stateDir,
      sessionId: 'dedup-zero',
      history: bothPresentHistory,
      userText: '测试全部重复则零注入',
      model: 'gpt-4o-mini',
      embeddingClient: fakeEmb,
      reader: fakeReader
    });
    assert.equal(zeroRes.meta.recall.mode, 'deduped_empty');
    assert.equal(zeroRes.meta.recall.count, 0);
    assert.equal(zeroRes.meta.recall.deduped_count, 2);
    assert.doesNotMatch(zeroRes.user_prefix, /<recalled_memory/);

    // D. Sliding 10-turn expiration: after 11 newer user turns, old mem-repeat-a expires and re-injects!
    const agedHistory = [
      { role: 'user', content: '很久以前的问题' },
      {
        role: 'system',
        content: '<recalled_memory><item id="mem-repeat-a" updated_at="2026-11-23"></item></recalled_memory>'
      },
      { role: 'assistant', content: '很久以前的回答' }
    ];
    for (let i = 1; i <= 11; i += 1) {
      agedHistory.push({ role: 'user', content: `后续第${i}轮` });
      agedHistory.push({ role: 'assistant', content: `后续回复${i}` });
    }
    const keys = extractRecentRecalledKeys(agedHistory, 10, '新问题');
    assert.equal(keys.size, 0);
  });
});
