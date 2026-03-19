import { describe, expect, it } from 'vitest';
import type { RunState } from '../src/state/run-state-store.js';
import type { MemoryRecord } from '../src/state/memory-store.js';
import type { AuditEvent } from '../src/state/audit-log.js';
import {
  buildProjectTimeline,
  buildOnboardingContext,
  isNewActor,
  formatTimeline,
} from '../src/collaboration/timeline.js';

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

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    scope: 'project',
    project_alias: 'proj-a',
    title: 'Test memory',
    content: 'Some content',
    tags: ['test'],
    source: 'manual',
    pinned: false,
    confidence: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildProjectTimeline', () => {
  it('returns empty array for no matching data', () => {
    const events = buildProjectTimeline([], [], [], 'proj-a');
    expect(events).toEqual([]);
  });

  it('includes successful runs as run_completed events', () => {
    const runs: RunState[] = [
      makeRun({ run_id: 'r1', status: 'success', project_alias: 'proj-a', prompt_excerpt: 'deploy app', updated_at: '2025-06-01T10:00:00.000Z' }),
    ];
    const events = buildProjectTimeline(runs, [], [], 'proj-a');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('run_completed');
    expect(events[0]!.summary).toContain('deploy app');
  });

  it('includes failed runs as run_failed events', () => {
    const runs: RunState[] = [
      makeRun({
        run_id: 'r1',
        status: 'failure',
        project_alias: 'proj-a',
        prompt_excerpt: 'build project',
        error: 'compilation error',
        updated_at: '2025-06-01T10:00:00.000Z',
      }),
    ];
    const events = buildProjectTimeline(runs, [], [], 'proj-a');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('run_failed');
    expect(events[0]!.summary).toContain('build project');
    expect(events[0]!.detail).toBe('compilation error');
  });

  it('ignores runs from other projects', () => {
    const runs: RunState[] = [
      makeRun({ run_id: 'r1', status: 'success', project_alias: 'proj-b' }),
    ];
    const events = buildProjectTimeline(runs, [], [], 'proj-a');
    expect(events).toHaveLength(0);
  });

  it('ignores runs that are still running', () => {
    const runs: RunState[] = [
      makeRun({ run_id: 'r1', status: 'running', project_alias: 'proj-a' }),
    ];
    const events = buildProjectTimeline(runs, [], [], 'proj-a');
    expect(events).toHaveLength(0);
  });

  it('includes memories as knowledge_added events', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ id: 'mem-1', project_alias: 'proj-a', title: 'Deploy guide', content: 'Always run tests first' }),
    ];
    const events = buildProjectTimeline([], memories, [], 'proj-a');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('knowledge_added');
    expect(events[0]!.summary).toContain('Deploy guide');
  });

  it('ignores archived memories', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ id: 'mem-1', project_alias: 'proj-a', archived_at: new Date().toISOString() }),
    ];
    const events = buildProjectTimeline([], memories, [], 'proj-a');
    expect(events).toHaveLength(0);
  });

  it('includes project.selected audit events', () => {
    const auditEvents: AuditEvent[] = [
      { type: 'project.selected', at: '2025-06-01T10:00:00.000Z', actor_id: 'alice', alias: 'proj-a' },
    ];
    const events = buildProjectTimeline([], [], auditEvents, 'proj-a');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('project_switch');
  });

  it('ignores unrelated audit events', () => {
    const auditEvents: AuditEvent[] = [
      { type: 'message.received', at: '2025-06-01T10:00:00.000Z' },
    ];
    const events = buildProjectTimeline([], [], auditEvents, 'proj-a');
    expect(events).toHaveLength(0);
  });

  it('sorts events by time descending', () => {
    const runs: RunState[] = [
      makeRun({ run_id: 'r1', status: 'success', project_alias: 'proj-a', updated_at: '2025-06-01T08:00:00.000Z' }),
      makeRun({ run_id: 'r2', status: 'success', project_alias: 'proj-a', updated_at: '2025-06-01T12:00:00.000Z' }),
    ];
    const events = buildProjectTimeline(runs, [], [], 'proj-a');
    expect(events).toHaveLength(2);
    expect(events[0]!.at).toBe('2025-06-01T12:00:00.000Z');
    expect(events[1]!.at).toBe('2025-06-01T08:00:00.000Z');
  });

  it('respects the limit parameter', () => {
    const runs: RunState[] = [];
    for (let i = 0; i < 10; i++) {
      runs.push(
        makeRun({
          run_id: `r${i}`,
          status: 'success',
          project_alias: 'proj-a',
          updated_at: `2025-06-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
        }),
      );
    }
    const events = buildProjectTimeline(runs, [], [], 'proj-a', 5);
    expect(events).toHaveLength(5);
  });

  it('uses finished_at when available for runs', () => {
    const runs: RunState[] = [
      makeRun({
        run_id: 'r1',
        status: 'success',
        project_alias: 'proj-a',
        finished_at: '2025-06-01T15:00:00.000Z',
        updated_at: '2025-06-01T10:00:00.000Z',
      }),
    ];
    const events = buildProjectTimeline(runs, [], [], 'proj-a');
    expect(events[0]!.at).toBe('2025-06-01T15:00:00.000Z');
  });
});

describe('buildOnboardingContext', () => {
  it('includes project alias header', () => {
    const result = buildOnboardingContext([], [], 'proj-a');
    expect(result).toContain('[项目 proj-a 历史上下文]');
  });

  it('includes pinned memories as key knowledge', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ pinned: true, title: 'Important rule', content: 'Never deploy on Friday' }),
      makeMemory({ pinned: false, title: 'Unimportant note', content: 'Random info' }),
    ];
    const result = buildOnboardingContext([], memories, 'proj-a');
    expect(result).toContain('关键知识');
    expect(result).toContain('Important rule');
    expect(result).not.toContain('Unimportant note');
  });

  it('excludes archived pinned memories', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ pinned: true, title: 'Archived rule', archived_at: new Date().toISOString() }),
    ];
    const result = buildOnboardingContext([], memories, 'proj-a');
    expect(result).not.toContain('Archived rule');
  });

  it('includes recent activity from timeline', () => {
    const timeline = [
      {
        type: 'run_completed' as const,
        at: '2025-06-01T10:00:00.000Z',
        actor_id: 'alice',
        project_alias: 'proj-a',
        summary: 'Completed: deployed the app',
      },
    ];
    const result = buildOnboardingContext(timeline, [], 'proj-a');
    expect(result).toContain('近期活动');
    expect(result).toContain('alice');
    expect(result).toContain('deployed the app');
  });

  it('includes recent knowledge additions', () => {
    const timeline = [
      {
        type: 'knowledge_added' as const,
        at: '2025-06-01T10:00:00.000Z',
        project_alias: 'proj-a',
        summary: 'Knowledge: deploy process docs',
      },
    ];
    const result = buildOnboardingContext(timeline, [], 'proj-a');
    expect(result).toContain('近期沉淀');
    expect(result).toContain('deploy process docs');
  });

  it('truncates to maxChars limit', () => {
    const memories: MemoryRecord[] = [];
    for (let i = 0; i < 20; i++) {
      memories.push(makeMemory({ pinned: true, title: `Rule ${i}`, content: 'x'.repeat(100) }));
    }
    const result = buildOnboardingContext([], memories, 'proj-a', 200);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toMatch(/\.\.\.$/);
  });
});

describe('isNewActor', () => {
  it('returns true when actor has no runs for the project', () => {
    const runs: RunState[] = [
      makeRun({ actor_id: 'bob', project_alias: 'proj-a' }),
    ];
    expect(isNewActor('alice', runs, 'proj-a')).toBe(true);
  });

  it('returns false when actor has runs for the project', () => {
    const runs: RunState[] = [
      makeRun({ actor_id: 'alice', project_alias: 'proj-a' }),
    ];
    expect(isNewActor('alice', runs, 'proj-a')).toBe(false);
  });

  it('returns true when actor has runs for different project', () => {
    const runs: RunState[] = [
      makeRun({ actor_id: 'alice', project_alias: 'proj-b' }),
    ];
    expect(isNewActor('alice', runs, 'proj-a')).toBe(true);
  });

  it('returns true for empty runs', () => {
    expect(isNewActor('alice', [], 'proj-a')).toBe(true);
  });
});

describe('formatTimeline', () => {
  it('returns placeholder for empty events', () => {
    const result = formatTimeline([]);
    expect(result).toContain('暂无活动记录');
  });

  it('formats events with date headers and icons', () => {
    const events = [
      {
        type: 'run_completed' as const,
        at: '2025-06-01T10:30:00.000Z',
        actor_id: 'alice',
        project_alias: 'proj-a',
        summary: 'Deployed the app',
      },
      {
        type: 'run_failed' as const,
        at: '2025-06-01T09:00:00.000Z',
        actor_id: 'bob',
        project_alias: 'proj-a',
        summary: 'Build failed',
        detail: 'type error in main.ts',
      },
    ];
    const result = formatTimeline(events);
    expect(result).toContain('项目时间线');
    expect(result).toContain('2025-06-01');
    expect(result).toContain('10:30');
    expect(result).toContain('[alice]');
    expect(result).toContain('Deployed the app');
    expect(result).toContain('09:00');
    expect(result).toContain('[bob]');
    expect(result).toContain('Build failed');
    expect(result).toContain('type error in main.ts');
  });

  it('groups events by date', () => {
    const events = [
      {
        type: 'run_completed' as const,
        at: '2025-06-02T10:00:00.000Z',
        project_alias: 'proj-a',
        summary: 'Day 2 event',
      },
      {
        type: 'run_completed' as const,
        at: '2025-06-01T10:00:00.000Z',
        project_alias: 'proj-a',
        summary: 'Day 1 event',
      },
    ];
    const result = formatTimeline(events);
    expect(result).toContain('2025-06-02');
    expect(result).toContain('2025-06-01');
  });

  it('omits actor when not present', () => {
    const events = [
      {
        type: 'knowledge_added' as const,
        at: '2025-06-01T10:00:00.000Z',
        project_alias: 'proj-a',
        summary: 'Added knowledge',
      },
    ];
    const result = formatTimeline(events);
    expect(result).not.toContain('[]');
    expect(result).toContain('Added knowledge');
  });
});
