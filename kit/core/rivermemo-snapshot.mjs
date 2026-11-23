/**
 * @fileoverview Atomic RiverMemo snapshot baker (`bakeSnapshot`) and thin
 * read-only snapshot reader (`openSnapshotReader`) powered by rust-vexus-lite.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildPipelineInputJson,
  buildRiverTopologyInputJson,
  loadVexusLite,
  md5Hex,
  resolveRiverRules
} from '../native/vexus-bridge.mjs';
import { computeModelSig, signEmbeddingModel } from './embedding-provider.mjs';
import { sha256 } from './ledger.mjs';
import { loadManifest } from './manifest.mjs';
import { projectVaultToRiverDocs } from './okf-projector.mjs';

export const SNAPSHOT_SCHEMA = 'pmv-rivermemo-snap/v1';
export const RIVER_RULES_SCHEMA = 'pmv-river-rules/v1';
const INDEX_CAPACITY = 50000;

function parseNativeJson(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function getSnapshotDir(vaultPath) {
  return path.join(vaultPath, 'snapshot', 'rivermemo.snap');
}

/**
 * Read `snapshot/rivermemo.snap/snapshot.manifest.json` if present.
 *
 * @param {string} vaultPath
 * @returns {Promise<Record<string, any> | null>}
 */
export async function readSnapshotManifest(vaultPath) {
  const manifestPath = path.join(getSnapshotDir(vaultPath), 'snapshot.manifest.json');
  try {
    return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Read saved `snapshot/rivermemo.snap/river_rules.json` if present.
 *
 * @param {string} vaultPath
 */
export async function readSnapshotRules(vaultPath) {
  const rulesPath = path.join(getSnapshotDir(vaultPath), 'river_rules.json');
  try {
    return JSON.parse(await fs.readFile(rulesPath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function copyExistingSnapshotToWork(snapDir, workDir) {
  const entries = await fs.readdir(snapDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === 'knowledge_base.sqlite' || entry.name.endsWith('.vec')) {
      await fs.copyFile(path.join(snapDir, entry.name), path.join(workDir, entry.name));
    }
  }
}

async function vacuumReadCountsAndClean(workDir, dbPath) {
  let counts;
  const db = new DatabaseSync(dbPath);
  try {
    const files = db.prepare('SELECT COUNT(*) AS c FROM files').get()?.c ?? 0;
    const chunks = db.prepare('SELECT COUNT(*) AS c FROM chunks').get()?.c ?? 0;
    const tags = db.prepare('SELECT COUNT(*) AS c FROM tags').get()?.c ?? 0;
    counts = {
      files: Number(files),
      chunks: Number(chunks),
      tags: Number(tags)
    };
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('PRAGMA journal_mode = DELETE;');
    db.exec('VACUUM;');
  } finally {
    db.close();
  }

  const entries = await fs.readdir(workDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isJunk = /(\.retired|\.checkpoint-source|\.restore-source|-wal$|-shm$)/i.test(entry.name);
    if (isJunk) {
      await fs.rm(path.join(workDir, entry.name), { force: true });
    }
  }
  return counts;
}

async function atomicSwapDirectory(workDir, snapDir) {
  const backupDir = `${snapDir}.bak-${Date.now()}`;
  let movedOld = false;
  try {
    await fs.access(snapDir);
    await fs.rename(snapDir, backupDir);
    movedOld = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  try {
    await fs.rename(workDir, snapDir);
  } catch (err) {
    if (movedOld) {
      await fs.rename(backupDir, snapDir).catch(() => {});
    }
    throw err;
  }

  if (movedOld) {
    await fs.rm(backupDir, { recursive: true, force: true });
  }
}

function createSignatureMismatchError(expectedSignature, incomingSignature) {
  const err = new Error(
    `Embedding signature mismatch: existing="${expectedSignature}", incoming="${incomingSignature}". Full re-bake confirmation required.`
  );
  err.code = 'EMBEDDING_SIGNATURE_MISMATCH';
  err.details = {
    expectedSignature,
    incomingSignature,
    requiresFullRebakeConfirmation: true
  };
  return err;
}

/**
 * Bake a clean, read-only RiverMemo Topology V3.1 snapshot at
 * `snapshot/rivermemo.snap/`. Enforces strict operation-signature guardrails
 * so incompatible embedding spaces can never mix silently.
 *
 * @param {string} vaultPath
 * @param {{
 *   embeddingClient: ReturnType<import('./embedding-provider.mjs').createEmbeddingClient>,
 *   providerConfig: Record<string, any>,
 *   preset?: string,
 *   rulesOverride?: Record<string, any>,
 *   forceFullRebake?: boolean,
 *   allowSignatureSwitch?: boolean,
 *   signedBy?: string,
 *   signSource?: string
 * }} options
 */
export async function bakeSnapshot(vaultPath, options) {
  const {
    embeddingClient,
    providerConfig,
    preset = 'balanced',
    rulesOverride = {},
    forceFullRebake = false,
    allowSignatureSwitch = false,
    signedBy = 'user',
    signSource = 'user_signed'
  } = options;

  if (!embeddingClient || !providerConfig) {
    throw new Error('bakeSnapshot requires embeddingClient and providerConfig');
  }

  const incomingSig = computeModelSig(providerConfig);
  const dimension = Number(providerConfig.dimension);
  if (!incomingSig || !Number.isInteger(dimension) || dimension <= 0) {
    throw new Error('Invalid embedding providerConfig for bakeSnapshot');
  }

  const manifest = await loadManifest(vaultPath);
  const existingSnap = await readSnapshotManifest(vaultPath);
  const manifestEmb = manifest.preferred_models?.embedding;

  if (existingSnap?.embedding?.model_sig && existingSnap.embedding.model_sig !== incomingSig) {
    if (!(forceFullRebake === true && allowSignatureSwitch === true)) {
      throw createSignatureMismatchError(existingSnap.embedding.model_sig, incomingSig);
    }
  } else if (
    !existingSnap &&
    manifestEmb?.status === 'signed' &&
    manifestEmb?.model_sig &&
    manifestEmb.model_sig !== incomingSig
  ) {
    if (!(forceFullRebake === true && allowSignatureSwitch === true)) {
      throw createSignatureMismatchError(manifestEmb.model_sig, incomingSig);
    }
  }

  const effectiveRules = resolveRiverRules(preset, rulesOverride);
  const { docs, diaryNames } = await projectVaultToRiverDocs(vaultPath, effectiveRules);
  if (docs.length === 0) {
    const err = new Error('No active wiki pages found to bake into snapshot');
    err.code = 'NO_ACTIVE_WIKI_PAGES';
    throw err;
  }

  const snapDir = getSnapshotDir(vaultPath);
  const snapParent = path.dirname(snapDir);
  await fs.mkdir(snapParent, { recursive: true });
  const workDir = path.join(snapParent, `.bake-work-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(workDir, { recursive: true });

  const mode =
    !forceFullRebake && existingSnap && existingSnap.embedding?.model_sig === incomingSig
      ? 'incremental'
      : 'full';

  let filesIngested = 0;
  let filesDeleted = 0;
  let artifactResult;

  try {
    if (mode === 'incremental') {
      await copyExistingSnapshotToWork(snapDir, workDir);
    }

    const workDbPath = path.join(workDir, 'knowledge_base.sqlite');
    const { NativeKnowledgeRuntime, VexusIndex } = loadVexusLite();
    const tagIndex = new VexusIndex(dimension, INDEX_CAPACITY);
    const runtime = new NativeKnowledgeRuntime(tagIndex);
    const diaryIndices = new Map();

    try {
      runtime.openAndInitStore(
        workDbPath,
        JSON.stringify({
          readPoolSize: 2,
          mmapSize: 32 * 1024 * 1024,
          busyTimeoutMs: 5000,
          schemaVersion: 2
        })
      );

      await runtime.restoreGlobalTagIndex(
        workDbPath,
        path.join(workDir, 'index_global_tags_a.vec'),
        incomingSig,
        INDEX_CAPACITY
      );

      const ensureDiaryReady = async (diaryName) => {
        if (diaryIndices.has(diaryName)) return diaryIndices.get(diaryName);
        const idx = new VexusIndex(dimension, INDEX_CAPACITY);
        runtime.registerDiaryIndex(diaryName, idx);
        await runtime.restoreDiaryIndex(
          workDbPath,
          diaryName,
          path.join(workDir, `index_diary_${md5Hex(diaryName)}_a.vec`),
          incomingSig,
          INDEX_CAPACITY,
          idx
        );
        diaryIndices.set(diaryName, idx);
        return idx;
      };

      for (const diaryName of diaryNames) {
        await ensureDiaryReady(diaryName);
      }

      let docsToIngest = docs;
      let versionByPath = new Map();

      if (mode === 'incremental') {
        const indexedRaw = await runtime.listIndexedFilePaths(workDbPath);
        const indexedPaths = parseNativeJson(indexedRaw) || [];
        const currentPathSet = new Set(docs.map((d) => d.relPath));
        const removedPaths = indexedPaths.filter((p) => !currentPathSet.has(p));

        if (removedPaths.length > 0) {
          await runtime.commitDeleteBatch(workDbPath, removedPaths, 0, vaultPath);
          filesDeleted = removedPaths.length;
        }

        const probeRows = parseNativeJson(
          await runtime.probeIngestionFiles(workDbPath, docs.map((d) => d.relPath))
        ) || [];
        const probeByPath = new Map(probeRows.map((r) => [r.path, r]));

        docsToIngest = docs.filter((doc) => {
          const row = probeByPath.get(doc.relPath);
          if (!row || !row.exists || !row.completeVectors || !row.completeTags) return true;
          return row.checksum !== doc.checksum;
        });

        for (const row of probeRows) {
          if (row?.path) versionByPath.set(row.path, Number(row.version) || 0);
        }
      }

      if (docsToIngest.length > 0) {
        const preparedDocs = [];
        const chunkTextsToEmbed = [];
        const uniqueTags = new Set();

        for (const doc of docsToIngest) {
          const prepRaw = await runtime.prepareText(
            JSON.stringify({
              text: doc.projectedText,
              tagBlacklistSuper: [],
              tagBlacklist: [],
              maxTags: 32,
              maxTokens: 2048,
              overlapTokens: 128
            })
          );
          const prep = parseNativeJson(prepRaw);
          const chunks = Array.isArray(prep?.chunks) && prep.chunks.length > 0
            ? prep.chunks.map(String).filter(Boolean)
            : [doc.projectedText];
          const tags = doc.orderedTags.length > 0
            ? doc.orderedTags
            : (Array.isArray(prep?.tags) ? prep.tags.map(String).filter(Boolean) : []);

          for (const tag of tags) uniqueTags.add(tag);
          const chunkOffset = chunkTextsToEmbed.length;
          for (const ch of chunks) chunkTextsToEmbed.push(ch);

          preparedDocs.push({ doc, chunks, tags, chunkOffset });
        }

        const chunkVecs = await embeddingClient.embedBatch(chunkTextsToEmbed);

        const tagProbeRows = uniqueTags.size > 0
          ? parseNativeJson(await runtime.probeIngestionTags(workDbPath, [...uniqueTags])) || []
          : [];
        const tagHasVec = new Map(tagProbeRows.map((r) => [r.name, r.hasVector === true]));
        const missingTagNames = [...uniqueTags].filter((t) => !tagHasVec.get(t));
        const missingTagVecs = missingTagNames.length > 0
          ? await embeddingClient.embedBatch(missingTagNames)
          : [];
        const tagSlotByName = new Map(missingTagNames.map((name, i) => [name, i]));

        const flatChunkVectors = new Float32Array(chunkVecs.length * dimension);
        chunkVecs.forEach((vec, i) => flatChunkVectors.set(vec, i * dimension));

        const flatTagVectors = new Float32Array(missingTagVecs.length * dimension);
        missingTagVecs.forEach((vec, i) => flatTagVectors.set(vec, i * dimension));

        const planFiles = [];
        const planChunks = [];
        const planTags = [];

        for (const item of preparedDocs) {
          const chunkStart = planChunks.length;
          item.chunks.forEach((text, cIdx) => {
            planChunks.push({
              content: text,
              chunkIndex: cIdx,
              vectorSlot: item.chunkOffset + cIdx
            });
          });

          const tagStart = planTags.length;
          item.tags.forEach((name, tIdx) => {
            planTags.push({
              name,
              position: tIdx + 1,
              vectorSlot: tagSlotByName.has(name) ? tagSlotByName.get(name) : null
            });
          });

          planFiles.push({
            path: item.doc.relPath,
            diaryName: item.doc.diaryName,
            checksum: item.doc.checksum,
            mtime: item.doc.mtime,
            expectedVersion: versionByPath.get(item.doc.relPath) || 0,
            size: item.doc.size,
            chunkStart,
            chunkCount: item.chunks.length,
            tagsOnly: false,
            tagStart,
            tagCount: item.tags.length,
            migrationCacheId: null,
            migrationSourceFileId: null
          });
        }

        const commitPlan = {
          operationId: `bake-${Date.now()}`,
          batchId: `batch-${crypto.randomBytes(4).toString('hex')}`,
          dimension,
          modelSig: incomingSig,
          files: planFiles,
          chunks: planChunks,
          tags: planTags
        };

        const receipt = parseNativeJson(
          await runtime.commitIngestionBatch(
            workDbPath,
            JSON.stringify(commitPlan),
            flatChunkVectors,
            flatTagVectors
          )
        );
        if (!receipt?.factsCommitted) {
          throw new Error('Rust commitIngestionBatch failed to commit snapshot facts');
        }
        filesIngested = docsToIngest.length;

        if (receipt.indexReady !== true) {
          await runtime.restoreGlobalTagIndex(
            workDbPath,
            path.join(workDir, 'index_global_tags_a.vec'),
            incomingSig,
            INDEX_CAPACITY
          );
          for (const diaryName of diaryNames) {
            const dIdx = diaryIndices.get(diaryName);
            await runtime.restoreDiaryIndex(
              workDbPath,
              diaryName,
              path.join(workDir, `index_diary_${md5Hex(diaryName)}_a.vec`),
              incomingSig,
              INDEX_CAPACITY,
              dIdx
            );
          }
        }
      }

      const geom = await tagIndex.computeMemoGeometry(workDbPath, incomingSig, JSON.stringify({}));
      if (!geom?.success) {
        throw new Error('Native computeMemoGeometry failed during snapshot bake');
      }

      artifactResult = await tagIndex.rebuildMemoArtifact(
        workDbPath,
        JSON.stringify({ modelSig: incomingSig, effectiveConfig: effectiveRules })
      );
      if (!artifactResult?.success || !artifactResult?.persisted) {
        throw new Error('Native rebuildMemoArtifact failed to persist RiverMemo artifact');
      }

      await runtime.checkpointGlobalTagIndex(
        workDbPath,
        path.join(workDir, 'index_global_tags_a.vec'),
        incomingSig,
        0,
        true
      );
      for (const diaryName of diaryNames) {
        await runtime.checkpointDiaryIndex(
          workDbPath,
          diaryName,
          path.join(workDir, `index_diary_${md5Hex(diaryName)}_a.vec`),
          incomingSig,
          0,
          true
        );
      }

      await runtime.pruneNativeMemoArtifacts(workDbPath, 1, 0);
    } finally {
      runtime.shutdown();
    }

    const dbCounts = await vacuumReadCountsAndClean(workDir, workDbPath);

    const rulesPayload = {
      schema: RIVER_RULES_SCHEMA,
      preset,
      rules: effectiveRules
    };
    await fs.writeFile(
      path.join(workDir, 'river_rules.json'),
      `${JSON.stringify(rulesPayload, null, 2)}\n`,
      'utf8'
    );

    const byPath = {};
    const byId = {};
    for (const doc of docs) {
      byPath[doc.relPath] = doc.okfMeta;
      byId[doc.okfMeta.id] = doc.okfMeta;
    }
    await fs.writeFile(
      path.join(workDir, 'okf_metadata.json'),
      `${JSON.stringify({ byPath, byId }, null, 2)}\n`,
      'utf8'
    );

    const riverConfigHash = sha256(JSON.stringify(effectiveRules));
    const snapshotVersion = `snap-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
    const snapshotManifest = {
      schema: SNAPSHOT_SCHEMA,
      character_id: manifest.character.id,
      snapshot_version: snapshotVersion,
      baked_at: new Date().toISOString(),
      mode,
      embedding: {
        provider: String(providerConfig.provider),
        model_id: String(providerConfig.model_id),
        dimension,
        normalize: providerConfig.normalize !== false,
        model_sig: incomingSig,
        signed_by: signedBy,
        sign_source: signSource
      },
      preset,
      river_config_hash: riverConfigHash,
      artifact_sig: artifactResult.artifactSig,
      diary_names: diaryNames,
      counts: {
        files: dbCounts.files,
        chunks: dbCounts.chunks,
        tags: dbCounts.tags,
        nodes: Number(artifactResult.nodeCount) || 0,
        edges: Number(artifactResult.edgeCount) || 0
      }
    };

    await fs.writeFile(
      path.join(workDir, 'snapshot.manifest.json'),
      `${JSON.stringify(snapshotManifest, null, 2)}\n`,
      'utf8'
    );

    await atomicSwapDirectory(workDir, snapDir);

    if (manifestEmb?.status !== 'signed' || (allowSignatureSwitch && manifestEmb?.model_sig !== incomingSig)) {
      await signEmbeddingModel(vaultPath, providerConfig, { signedBy, signSource });
    }

    const logPath = path.join(vaultPath, 'wiki', 'log.md');
    await fs.appendFile(
      logPath,
      `- ${snapshotManifest.baked_at} | 烘焙 RiverMemo 快照 \`${snapshotVersion}\` (${mode}) | sig=\`${incomingSig}\` | preset=\`${preset}\` | files=${dbCounts.files}, nodes=${snapshotManifest.counts.nodes}, edges=${snapshotManifest.counts.edges}\n`,
      'utf8'
    );

    return {
      snapshotManifest,
      mode,
      filesIngested,
      filesDeleted
    };
  } catch (err) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Open a thin read-only RiverMemo Topology V3.1 snapshot reader for L2 recall
 * or offline Studio regression comparison.
 *
 * @param {string} vaultPath
 */
export async function openSnapshotReader(vaultPath) {
  const snapDir = getSnapshotDir(vaultPath);
  const snapshotManifest = await readSnapshotManifest(vaultPath);
  if (!snapshotManifest) {
    throw new Error(`No baked RiverMemo snapshot found at ${snapDir}`);
  }

  const savedRulesDoc = (await readSnapshotRules(vaultPath)) || { preset: snapshotManifest.preset || 'balanced', rules: {} };
  const okfMetaDoc = JSON.parse(await fs.readFile(path.join(snapDir, 'okf_metadata.json'), 'utf8'));

  const dimension = Number(snapshotManifest.embedding.dimension);
  const modelSig = String(snapshotManifest.embedding.model_sig);
  const artifactSig = String(snapshotManifest.artifact_sig);
  const dbPath = path.join(snapDir, 'knowledge_base.sqlite');
  const diaryNames = Array.isArray(snapshotManifest.diary_names) ? snapshotManifest.diary_names : [];

  const { NativeKnowledgeRuntime, VexusIndex } = loadVexusLite();
  const tagIndex = new VexusIndex(dimension, INDEX_CAPACITY);
  const runtime = new NativeKnowledgeRuntime(tagIndex);
  const diaryIndices = new Map();

  runtime.openAndInitStore(
    dbPath,
    JSON.stringify({
      readPoolSize: 2,
      mmapSize: 32 * 1024 * 1024,
      busyTimeoutMs: 5000,
      schemaVersion: 2
    })
  );

  await runtime.restoreGlobalTagIndex(
    dbPath,
    path.join(snapDir, 'index_global_tags_a.vec'),
    modelSig,
    INDEX_CAPACITY
  );

  for (const diaryName of diaryNames) {
    const idx = new VexusIndex(dimension, INDEX_CAPACITY);
    runtime.registerDiaryIndex(diaryName, idx);
    await runtime.restoreDiaryIndex(
      dbPath,
      diaryName,
      path.join(snapDir, `index_diary_${md5Hex(diaryName)}_a.vec`),
      modelSig,
      INDEX_CAPACITY,
      idx
    );
    diaryIndices.set(diaryName, idx);
  }

  let closed = false;

  return {
    snapshotManifest,
    savedRules: savedRulesDoc,
    diaryNames,

    /**
     * Execute full native Topology V3.1 recall on the read-only snapshot.
     *
     * @param {{
     *   text: string,
     *   vector: Float32Array | number[],
     *   preset?: string,
     *   rulesOverride?: Record<string, any>,
     *   topK?: number,
     *   coreTags?: string[],
     *   includeTrace?: boolean,
     *   diaryNames?: string[]
     * }} params
     */
    async query(params) {
      if (closed) throw new Error('SnapshotReader is closed');

      const queryText = String(params.text || '');
      const queryVector = params.vector instanceof Float32Array
        ? params.vector
        : new Float32Array(params.vector || []);
      if (queryVector.length !== dimension) {
        throw new RangeError(`Query vector dimension mismatch: expected ${dimension}, got ${queryVector.length}`);
      }

      const activePreset = params.preset || savedRulesDoc.preset || 'balanced';
      const baseRules = params.preset
        ? resolveRiverRules(activePreset, params.rulesOverride || {})
        : resolveRiverRules(savedRulesDoc.preset || 'balanced', {
            ...(savedRulesDoc.rules || {}),
            ...(params.rulesOverride || {})
          });
      const topK = Math.max(1, Math.floor(Number(params.topK ?? baseRules.query?.topK ?? 5)));
      const targetDiaries = Array.isArray(params.diaryNames) && params.diaryNames.length > 0
        ? params.diaryNames.filter((d) => diaryIndices.has(d))
        : diaryNames;

      if (targetDiaries.length === 0) {
        return {
          preset: activePreset,
          snapshotManifest,
          items: [],
          trace: { observation: null, topology: null }
        };
      }

      const queryId = `q-${Date.now()}`;
      const pipelineJson = buildPipelineInputJson({
        queryId,
        queryText,
        coreTags: params.coreTags || [],
        rules: baseRules
      });

      const pipelineRes = await tagIndex.runMemoPipeline(
        dbPath,
        artifactSig,
        pipelineJson,
        queryVector,
        new Float32Array(0)
      );
      const pipelineMeta = parseNativeJson(pipelineRes?.metadataJson);
      const observationHandle = pipelineMeta?.observationHandle;
      if (!observationHandle) {
        throw new Error('Native runMemoPipeline did not return an observationHandle');
      }

      const riverInputJson = buildRiverTopologyInputJson({
        observationHandle,
        dimension,
        topK,
        queryId,
        queryText,
        rules: baseRules,
        includeTrace: params.includeTrace !== false
      });

      const perIndexK = Math.max(1, Math.floor(Number(baseRules.query?.perIndexK ?? 100)));
      const candidateK = Math.max(1, Math.floor(Number(baseRules.query?.candidateK ?? 200)));
      const semanticThreshold = Number(baseRules.query?.semanticThreshold ?? 0.92);

      const riverPayload = parseNativeJson(
        await runtime.executeRiverQuery(
          dbPath,
          artifactSig,
          riverInputJson,
          targetDiaries,
          queryVector,
          perIndexK,
          candidateK,
          semanticThreshold
        )
      );

      const rawResults = Array.isArray(riverPayload?.results) ? riverPayload.results : [];
      const items = rawResults.map((item) => {
        const hydrated = item.hydratedChunk || {};
        const relPath = hydrated.fullPath || hydrated.sourceFile || hydrated.path || '';
        const okf = okfMetaDoc.byPath?.[relPath] || {};
        return {
          rank: Number(item.rank) || 0,
          chunkId: Number(item.chunkId ?? item.id),
          id: okf.id || relPath || `chunk-${item.chunkId}`,
          title: okf.title || relPath,
          path: relPath,
          diaryName: okf.diaryName || hydrated.diaryName || '',
          score: Number(Number(item.score ?? 0).toFixed(4)),
          baseScore: Number(Number(item.baseScore ?? 0).toFixed(4)),
          topologyBonus: Number(Number(item.topologyBonus ?? 0).toFixed(4)),
          anchorBonus: Number(Number(item.anchorBonus ?? 0).toFixed(4)),
          omega: Number(Number(item.omega ?? 0).toFixed(4)),
          role: item.role || 'thematic_neighbor',
          riverRegime: item.riverRegime || riverPayload.omega?.regime || 'collapsed',
          matchedTags: Array.isArray(item.matchedTags) ? item.matchedTags : [],
          updated_at: okf.updated_at || null,
          anchors: okf.anchors || [],
          tag_chain: okf.tag_chain || [],
          sources: okf.sources || [],
          excerpt: cleanHydratedChunkText(hydrated.text || hydrated.content) || okf.excerpt || '',
          topologyV3: item.topologyV3 || null
        };
      });

      return {
        preset: activePreset,
        snapshotManifest,
        items,
        trace: {
          observation: {
            matchedTags: pipelineMeta.matchedTags || [],
            epa: pipelineMeta.epa || null,
            pyramid: pipelineMeta.pyramid || null,
            diagnostics: pipelineMeta.diagnostics || null
          },
          topology: {
            omega: riverPayload.omega || null,
            diagnostics: riverPayload.diagnostics || null
          }
        }
      };
    },

    close() {
      if (closed) return;
      closed = true;
      runtime.shutdown();
    }
  };
}

function cleanHydratedChunkText(rawText) {
  let text = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  // Strip trailing synthetic `Tag: ...` projection line (tags are already in XML attributes).
  text = text.replace(/\n{1,2}Tag:\s*[^\n]+$/i, '').trim();
  // Deduplicate identical consecutive H1 title line if projector prepended `# title` over `# title`.
  const m = text.match(/^(#\s+[^\n]+)\n+(#\s+[^\n]+)/);
  if (m && m[1].trim() === m[2].trim()) {
    text = text.slice(m[1].length).trimStart();
  }
  return text;
}

function escapeXmlAttr(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlText(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatLocalIsoTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const tzMin = -date.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const absTz = Math.abs(tzMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absTz / 60))}:${pad(absTz % 60)}`
  );
}

/**
 * Format Topology V3.1 recall items into SPEC v1.1 `<recalled_memory>` XML
 * for L2 per-user-turn injection.
 *
 * @param {Awaited<ReturnType<Awaited<ReturnType<typeof openSnapshotReader>>['query']>>} queryResult
 * @returns {string}
 */
export function formatRecalledMemoryXml(queryResult) {
  if (!queryResult?.items?.length) return '';
  const snapSig = queryResult.snapshotManifest?.embedding?.model_sig || 'unknown';
  const preset = queryResult.preset || 'balanced';
  const nowTs = formatLocalIsoTimestamp();

  const itemBlocks = queryResult.items.map((item) => {
    const anchors = (item.anchors || []).join(', ');
    const chain = (item.tag_chain || []).join(' -> ');
    const sources = (item.sources || []).join(', ');
    const updatedAt = item.updated_at || 'unknown';
    return (
      `  <item id="${escapeXmlAttr(item.id)}"\n` +
      `        path="${escapeXmlAttr(item.path)}"\n` +
      `        updated_at="${escapeXmlAttr(updatedAt)}"\n` +
      `        score="${escapeXmlAttr(item.score.toFixed(3))}"\n` +
      `        anchors="${escapeXmlAttr(anchors)}"\n` +
      `        tag_chain="${escapeXmlAttr(chain)}"\n` +
      `        sources="${escapeXmlAttr(sources)}">\n` +
      `    <excerpt>\n` +
      `${escapeXmlText(item.excerpt)}\n` +
      `    </excerpt>\n` +
      `  </item>`
    );
  });

  return (
    `<recalled_memory snapshot_sig="${escapeXmlAttr(snapSig)}" preset="${escapeXmlAttr(preset)}" now="${escapeXmlAttr(nowTs)}">\n` +
    `${itemBlocks.join('\n')}\n` +
    `</recalled_memory>`
  );
}
