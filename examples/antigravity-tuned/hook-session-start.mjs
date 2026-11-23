/**
 * @fileoverview Antigravity SessionStart hook layered on `harness-connector`:
 * - Uses `harness-connector/slot-scanner.mjs` (via `mode-router.mjs`) and
 *   `harness-connector/rules-renderer.mjs` with Antigravity's 24KB cap.
 * - Full-Auto: when workspace embeds 1 cartridge (`character.manifest.json`)
 *   or `.persona`, automatically renders `<workspace>/AGENTS.md` (SOUL ->
 *   USER_PROFILE -> L0 -> Evergreen -> bottom-rotated Living Timeline), freezes
 *   the session baseline cursor, and returns `{}` silently on subsequent sessions.
 * - Multi-Cartridge Interlock (>=2 cartridges): returns `{}` silently.
 */

import { beginSession, composeSystemPrefix, loadVault } from '../../kit/core/runtime.mjs';
import {
  detectWorkspaceRulesFile,
  syncWorkspaceRulesFile
} from '../../harness-connector/rules-renderer.mjs';
import {
  ANTIGRAVITY_MAX_RULE_BYTES,
  ANTIGRAVITY_RULE_FILENAMES,
  DEFAULT_KIT_ROOT,
  recordSessionTracking,
  resolveConversationMode,
  setConversationModeOverride
} from './mode-router.mjs';

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  const payload = await readStdinJson();
  const kitRoot = process.env.PMV_KIT_ROOT || DEFAULT_KIT_ROOT;
  const resolved = await resolveConversationMode(payload);

  if (resolved.mode !== 'assistant') {
    process.stdout.write('{}\n');
    return;
  }

  const cartridgeId = resolved.cartridge || null;
  const cartridgeRef = resolved.cartridge_path || cartridgeId;
  const sessionId = String(payload.conversationId || '').trim();

  let topRules = await detectWorkspaceRulesFile(resolved.candidate_dirs, cartridgeId, {
    kitRoot,
    cartridgeRef,
    fileNames: ANTIGRAVITY_RULE_FILENAMES,
    maxBytes: ANTIGRAVITY_MAX_RULE_BYTES,
    autoRefresh: true,
    refreshIndex: true
  });

  let autoRenderedFirstTime = false;
  const isMarkerOrSlotWorkspace =
    resolved.source === 'workspace_cartridge_slot' || resolved.source === 'marker:.persona';
  if (!topRules.active && isMarkerOrSlotWorkspace && resolved.slot_workspace) {
    const syncRes = await syncWorkspaceRulesFile(resolved.slot_workspace, cartridgeRef, {
      kitRoot,
      fileName: 'AGENTS.md',
      includeIndex: true,
      maxBytes: ANTIGRAVITY_MAX_RULE_BYTES,
      createPersonaMarker: false
    });
    topRules = {
      active: true,
      filePath: syncRes.filePath,
      fileName: syncRes.fileName,
      workspace: syncRes.workspace,
      cartridge: syncRes.cartridge,
      sha256: syncRes.sha256,
      index_sha256: syncRes.index_sha256,
      include_index: syncRes.include_index,
      refreshed: true
    };
    autoRenderedFirstTime = true;
  }

  const fullTopRulesPreExisting = topRules.active && topRules.include_index && !autoRenderedFirstTime;
  const assemblyOverrides =
    topRules.active && !autoRenderedFirstTime
      ? { system_sections: ['l0_contract', 'index'] }
      : undefined;

  let systemText = '';
  let activeCartridge = cartridgeId;
  let activeVaultPath = resolved.cartridge_path || null;

  if (sessionId) {
    const started = await beginSession(cartridgeRef, {
      sessionId,
      model: payload.modelName,
      assemblyOverrides,
      forceReset: topRules.active && topRules.include_index,
      kitRoot
    });
    activeCartridge = started.cartridge_id || cartridgeId;
    activeVaultPath = started.vault_path || activeVaultPath;
    systemText = fullTopRulesPreExisting ? '' : started.system;

    const trackingPayload = {
      mode: 'assistant',
      cartridge: activeCartridge,
      cartridge_path: activeVaultPath,
      baseline_injected: true,
      baseline_checkpoint_step: -1,
      turns_since_baseline: 0,
      top_rules_active: topRules.active
    };
    if (resolved.source === 'session_override') {
      await setConversationModeOverride(sessionId, trackingPayload);
    } else {
      await recordSessionTracking(sessionId, trackingPayload);
    }
  } else if (!fullTopRulesPreExisting) {
    const vault = await loadVault(cartridgeRef, { kitRoot });
    if (topRules.active && !autoRenderedFirstTime) {
      systemText = vault.indexMd?.trim() || '';
    } else {
      systemText = composeSystemPrefix(vault, { reportedModel: payload.modelName }).systemPrefix;
    }
  }

  if (!systemText.trim()) {
    process.stdout.write('{}\n');
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      injectSteps: [{ systemMessage: { systemMessage: systemText } }]
    })}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[ag-tuned SessionStart] ${err?.message || err}\n`);
  process.stdout.write('{}\n');
});
