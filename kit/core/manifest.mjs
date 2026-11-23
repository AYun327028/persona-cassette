/**
 * @fileoverview Character manifest schema helpers and honest model signature
 * evaluation (forbidding guessed model names and prompting user attestation).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const MANIFEST_SCHEMA = 'persona-memory-vault/v1';

const DEFAULT_UNKNOWN_VALUES = ['', 'auto', 'unknown', 'default'];

export const DEFAULT_CONTEXT_ASSEMBLY = Object.freeze({
  system_sections: ['soul', 'user_profile', 'l0_contract', 'index'],
  user_injection_order: ['chronicle_board_update', 'recalled_memory', 'signature_notice'],
  user_separator: '\n\n---\n\n',
  history_backfill_turns: 10,
  backfill_from_ledger: true,
  backfill_max_msg_chars: 2400,
  recall_dedup_window_turns: 10,
  fallback_to_spans: true,
  strip_injected_tags_from_history: true,
  dedup_current_session_timeline: true,
  delivery_mode: 'ephemeral',
  auto_dream_on_commit: false
});

/**
 * Build a clean Phase 1 character manifest with all 4 model signature slots
 * explicitly initialized as `unsigned`.
 *
 * @param {{ id: string, name: string, displayName?: string, aliases?: string[] }} options
 * @returns {Record<string, any>}
 */
export function createDefaultManifest({ id, name, displayName, aliases }) {
  const cleanId = String(id || '').trim();
  const cleanName = String(name || cleanId).trim();
  const cleanDisplay = String(displayName || cleanName).trim();
  const aliasList = Array.isArray(aliases) && aliases.length > 0
    ? [...new Set(aliases.map((a) => String(a).trim()).filter(Boolean))]
    : [...new Set([cleanName, cleanDisplay].filter(Boolean))];

  return {
    schema: MANIFEST_SCHEMA,
    character: {
      id: cleanId,
      name: cleanName,
      display_name: cleanDisplay,
      aliases: aliasList
    },
    preferred_models: {
      chat: {
        status: 'unsigned',
        provider: null,
        model_id: null,
        sign_source: 'unsigned',
        signed_by: null,
        signed_at: null,
        note: '对话主力模型签名；无法自动识别时由用户现场代签'
      },
      dream: {
        status: 'unsigned',
        provider: null,
        model_id: null,
        sign_source: 'unsigned',
        signed_by: null,
        signed_at: null,
        note: '后台做梦整理模型签名'
      },
      embedding: {
        status: 'unsigned',
        provider: null,
        model_id: null,
        dimension: null,
        normalize: true,
        model_sig: null,
        sign_source: 'unsigned',
        signed_by: null,
        signed_at: null,
        note: 'Phase 1 留空签名位，留待 Phase 2 首次烘焙快照时由用户现场选定并签写'
      },
      decision: {
        status: 'unsigned',
        optional: true,
        provider: null,
        adapter: null,
        model_id: null,
        sign_source: 'unsigned',
        signed_by: null,
        signed_at: null,
        note: '可选外部判断服务接口签名（如 gemini-decisions / typesafe-jev / openai-compat-json / custom-http）；未签时无损降级'
      }
    },
    signature_policy: {
      forbid_guessed_model_name: true,
      unknown_values: [...DEFAULT_UNKNOWN_VALUES],
      on_unverifiable_model: 'prompt_user_to_sign',
      on_embedding_mismatch: 'abort_and_request_full_rebake'
    },
    budgets: {
      index_max_lines: 150,
      timeline_section_max_items: 12,
      timeline_salience_floor: 0.55,
      recall_top_k: 5
    },
    context_assembly: {
      ...DEFAULT_CONTEXT_ASSEMBLY,
      system_sections: [...DEFAULT_CONTEXT_ASSEMBLY.system_sections],
      user_injection_order: [...DEFAULT_CONTEXT_ASSEMBLY.user_injection_order]
    }
  };
}

/**
 * Resolve effective context-assembly policy by merging defaults, cartridge
 * manifest declarations, and optional per-call overrides.
 *
 * @param {Record<string, any> | null | undefined} manifest
 * @param {Record<string, any>} [overrides]
 */
export function resolveContextAssemblyConfig(manifest, overrides = {}) {
  const fromManifest =
    manifest?.context_assembly && typeof manifest.context_assembly === 'object'
      ? manifest.context_assembly
      : {};
  const merged = {
    ...DEFAULT_CONTEXT_ASSEMBLY,
    ...fromManifest,
    ...(overrides && typeof overrides === 'object' ? overrides : {})
  };
  const backfillTurns = Number(merged.history_backfill_turns);
  const backfillMaxChars = Number(merged.backfill_max_msg_chars);
  const recallDedupWindow = Number(merged.recall_dedup_window_turns);
  return {
    system_sections: Array.isArray(merged.system_sections)
      ? merged.system_sections.map((s) => String(s).trim()).filter(Boolean)
      : [...DEFAULT_CONTEXT_ASSEMBLY.system_sections],
    user_injection_order: Array.isArray(merged.user_injection_order)
      ? merged.user_injection_order.map((s) => String(s).trim()).filter(Boolean)
      : [...DEFAULT_CONTEXT_ASSEMBLY.user_injection_order],
    user_separator:
      typeof merged.user_separator === 'string'
        ? merged.user_separator
        : DEFAULT_CONTEXT_ASSEMBLY.user_separator,
    history_backfill_turns:
      Number.isFinite(backfillTurns) && backfillTurns >= 0 ? Math.floor(backfillTurns) : 10,
    backfill_from_ledger: merged.backfill_from_ledger !== false,
    backfill_max_msg_chars:
      Number.isFinite(backfillMaxChars) && backfillMaxChars >= 200
        ? Math.floor(backfillMaxChars)
        : 2400,
    recall_dedup_window_turns:
      Number.isFinite(recallDedupWindow) && recallDedupWindow >= 0
        ? Math.floor(recallDedupWindow)
        : 10,
    fallback_to_spans: merged.fallback_to_spans !== false,
    strip_injected_tags_from_history: merged.strip_injected_tags_from_history !== false,
    dedup_current_session_timeline: merged.dedup_current_session_timeline !== false,
    delivery_mode: merged.delivery_mode === 'persistent' ? 'persistent' : 'ephemeral',
    auto_dream_on_commit: merged.auto_dream_on_commit === true
  };
}

/**
 * Read and validate `character.manifest.json` from a Persona Memory Vault.
 *
 * @param {string} vaultPath
 * @returns {Promise<Record<string, any>>}
 */
export async function loadManifest(vaultPath) {
  const filePath = path.join(vaultPath, 'character.manifest.json');
  const raw = await fs.readFile(filePath, 'utf8');
  const manifest = JSON.parse(raw);
  if (manifest?.schema !== MANIFEST_SCHEMA) {
    throw new Error(
      `Unsupported character.manifest.json schema "${manifest?.schema}" in ${filePath}`
    );
  }
  return manifest;
}

/**
 * Persist `character.manifest.json` formatted cleanly.
 *
 * @param {string} vaultPath
 * @param {Record<string, any>} manifest
 */
export async function saveManifest(vaultPath, manifest) {
  const filePath = path.join(vaultPath, 'character.manifest.json');
  await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Determine whether a host-reported model string is missing or placeholder (`auto`, etc.).
 *
 * @param {unknown} name
 * @param {Record<string, any>} [policy]
 * @returns {boolean}
 */
export function isUnknownModelName(name, policy = {}) {
  if (name === null || name === undefined) return true;
  const normalized = String(name).trim().toLowerCase();
  const unknowns = Array.isArray(policy.unknown_values)
    ? policy.unknown_values.map((v) => String(v).trim().toLowerCase())
    : DEFAULT_UNKNOWN_VALUES;
  return unknowns.includes(normalized);
}

/**
 * Evaluate runtime model identity against manifest policy without ever guessing.
 *
 * @param {Record<string, any>} manifest
 * @param {string | null | undefined} reportedModel
 * @returns {{
 *   verified: boolean,
 *   needsUserSign: boolean,
 *   reported: string,
 *   preferredChat: string | null,
 *   sign_source: 'runtime_verified' | 'unsigned',
 *   reason: string
 * }}
 */
export function evaluateRuntimeSignature(manifest, reportedModel) {
  const policy = manifest?.signature_policy || {};
  const preferredChat = manifest?.preferred_models?.chat?.model_id || null;
  const reported = reportedModel === null || reportedModel === undefined
    ? ''
    : String(reportedModel).trim();

  if (isUnknownModelName(reported, policy)) {
    return {
      verified: false,
      needsUserSign: true,
      reported: reported || 'empty',
      preferredChat,
      sign_source: 'unsigned',
      reason: 'unverifiable_host_model'
    };
  }

  if (preferredChat && reported !== preferredChat) {
    return {
      verified: true,
      needsUserSign: true,
      reported,
      preferredChat,
      sign_source: 'runtime_verified',
      reason: 'differs_from_preferred_chat'
    };
  }

  return {
    verified: true,
    needsUserSign: false,
    reported,
    preferredChat,
    sign_source: 'runtime_verified',
    reason: 'verified'
  };
}

/**
 * Render the L2 `<signature_notice>` XML block when user attestation is needed.
 *
 * @param {ReturnType<typeof evaluateRuntimeSignature>} sigEval
 * @returns {string}
 */
export function formatSignatureNoticeXml(sigEval) {
  if (!sigEval?.needsUserSign) return '';
  const status = sigEval.verified ? 'mismatch' : 'unverified';
  const preferred = sigEval.preferredChat || 'unsigned';
  const message = sigEval.verified
    ? `当前检测到运行模型为 "${sigEval.reported}"，与角色常用签名 "${preferred}" 不一致。请向用户确认是否更新常用签名或以当前型号签注。`
    : '当前运行环境无法自动识别你的真实模型签名。严禁猜测或自填模型名；若本次交互需要记录签名或确认身份偏好，请顺口提醒用户为你代签。';
  return (
    `<signature_notice status="${status}" reported="${sigEval.reported}" preferred_chat="${preferred}">\n` +
    `${message}\n` +
    '</signature_notice>'
  );
}
