/**
 * Direction 4: 瓶颈诊断与效率体检 — Bottleneck Diagnostics
 *
 * Analyzes audit logs and run history to detect patterns:
 * retry loops, duplicate work, queue bottlenecks, error clusters.
 */

import type { RunState } from '../state/run-state-store.js';
import type { AuditEvent } from '../state/audit-log.js';

export type InsightSeverity = 'info' | 'warning' | 'critical';
export type InsightKind =
  | 'retry_pattern'
  | 'duplicate_work'
  | 'queue_bottleneck'
  | 'error_cluster'
  | 'long_running'
  | 'idle_project';

export interface TeamInsight {
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  detail: string;
  affected_projects: string[];
  affected_actors: string[];
  suggestion: string;
}

/**
 * Run all analysis passes on recent run data.
 */
export function analyzeTeamHealth(runs: RunState[], auditEvents: AuditEvent[]): TeamInsight[] {
  const insights: TeamInsight[] = [];
  insights.push(...detectRetryPatterns(runs));
  insights.push(...detectDuplicateWork(runs));
  insights.push(...detectQueueBottlenecks(runs));
  insights.push(...detectErrorClusters(runs));
  insights.push(...detectLongRunning(runs));

  // Sort: critical first, then warning, then info
  const order: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };
  insights.sort((a, b) => order[a.severity] - order[b.severity]);

  return insights;
}

/**
 * Detect actors who start multiple sessions on the same project in a short window.
 * This suggests the AI is not being effective and the person is retrying.
 */
function detectRetryPatterns(runs: RunState[]): TeamInsight[] {
  const insights: TeamInsight[] = [];
  const byActorProject = groupBy(runs, (r) => `${r.actor_id}::${r.project_alias}`);

  for (const [key, group] of Object.entries(byActorProject)) {
    const recent = group.filter((r) => isWithinHours(r.started_at, 4));
    const failures = recent.filter((r) => r.status === 'failure');

    if (recent.length >= 4 && failures.length >= 2) {
      const parts = key.split('::');
      const actorId = parts[0] ?? 'unknown';
      const projectAlias = parts[1] ?? 'unknown';
      insights.push({
        kind: 'retry_pattern',
        severity: 'warning',
        title: `${actorId} 在 ${projectAlias} 上反复重试`,
        detail: `过去 4 小时内发起 ${recent.length} 次运行，其中 ${failures.length} 次失败`,
        affected_projects: [projectAlias],
        affected_actors: [actorId],
        suggestion: '可能需要换个思路，或者寻求团队协助',
      });
    }
  }

  return insights;
}

/**
 * Detect similar prompts from different actors on the same project.
 */
function detectDuplicateWork(runs: RunState[]): TeamInsight[] {
  const insights: TeamInsight[] = [];
  const recentRuns = runs.filter((r) => isWithinHours(r.started_at, 24));

  // Group by project, then compare prompts across actors
  const byProject = groupBy(recentRuns, (r) => r.project_alias);

  for (const [project, group] of Object.entries(byProject)) {
    const byActor = groupBy(group, (r) => r.actor_id ?? 'unknown');
    const actors = Object.keys(byActor);

    if (actors.length < 2) continue;

    // Compare prompt excerpts between actors (simple overlap check)
    for (let i = 0; i < actors.length; i++) {
      for (let j = i + 1; j < actors.length; j++) {
        const actorA = actors[i]!;
        const actorB = actors[j]!;
        const groupA = byActor[actorA];
        const groupB = byActor[actorB];
        if (!groupA || !groupB) continue;
        const promptsA = groupA.map((r) => r.prompt_excerpt).filter(Boolean) as string[];
        const promptsB = groupB.map((r) => r.prompt_excerpt).filter(Boolean) as string[];

        const similar = findSimilarPrompts(promptsA, promptsB);
        if (similar.length > 0) {
          insights.push({
            kind: 'duplicate_work',
            severity: 'info',
            title: `${actorA} 和 ${actorB} 在 ${project} 上可能有重复工作`,
            detail: `发现 ${similar.length} 组相似的提问`,
            affected_projects: [project],
            affected_actors: [actorA, actorB],
            suggestion: '建议沟通确认是否在做相同的事，避免重复劳动',
          });
        }
      }
    }
  }

  return insights;
}

/**
 * Detect projects where queuing happens frequently.
 */
function detectQueueBottlenecks(runs: RunState[]): TeamInsight[] {
  const insights: TeamInsight[] = [];
  const recentRuns = runs.filter((r) => isWithinHours(r.started_at, 24));
  const byProject = groupBy(recentRuns, (r) => r.project_alias);

  for (const [project, group] of Object.entries(byProject)) {
    const queuedRuns = group.filter((r) => r.status === 'queued' || r.status_detail?.includes('queued'));
    if (queuedRuns.length >= 3) {
      const actors = [...new Set(group.map((r) => r.actor_id).filter(Boolean))] as string[];
      insights.push({
        kind: 'queue_bottleneck',
        severity: queuedRuns.length >= 5 ? 'warning' : 'info',
        title: `${project} 频繁出现排队`,
        detail: `过去 24 小时有 ${queuedRuns.length} 次排队，${actors.length} 位成员受影响`,
        affected_projects: [project],
        affected_actors: actors,
        suggestion: '考虑增加并发处理能力或拆分项目粒度',
      });
    }
  }

  return insights;
}

/**
 * Detect projects with high failure rates.
 */
function detectErrorClusters(runs: RunState[]): TeamInsight[] {
  const insights: TeamInsight[] = [];
  const recentRuns = runs.filter((r) => isWithinHours(r.started_at, 24));
  const byProject = groupBy(recentRuns, (r) => r.project_alias);

  for (const [project, group] of Object.entries(byProject)) {
    const total = group.length;
    const failures = group.filter((r) => r.status === 'failure');
    const failureRate = total > 0 ? failures.length / total : 0;

    if (failures.length >= 3 && failureRate > 0.4) {
      const actors = [...new Set(failures.map((r) => r.actor_id).filter(Boolean))] as string[];
      const severity: InsightSeverity = failureRate > 0.7 ? 'critical' : 'warning';

      insights.push({
        kind: 'error_cluster',
        severity,
        title: `${project} 失败率异常 (${Math.round(failureRate * 100)}%)`,
        detail: `过去 24 小时 ${total} 次运行中 ${failures.length} 次失败`,
        affected_projects: [project],
        affected_actors: actors,
        suggestion: '检查项目配置或底层依赖是否有问题',
      });
    }
  }

  return insights;
}

/**
 * Detect runs that are taking unusually long.
 */
function detectLongRunning(runs: RunState[]): TeamInsight[] {
  const insights: TeamInsight[] = [];
  const activeRuns = runs.filter((r) => r.status === 'running');

  for (const run of activeRuns) {
    const elapsed = Date.now() - new Date(run.started_at).getTime();
    const minutes = elapsed / 60_000;

    if (minutes > 20) {
      insights.push({
        kind: 'long_running',
        severity: minutes > 45 ? 'warning' : 'info',
        title: `${run.project_alias} 有运行超过 ${Math.round(minutes)} 分钟的任务`,
        detail: `run ${run.run_id.slice(0, 8)} by ${run.actor_id ?? 'unknown'}`,
        affected_projects: [run.project_alias],
        affected_actors: run.actor_id ? [run.actor_id] : [],
        suggestion: '考虑检查任务是否卡住，或取消后重新拆解',
      });
    }
  }

  return insights;
}

export function formatInsightsReport(insights: TeamInsight[]): string {
  if (insights.length === 0) {
    return '🏥 团队 AI 协作体检: 一切正常，未发现明显瓶颈。';
  }

  const lines: string[] = ['🏥 团队 AI 协作体检报告\n'];

  const criticals = insights.filter((i) => i.severity === 'critical');
  const warnings = insights.filter((i) => i.severity === 'warning');
  const infos = insights.filter((i) => i.severity === 'info');

  if (criticals.length > 0) {
    lines.push(`🔴 严重问题 (${criticals.length})`);
    for (const i of criticals) {
      lines.push(`  ${i.title}`);
      lines.push(`    ${i.detail}`);
      lines.push(`    💡 ${i.suggestion}`);
    }
  }

  if (warnings.length > 0) {
    lines.push(`\n🟡 需要关注 (${warnings.length})`);
    for (const i of warnings) {
      lines.push(`  ${i.title}`);
      lines.push(`    ${i.detail}`);
      lines.push(`    💡 ${i.suggestion}`);
    }
  }

  if (infos.length > 0) {
    lines.push(`\n🔵 参考信息 (${infos.length})`);
    for (const i of infos) {
      lines.push(`  ${i.title}`);
      lines.push(`    ${i.detail}`);
    }
  }

  return lines.join('\n');
}

// --- Utility functions ---

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    (result[key] ??= []).push(item);
  }
  return result;
}

function isWithinHours(isoDate: string, hours: number): boolean {
  const ms = Date.now() - new Date(isoDate).getTime();
  return ms < hours * 3600_000;
}

/**
 * Simple similarity check: find prompts with significant word overlap.
 */
function findSimilarPrompts(promptsA: string[], promptsB: string[]): Array<[string, string]> {
  const similar: Array<[string, string]> = [];

  for (const a of promptsA) {
    for (const b of promptsB) {
      if (computeWordOverlap(a, b) > 0.5) {
        similar.push([a, b]);
      }
    }
  }

  return similar;
}

function computeWordOverlap(a: string, b: string): number {
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  return intersection / Math.min(wordsA.size, wordsB.size);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}
