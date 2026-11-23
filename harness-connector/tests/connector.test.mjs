import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { registerCartridge } from '../../kit/core/cartridges.mjs';
import { closeAllCachedReaders } from '../../kit/core/runtime.mjs';
import { initVault } from '../../kit/core/vault-init.mjs';
import { handleConnectorMcpMessage } from '../mcp-server.mjs';
import {
  detectWorkspaceRulesFile,
  removeWorkspaceRulesFile,
  syncWorkspaceRulesFile
} from '../rules-renderer.mjs';
import { resolveConnectorCartridge, scanWorkspaceCartridges } from '../slot-scanner.mjs';

async function withTempWorkspace(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmv-conn-'));
  const kitRoot = path.join(root, 'kit');
  const demoVault = path.join(root, 'shelf', 'demo-memory');
  await fs.mkdir(kitRoot, { recursive: true });
  await initVault(demoVault, { id: 'demo', name: 'Demo', displayName: '默认库卡' });
  await registerCartridge(kitRoot, { id: 'demo', vaultPath: demoVault, setDefault: true });
  try {
    return await fn({ root, kitRoot, demoVault });
  } finally {
    closeAllCachedReaders();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('1. slot-scanner detects single drop-in cartridge, triggers multi-cartridge interlock on >=2, and ignores deep nested folders', async () => {
  await withTempWorkspace(async ({ root, kitRoot }) => {
    // A. Empty workspace -> none
    const wsEmpty = path.join(root, 'ws-empty');
    await fs.mkdir(wsEmpty, { recursive: true });
    const scanEmpty = await scanWorkspaceCartridges([wsEmpty]);
    assert.equal(scanEmpty.status, 'none');

    // B. Deep nested cartridge (2 levels deep, e.g. cassettes/starter-persona) -> ignored!
    const wsNested = path.join(root, 'ws-nested');
    await initVault(path.join(wsNested, 'cassettes', 'nested-persona'), {
      id: 'nested',
      name: 'Nested',
      displayName: '嵌套模板'
    });
    const scanNested = await scanWorkspaceCartridges([wsNested]);
    assert.equal(scanNested.status, 'none');

    // C. Single drop-in cartridge at 1st-level subdir -> single!
    const wsSingle = path.join(root, 'ws-single');
    const alphaPath = path.join(wsSingle, 'alpha-memory');
    await initVault(alphaPath, { id: 'alpha', name: 'Alpha', displayName: '直插卡A' });
    const scanSingle = await scanWorkspaceCartridges([wsSingle]);
    assert.equal(scanSingle.status, 'single');
    assert.equal(scanSingle.primary.id, 'alpha');
    assert.equal(scanSingle.primary.placement, 'workspace_subdir');

    const resolvedSingle = await resolveConnectorCartridge({ workspacePath: wsSingle, kitRoot });
    assert.equal(resolvedSingle.source, 'workspace_cartridge_slot');
    assert.equal(resolvedSingle.cartridgeId, 'alpha');

    // D. Workspace root itself is a cartridge -> single (workspace_root)!
    const scanRoot = await scanWorkspaceCartridges([alphaPath]);
    assert.equal(scanRoot.status, 'single');
    assert.equal(scanRoot.primary.placement, 'workspace_root');

    // E. Two cartridges in one workspace -> multi-cartridge interlock!
    const wsMulti = path.join(root, 'ws-multi');
    await initVault(path.join(wsMulti, 'alpha-memory'), { id: 'alpha', name: 'Alpha', displayName: '卡A' });
    await initVault(path.join(wsMulti, 'beta-memory'), { id: 'beta', name: 'Beta', displayName: '卡B' });
    const scanMulti = await scanWorkspaceCartridges([wsMulti]);
    assert.equal(scanMulti.status, 'interlocked');
    assert.equal(scanMulti.cartridges.length, 2);

    await assert.rejects(
      () => resolveConnectorCartridge({ workspacePath: wsMulti, kitRoot }),
      /Multi-cartridge interlock active/
    );
    const unlockedBeta = await resolveConnectorCartridge({
      workspacePath: wsMulti,
      cartridge: 'beta',
      kitRoot
    });
    assert.equal(unlockedBeta.cartridgeId, 'beta');
    assert.equal(unlockedBeta.source, 'workspace');
  });
});

test('2. rules-renderer supports AGENTS.md/CLAUDE.md/GEMINI.md with monotonic KV-Cache order and preserves user notes', async () => {
  await withTempWorkspace(async ({ root, kitRoot, demoVault }) => {
    await fs.writeFile(
      path.join(demoVault, 'wiki', 'index.md'),
      [
        '# 默认库卡 总索引',
        '',
        '## 近期脉络（Living Timeline）',
        '- [2026-11-24 01:00] 最近动态A',
        '',
        '## 常青支柱（Evergreen Pillars）',
        '- `[core]` 常青专题A'
      ].join('\n') + '\n',
      'utf8'
    );

    const wsDir = path.join(root, 'claude-home');
    await fs.mkdir(wsDir, { recursive: true });
    const claudeFile = path.join(wsDir, 'CLAUDE.md');
    await fs.writeFile(claudeFile, '# Project Notes\n- Keep my custom rules.\n', 'utf8');

    const synced = await syncWorkspaceRulesFile(wsDir, 'demo', {
      kitRoot,
      fileName: 'CLAUDE.md',
      includeIndex: true,
      maxBytes: 24000
    });
    assert.equal(synced.synced, true);
    assert.equal(synced.fileName, 'CLAUDE.md');
    assert.equal(synced.withinLimit, true);

    const content = await fs.readFile(claudeFile, 'utf8');
    assert.match(content, /Keep my custom rules/);
    const evPos = content.indexOf('常青支柱（Evergreen Pillars）');
    const tlPos = content.indexOf('近期脉络（Living Timeline）');
    assert.ok(evPos > 0 && tlPos > evPos, 'Evergreen Pillars must precede Living Timeline');

    const detected = await detectWorkspaceRulesFile([wsDir], 'demo', {
      kitRoot,
      autoRefresh: false
    });
    assert.equal(detected.active, true);
    assert.equal(detected.fileName, 'CLAUDE.md');

    const removed = await removeWorkspaceRulesFile(wsDir, { fileName: 'CLAUDE.md' });
    assert.equal(removed.removed, true);
    assert.equal(removed.deletedFile, false);
    assert.equal(removed.preservedUserContent, true);
    const remaining = await fs.readFile(claudeFile, 'utf8');
    assert.match(remaining, /Keep my custom rules/);
    assert.doesNotMatch(remaining, /pmv-top-rules/);
  });
});

test('3. Universal harness-connector MCP server exposes 6 core + 3 universal tools (slot status, sync rules, commit turn) with interlock & shelf discovery', async () => {
  await withTempWorkspace(async ({ root, kitRoot }) => {
    // 1. tools/list returns 9 universal tools (zero Antigravity-only tools!)
    const listRes = await handleConnectorMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { kitRoot }
    );
    const names = listRes.result.tools.map((t) => t.name);
    assert.equal(names.length, 9);
    assert.ok(names.includes('pmv_status'));
    assert.ok(names.includes('pmv_slot_status'));
    assert.ok(names.includes('pmv_sync_rules'));
    assert.ok(names.includes('pmv_commit_turn'));
    assert.ok(!names.includes('pmv_set_persona_mode'));

    // 2. Drop-in single cartridge workspace: pmv_status, pmv_sync_rules, pmv_commit_turn work zero-config!
    const wsSingle = path.join(root, 'ws-dropin');
    const alphaVault = path.join(wsSingle, 'alpha-memory');
    await initVault(alphaVault, { id: 'alpha', name: 'Alpha', displayName: '直插阿尔法' });

    const stRes = await handleConnectorMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pmv_status', arguments: { workspace_path: wsSingle } } },
      { kitRoot }
    );
    assert.equal(stRes.result.isError, false);
    assert.match(stRes.result.content[0].text, /"id": "alpha"/);

    const syncRes = await handleConnectorMcpMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'pmv_sync_rules', arguments: { workspace_path: wsSingle, file_name: 'CLAUDE.md' } }
      },
      { kitRoot }
    );
    assert.equal(syncRes.result.isError, false);
    assert.match(await fs.readFile(path.join(wsSingle, 'CLAUDE.md'), 'utf8'), /直插阿尔法/);

    const commitRes = await handleConnectorMcpMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'pmv_commit_turn',
          arguments: {
            workspace_path: wsSingle,
            session_id: 'cherry-001',
            harness: 'cherry-studio',
            user_text: '通过纯 MCP 写入一条对话记忆',
            assistant_text: '已收到并通过通用 MCP 落盘'
          }
        }
      },
      { kitRoot }
    );
    assert.equal(commitRes.result.isError, false);
    const sessions = await fs.readdir(path.join(alphaVault, 'ledger', 'sessions', 'cherry-studio'));
    assert.ok(sessions.some((f) => f.includes('cherry-001')));

    // 3. Multi-cartridge interlock blocks ambiguous workspace reads & syncs cleanly
    const wsMulti = path.join(root, 'ws-interlock');
    await initVault(path.join(wsMulti, 'a-memory'), { id: 'card-a', name: 'A', displayName: '卡A' });
    await initVault(path.join(wsMulti, 'b-memory'), { id: 'card-b', name: 'B', displayName: '卡B' });

    const lockedStatus = await handleConnectorMcpMessage(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pmv_slot_status', arguments: { workspace_path: wsMulti } } },
      { kitRoot }
    );
    const lockedObj = JSON.parse(lockedStatus.result.content[0].text);
    assert.equal(lockedObj.usage_mode, 'workspace_multi_cartridge_interlock');
    assert.equal(lockedObj.interlocked, true);

    const blockedRead = await handleConnectorMcpMessage(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'pmv_status', arguments: { workspace_path: wsMulti } } },
      { kitRoot }
    );
    assert.equal(blockedRead.result.isError, true);
    assert.match(blockedRead.result.content[0].text, /Multi-cartridge interlock active/);

    // 4. Fixed shelf directory (PMV_CARTRIDGES_DIR) auto-discovers new shelf cartridges!
    const shelfDir = path.join(root, 'custom-shelf');
    await initVault(path.join(shelfDir, 'gamma-memory'), { id: 'gamma', name: 'Gamma', displayName: '库卡伽马' });
    const prevShelf = process.env.PMV_CARTRIDGES_DIR;
    process.env.PMV_CARTRIDGES_DIR = shelfDir;
    try {
      const shelfRead = await handleConnectorMcpMessage(
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pmv_status', arguments: { cartridge: 'gamma' } } },
        { kitRoot }
      );
      assert.equal(shelfRead.result.isError, false);
      assert.match(shelfRead.result.content[0].text, /"id": "gamma"/);
    } finally {
      if (prevShelf === undefined) delete process.env.PMV_CARTRIDGES_DIR;
      else process.env.PMV_CARTRIDGES_DIR = prevShelf;
    }
  });
});
