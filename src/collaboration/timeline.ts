/**
 * Direction 6: 上下文连续性 — Context Continuity
 *
 * Builds project timelines from audit/run/memory data and generates
 * onboarding context for new team members.
 */

import type { RunState } from '../state/run-state-store.js';
import type { MemoryRecord } from '../state/memory-store.js';
import type { AuditEvent } from '../state/audit-log.js';

export interface TimelineEvent {
  type: 'run_completed' | 'run_failed' | 'knowledge_added' | 'handoff' | 'config_change' | 'project_switch';
  at: string;
  actor_id?: string;
  project_alias: string;
  summary: string;
  detail?: string;
}

/**
 * Build a chronological timeline for a project from multiple data sources.
 */
export function buildProjectTimeline(
  runs: RunState[],
  memories: MemoryRecord[],
  auditEvents: AuditEvent[],
  projectAlias: string,
  limit: number = 30,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // Runs → timeline events
  for (const run of runs) {
    if (run.project_alias !== projectAlias) continue;

    if (run.status === 'success') {
      events.push({
        type: 'run_completed',
        at: run.finished_at ?? run.updated_at,
        actor_id: run.actor_id,
        project_alias: projectAlias,
        summary: `完成任务: "${truncate(run.prompt_excerpt, 60)}"`,
      });
    } else if (run.status === 'failure') {
      events.push({
        type: 'run_failed',
        at: run.finished_at ?? run.updated_at,
        actor_id: run.actor_id,
        project_alias: projectAlias,
        summary: `任务失败: "${truncate(run.prompt_excerpt, 60)}"`,
        detail: run.error,
      });
    }
  }

  // Memories → timeline events
  for (const mem of memories) {
    if (mem.project_alias !== projectAlias) continue;
    if (mem.archived_at) continue;

    events.push({
      type: 'knowledge_added',
      at: mem.created_at,
      actor_id: mem.created_by,
      project_alias: projectAlias,
      summary: `知识沉淀: ${mem.title}`,
      detail: truncate(mem.content, 100),
    });
  }

  // Audit events → timeline events (selective)
  for (const event of auditEvents) {
    if (event.type === 'project.selected') {
      events.push({
        type: 'project_switch',
        at: event.at,
        actor_id: event.actor_id as string | undefined,
        project_alias: projectAlias,
        summary: `切换到项目 ${event.alias as string ?? projectAlias}`,
      });
    }
  }

  // Sort by time descending, limit
  events.sort((a, b) => b.at.localeCompare(a.at));
  return events.slice(0, limit);
}

/**
 * Generate an onboarding context summary for a new team member.
 * This is injected into the AI prompt when a new actor_id appears.
 */
export function buildOnboardingContext(
  timeline: TimelineEvent[],
  memories: MemoryRecord[],
  projectAlias: string,
  maxChars: number = 1200,
): string {
  const parts: string[] = [];
  parts.push(`[项目 ${projectAlias} 历史上下文]`);

  // Key knowledge first
  const pinnedMemories = memories.filter((m) => m.pinned && !m.archived_at);
  if (pinnedMemories.length > 0) {
    parts.push('\n关键知识:');
    for (const mem of pinnedMemories.slice(0, 5)) {
      parts.push(`- ${mem.title}: ${truncate(mem.content, 80)}`);
    }
  }

  // Recent activity summary
  const recentRuns = timeline
    .filter((e) => e.type === 'run_completed' || e.type === 'run_failed')
    .slice(0, 5);

  if (recentRuns.length > 0) {
    parts.push('\n近期活动:');
    for (const event of recentRuns) {
      const actor = event.actor_id ? `${event.actor_id}: ` : '';
      parts.push(`- ${actor}${event.summary}`);
    }
  }

  // Recent knowledge additions
  const recentKnowledge = timeline
    .filter((e) => e.type === 'knowledge_added')
    .slice(0, 3);

  if (recentKnowledge.length > 0) {
    parts.push('\n近期沉淀:');
    for (const event of recentKnowledge) {
      parts.push(`- ${event.summary}`);
    }
  }

  let result = parts.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 3) + '...';
  }

  return result;
}

export function formatTimeline(events: TimelineEvent[]): string {
  if (events.length === 0) {
    return '该项目暂无活动记录。';
  }

  const lines: string[] = ['📅 项目时间线\n'];

  let lastDate = '';
  for (const event of events) {
    const date = event.at.slice(0, 10);
    if (date !== lastDate) {
      lines.push(`\n── ${date} ──`);
      lastDate = date;
    }

    const time = event.at.slice(11, 16);
    const icon = EVENT_ICONS[event.type] ?? '•';
    const actor = event.actor_id ? ` [${event.actor_id}]` : '';

    lines.push(`  ${time} ${icon}${actor} ${event.summary}`);
    if (event.detail) {
      lines.push(`         ${truncate(event.detail, 80)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Detect if an actor is new to a project (never seen in run history).
 */
export function isNewActor(actorId: string, runs: RunState[], projectAlias: string): boolean {
  return !runs.some(
    (r) => r.actor_id === actorId && r.project_alias === projectAlias,
  );
}

const EVENT_ICONS: Record<string, string> = {
  run_completed: '✅',
  run_failed: '❌',
  knowledge_added: '💡',
  handoff: '🤝',
  config_change: '⚙️',
  project_switch: '🔀',
};

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}
