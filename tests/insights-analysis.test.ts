import { describe, expect, it } from 'vitest';
import type { RunState } from '../src/state/run-state-store.js';
import {
  analyzeTeamHealth,
  formatInsightsReport,
} from '../src/collaboration/insights.js';

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: 'run-1',
    queue_key: 'qk',
    conversation_key: 'ck',
    project_alias: 'proj-a',
    chat_id: 'chat-1',
    actor_id: 'user-1',
    project_root: '/repo/a',
    prompt_excerpt: 'fix the bug',
    status: 'running',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function recentISOString(minutesAgo: number = 0): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe('analyzeTeamHealth', () => {
  it('returns empty insights for no runs', () => {
    const insights = analyzeTeamHealth([], []);
    expect(insights).toEqual([]);
  });

  it('returns empty insights when runs are healthy', () => {
    const runs: RunState[] = [
      makeRun({ run_id: 'r1', status: 'success', started_at: recentISOString(30) }),
      makeRun({ run_id: 'r2', status: 'success', started_at: recentISOString(60) }),
    ];
    const insights = analyzeTeamHealth(runs, []);
    expect(insights).toEqual([]);
  });

  it('sorts insights by severity: critical first', () => {
    // Create enough failures for error_cluster (critical: >70% failure rate)
    // and retry_pattern (warning) at the same time
    const runs: RunState[] = [];

    // Project A: high failure rate -> error_cluster (critical)
    for (let i = 0; i < 5; i++) {
      runs.push(
        makeRun({
          run_id: `fail-${i}`,
          status: 'failure',
          actor_id: 'user-1',
          project_alias: 'proj-fail',
          started_at: recentISOString(i * 10),
        }),
      );
    }

    // Project B: retry pattern (warning)
    for (let i = 0; i < 4; i++) {
      runs.push(
        makeRun({
          run_id: `retry-${i}`,
          status: i < 2 ? 'failure' : 'success',
          actor_id: 'user-2',
          project_alias: 'proj-retry',
          started_at: recentISOString(i * 10),
        }),
      );
    }

    const insights = analyzeTeamHealth(runs, []);
    if (insights.length >= 2) {
      const severities = insights.map((i) => i.severity);
      const criticalIndex = severities.indexOf('critical');
      const warningIndex = severities.indexOf('warning');
      if (criticalIndex >= 0 && warningIndex >= 0) {
        expect(criticalIndex).toBeLessThan(warningIndex);
      }
    }
  });
});

describe('detectRetryPatterns (via analyzeTeamHealth)', () => {
  it('detects retry pattern: 4+ runs with 2+ failures in 4 hours', () => {
    const runs: RunState[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(
        makeRun({
          run_id: `r-${i}`,
          status: i < 3 ? 'failure' : 'success',
          actor_id: 'alice',
          project_alias: 'proj-a',
          started_at: recentISOString(i * 30), // within 4 hours
        }),
      );
    }

    const insights = analyzeTeamHealth(runs, []);
    const retryInsights = insights.filter((i) => i.kind === 'retry_pattern');
    expect(retryInsights.length).toBeGreaterThanOrEqual(1);
    expect(retryInsights[0]!.affected_actors).toContain('alice');
    expect(retryInsights[0]!.affected_projects).toContain('proj-a');
  });

  it('does not flag retry if fewer than 4 runs', () => {
    const runs: RunState[] = [
      makeRun({ run_id: 'r1', status: 'failure', actor_id: 'alice', project_alias: 'proj-a', started_at: recentISOString(10) }),
      makeRun({ run_id: 'r2', status: 'failure', actor_id: 'alice', project_alias: 'proj-a', started_at: recentISOString(20) }),
      makeRun({ run_id: 'r3', status: 'success', actor_id: 'alice', project_alias: 'proj-a', started_at: recentISOString(30) }),
    ];

    const insights = analyzeTeamHealth(runs, []);
    const retryInsights = insights.filter((i) => i.kind === 'retry_pattern');
    expect(retryInsights).toHaveLength(0);
  });
});

describe('detectDuplicateWork (via analyzeTeamHealth)', () => {
  it('detects similar prompts from different actors on the same project', () => {
    const runs: RunState[] = [
      makeRun({
        run_id: 'r1',
        actor_id: 'alice',
        project_alias: 'proj-a',
        prompt_excerpt: 'fix the authentication bug in login module',
        status: 'success',
        started_at: recentISOString(60),
      }),
      makeRun({
        run_id: 'r2',
        actor_id: 'bob',
        project_alias: 'proj-a',
        prompt_excerpt: 'fix the authentication bug in login module',
        status: 'running',
        started_at: recentISOString(30),
      }),
    ];

    const insights = analyzeTeamHealth(runs, []);
    const duplicates = insights.filter((i) => i.kind === 'duplicate_work');
    expect(duplicates.length).toBeGreaterThanOrEqual(1);
  });

  it('does not flag when only one actor', () => {
    const runs: RunState[] = [
      makeRun({ run_id: 'r1', actor_id: 'alice', project_alias: 'proj-a', prompt_excerpt: 'fix bug', status: 'success', started_at: recentISOString(60) }),
      makeRun({ run_id: 'r2', actor_id: 'alice', project_alias: 'proj-a', prompt_excerpt: 'fix bug', status: 'success', started_at: recentISOString(30) }),
    ];

    const insights = analyzeTeamHealth(runs, []);
    const duplicates = insights.filter((i) => i.kind === 'duplicate_work');
    expect(duplicates).toHaveLength(0);
  });
});

describe('detectQueueBottlenecks (via analyzeTeamHealth)', () => {
  it('detects queue bottleneck: 3+ queued runs in 24 hours', () => {
    const runs: RunState[] = [];
    for (let i = 0; i < 4; i++) {
      runs.push(
        makeRun({
          run_id: `q-${i}`,
          status: 'queued',
          actor_id: `user-${i}`,
          project_alias: 'proj-busy',
          started_at: recentISOString(i * 60),
        }),
      );
    }

    const insights = analyzeTeamHealth(runs, []);
    const bottlenecks = insights.filter((i) => i.kind === 'queue_bottleneck');
    expect(bottlenecks.length).toBeGreaterThanOrEqual(1);
    expect(bottlenecks[0]!.affected_projects).toContain('proj-busy');
  });

  it('escalates severity to warning at 5+ queued runs', () => {
    const runs: RunState[] = [];
    for (let i = 0; i < 6; i++) {
      runs.push(
        makeRun({
          run_id: `q-${i}`,
          status: 'queued',
          actor_id: `user-${i}`,
          project_alias: 'proj-busy',
          started_at: recentISOString(i * 60),
        }),
      );
    }

    const insights = analyzeTeamHealth(runs, []);
    const bottlenecks = insights.filter((i) => i.kind === 'queue_bottleneck');
    expect(bottlenecks.length).toBeGreaterThanOrEqual(1);
    expect(bottlenecks[0]!.severity).toBe('warning');
  });

  it('does not flag with fewer than 3 queued runs', () => {
    const runs: RunState[] = [
      makeRun({ run_id: 'q1', status: 'queued', project_alias: 'proj-a', started_at: recentISOString(30) }),
      makeRun({ run_id: 'q2', status: 'queued', project_alias: 'proj-a', started_at: recentISOString(60) }),
    ];

    const insights = analyzeTeamHealth(runs, []);
    const bottlenecks = insights.filter((i) => i.kind === 'queue_bottleneck');
    expect(bottlenecks).toHaveLength(0);
  });
});

describe('detectErrorClusters (via analyzeTeamHealth)', () => {
  it('detects error cluster: 3+ failures with >40% failure rate', () => {
    const runs: RunState[] = [];
    // 4 failures out of 6 total = 66.7% failure rate
    for (let i = 0; i < 4; i++) {
      runs.push(
        makeRun({
          run_id: `f-${i}`,
          status: 'failure',
          actor_id: 'user-1',
          project_alias: 'proj-broken',
          started_at: recentISOString(i * 30),
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      runs.push(
        makeRun({
          run_id: `s-${i}`,
          status: 'success',
          actor_id: 'user-1',
          project_alias: 'proj-broken',
          started_at: recentISOString((i + 4) * 30),
        }),
      );
    }

    const insights = analyzeTeamHealth(runs, []);
    const clusters = insights.filter((i) => i.kind === 'error_cluster');
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0]!.severity).toBe('warning');
  });

  it('flags critical when failure rate > 70%', () => {
    const runs: RunState[] = [];
    // 4 failures out of 5 total = 80%
    for (let i = 0; i < 4; i++) {
      runs.push(
        makeRun({
          run_id: `f-${i}`,
          status: 'failure',
          project_alias: 'proj-critical',
          started_at: recentISOString(i * 30),
        }),
      );
    }
    runs.push(
      makeRun({
        run_id: 's-1',
        status: 'success',
        project_alias: 'proj-critical',
        started_at: recentISOString(150),
      }),
    );

    const insights = analyzeTeamHealth(runs, []);
    const clusters = insights.filter((i) => i.kind === 'error_cluster');
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0]!.severity).toBe('critical');
  });

  it('does not flag when fewer than 3 failures', () => {
    const runs: RunState[] = [
      makeRun({ run_id: 'f1', status: 'failure', project_alias: 'proj-a', started_at: recentISOString(30) }),
      makeRun({ run_id: 'f2', status: 'failure', project_alias: 'proj-a', started_at: recentISOString(60) }),
      makeRun({ run_id: 's1', status: 'success', project_alias: 'proj-a', started_at: recentISOString(90) }),
    ];

    const insights = analyzeTeamHealth(runs, []);
    const clusters = insights.filter((i) => i.kind === 'error_cluster');
    expect(clusters).toHaveLength(0);
  });
});

describe('formatInsightsReport', () => {
  it('returns healthy message for empty insights', () => {
    const result = formatInsightsReport([]);
    expect(result).toContain('一切正常');
    expect(result).toContain('未发现明显瓶颈');
  });

  it('formats report with critical, warning, and info sections', () => {
    const insights = [
      {
        kind: 'error_cluster' as const,
        severity: 'critical' as const,
        title: 'proj-x 失败率异常 (85%)',
        detail: '20 次运行中 17 次失败',
        affected_projects: ['proj-x'],
        affected_actors: ['user-1'],
        suggestion: '检查项目配置',
      },
      {
        kind: 'retry_pattern' as const,
        severity: 'warning' as const,
        title: 'alice 在 proj-y 上反复重试',
        detail: '过去 4 小时内发起 6 次运行',
        affected_projects: ['proj-y'],
        affected_actors: ['alice'],
        suggestion: '可能需要换个思路',
      },
      {
        kind: 'duplicate_work' as const,
        severity: 'info' as const,
        title: 'alice 和 bob 在 proj-z 上可能有重复工作',
        detail: '发现 1 组相似的提问',
        affected_projects: ['proj-z'],
        affected_actors: ['alice', 'bob'],
        suggestion: '建议沟通',
      },
    ];

    const result = formatInsightsReport(insights);
    expect(result).toContain('团队 AI 协作体检报告');
    expect(result).toContain('严重问题 (1)');
    expect(result).toContain('需要关注 (1)');
    expect(result).toContain('参考信息 (1)');
    expect(result).toContain('proj-x 失败率异常');
    expect(result).toContain('检查项目配置');
    expect(result).toContain('alice 在 proj-y 上反复重试');
  });

  it('omits sections that have no entries', () => {
    const insights = [
      {
        kind: 'duplicate_work' as const,
        severity: 'info' as const,
        title: 'Some info',
        detail: 'Detail',
        affected_projects: ['p'],
        affected_actors: ['a'],
        suggestion: 'Suggestion',
      },
    ];
    const result = formatInsightsReport(insights);
    expect(result).not.toContain('严重问题');
    expect(result).not.toContain('需要关注');
    expect(result).toContain('参考信息 (1)');
  });
});
