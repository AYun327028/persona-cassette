#!/usr/bin/env node
/**
 * @fileoverview Unified CLI entrypoint (`pmv`) for Persona Memory Vault (Phase 1–3).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCartridgesRegistry,
  registerCartridge,
  resolveCartridgePath,
  setDefaultCartridge
} from '../core/cartridges.mjs';
import { createDecisionClient, loadProvidersConfig, resolveDecisionProvider } from '../core/decision-provider.mjs';
import {
  commitDreamSession,
  listDreamQueue,
  reviewDreamOp,
  runDream
} from '../core/dream-runner.mjs';
import {
  computeModelSig,
  createEmbeddingClient,
  resolveEmbeddingProvider,
  signEmbeddingModel
} from '../core/embedding-provider.mjs';
import { buildIndex } from '../core/index-builder.mjs';
import { ingestAntigravityTranscripts, mirrorDoc } from '../core/ledger.mjs';
import { loadManifest } from '../core/manifest.mjs';
import {
  bakeSnapshot,
  formatRecalledMemoryXml,
  openSnapshotReader,
  readSnapshotManifest
} from '../core/rivermemo-snapshot.mjs';
import { startCassetteServer } from '../core/cassette-server.mjs';
import {
  assembleTurn,
  beginSession,
  closeAllCachedReaders,
  commitTurn,
  readActivityState
} from '../core/runtime.mjs';
import { buildAllSpans, readLedgerSpan, searchLedgerSpans } from '../core/spans.mjs';
import { lintTags } from '../core/tags.mjs';
import { initVault } from '../core/vault-init.mjs';
import { startStudioServer } from '../studio/server.mjs';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0] || '--help', args: positionals.slice(1), flags };
}

function printHelp() {
  console.log(`Persona Memory Vault CLI (pmv) — SPEC v1.1 (Phase 1–3)

Usage:
  pmv init <vaultPath> --id <id> [--name <name>] [--display <displayName>] [--overwrite]
  pmv status [vaultPathOrId]
  pmv cartridges list
  pmv cartridges add <id> <vaultPath> [--default]
  pmv cartridges set-default <id>
  pmv ingest-antigravity [vaultPathOrId] [--brain <dir>] [--tools summary|none] [--limit <n>]
  pmv build-spans [vaultPathOrId] [--session <id>]
  pmv search-spans [vaultPathOrId] [--query <kw>] [--kind <kind>] [--min-salience <0..1>] [--limit <n>]
  pmv read-span [vaultPathOrId] --id <spanId> [--pad <steps>]
  pmv lint-tags [vaultPathOrId] [--fix]
  pmv build-index [vaultPathOrId]
  pmv mirror-doc [vaultPathOrId] <sourceFile> [--id <docId>]
  pmv sign-embedding [vaultPathOrId] --provider <p> --model <m> --dim <d> [--adapter <a>] [--signed-by <who>]
  pmv bake [vaultPathOrId] [--provider-id <id>] [--preset balanced|precision_research|associative_explore] [--full] [--confirm-switch]
  pmv query-snap [vaultPathOrId] --query <text> [--preset <p>] [--top-k <n>] [--provider-id <id>] [--xml]
  pmv studio [vaultPathOrId] [--port <n>]
  pmv dream [vaultPathOrId] [--dry-run] [--min-salience 0.45] [--provider-id <id>]
  pmv dream-commit [vaultPathOrId] [--summary <text>] [--model <m>] [--bake] [--provider-id <id>]
  pmv queue [vaultPathOrId] [--status pending_review|approved|rejected|all]
  pmv approve [vaultPathOrId] --op <opId> [--note <text>]
  pmv reject [vaultPathOrId] --op <opId> [--note <text>]
  pmv serve [--port 3891] [--host 127.0.0.1]
  pmv session-start [vaultPathOrId] --session <id> [--model <m>] [--reset]
  pmv assemble [vaultPathOrId] [--text <userText>] [--session <id>] [--model <m>]
  pmv commit [vaultPathOrId]   (reads JSON from stdin)
`);
}

async function readOptionalStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function resolveTargetVault(rawArg) {
  const { vaultPath } = await resolveCartridgePath(KIT_ROOT, rawArg || null);
  return vaultPath;
}

async function resolveOptionalDecisionClient(vaultPath) {
  const manifest = await loadManifest(vaultPath);
  const providers = await loadProvidersConfig(KIT_ROOT);
  const resolved = resolveDecisionProvider(manifest, providers);
  return createDecisionClient(resolved.config);
}

async function countFilesRecursive(dir, predicate) {
  let count = 0;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) count += await countFilesRecursive(full, predicate);
    else if (e.isFile() && (!predicate || predicate(full))) count += 1;
  }
  return count;
}

async function resolveEmbeddingForCli(vaultPath, flags) {
  const manifest = await loadManifest(vaultPath);
  const snapManifest = await readSnapshotManifest(vaultPath);
  const providers = await loadProvidersConfig(KIT_ROOT);
  const embStatus = resolveEmbeddingProvider(manifest, snapManifest, providers);

  let selected = null;
  if (flags['provider-id']) {
    selected = embStatus.candidates.find(
      (c) => c.id === flags['provider-id'] || c.model_sig === flags['provider-id']
    );
    if (!selected) {
      throw new Error(`Embedding provider "${flags['provider-id']}" not found in providers.local.json`);
    }
  } else if (embStatus.state === 'matched') {
    selected = embStatus.providerConfig;
  } else if (embStatus.state === 'unsigned' && embStatus.candidates.length === 1) {
    selected = embStatus.candidates[0];
  } else {
    throw new Error(embStatus.message);
  }

  return { manifest, snapManifest, embStatus, providerConfig: selected };
}

async function cmdStatus(vaultPath) {
  const manifest = await loadManifest(vaultPath);
  const snapManifest = await readSnapshotManifest(vaultPath);
  const providers = await loadProvidersConfig(KIT_ROOT);
  const decisionResolution = resolveDecisionProvider(manifest, providers);
  const embeddingStatus = resolveEmbeddingProvider(manifest, snapManifest, providers);
  const activity = await readActivityState(vaultPath);
  const pendingQueue = await listDreamQueue(vaultPath, { status: 'pending_review' });

  const sessionFiles = await countFilesRecursive(path.join(vaultPath, 'ledger', 'sessions'), (f) => f.endsWith('.jsonl'));
  const spanFiles = await countFilesRecursive(path.join(vaultPath, 'ledger', 'spans'), (f) => f.endsWith('.spans.json'));
  const wikiFiles = await countFilesRecursive(
    path.join(vaultPath, 'wiki'),
    (f) => f.endsWith('.md') && !f.endsWith(`${path.sep}index.md`) && !f.endsWith(`${path.sep}log.md`)
  );
  let indexLines = 0;
  try {
    const idxRaw = await fs.readFile(path.join(vaultPath, 'wiki', 'index.md'), 'utf8');
    indexLines = idxRaw.trimEnd().split(/\r?\n/).length;
  } catch {
    indexLines = 0;
  }

  console.log(`Vault: ${vaultPath}`);
  console.log(`Character: ${manifest.character.display_name} (${manifest.character.id})`);
  console.log('Model Signatures:');
  for (const [slot, cfg] of Object.entries(manifest.preferred_models || {})) {
    console.log(`  - ${slot}: status=${cfg.status}, provider=${cfg.provider ?? 'null'}, model=${cfg.model_id ?? 'null'}, sign_source=${cfg.sign_source ?? 'unsigned'}`);
  }
  console.log(`DecisionProvider Status: ${decisionResolution.status} (${decisionResolution.reason})`);
  console.log(`Embedding Status: ${embeddingStatus.state} (${embeddingStatus.message})`);
  if (snapManifest) {
    console.log(
      `Snapshot: ${snapManifest.snapshot_version} | sig=${snapManifest.embedding?.model_sig} | preset=${snapManifest.preset} | files=${snapManifest.counts?.files}, nodes=${snapManifest.counts?.nodes}, edges=${snapManifest.counts?.edges}`
    );
  } else {
    console.log('Snapshot: none (run `pmv bake` or `pmv studio` after signing an embedding model)');
  }
  console.log(`Dream Activity: turns_since_dream=${activity.turns_since_dream}/${activity.dream_threshold_turns}, pending_queue=${pendingQueue.length}`);
  console.log(`Counts: sessions=${sessionFiles}, span_files=${spanFiles}, wiki_pages=${wikiFiles}, index_lines=${indexLines}/${manifest.budgets?.index_max_lines ?? 150}`);
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2));
  if (command === '--help' || command === '-h' || flags.help) {
    printHelp();
    return;
  }

  if (command === 'cartridges') {
    const sub = args[0] || 'list';
    if (sub === 'list') {
      console.log(JSON.stringify(await loadCartridgesRegistry(KIT_ROOT), null, 2));
      return;
    }
    if (sub === 'add') {
      const id = args[1];
      const vPath = args[2];
      if (!id || !vPath) throw new Error('cartridges add requires <id> <vaultPath>');
      const res = await registerCartridge(KIT_ROOT, {
        id,
        vaultPath: vPath,
        setDefault: Boolean(flags.default)
      });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (sub === 'set-default') {
      const id = args[1];
      if (!id) throw new Error('cartridges set-default requires <id>');
      const res = await setDefaultCartridge(KIT_ROOT, id);
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    throw new Error(`Unknown cartridges subcommand: ${sub}`);
  }

  if (command === 'serve') {
    const port = flags.port !== undefined ? Number(flags.port) : 3891;
    const host = flags.host ? String(flags.host) : '127.0.0.1';
    const { server, url } = await startCassetteServer({ kitRoot: KIT_ROOT, host, port });
    console.log(`Persona Cassette Headless Server listening at ${url}`);
    console.log(`Endpoints: GET ${url}/cartridges | POST ${url}/cartridges/:id/assemble | POST ${url}/cartridges/:id/commit`);
    console.log('Press Ctrl+C to stop.');
    await new Promise((resolve) => {
      const shutdown = () => server.close(resolve);
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return;
  }

  if (command === 'init') {
    if (!args[0]) throw new Error('init requires <vaultPath>');
    const res = await initVault(path.resolve(args[0]), {
      id: flags.id,
      name: flags.name,
      displayName: flags.display,
      overwrite: Boolean(flags.overwrite)
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const vaultPath = await resolveTargetVault(args[0]);

  if (command === 'status') {
    await cmdStatus(vaultPath);
    return;
  }

  if (command === 'ingest-antigravity') {
    const brainDir = flags.brain ? path.resolve(String(flags.brain)) : DEFAULT_BRAIN_DIR;
    const includeTools = flags.tools === 'none' ? 'none' : 'summary';
    const limitSessions = flags.limit ? Number(flags.limit) : null;
    const res = await ingestAntigravityTranscripts(vaultPath, { brainDir, includeTools, limitSessions });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'build-spans') {
    const decisionClient = await resolveOptionalDecisionClient(vaultPath);
    const res = await buildAllSpans(vaultPath, {
      sessionId: flags.session ? String(flags.session) : null,
      decisionClient
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'search-spans') {
    const res = await searchLedgerSpans(vaultPath, {
      query: flags.query ? String(flags.query) : '',
      kind: flags.kind ? String(flags.kind) : null,
      minSalience: flags['min-salience'] ? Number(flags['min-salience']) : 0,
      sessionId: flags.session ? String(flags.session) : null,
      limit: flags.limit ? Number(flags.limit) : 10
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'read-span') {
    if (!flags.id) throw new Error('read-span requires --id <spanId>');
    const res = await readLedgerSpan(vaultPath, String(flags.id), {
      padSteps: flags.pad !== undefined ? Number(flags.pad) : 1
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'lint-tags') {
    const decisionClient = await resolveOptionalDecisionClient(vaultPath);
    const res = await lintTags(vaultPath, { fix: Boolean(flags.fix), decisionClient });
    console.log(JSON.stringify(res, null, 2));
    if (res.errors > 0) process.exitCode = 1;
    return;
  }

  if (command === 'build-index') {
    const res = await buildIndex(vaultPath);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'mirror-doc') {
    const sourceFile = args[1];
    if (!sourceFile) throw new Error('mirror-doc requires <sourceFile>');
    const res = await mirrorDoc(vaultPath, sourceFile, {
      docId: flags.id ? String(flags.id) : undefined
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'sign-embedding') {
    if (!flags.provider || !flags.model || !flags.dim) {
      throw new Error('sign-embedding requires --provider <p> --model <m> --dim <d>');
    }
    const res = await signEmbeddingModel(
      vaultPath,
      {
        provider: String(flags.provider),
        model_id: String(flags.model),
        dimension: Number(flags.dim),
        adapter: flags.adapter ? String(flags.adapter) : undefined,
        normalize: true
      },
      { signedBy: flags['signed-by'] ? String(flags['signed-by']) : 'user' }
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'bake') {
    const { providerConfig } = await resolveEmbeddingForCli(vaultPath, flags);
    const client = createEmbeddingClient(providerConfig);
    try {
      const confirmSwitch = Boolean(flags['confirm-switch']);
      const res = await bakeSnapshot(vaultPath, {
        embeddingClient: client,
        providerConfig,
        preset: flags.preset ? String(flags.preset) : 'balanced',
        forceFullRebake: Boolean(flags.full || confirmSwitch),
        allowSignatureSwitch: confirmSwitch
      });
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      if (err?.code === 'EMBEDDING_SIGNATURE_MISMATCH') {
        console.error(JSON.stringify({ error: err.code, ...err.details }, null, 2));
        process.exitCode = 2;
        return;
      }
      throw err;
    }
    return;
  }

  if (command === 'query-snap') {
    if (!flags.query) throw new Error('query-snap requires --query <text>');
    const { snapManifest, providerConfig } = await resolveEmbeddingForCli(vaultPath, flags);
    if (!snapManifest) throw new Error('No baked snapshot found; run `pmv bake` first');
    if (computeModelSig(providerConfig) !== snapManifest.embedding?.model_sig) {
      throw new Error(
        `Embedding signature mismatch: snapshot="${snapManifest.embedding?.model_sig}", provider="${computeModelSig(providerConfig)}"`
      );
    }

    const client = createEmbeddingClient(providerConfig);
    const vec = await client.embedOne(String(flags.query));
    const reader = await openSnapshotReader(vaultPath);
    try {
      const res = await reader.query({
        text: String(flags.query),
        vector: vec,
        preset: flags.preset ? String(flags.preset) : undefined,
        topK: flags['top-k'] ? Number(flags['top-k']) : undefined,
        includeTrace: true
      });
      if (flags.xml) {
        console.log(formatRecalledMemoryXml(res));
      } else {
        console.log(JSON.stringify(res, null, 2));
      }
    } finally {
      reader.close();
    }
    return;
  }

  if (command === 'studio') {
    const port = flags.port !== undefined ? Number(flags.port) : 3456;
    const { server, url } = await startStudioServer({ vaultPath, kitRoot: KIT_ROOT, port });
    console.log(`RiverMemo Studio listening at ${url}`);
    console.log(`Vault: ${vaultPath}`);
    console.log('Press Ctrl+C to stop.');
    await new Promise((resolve) => {
      const shutdown = () => server.close(resolve);
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return;
  }

  if (command === 'dream') {
    const res = await runDream(vaultPath, {
      kitRoot: KIT_ROOT,
      dryRun: Boolean(flags['dry-run']),
      minSalience: flags['min-salience'] ? Number(flags['min-salience']) : 0.45,
      providerId: flags['provider-id'] ? String(flags['provider-id']) : null
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'dream-commit') {
    const res = await commitDreamSession(vaultPath, {
      kitRoot: KIT_ROOT,
      summary: flags.summary !== undefined ? String(flags.summary) : null,
      model: flags.model !== undefined ? String(flags.model) : null,
      bake: Boolean(flags.bake),
      providerId: flags['provider-id'] ? String(flags['provider-id']) : null
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'queue') {
    const res = await listDreamQueue(vaultPath, {
      status: flags.status ? String(flags.status) : 'pending_review'
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'session-start') {
    const stdinBody = await readOptionalStdinJson();
    const res = await beginSession(vaultPath, {
      ...stdinBody,
      sessionId: flags.session !== undefined ? String(flags.session) : stdinBody.sessionId,
      model: flags.model !== undefined ? String(flags.model) : stdinBody.model,
      forceReset: Boolean(flags.reset),
      kitRoot: KIT_ROOT
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'assemble') {
    const stdinBody = await readOptionalStdinJson();
    try {
      const res = await assembleTurn(vaultPath, {
        ...stdinBody,
        userText: flags.text !== undefined ? String(flags.text) : stdinBody.userText,
        sessionId: flags.session !== undefined ? String(flags.session) : stdinBody.sessionId,
        model: flags.model !== undefined ? String(flags.model) : stdinBody.model,
        preset: flags.preset !== undefined ? String(flags.preset) : stdinBody.preset,
        topK: flags['top-k'] !== undefined ? Number(flags['top-k']) : stdinBody.topK,
        kitRoot: KIT_ROOT
      });
      console.log(JSON.stringify(res, null, 2));
    } finally {
      closeAllCachedReaders();
    }
    return;
  }

  if (command === 'commit') {
    const stdinBody = await readOptionalStdinJson();
    const res = await commitTurn(vaultPath, {
      ...stdinBody,
      sessionId: flags.session !== undefined ? String(flags.session) : stdinBody.sessionId,
      model: flags.model !== undefined ? String(flags.model) : stdinBody.model,
      harness: flags.harness !== undefined ? String(flags.harness) : stdinBody.harness,
      kitRoot: KIT_ROOT
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'approve' || command === 'reject') {
    if (!flags.op) throw new Error(`${command} requires --op <opId>`);
    const res = await reviewDreamOp(vaultPath, String(flags.op), {
      decision: command,
      note: flags.note ? String(flags.note) : ''
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(`[pmv error] ${err?.message || err}`);
  process.exit(1);
});
