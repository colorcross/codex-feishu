import path from 'node:path';
import type { BridgeConfig } from '../config/schema.js';
import type { FeishuClient } from '../feishu/client.js';
import type { Logger } from '../logging.js';
import { AuditLog } from '../state/audit-log.js';
import type { MemoryStore } from '../state/memory-store.js';
import { RunStateStore, type RunState } from '../state/run-state-store.js';
import { loadBridgeConfigFile } from '../config/load.js';
import { getProjectArchiveDir, getProjectAuditDir, getProjectAuditFile } from '../projects/paths.js';
import { buildTeamDigest, formatTeamDigest, createDigestPeriod } from '../collaboration/digest.js';
import { checkLongRunningAlerts, formatAlert } from '../collaboration/proactive-alerts.js';
import { diffConfigs } from './service-utils.js';

/**
 * Subset of FeiqueService that the lifecycle/maintenance routines need.
 * Same structural-host pattern as the command modules.
 *
 * `notifyProjectChats` is exposed as a method because it is ALSO used from
 * inside service.ts (executePrompt, admin command, checkAndSendAlerts),
 * so it has to live on the class. The lifecycle module just reaches back
 * into it via the host.
 */
export interface LifecycleHost {
  readonly config: BridgeConfig;
  readonly auditLog: AuditLog;
  readonly feishuClient: FeishuClient;
  readonly memoryStore: MemoryStore;
  readonly runStateStore: RunStateStore;
  readonly logger: Logger;
  notifyProjectChats(projectAlias: string, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Run state recovery (startup orphan handling)
// ---------------------------------------------------------------------------

export async function recoverRuntimeState(host: LifecycleHost): Promise<RunState[]> {
  const recovered = await host.runStateStore.recoverOrphanedRuns();
  for (const run of recovered) {
    await host.auditLog.append({
      type: 'codex.run.recovered',
      run_id: run.run_id,
      project_alias: run.project_alias,
      conversation_key: run.conversation_key,
      status: run.status,
      pid: run.pid,
    });
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// Config hot reload
// ---------------------------------------------------------------------------

export interface ReloadConfigResult {
  ok: boolean;
  error?: string;
  changes?: string[];
  /**
   * Present only on successful reloads where the diff is non-empty. The
   * caller (FeiqueService) is responsible for assigning this to
   * `this.config`. We return it rather than mutating the host so the host
   * interface can stay `readonly`.
   */
  newConfig?: BridgeConfig;
}

export async function reloadConfig(
  host: LifecycleHost,
  configPath: string,
): Promise<ReloadConfigResult> {
  let newConfig: BridgeConfig;
  try {
    const { config } = await loadBridgeConfigFile(configPath);
    newConfig = config;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    host.logger.error({ configPath, error: msg }, 'Config reload rejected — invalid config');

    // Notify admin about the broken config
    const alertText = `🔴 配置变更被拒绝\n\n文件: ${configPath}\n原因: ${msg}\n\n当前服务继续使用旧配置运行。请修正后重新保存。`;
    for (const chatId of host.config.security.admin_chat_ids) {
      try { await host.feishuClient.sendText(chatId, alertText); } catch { /* best-effort */ }
    }

    await host.auditLog.append({
      type: 'config.reload.rejected',
      config_path: configPath,
      error: msg,
    });

    return { ok: false, error: msg };
  }

  // Diff: what changed?
  const changes = diffConfigs(host.config, newConfig);

  if (changes.length === 0) {
    host.logger.debug({ configPath }, 'Config file changed but no effective differences');
    return { ok: true, changes: [] };
  }

  host.logger.info({ configPath, changeCount: changes.length }, 'Config reloaded');

  // Notify admin — read admin_chat_ids from the OLD config in case the new
  // config removed them, so we can still deliver the notification.
  const changeList = changes.slice(0, 15).map((c) => `  • ${c}`).join('\n');
  const truncated = changes.length > 15 ? `\n  …及其他 ${changes.length - 15} 项变更` : '';
  const notifyText = `✅ 配置已热加载\n\n${changes.length} 项变更:\n${changeList}${truncated}`;
  const notifyChatIds = host.config.security.admin_chat_ids.length > 0
    ? host.config.security.admin_chat_ids
    : newConfig.security.admin_chat_ids;
  for (const chatId of notifyChatIds) {
    try { await host.feishuClient.sendText(chatId, notifyText); } catch { /* best-effort */ }
  }

  await host.auditLog.append({
    type: 'config.reload.applied',
    config_path: configPath,
    change_count: changes.length,
    changes: changes.slice(0, 20),
  });

  return { ok: true, changes, newConfig };
}

// ---------------------------------------------------------------------------
// Team digest cycle
// ---------------------------------------------------------------------------

export async function runDigestCycle(host: LifecycleHost): Promise<void> {
  const chatIds = host.config.service.team_digest_chat_ids;
  if (chatIds.length === 0) return;

  try {
    const period = createDigestPeriod(host.config.service.team_digest_interval_hours);
    const runs = await host.runStateStore.listRuns();
    const memories = host.config.service.memory_enabled
      ? await host.memoryStore.listRecentMemories({ scope: 'project', project_alias: '' }, 100)
      : [];
    const auditEvents = await host.auditLog.tail(500);

    const digest = buildTeamDigest(runs, memories, auditEvents, period);

    if (digest.summary.total_runs === 0) {
      return; // Nothing to report
    }

    const text = formatTeamDigest(digest);
    for (const chatId of chatIds) {
      try {
        await host.feishuClient.sendText(chatId, text);
      } catch (error) {
        host.logger.warn({ chatId, error }, 'Failed to send team digest');
      }
    }

    await host.auditLog.append({
      type: 'collaboration.digest.sent',
      period_label: period.label,
      total_runs: digest.summary.total_runs,
      chat_ids: chatIds,
    });

    // Send per-project mini-digests to project notification chats
    for (const projectDigest of digest.topProjects) {
      const projectChatIds = host.config.projects[projectDigest.alias]?.notification_chat_ids ?? [];
      if (projectChatIds.length === 0) continue;
      const successPct = Math.round(projectDigest.success_rate * 100);
      const miniDigestText = [
        `📊 项目摘要 [${projectDigest.alias}] — ${period.label}`,
        `运行: ${projectDigest.runs} | 成功率: ${successPct}%`,
        `参与者: ${projectDigest.actors.join(', ') || '无'}`,
      ].join('\n');
      for (const chatId of projectChatIds) {
        try {
          await host.feishuClient.sendText(chatId, miniDigestText);
        } catch { /* best-effort */ }
      }
    }
  } catch (error) {
    host.logger.error({ error }, 'Failed to generate team digest');
  }
}

// ---------------------------------------------------------------------------
// Memory maintenance
// ---------------------------------------------------------------------------

export async function runMemoryMaintenance(host: LifecycleHost): Promise<number> {
  if (!host.config.service.memory_enabled) {
    return 0;
  }
  const cleaned = await host.memoryStore.cleanupExpiredMemories();
  if (cleaned > 0) {
    await host.auditLog.append({
      type: 'memory.archive.expired.maintenance',
      count: cleaned,
    });
    host.logger.info({ cleaned }, 'Expired memories cleaned by background maintenance');
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Audit maintenance
// ---------------------------------------------------------------------------

function listManagedAuditTargets(config: BridgeConfig): Array<{ stateDir: string; fileName: string; archiveDir?: string }> {
  const targets: Array<{ stateDir: string; fileName: string; archiveDir?: string }> = [
    {
      stateDir: config.storage.dir,
      fileName: 'audit.jsonl',
      archiveDir: path.join(config.storage.dir, 'archive'),
    },
    {
      stateDir: config.storage.dir,
      fileName: 'admin-audit.jsonl',
      archiveDir: path.join(config.storage.dir, 'archive'),
    },
  ];

  for (const [alias, project] of Object.entries(config.projects)) {
    targets.push({
      stateDir: getProjectAuditDir(config.storage.dir, alias, project),
      fileName: path.basename(getProjectAuditFile(config.storage.dir, alias, project)),
      archiveDir: getProjectArchiveDir(config.storage.dir, alias),
    });
  }

  return targets;
}

export async function runAuditMaintenance(
  host: LifecycleHost,
): Promise<{ scanned: number; archived: number; removed: number }> {
  const auditTargets = listManagedAuditTargets(host.config);
  let scanned = 0;
  let archived = 0;
  let removed = 0;

  for (const target of auditTargets) {
    const auditLog = new AuditLog(target.stateDir, target.fileName);
    const result = await auditLog.cleanup({
      retentionDays: host.config.service.audit_retention_days,
      archiveAfterDays: host.config.service.audit_archive_after_days,
      archiveDir: target.archiveDir,
    });
    scanned += 1;
    archived += result.archived;
    removed += result.removed;
  }

  if (archived > 0 || removed > 0) {
    await host.auditLog.append({
      type: 'audit.cleanup.completed',
      scanned,
      archived,
      removed,
    });
    host.logger.info({ scanned, archived, removed }, 'Audit retention cleanup completed');
  }

  return { scanned, archived, removed };
}

// ---------------------------------------------------------------------------
// Combined maintenance cycle
// ---------------------------------------------------------------------------

export async function runMaintenanceCycle(host: LifecycleHost): Promise<void> {
  if (host.config.service.memory_enabled) {
    await runMemoryMaintenance(host);
  }
  await runAuditMaintenance(host);

  // Proactive: check for long-running tasks
  try {
    const activeRuns = await host.runStateStore.listRuns();
    const longAlerts = checkLongRunningAlerts(activeRuns);
    for (const alert of longAlerts) {
      const text = formatAlert(alert);
      for (const chatId of host.config.security.admin_chat_ids) {
        try { await host.feishuClient.sendText(chatId, text); } catch { /* best-effort */ }
      }
      await host.notifyProjectChats(alert.project_alias, text);
    }
  } catch { /* best-effort */ }
}
