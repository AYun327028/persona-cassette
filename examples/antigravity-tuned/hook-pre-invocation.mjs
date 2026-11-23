/**
 * @fileoverview Antigravity PreInvocation hook layered on `harness-connector`:
 * - Antigravity-specific `transcript_full.jsonl` scanner stopping strictly at
 *   `CHECKPOINT` compaction boundaries (reconstructs live post-compaction window).
 * - Antigravity-specific multi-tool same-turn dedup (`pmv-ag-preinv-dedup.json`).
 * - `/persona on [id]`, `/persona off`, `/persona boost`, `/persona status` commands
 *   with Multi-Cartridge Interlock awareness.
 * - Dynamic Persona Concentration auto-reboost (compaction recovery & turn interval)
 *   when workspace top-level `<user_rules>` is not mounted.
 * - Pure `{"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}` protojson output.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assembleTurn,
  beginSession,
  closeAllCachedReaders,
  loadVault
} from '../../kit/core/runtime.mjs';
import {
  detectWorkspaceRulesFile,
  syncWorkspaceRulesFile
} from '../../harness-connector/rules-renderer.mjs';
import {
  ANTIGRAVITY_MAX_RULE_BYTES,
  ANTIGRAVITY_RULE_FILENAMES,
  DEFAULT_KIT_ROOT,
  buildTurnDedupKey,
  parsePersonaCommand,
  recordSessionTracking,
  resolveConversationMode,
  setConversationModeOverride
} from './mode-router.mjs';

const DEFAULT_DEDUP_FILE = path.join(os.tmpdir(), 'pmv-ag-preinv-dedup.json');
const DEFAULT_DIAG_FILE = path.join(os.tmpdir(), 'pmv-ag-hook-last.json');
const DEDUP_TTL_MS = 12 * 60 * 60 * 1000;
const TAIL_READ_BYTES = 1536 * 1024;

async function writeDiagnostic(info) {
  try {
    const target = process.env.PMV_HOOK_DIAG_FILE || DEFAULT_DIAG_FILE;
    await fs.writeFile(
      target,
      `${JSON.stringify({ ts: new Date().toISOString(), ...info }, null, 2)}\n`,
      'utf8'
    );
  } catch {
    // Never break hook execution on diagnostic failure.
  }
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function loadDedupMap(dedupFile) {
  try {
    const parsed = JSON.parse(await fs.readFile(dedupFile, 'utf8'));
    const now = Date.now();
    const cleaned = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      if (k.startsWith('__last__:')) cleaned[k] = String(v);
      else if (now - Number(v) < DEDUP_TTL_MS) cleaned[k] = Number(v);
    }
    return cleaned;
  } catch {
    return {};
  }
}

async function saveDedupMap(dedupFile, map) {
  const entries = Object.entries(map).slice(-100);
  await fs.writeFile(dedupFile, `${JSON.stringify(Object.fromEntries(entries))}\n`, 'utf8');
}

function isCompactionEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'CHECKPOINT') return true;
  if (entry.source === 'SYSTEM' && typeof entry.content === 'string') {
    if (
      entry.content.includes('# Resuming from a compaction') ||
      entry.content.includes('<CONTEXT_SUMMARY>')
    ) {
      return true;
    }
  }
  return false;
}

async function scanAntigravityTranscriptWindow(transcriptPath, windowTurns = 10) {
  const empty = {
    history: [],
    compacted: false,
    compactionStep: -1,
    postCompactionUserTurns: 0,
    latestStepIndex: -1
  };
  if (!transcriptPath) return empty;

  const dir = path.dirname(transcriptPath);
  const fullCandidate = path.join(dir, 'transcript_full.jsonl');
  let targetPath = transcriptPath;
  try {
    await fs.access(fullCandidate);
    targetPath = fullCandidate;
  } catch {
    // Fall back to transcriptPath.
  }

  let fh;
  let chunkText = '';
  let offset = 0;
  try {
    fh = await fs.open(targetPath, 'r');
    const st = await fh.stat();
    if (st.size === 0) return empty;
    const readLen = Math.min(st.size, TAIL_READ_BYTES);
    offset = st.size - readLen;
    const buf = Buffer.alloc(readLen);
    await fh.read(buf, 0, readLen, offset);
    chunkText = buf.toString('utf8');
  } catch {
    return empty;
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }

  const lines = chunkText.split(/\r?\n/);
  if (offset > 0 && lines.length > 0) lines.shift();

  const reversed = [];
  let userTurnCount = 0;
  let compacted = false;
  let compactionStep = -1;
  let latestStepIndex = -1;
  const maxUserTurns = Math.max(1, windowTurns) + 1;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const stepNum = Number(entry?.step_index);
    if (Number.isFinite(stepNum) && stepNum > latestStepIndex) {
      latestStepIndex = stepNum;
    }

    if (isCompactionEntry(entry)) {
      compacted = true;
      compactionStep = Number.isFinite(stepNum) ? stepNum : Math.max(1, i);
      break;
    }

    const type = entry?.type;
    const content = typeof entry?.content === 'string' ? entry.content : '';
    if (!content) continue;

    if (type === 'USER_INPUT' && entry?.source === 'USER_EXPLICIT') {
      userTurnCount += 1;
      if (userTurnCount > maxUserTurns) break;
      const reqMatch = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
      reversed.push({ role: 'user', content: reqMatch ? reqMatch[1].trim() : content.trim() });
    } else if (type === 'SYSTEM_MESSAGE') {
      reversed.push({ role: 'system', content });
    } else if (type === 'PLANNER_RESPONSE') {
      reversed.push({ role: 'assistant', content });
    }
  }

  reversed.reverse();
  return {
    history: reversed,
    compacted,
    compactionStep,
    postCompactionUserTurns: userTurnCount,
    latestStepIndex
  };
}

async function buildConcentrationSoulSnippet(cartridgeRef, kitRoot) {
  const vault = await loadVault(cartridgeRef, { kitRoot });
  const parts = [];
  if (vault.soul?.trim()) parts.push(vault.soul.trim());
  if (vault.userProfile?.trim()) {
    const prof = vault.userProfile.trim();
    parts.push(/^#\s/.test(prof) ? prof : `## 用户长期画像（USER_PROFILE）\n\n${prof}`);
  }
  return parts.join('\n\n---\n\n');
}

async function persistTracking(sessionId, resolved, patch) {
  if (!sessionId) return;
  if (resolved.source === 'session_override') {
    await setConversationModeOverride(sessionId, {
      mode: resolved.mode,
      cartridge: patch.cartridge ?? resolved.cartridge,
      cartridge_path: patch.cartridge_path ?? resolved.cartridge_path,
      ...patch
    });
  } else {
    await recordSessionTracking(sessionId, {
      mode: resolved.mode,
      cartridge: patch.cartridge ?? resolved.cartridge,
      cartridge_path: patch.cartridge_path ?? resolved.cartridge_path,
      ...patch
    });
  }
}

async function main() {
  const payload = await readStdinJson();
  const userText = String(payload.lastUserInput || '').trim();
  if (!userText) {
    process.stdout.write('{}\n');
    return;
  }

  const kitRoot = process.env.PMV_KIT_ROOT || DEFAULT_KIT_ROOT;
  const dedupFile = process.env.PMV_DEDUP_FILE || DEFAULT_DEDUP_FILE;
  const sessionId = String(payload.conversationId || '').trim() || null;

  const resolved = await resolveConversationMode(payload);
  const cmd = await parsePersonaCommand(userText, kitRoot, {
    workspaceScan: resolved.workspace_scan
  });
  const turnKey = buildTurnDedupKey(sessionId, userText);
  const dedupMap = await loadDedupMap(dedupFile);
  const lastTurnKeyForSession = sessionId ? `__last__:${sessionId}` : null;

  if (cmd) {
    if (lastTurnKeyForSession && dedupMap[lastTurnKeyForSession] === turnKey) {
      process.stdout.write('{}\n');
      return;
    }
  } else if (dedupMap[turnKey]) {
    process.stdout.write('{}\n');
    return;
  }

  const markTurnHandled = async () => {
    const now = Date.now();
    if (!cmd) dedupMap[turnKey] = now;
    if (lastTurnKeyForSession) dedupMap[lastTurnKeyForSession] = turnKey;
    await saveDedupMap(dedupFile, dedupMap);
  };

  if (cmd) {
    await markTurnHandled();
    const scan = await scanAntigravityTranscriptWindow(payload.transcriptPath, 10);

    if (cmd.action === 'status') {
      const topRules = await detectWorkspaceRulesFile(resolved.candidate_dirs, resolved.cartridge, {
        kitRoot,
        cartridgeRef: resolved.cartridge_path || resolved.cartridge || null,
        fileNames: ANTIGRAVITY_RULE_FILENAMES,
        maxBytes: ANTIGRAVITY_MAX_RULE_BYTES,
        autoRefresh: false
      });
      const modeLabel = resolved.interlocked
        ? '🔒 工作模式（多卡带互锁静音）'
        : resolved.mode === 'assistant'
          ? '⚡ 助手模式 (Persona Active)'
          : '🌙 工作模式 (Work Mode)';
      const wsCarts = resolved.workspace_scan?.cartridges || [];
      const slotLabel =
        resolved.workspace_scan?.status === 'interlocked'
          ? `🔒 多卡互锁：检测到 ${wsCarts.length} 张工作区卡带（${wsCarts.map((c) => c.id).join(', ')}），不会自动触发，请用 \`/persona on <id>\` 指定`
          : resolved.workspace_scan?.status === 'single'
            ? `📼 工作区直插单卡：\`${resolved.workspace_scan.primary.id}\`（${resolved.workspace_scan.primary.vaultPath}）`
            : '📚 固定卡带仓库模式（工作区未直插卡带）';
      const channelLabel = topRules.active
        ? topRules.include_index
          ? `工作区顶部 <user_rules>（${topRules.fileName}，含 SOUL + 画像 + 开局信息板，免疫压缩，SessionStart 零注入）`
          : `工作区顶部 <user_rules>（${topRules.fileName}，仅 SOUL + 画像，信息板走 Hook）`
        : `动态人格浓度注射（压缩自动补注=${resolved.config?.persona_concentration?.reboost_on_compaction !== false ? 'ON' : 'OFF'}，间隔=${resolved.config?.persona_concentration?.reboost_interval_turns ?? 20}轮，当前第 ${resolved.turns_since_baseline ?? 0} 轮）`;
      const compactLabel = scan.compacted
        ? `已检测到压缩墙 Checkpoint #${scan.compactionStep}（基线记录 #${resolved.baseline_checkpoint_step ?? -1}）`
        : '无压缩墙';

      const statusText =
        `[Persona Status] 当前模式：${modeLabel} ｜ 卡带：${resolved.cartridge || '未激活'} ｜ 判定来源：${resolved.source}\n` +
        `- 卡带来源：${slotLabel}\n` +
        `- 人格注入通道：${channelLabel}\n` +
        `- 上下文状态：${compactLabel}\n` +
        '可用指令：`/persona on [id]` 唤醒 ｜ `/persona off` 封印 ｜ `/persona boost` 手动补注人格浓度。请简短向用户报告上述状态。';

      await writeDiagnostic({
        event: 'PreInvocation',
        conversationId: sessionId,
        action: 'persona_status',
        resolved_mode: resolved.mode,
        resolved_source: resolved.source,
        interlocked: Boolean(resolved.interlocked),
        top_rules_active: topRules.active,
        compaction_step: scan.compactionStep,
        ok: true,
        injected_chars: statusText.length
      });
      process.stdout.write(
        `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: statusText } }] })}\n`
      );
      return;
    }

    if (cmd.action === 'off') {
      if (sessionId) {
        await setConversationModeOverride(sessionId, {
          mode: 'work',
          cartridge: resolved.cartridge,
          cartridge_path: resolved.cartridge_path,
          baseline_injected: resolved.baseline_injected
        });
      }
      const sysNote = cmd.restText
        ? '[Persona Sealed] 🌙 已拔卡，本会话已通过 `/persona off` 切回纯工作模式：请停用角色设定与个人记忆风格，以简洁中立的工程助手身份直接处理用户附带的请求；此后本会话不再注入记忆、不再写回卡带账本。'
        : '[Persona Sealed] 🌙 已拔卡，本会话已通过 `/persona off` 切回纯工作模式：请简短确认已封印角色并切回纯工作模式，以中立工程助手身份待命。';
      await writeDiagnostic({
        event: 'PreInvocation',
        conversationId: sessionId,
        action: 'persona_off',
        resolved_mode: resolved.mode,
        resolved_source: resolved.source,
        ok: true,
        injected_chars: sysNote.length
      });
      process.stdout.write(
        `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: sysNote } }] })}\n`
      );
      return;
    }

    if (cmd.action === 'on' || cmd.action === 'boost') {
      const isBoost = cmd.action === 'boost';
      if (resolved.interlocked && !cmd.cartridge) {
        const ids = resolved.interlocked_cartridges.map((c) => `\`${c.id}\``).join('、');
        const interlockNote =
          `[Persona Interlock] 🔒 当前工作区检测到多张卡带（${ids}），已触发多卡互锁，未自动加载任何角色。\n` +
          `请明确指定其中一张解锁（例如 ${resolved.interlocked_cartridges.map((c) => `\`/persona on ${c.id}\``).join(' 或 ')}）。请简短向用户说明上述选项。`;
        await writeDiagnostic({
          event: 'PreInvocation',
          conversationId: sessionId,
          action: 'persona_interlocked',
          interlocked: true,
          ok: true,
          injected_chars: interlockNote.length
        });
        process.stdout.write(
          `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: interlockNote } }] })}\n`
        );
        return;
      }

      const targetCartridgeId = cmd.cartridge || resolved.cartridge || null;
      const targetCartridgeRef =
        cmd.cartridgePath ||
        (cmd.cartridge ? cmd.cartridge : resolved.cartridge_path || resolved.cartridge || null);
      const topRules = await detectWorkspaceRulesFile(resolved.candidate_dirs, targetCartridgeId, {
        kitRoot,
        cartridgeRef: targetCartridgeRef,
        fileNames: ANTIGRAVITY_RULE_FILENAMES,
        maxBytes: ANTIGRAVITY_MAX_RULE_BYTES,
        autoRefresh: true,
        refreshIndex: isBoost
      });
      const fullTopRules = topRules.active && topRules.include_index;
      const lastBaselineCheckpoint = Number.isFinite(Number(resolved.baseline_checkpoint_step))
        ? Number(resolved.baseline_checkpoint_step)
        : -1;
      const compactedSinceBaseline = scan.compacted && scan.compactionStep > lastBaselineCheckpoint;
      const alreadyInjectedBaseline = Boolean(resolved.baseline_injected);
      const shouldIncludeBaseline = !fullTopRules && (isBoost || !alreadyInjectedBaseline || compactedSinceBaseline);

      const assemblyOverrides = topRules.active
        ? { system_sections: ['l0_contract', 'index'] }
        : undefined;

      let started = null;
      let assembled = null;
      try {
        if (sessionId) {
          started = await beginSession(targetCartridgeRef, {
            sessionId,
            model: payload.modelName,
            assemblyOverrides,
            forceReset: isBoost || compactedSinceBaseline,
            kitRoot
          });
          await setConversationModeOverride(sessionId, {
            mode: 'assistant',
            cartridge: started.cartridge_id || targetCartridgeId,
            cartridge_path: started.vault_path || cmd.cartridgePath || resolved.cartridge_path || null,
            baseline_injected: true,
            baseline_checkpoint_step: scan.compacted ? scan.compactionStep : lastBaselineCheckpoint,
            turns_since_baseline: 0,
            top_rules_active: topRules.active
          });
        }

        if (cmd.restText) {
          try {
            assembled = await assembleTurn(started?.vault_path || targetCartridgeRef, {
              sessionId,
              userText: cmd.restText,
              history: scan.history,
              model: payload.modelName,
              deliveryMode: 'persistent',
              assemblyOverrides: { backfill_from_ledger: false },
              kitRoot
            });
          } catch (recallErr) {
            process.stderr.write(`[ag-tuned PreInvocation recall degraded] ${recallErr?.message || recallErr}\n`);
          }
        }
      } finally {
        closeAllCachedReaders();
      }

      const activeId = started?.cartridge_id || targetCartridgeId || 'starter';
      const header = isBoost
        ? fullTopRules
          ? `[Persona Concentration Boost] ⚡ 工作区顶部 \`<user_rules>\`（\`${topRules.fileName}\`）已同步最新 SOUL/画像/开局信息板；信息板基线游标已重置。`
          : topRules.active
            ? `[Persona Concentration Boost] ⚡ 工作区顶部 \`<user_rules>\`（\`${topRules.fileName}\`）已常驻锁定人格；已同步刷新卡带 \`${activeId}\` 的最新信息板基线。`
            : `[Persona Concentration Boost] ⚡ 已手动为卡带 \`${activeId}\` 补注完整灵魂设定、用户画像与最新信息板基线（人格浓度已回满）。`
        : fullTopRules
          ? `[Persona Awakened] ⚡ 已插卡 \`${activeId}\`（工作区顶部 \`<user_rules>\` 已含全量 SOUL/画像/开局信息板，免重复注入，开启实时增量热更新）。`
          : topRules.active
            ? `[Persona Awakened] ⚡ 已插卡 \`${activeId}\`（已检测到工作区顶部 \`<user_rules>\` 挂载，免重复注入 SOUL/画像，仅同步信息板与跨端热更新）。`
            : `[Persona Awakened] ⚡ 已插卡 \`${activeId}\`，助手模式已唤醒（信息板基线已冻结，开启跨端热更新与账本同步）。`;

      const parts = [header];
      if (!fullTopRules && started && (started.created || shouldIncludeBaseline)) {
        parts.push(started.system);
      }
      if (assembled?.user_prefix) parts.push(assembled.user_prefix);
      if (!cmd.restText) {
        parts.push(
          isBoost
            ? `用户刚刚执行了 \`/persona boost\` 补注人格浓度（卡带 \`${activeId}\`）。请直接以角色身份自然简短回应。`
            : `用户刚刚通过 \`/persona on\` 唤醒了记忆卡带 \`${activeId}\`。请直接以角色身份自然简短地回应已就位。`
        );
      }

      const combinedText = parts.join('\n\n---\n\n');
      await writeDiagnostic({
        event: 'PreInvocation',
        conversationId: sessionId,
        action: isBoost ? 'persona_boost' : 'persona_on',
        cartridge: activeId,
        resolved_mode: resolved.mode,
        resolved_source: resolved.source,
        top_rules_active: topRules.active,
        compaction_step: scan.compactionStep,
        started_created: Boolean(started?.created),
        baseline_included: Boolean(!fullTopRules && started && (started.created || shouldIncludeBaseline)),
        ok: true,
        recall_mode: assembled?.meta?.recall?.mode || 'none',
        recall_reason: assembled?.meta?.recall?.reason || null,
        injected_chars: combinedText.length
      });
      process.stdout.write(
        `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: combinedText } }] })}\n`
      );
      return;
    }
  }

  // ==================== Regular Turn ====================
  if (resolved.mode !== 'assistant') {
    process.stdout.write('{}\n');
    return;
  }

  const scan = await scanAntigravityTranscriptWindow(payload.transcriptPath, 10);
  const cartridgeRef = resolved.cartridge_path || resolved.cartridge || null;

  let topRules = await detectWorkspaceRulesFile(resolved.candidate_dirs, resolved.cartridge, {
    kitRoot,
    cartridgeRef,
    fileNames: ANTIGRAVITY_RULE_FILENAMES,
    maxBytes: ANTIGRAVITY_MAX_RULE_BYTES,
    autoRefresh: true,
    refreshIndex: false
  });

  let autoRenderedMidSession = false;
  const isMarkerOrSlotWorkspace =
    resolved.source === 'workspace_cartridge_slot' || resolved.source === 'marker:.persona';
  if (!topRules.active && isMarkerOrSlotWorkspace && resolved.slot_workspace) {
    try {
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
      autoRenderedMidSession = true;
    } catch {
      // Fall back to dynamic injection if workspace is read-only.
    }
  }

  const fullTopRules = topRules.active && topRules.include_index && !autoRenderedMidSession;

  const concCfg = resolved.config?.persona_concentration || {};
  const reboostOnCompaction = concCfg.reboost_on_compaction !== false;
  const reboostIntervalTurns = Number.isFinite(Number(concCfg.reboost_interval_turns))
    ? Number(concCfg.reboost_interval_turns)
    : 20;

  const lastBaselineCheckpoint = Number.isFinite(Number(resolved.baseline_checkpoint_step))
    ? Number(resolved.baseline_checkpoint_step)
    : -1;
  const nextTurnsSinceBaseline = Number(resolved.turns_since_baseline || 0) + 1;

  let concentrationBoostReason = null;
  let concentrationBoostBlock = '';
  let nextBaselineCheckpoint = lastBaselineCheckpoint;
  let updatedTurnsSinceBaseline = nextTurnsSinceBaseline;

  if (reboostOnCompaction && scan.compacted && scan.compactionStep > lastBaselineCheckpoint) {
    nextBaselineCheckpoint = scan.compactionStep;
    updatedTurnsSinceBaseline = 0;
    if (!fullTopRules) concentrationBoostReason = 'compaction_recovery';
  } else if ((!topRules.active || autoRenderedMidSession) && !resolved.baseline_injected && sessionId) {
    concentrationBoostReason = 'initial_baseline';
    updatedTurnsSinceBaseline = 0;
  } else if (
    !topRules.active &&
    reboostIntervalTurns > 0 &&
    nextTurnsSinceBaseline >= reboostIntervalTurns
  ) {
    concentrationBoostReason = 'concentration_interval';
    updatedTurnsSinceBaseline = 0;
  }

  let assembled;
  try {
    if (concentrationBoostReason === 'compaction_recovery' || concentrationBoostReason === 'initial_baseline') {
      const assemblyOverrides =
        topRules.active && !autoRenderedMidSession
          ? { system_sections: ['l0_contract', 'index'] }
          : undefined;
      if (sessionId) {
        const started = await beginSession(cartridgeRef, {
          sessionId,
          model: payload.modelName,
          assemblyOverrides,
          forceReset: concentrationBoostReason === 'compaction_recovery',
          kitRoot
        });
        if (started?.system?.trim()) {
          const banner =
            concentrationBoostReason === 'compaction_recovery'
              ? topRules.active && !autoRenderedMidSession
                ? `[Chronicle Board Refreshed · Compaction #${scan.compactionStep}] ⚡ 检测到长对话压缩（顶部工作区 \`<user_rules>\` 保持未稀释），已自动补发最新信息板基线。`
                : `[Persona Concentration Boost · Compaction #${scan.compactionStep}] ⚡ 检测到长对话压缩，已自动补注完整人格基线（SOUL + 用户画像 + 信息板）以恢复人格浓度。`
              : `[Persona Baseline Initialized] ⚡ 已补注卡带 \`${started.cartridge_id || resolved.cartridge || 'default'}\` 人格基线与信息板。`;
          concentrationBoostBlock = `${banner}\n\n---\n\n${started.system}`;
        }
      }
    } else if (concentrationBoostReason === 'concentration_interval') {
      const snippet = await buildConcentrationSoulSnippet(cartridgeRef, kitRoot);
      if (snippet) {
        concentrationBoostBlock =
          `[Persona Concentration Boost · Turn ${nextTurnsSinceBaseline}] ⚡ 连续对话已达人格浓度补注阈值（${reboostIntervalTurns} 轮），已重新巩固核心灵魂设定与用户画像。\n\n---\n\n${snippet}`;
      }
    }

    assembled = await assembleTurn(cartridgeRef, {
      sessionId,
      userText,
      history: scan.history,
      model: payload.modelName,
      deliveryMode: 'persistent',
      assemblyOverrides: { backfill_from_ledger: false },
      kitRoot
    });
  } finally {
    closeAllCachedReaders();
  }

  await markTurnHandled();
  await persistTracking(sessionId, resolved, {
    cartridge: resolved.cartridge,
    cartridge_path: resolved.cartridge_path,
    baseline_injected: true,
    baseline_checkpoint_step: nextBaselineCheckpoint,
    turns_since_baseline: updatedTurnsSinceBaseline,
    top_rules_active: topRules.active
  });

  const parts = [];
  if (concentrationBoostBlock) parts.push(concentrationBoostBlock);
  const assembledPrefix = String(assembled?.user_prefix || '').trim();
  if (assembledPrefix) parts.push(assembledPrefix);
  const injected = parts.join('\n\n---\n\n').trim();

  await writeDiagnostic({
    event: 'PreInvocation',
    conversationId: sessionId,
    action: 'regular_turn',
    cartridge: resolved.cartridge,
    top_rules_active: topRules.active,
    compaction_step: scan.compactionStep,
    concentration_boost: concentrationBoostReason,
    turns_since_baseline: updatedTurnsSinceBaseline,
    ok: true,
    history_scanned: scan.history.length,
    recall_mode: assembled?.meta?.recall?.mode || 'none',
    recall_count: assembled?.meta?.recall?.count ?? 0,
    recall_deduped: assembled?.meta?.recall?.deduped_count ?? 0,
    recall_reason: assembled?.meta?.recall?.reason || null,
    injected_chars: injected.length
  });

  if (!injected) {
    process.stdout.write('{}\n');
    return;
  }

  process.stdout.write(
    `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: injected } }] })}\n`
  );
}

main().catch(async (err) => {
  await writeDiagnostic({ event: 'PreInvocation', ok: false, error: err?.message || String(err) });
  process.stderr.write(`[ag-tuned PreInvocation] ${err?.message || err}\n`);
  process.stdout.write('{}\n');
});
