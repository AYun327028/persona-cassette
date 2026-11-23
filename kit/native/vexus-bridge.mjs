/**
 * @fileoverview Native rust-vexus-lite loader, calibrated RiverMemo Topology V3.1
 * defaults/presets, and JSON contract builders matching Rust serde schemas.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let cachedBinding = null;

function getVexusCandidates() {
  return [
    process.env.PMV_VEXUS_LITE_PATH,
    path.join(KIT_ROOT, 'native', 'vexus-lite', 'index.js')
  ].filter(Boolean);
}

/**
 * Check whether the optional native `rust-vexus-lite` module is installed.
 *
 * @returns {boolean}
 */
export function hasVexusLite() {
  if (cachedBinding) return true;
  return getVexusCandidates().some((c) => fs.existsSync(path.resolve(c)));
}

/**
 * Resolve and load `rust-vexus-lite` native N-API exports.
 *
 * @returns {{ NativeKnowledgeRuntime: any, VexusIndex: any, VexusWatcher: any, resolvedPath: string }}
 */
export function loadVexusLite() {
  if (cachedBinding) return cachedBinding;

  const candidates = getVexusCandidates();

  for (const candidate of candidates) {
    const absPath = path.resolve(candidate);
    if (!fs.existsSync(absPath)) continue;
    const mod = require(absPath);
    if (!mod?.NativeKnowledgeRuntime || !mod?.VexusIndex) {
      throw new Error(`Invalid vexus-lite module at ${absPath}`);
    }
    cachedBinding = {
      NativeKnowledgeRuntime: mod.NativeKnowledgeRuntime,
      VexusIndex: mod.VexusIndex,
      VexusWatcher: mod.VexusWatcher,
      resolvedPath: absPath
    };
    return cachedBinding;
  }

  throw new Error(
    `Unable to locate optional rust-vexus-lite native module. Set PMV_VEXUS_LITE_PATH or place it under kit/native/vexus-lite/index.js. Checked: ${candidates.join(', ')}`
  );
}

/**
 * Calibrated RiverMemo Topology V3.1 production parameters (aligned with
 * VCPToolBox modules/knowledgeBase/memoConfig.js).
 */
export const RIVER_DEFAULTS = Object.freeze({
  sourceObservation: { baseTagBoost: 0.6, coreBoostFactor: 1.33 },
  localField: { alpha: 0.15, maxIterations: 80, tolerance: 1e-9 },
  transferField: { alpha: 0.55, maxIterations: 80, tolerance: 1e-9 },
  effectiveSupport: { localMassRatio: 0.8, transferMassRatio: 0.9 },
  candidateSuperset: {
    queryK: 100,
    denoisedK: 100,
    localFieldK: 100,
    transferFieldK: 100,
    bm25K: 50,
    anchorK: 50,
    maxUnionCandidates: 300
  },
  pathGeometry: {
    localWeight: 0.6,
    transferWeight: 0.4,
    directionFloor: 0.05,
    closureFloor: 0
  },
  relativeTopology: {
    semanticNodeThreshold: 0.48,
    relativeDistanceTemperature: 0.35,
    reverseDirectionCredit: 0.25,
    nodeOnlyReliabilityCap: 0.2,
    minimumRiverEdgeFlow: 0.015,
    maximumRiverEdges: 96
  },
  riverObservability: {
    kappaEdge: 0.5,
    kappaRatio: 0.3,
    epsilon: 0.02,
    collapsedThreshold: 0.12,
    sparseThreshold: 0.45
  },
  directAnchor: {
    semanticThreshold: 0.8,
    semanticDiscount: 0.7,
    specificityFloor: 0.35,
    rarityFloor: 0.15,
    reliabilitySeedSaturation: 2,
    fallbackReliabilityCap: 0.5
  },
  topology: {
    topologyBonusCap: 0.08,
    topologyPathSaturation: 0.15,
    innovationScale: 0.5,
    conditionalBandwidth: 0.04,
    conditionalClosureBandwidth: 0.1,
    conditionalDirectBandwidth: 0.12,
    minimumPeers: 3,
    minimumEffectivePeers: 2.5,
    innovationConfidenceZ: 1,
    omegaGamma: 1,
    structRoleMinOmega: 0.12,
    anchorBonusCap: 0.1,
    anchorActivationZ: 2,
    anchorActivationFloor: 0.05,
    anchorSaturation: 0.2,
    anchorFrontierContrast: 2,
    anchorFrontierAbsFloor: 0.1
  },
  query: {
    topK: 5,
    perIndexK: 100,
    candidateK: 200,
    semanticThreshold: 0.92
  },
  filters: {
    include_diaries: null,
    exclude_domains: [],
    min_importance: null
  }
});

/**
 * Business-oriented recall presets built atop calibrated RIVER_DEFAULTS.
 */
export const RIVER_PRESETS = Object.freeze({
  balanced: {
    label: '日常均衡 (Balanced)',
    description: '校准默认构型：兼顾直接事实锚点与关系河网拓扑联想。',
    overrides: {}
  },
  precision_research: {
    label: '精准考据 (Precision Research)',
    description: '偏重局部场与直接事实锚点，适合版本校勘、架构结论与精确溯源查询。',
    overrides: {
      query: { topK: 6 },
      pathGeometry: { localWeight: 0.72, transferWeight: 0.28 },
      directAnchor: { semanticThreshold: 0.78 },
      topology: { anchorBonusCap: 0.14, topologyBonusCap: 0.06 }
    }
  },
  associative_explore: {
    label: '跨界联想 (Associative Explore)',
    description: '放大迁移场权重与拓扑创新通道上限，适合跨主题发散联想与母题桥接。',
    overrides: {
      query: { topK: 8 },
      pathGeometry: { localWeight: 0.45, transferWeight: 0.55 },
      topology: { topologyBonusCap: 0.11, anchorBonusCap: 0.08 }
    }
  }
});

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function deepMerge(base, patch) {
  const out = structuredClone(base);
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

/**
 * Resolve complete RiverMemo rules configuration from a named preset plus
 * optional user overrides.
 *
 * @param {string} [presetName='balanced']
 * @param {Record<string, any>} [overrides={}]
 */
export function resolveRiverRules(presetName = 'balanced', overrides = {}) {
  const preset = RIVER_PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `Unknown RiverMemo preset "${presetName}". Available: ${Object.keys(RIVER_PRESETS).join(', ')}`
    );
  }
  const withPreset = deepMerge(RIVER_DEFAULTS, preset.overrides || {});
  return deepMerge(withPreset, overrides || {});
}

/**
 * Build JSON string matching Rust `memo_pipeline.rs::PipelineInput`.
 *
 * @param {{ queryId?: string | null, queryText: string, coreTags?: string[], rules: Record<string, any> }} params
 */
export function buildPipelineInputJson({ queryId = null, queryText, coreTags = [], rules }) {
  const srcObs = rules.sourceObservation || RIVER_DEFAULTS.sourceObservation;
  const localField = rules.localField || RIVER_DEFAULTS.localField;
  const transferField = rules.transferField || RIVER_DEFAULTS.transferField;
  const effSupport = rules.effectiveSupport || RIVER_DEFAULTS.effectiveSupport;

  return JSON.stringify({
    queryId: queryId || null,
    queryText: String(queryText || ''),
    coreTags: (Array.isArray(coreTags) ? coreTags : [])
      .map((t) => String(t || '').trim().toLowerCase())
      .filter(Boolean),
    ghostTags: [],
    config: {
      baseTagBoost: Number(srcObs.baseTagBoost ?? 0.6),
      coreBoostFactor: Number(srcObs.coreBoostFactor ?? 1.33),
      localAlpha: Number(localField.alpha ?? 0.15),
      transferAlpha: Number(transferField.alpha ?? 0.55),
      fieldMaxIterations: Math.max(
        1,
        Math.floor(Math.max(Number(localField.maxIterations) || 80, Number(transferField.maxIterations) || 80))
      ),
      localTolerance: Number(localField.tolerance ?? 1e-9),
      transferTolerance: Number(transferField.tolerance ?? 1e-9),
      localMassRatio: Number(effSupport.localMassRatio ?? 0.8),
      transferMassRatio: Number(effSupport.transferMassRatio ?? 0.9),
      maxLevels: 3,
      pyramidTopK: 10,
      minEnergyRatio: 0.1,
      layerDecay: 0.7,
      epaGateMode: 'backgroundRelative',
      activationMultiplier: [0.5, 1.5],
      dynamicBoostRange: [0.3, 2.0],
      coreBoostRange: [1.2, 1.4],
      langConfidenceEnabled: true,
      langPenaltyUnknown: 0.05,
      langPenaltyCrossDomain: 0.1,
      deduplicationThreshold: 0.88,
      maxFusionTags: 128,
      maxEmergentNodes: 50,
      techTagThreshold: 0.08,
      normalTagThreshold: 0.015
    }
  });
}

/**
 * Build JSON string matching Rust `rivermemo_topology_v3.rs::NativeInput`.
 * Note: omits `allowedFileIds` when unrestricted (`null`) because Rust treats
 * an explicit empty array `[]` as zero permitted files.
 *
 * @param {{
 *   observationHandle: string,
 *   dimension: number,
 *   topK?: number,
 *   queryId?: string | null,
 *   queryText?: string,
 *   rules: Record<string, any>,
 *   allowedFileIds?: number[] | null,
 *   includeTrace?: boolean
 * }} params
 */
export function buildRiverTopologyInputJson({
  observationHandle,
  dimension,
  topK,
  queryId = null,
  queryText = '',
  rules,
  allowedFileIds = null,
  includeTrace = true
}) {
  const cand = rules.candidateSuperset || RIVER_DEFAULTS.candidateSuperset;
  const pathGeom = rules.pathGeometry || RIVER_DEFAULTS.pathGeometry;
  const rel = rules.relativeTopology || RIVER_DEFAULTS.relativeTopology;
  const omega = rules.riverObservability || RIVER_DEFAULTS.riverObservability;
  const anchor = rules.directAnchor || RIVER_DEFAULTS.directAnchor;
  const topo = rules.topology || RIVER_DEFAULTS.topology;

  const payload = {
    observationHandle,
    dimension: Number(dimension),
    topK: Math.max(1, Math.floor(Number(topK ?? rules.query?.topK ?? 5))),
    includeTrace: includeTrace === true,
    query: {
      text: String(queryText || ''),
      vector: []
    },
    candidates: [],
    queryState: {
      queryId: queryId || null,
      completeObservation: true
    },
    ...(Array.isArray(allowedFileIds) ? { allowedFileIds } : {}),
    config: {
      queryK: cand.queryK,
      denoisedK: cand.denoisedK ?? cand.queryK,
      localFieldK: cand.localFieldK,
      transferFieldK: cand.transferFieldK,
      bm25K: cand.bm25K,
      anchorK: cand.anchorK,
      maxUnionCandidates: cand.maxUnionCandidates,
      localWeight: pathGeom.localWeight,
      transferWeight: pathGeom.transferWeight,
      directionFloor: pathGeom.directionFloor,
      closureFloor: pathGeom.closureFloor,
      semanticNodeThreshold: rel.semanticNodeThreshold,
      relativeDistanceTemperature: rel.relativeDistanceTemperature,
      reverseDirectionCredit: rel.reverseDirectionCredit,
      minimumRiverEdgeFlow: rel.minimumRiverEdgeFlow,
      maximumRiverEdges: rel.maximumRiverEdges,
      nodeOnlyReliabilityCap: rel.nodeOnlyReliabilityCap,
      kappaEdge: omega.kappaEdge,
      kappaRatio: omega.kappaRatio,
      omegaEpsilon: omega.epsilon,
      collapsedThreshold: omega.collapsedThreshold,
      sparseThreshold: omega.sparseThreshold,
      semanticAnchorThreshold: anchor.semanticThreshold,
      semanticAnchorDiscount: anchor.semanticDiscount,
      specificityFloor: anchor.specificityFloor,
      rarityFloor: anchor.rarityFloor,
      reliabilitySeedSaturation: anchor.reliabilitySeedSaturation,
      fallbackReliabilityCap: anchor.fallbackReliabilityCap,
      topologyBonusCap: topo.topologyBonusCap,
      topologyPathSaturation: topo.topologyPathSaturation,
      conditionalBandwidth: topo.conditionalBandwidth,
      conditionalClosureBandwidth: topo.conditionalClosureBandwidth,
      conditionalDirectBandwidth: topo.conditionalDirectBandwidth,
      minimumPeers: topo.minimumPeers,
      minimumEffectivePeers: topo.minimumEffectivePeers,
      innovationConfidenceZ: topo.innovationConfidenceZ,
      innovationScale: topo.innovationScale,
      omegaGamma: topo.omegaGamma,
      structRoleMinOmega: topo.structRoleMinOmega,
      anchorBonusCap: topo.anchorBonusCap,
      anchorActivationZ: topo.anchorActivationZ,
      anchorActivationFloor: topo.anchorActivationFloor,
      anchorSaturation: topo.anchorSaturation,
      anchorFrontierContrast: topo.anchorFrontierContrast,
      anchorFrontierAbsFloor: topo.anchorFrontierAbsFloor
    }
  };

  return JSON.stringify(payload);
}

/**
 * Compute lowercase hex MD5 digest (used for deterministic diary .vec filenames).
 *
 * @param {string} text
 * @returns {string}
 */
export function md5Hex(text) {
  return crypto.createHash('md5').update(String(text || '')).digest('hex');
}
