import { describe, expect, it } from 'vitest';
import type { RunState } from '../src/state/run-state-store.js';
import {
  buildTeamActivityView,
  detectOverlaps,
  formatTeamView,
  formatOverlapAlerts,
} from '../src/collaboration/awareness.js';

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

describe('buildTeamActivityView', () => {
  it('returns empty array when no runs', () => {
    expect(buildTeamActivityView([])).toEqual([]);
  });

  it('returns empty array when all runs are terminal', () => {
    const runs: RunState[] = [
      makeRun({ status: 'success' }),
      makeRun({ run_id: 'run-2', status: 'failure' }),
      makeRun({ run_id: 'run-3', status: 'cancelled' }),
    ];
    expect(buildTeamActivityView(runs)).toEqual([]);
  });

  it('includes only running and queued runs', () => {
    const runs: RunState[] = [
      makeRun({ run_id: 'run-1', status: 'running', actor_id: 'user-1' }),
      makeRun({ run_id: 'run-2', status: 'queued', actor_id: 'user-2' }),
      makeRun({ run_id: 'run-3', status: 'success', actor_id: 'user-3' }),
      makeRun({ run_id: 'run-4', status: 'failure', actor_id: 'user-4' }),
    ];
    const view = buildTeamActivityView(runs);
    expect(view).toHaveLength(2);
    expect(view.map((a) => a.run_id).sort()).toEqual(['run-1', 'run-2']);
  });

  it('sorts by updated_at descending', () => {
    const older = '2025-01-01T00:00:00.000Z';
    const newer = '2025-01-02T00:00:00.000Z';
    const runs: RunState[] = [
      makeRun({ run_id: 'run-old', status: 'running', updated_at: older }),
      makeRun({ run_id: 'run-new', status: 'running', updated_at: newer }),
    ];
    const view = buildTeamActivityView(runs);
    expect(view[0]!.run_id).toBe('run-new');
    expect(view[1]!.run_id).toBe('run-old');
  });

  it('maps fields correctly including prompt_excerpt', () => {
    const run = makeRun({
      run_id: 'run-1',
      status: 'running',
      actor_id: 'alice',
      chat_id: 'ch-1',
      project_alias: 'proj-x',
      project_root: '/repos/x',
      prompt_excerpt: 'deploy the app',
      started_at: '2025-06-01T10:00:00.000Z',
      updated_at: '2025-06-01T10:05:00.000Z',
    });
    const view = buildTeamActivityView([run]);
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({
      actor_id: 'alice',
      chat_id: 'ch-1',
      project_alias: 'proj-x',
      project_root: '/repos/x',
      status: 'running',
      run_id: 'run-1',
      prompt_excerpt: 'deploy the app',
    });
  });

  it('uses "unknown" for missing actor_id', () => {
    const run = makeRun({ actor_id: undefined });
    const view = buildTeamActivityView([run]);
    expect(view[0]!.actor_id).toBe('unknown');
  });
});

describe('detectOverlaps', () => {
  it('detects same_project overlap', () => {
    const incoming = { actor_id: 'user-2', project_alias: 'proj-a', project_root: '/repo/a' };
    const activeRuns: RunState[] = [
      makeRun({ run_id: 'run-1', actor_id: 'user-1', project_alias: 'proj-a', status: 'running' }),
    ];
    const alerts = detectOverlaps(incoming, activeRuns);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('same_project');
    expect(alerts[0]!.existing_actor_id).toBe('user-1');
    expect(alerts[0]!.existing_run_id).toBe('run-1');
  });

  it('detects same_root overlap when project_alias differs', () => {
    const incoming = { actor_id: 'user-2', project_alias: 'proj-b', project_root: '/repo/shared' };
    const activeRuns: RunState[] = [
      makeRun({
        run_id: 'run-1',
        actor_id: 'user-1',
        project_alias: 'proj-a',
        project_root: '/repo/shared',
        status: 'running',
      }),
    ];
    const alerts = detectOverlaps(incoming, activeRuns);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('same_root');
  });

  it('returns no overlap when different project and root', () => {
    const incoming = { actor_id: 'user-2', project_alias: 'proj-b', project_root: '/repo/b' };
    const activeRuns: RunState[] = [
      makeRun({ run_id: 'run-1', actor_id: 'user-1', project_alias: 'proj-a', project_root: '/repo/a', status: 'running' }),
    ];
    const alerts = detectOverlaps(incoming, activeRuns);
    expect(alerts).toHaveLength(0);
  });

  it('does not alert when actor is the same', () => {
    const incoming = { actor_id: 'user-1', project_alias: 'proj-a', project_root: '/repo/a' };
    const activeRuns: RunState[] = [
      makeRun({ run_id: 'run-1', actor_id: 'user-1', project_alias: 'proj-a', status: 'running' }),
    ];
    const alerts = detectOverlaps(incoming, activeRuns);
    expect(alerts).toHaveLength(0);
  });

  it('ignores non-active runs', () => {
    const incoming = { actor_id: 'user-2', project_alias: 'proj-a' };
    const activeRuns: RunState[] = [
      makeRun({ run_id: 'run-1', actor_id: 'user-1', project_alias: 'proj-a', status: 'success' }),
      makeRun({ run_id: 'run-2', actor_id: 'user-1', project_alias: 'proj-a', status: 'failure' }),
    ];
    const alerts = detectOverlaps(incoming, activeRuns);
    expect(alerts).toHaveLength(0);
  });
});

describe('formatTeamView', () => {
  it('returns placeholder for empty activities', () => {
    const result = formatTeamView([]);
    expect(result).toContain('没有活跃的团队成员');
  });

  it('groups running and queued activities', () => {
    const activities = buildTeamActivityView([
      makeRun({ run_id: 'r1', status: 'running', actor_id: 'alice', project_alias: 'proj-a', prompt_excerpt: 'fix bug' }),
      makeRun({ run_id: 'r2', status: 'queued', actor_id: 'bob', project_alias: 'proj-b' }),
    ]);
    const result = formatTeamView(activities);
    expect(result).toContain('执行中 (1)');
    expect(result).toContain('排队中 (1)');
    expect(result).toContain('alice');
    expect(result).toContain('bob');
  });

  it('includes prompt excerpt for running activities', () => {
    const activities = buildTeamActivityView([
      makeRun({ run_id: 'r1', status: 'running', actor_id: 'alice', prompt_excerpt: 'deploy the service' }),
    ]);
    const result = formatTeamView(activities);
    expect(result).toContain('deploy the service');
  });
});

describe('formatOverlapAlerts', () => {
  it('returns empty string for no alerts', () => {
    expect(formatOverlapAlerts([])).toBe('');
  });

  it('formats alerts with coordination suggestion', () => {
    const alerts = detectOverlaps(
      { actor_id: 'user-2', project_alias: 'proj-a' },
      [makeRun({ actor_id: 'user-1', project_alias: 'proj-a', status: 'running' })],
    );
    const result = formatOverlapAlerts(alerts);
    expect(result).toContain('协作提醒');
    expect(result).toContain('协调');
  });
});
