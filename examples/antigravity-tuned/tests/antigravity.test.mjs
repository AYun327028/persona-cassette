import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { registerCartridge } from '../../../kit/core/cartridges.mjs';
import { closeAllCachedReaders } from '../../../kit/core/runtime.mjs';
import { initVault } from '../../../kit/core/vault-init.mjs';
import { syncWorkspaceRulesFile } from '../../../harness-connector/rules-renderer.mjs';
import { handleAntigravityMcpMessage } from '../mcp-server.mjs';

const EXAMPLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runScriptWithStdin(scriptPath, stdinText, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(stdinText);
  });
}

async function withTempSetup(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmv-ag-ex-'));
  const kitRoot = path.join(root, 'kit');
  const stateDir = path.join(root, 'baselines');
  const vaultDir = path.join(root, 'shelf', 'demo-memory');
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

test('1. Antigravity dual-mode isolation + /persona on|off|status wake/seal lifecycle', async () => {
  await withTempSetup(async ({ root, kitRoot, stateDir, vaultDir }) => {
    const modeStateFile = path.join(root, 'modes.json');
    const dedupFile = path.join(root, 'dedup.json');
    const codeWs = path.join(root, 'code-repo');
    const trWork = path.join(root, 'work-tr.jsonl');
    await fs.mkdir(codeWs, { recursive: true });

    const env = {
      PMV_KIT_ROOT: kitRoot,
      PMV_CARTRIDGE: 'demo',
      PMV_SESSION_STATE_DIR: stateDir,
      PMV_MODE_STATE_FILE: modeStateFile,
      PMV_DEDUP_FILE: dedupFile,
      PMV_WORK_WORKSPACES: kitRoot
    };

    // Code repo stays silent in Work Mode
    const workSs = await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-session-start.mjs'),
      JSON.stringify({ conversationId: 'ag-c1', workspacePaths: [codeWs] }),
      env
    );
    assert.deepEqual(JSON.parse(workSs.stdout), {});

    const workPre = await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-pre-invocation.mjs'),
      JSON.stringify({ conversationId: 'ag-c1', workspacePaths: [codeWs], lastUserInput: '修普通 bug' }),
      env
    );
    assert.deepEqual(JSON.parse(workPre.stdout), {});

    // `/persona on` wakes Assistant Mode mid-conversation
    const wake = await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-pre-invocation.mjs'),
      JSON.stringify({ conversationId: 'ag-c1', workspacePaths: [codeWs], lastUserInput: '/persona on' }),
      env
    );
    assert.match(JSON.parse(wake.stdout).injectSteps[0].systemMessage.systemMessage, /Persona Awakened/);

    // Stop persists to ledger once awake
    await fs.writeFile(
      trWork,
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-11-24T03:00:00Z', content: '唤醒后的消息' }) + '\n',
      'utf8'
    );
    await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-stop.mjs'),
      JSON.stringify({ conversationId: 'ag-c1', workspacePaths: [codeWs], transcriptPath: trWork }),
      env
    );
    const ledgerFiles = await fs.readdir(path.join(vaultDir, 'ledger', 'sessions', 'antigravity'));
    assert.ok(ledgerFiles.some((f) => f.includes('ag-c1')));

    // `/persona off` seals back to silent Work Mode
    const seal = await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-pre-invocation.mjs'),
      JSON.stringify({ conversationId: 'ag-c1', workspacePaths: [codeWs], lastUserInput: '/persona off' }),
      env
    );
    assert.match(JSON.parse(seal.stdout).injectSteps[0].systemMessage.systemMessage, /Persona Sealed/);
  });
});

test('2. Drop-in single cartridge full-auto AGENTS.md rendering + silent SessionStart + multi-cartridge interlock', async () => {
  await withTempSetup(async ({ root, kitRoot, stateDir }) => {
    const env = {
      PMV_KIT_ROOT: kitRoot,
      PMV_SESSION_STATE_DIR: stateDir,
      PMV_MODE_STATE_FILE: path.join(root, 'slot-modes.json'),
      PMV_DEDUP_FILE: path.join(root, 'slot-dedup.json'),
      PMV_WORK_WORKSPACES: kitRoot
    };

    // Single unregistered drop-in cartridge -> auto-renders AGENTS.md, 2nd SessionStart is silent `{}`
    const wsSingle = path.join(root, 'ws-single');
    await initVault(path.join(wsSingle, 'alpha-memory'), { id: 'alpha', name: 'Alpha', displayName: '直插阿尔法' });

    const ss1 = await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-session-start.mjs'),
      JSON.stringify({ conversationId: 'slot-1', workspacePaths: [wsSingle] }),
      env
    );
    assert.equal(ss1.code, 0, ss1.stderr);
    assert.match(await fs.readFile(path.join(wsSingle, 'AGENTS.md'), 'utf8'), /直插阿尔法/);

    const ss2 = await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-session-start.mjs'),
      JSON.stringify({ conversationId: 'slot-2', workspacePaths: [wsSingle] }),
      env
    );
    assert.deepEqual(JSON.parse(ss2.stdout), {});

    // Two cartridges -> Multi-Cartridge Interlock (silent, no AGENTS.md, `/persona on beta` unlocks!)
    const wsMulti = path.join(root, 'ws-multi');
    await initVault(path.join(wsMulti, 'alpha-memory'), { id: 'alpha', name: 'Alpha', displayName: '卡A' });
    await initVault(path.join(wsMulti, 'beta-memory'), { id: 'beta', name: 'Beta', displayName: '贝塔卡' });

    const ssMulti = await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-session-start.mjs'),
      JSON.stringify({ conversationId: 'multi-1', workspacePaths: [wsMulti] }),
      env
    );
    assert.deepEqual(JSON.parse(ssMulti.stdout), {});
    await assert.rejects(() => fs.access(path.join(wsMulti, 'AGENTS.md')));

    const onNoId = await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-pre-invocation.mjs'),
      JSON.stringify({ conversationId: 'multi-1', workspacePaths: [wsMulti], lastUserInput: '/persona on' }),
      env
    );
    assert.match(JSON.parse(onNoId.stdout).injectSteps[0].systemMessage.systemMessage, /Persona Interlock/);

    const onBeta = await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-pre-invocation.mjs'),
      JSON.stringify({ conversationId: 'multi-1', workspacePaths: [wsMulti], lastUserInput: '/persona on beta' }),
      env
    );
    assert.match(JSON.parse(onBeta.stdout).injectSteps[0].systemMessage.systemMessage, /贝塔卡/);
  });
});

test('3. CHECKPOINT compaction wall stops dedup scan and drives Dynamic Persona Concentration Boost', async () => {
  await withTempSetup(async ({ root, kitRoot, stateDir }) => {
    const diagFile = path.join(root, 'diag.json');
    const codeWs = path.join(root, 'code-ws');
    const wsTop = path.join(root, 'top-ws');
    await fs.mkdir(codeWs, { recursive: true });
    await syncWorkspaceRulesFile(wsTop, 'demo', { kitRoot, includeIndex: true, createPersonaMarker: true });

    const env = {
      PMV_KIT_ROOT: kitRoot,
      PMV_CARTRIDGE: 'demo',
      PMV_SESSION_STATE_DIR: stateDir,
      PMV_MODE_STATE_FILE: path.join(root, 'c-modes.json'),
      PMV_DEDUP_FILE: path.join(root, 'c-dedup.json'),
      PMV_HOOK_DIAG_FILE: diagFile,
      PMV_WORK_WORKSPACES: kitRoot,
      PMV_REBOOST_ON_COMPACTION: 'true',
      PMV_REBOOST_INTERVAL_TURNS: '2'
    };

    await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-pre-invocation.mjs'),
      JSON.stringify({ conversationId: 'dyn-1', workspacePaths: [codeWs], lastUserInput: '/persona on' }),
      env
    );

    const trDir = path.join(root, 'logs');
    await fs.mkdir(trDir, { recursive: true });
    const trPath = path.join(trDir, 'transcript.jsonl');
    const trFull = path.join(trDir, 'transcript_full.jsonl');
    const lines = [
      JSON.stringify({ step_index: 10, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>旧问题</USER_REQUEST>' }),
      JSON.stringify({ step_index: 11, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', content: '<recalled_memory><item id="mem-old"></item></recalled_memory>' }),
      JSON.stringify({ step_index: 50, source: 'SYSTEM', type: 'CHECKPOINT', content: '# Resuming from a compaction' }),
      JSON.stringify({ step_index: 51, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>压缩后第一句</USER_REQUEST>' })
    ].join('\n') + '\n';
    await fs.writeFile(trPath, lines, 'utf8');
    await fs.writeFile(trFull, lines, 'utf8');

    // Dynamic mode recovers from CHECKPOINT #50 and cuts off history scan at step 50 (history_scanned === 1)
    const post = await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-pre-invocation.mjs'),
      JSON.stringify({ conversationId: 'dyn-1', workspacePaths: [codeWs], transcriptPath: trPath, lastUserInput: '压缩后第一句' }),
      env
    );
    assert.match(JSON.parse(post.stdout).injectSteps[0].systemMessage.systemMessage, /Persona Concentration Boost · Compaction #50/);
    const d1 = JSON.parse(await fs.readFile(diagFile, 'utf8'));
    assert.equal(d1.history_scanned, 1);
    assert.equal(d1.concentration_boost, 'compaction_recovery');

    // Full top-rules workspace skips duplicate baseline on compaction while still cutting off history at step 50
    await runScriptWithStdin(
      path.join(EXAMPLE_DIR, 'hook-pre-invocation.mjs'),
      JSON.stringify({ conversationId: 'top-1', workspacePaths: [wsTop], transcriptPath: trPath, lastUserInput: '顶部压缩后一句' }),
      env
    );
    const dTop = JSON.parse(await fs.readFile(diagFile, 'utf8'));
    assert.equal(dTop.top_rules_active, true);
    assert.equal(dTop.concentration_boost, null);
    assert.equal(dTop.history_scanned, 1);
  });
});

test('4. Antigravity-tuned MCP server exposes 9 universal + 2 Hook-coupled tools and standalone installer rewrites paths', async () => {
  await withTempSetup(async ({ root, kitRoot, stateDir }) => {
    const prevMode = process.env.PMV_MODE_STATE_FILE;
    const prevState = process.env.PMV_SESSION_STATE_DIR;
    process.env.PMV_MODE_STATE_FILE = path.join(root, 'mcp-ag-modes.json');
    process.env.PMV_SESSION_STATE_DIR = stateDir;

    try {
      const listRes = await handleAntigravityMcpMessage(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { kitRoot }
      );
      const names = listRes.result.tools.map((t) => t.name);
      assert.equal(names.length, 11);
      assert.ok(names.includes('pmv_slot_status'));
      assert.ok(names.includes('pmv_sync_rules'));
      assert.ok(names.includes('pmv_commit_turn'));
      assert.ok(names.includes('pmv_persona_status'));
      assert.ok(names.includes('pmv_set_persona_mode'));

      const boostRes = await handleAntigravityMcpMessage(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'pmv_set_persona_mode', arguments: { conversation_id: 'ag-mcp-1', action: 'boost', cartridge: 'demo' } }
        },
        { kitRoot }
      );
      const boostObj = JSON.parse(boostRes.result.content[0].text);
      assert.equal(boostObj.ok, true);
      assert.match(boostObj.refreshed_context, /演示角色/);

      // Standalone installer rewrites hooks.json & mcp_config.json cleanly into target folder
      const installDest = path.join(root, 'installed-plugin');
      const inst = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(EXAMPLE_DIR, 'install.mjs'), '--target', installDest, '--enable'], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
        child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
      });
      assert.equal(inst.code, 0, inst.stderr);
      const installedMcp = JSON.parse(await fs.readFile(path.join(installDest, 'mcp_config.json'), 'utf8'));
      assert.match(installedMcp.mcpServers['pmv-memory'].args[0], /examples\/antigravity-tuned\/mcp-server\.mjs$/);
    } finally {
      if (prevMode === undefined) delete process.env.PMV_MODE_STATE_FILE;
      else process.env.PMV_MODE_STATE_FILE = prevMode;
      if (prevState === undefined) delete process.env.PMV_SESSION_STATE_DIR;
      else process.env.PMV_SESSION_STATE_DIR = prevState;
    }
  });
});
