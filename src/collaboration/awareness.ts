/**
 * Direction 1: 协作态势感知 — Team Activity Awareness
 *
 * Aggregates run states into a team-level view and detects
 * overlapping work across team members.
 */

import type { RunState } from '../state/run-state-store.js';

export interface TeamMemberActivity {
  actor_id: string;
  actor_name?: string;
  chat_id: string;
  project_alias: string;
  project_root?: string;
  backend?: string;
  status: 'running' | 'queued';
  run_id: string;
  started_at: string;
  updated_at: string;
  prompt_excerpt?: string;
}

export interface OverlapAlert {
  kind: 'same_project' | 'same_root';
  existing_actor_id?: string;
  existing_run_id: string;
  project_alias: string;
  project_root?: string;
  detail: string;
}

const ACTIVE_STATUSES = new Set<string>(['running', 'queued']);

export function buildTeamActivityView(runs: RunState[]): TeamMemberActivity[] {
  return runs
    .filter((r) => ACTIVE_STATUSES.has(r.status))
    .map((r) => ({
      actor_id: r.actor_id ?? 'unknown',
      actor_name: r.actor_name,
      chat_id: r.chat_id,
      project_alias: r.project_alias,
      project_root: r.project_root,
      status: r.status as 'running' | 'queued',
      run_id: r.run_id,
      started_at: r.started_at,
      updated_at: r.updated_at,
      prompt_excerpt: r.prompt_excerpt,
    }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function detectOverlaps(
  incoming: { actor_id?: string; project_alias: string; project_root?: string },
  activeRuns: RunState[],
): OverlapAlert[] {
  const alerts: OverlapAlert[] = [];

  for (const run of activeRuns) {
    if (!ACTIVE_STATUSES.has(run.status)) continue;
    if (run.actor_id === incoming.actor_id) continue;

    if (run.project_alias === incoming.project_alias) {
      alerts.push({
        kind: 'same_project',
        existing_actor_id: run.actor_id,
        existing_run_id: run.run_id,
        project_alias: run.project_alias,
        project_root: run.project_root,
        detail: `${run.actor_id ?? '其他成员'} 正在项目 ${run.project_alias} 上工作`,
      });
    } else if (
      incoming.project_root &&
      run.project_root &&
      run.project_root === incoming.project_root
    ) {
      alerts.push({
        kind: 'same_root',
        existing_actor_id: run.actor_id,
        existing_run_id: run.run_id,
        project_alias: run.project_alias,
        project_root: run.project_root,
        detail: `${run.actor_id ?? '其他成员'} 正在操作同一仓库 (${run.project_alias})`,
      });
    }
  }

  return alerts;
}

export function formatTeamView(activities: TeamMemberActivity[]): string {
  if (activities.length === 0) {
    return '当前没有活跃的团队成员在使用 AI 工具。';
  }

  const lines: string[] = ['📡 团队 AI 协作态势\n'];

  const running = activities.filter((a) => a.status === 'running');
  const queued = activities.filter((a) => a.status === 'queued');

  if (running.length > 0) {
    lines.push(`🟢 执行中 (${running.length})`);
    for (const a of running) {
      const actor = a.actor_name ?? a.actor_id;
      const elapsed = formatElapsed(a.started_at);
      lines.push(`  • ${actor} → ${a.project_alias} (${elapsed})`);
      if (a.prompt_excerpt) {
        lines.push(`    "${truncate(a.prompt_excerpt, 60)}"`);
      }
    }
  }

  if (queued.length > 0) {
    lines.push(`\n⏳ 排队中 (${queued.length})`);
    for (const a of queued) {
      lines.push(`  • ${a.actor_name ?? a.actor_id} → ${a.project_alias}`);
    }
  }

  return lines.join('\n');
}

export function formatOverlapAlerts(alerts: OverlapAlert[]): string {
  if (alerts.length === 0) return '';

  const lines = ['⚠️ 协作提醒：'];
  for (const alert of alerts) {
    lines.push(`  • ${alert.detail}`);
  }
  lines.push('建议先确认是否需要协调，避免冲突。');
  return lines.join('\n');
}

function formatElapsed(isoStart: string): string {
  const ms = Date.now() - new Date(isoStart).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}
