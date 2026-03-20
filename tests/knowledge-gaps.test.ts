import { describe, expect, it } from 'vitest';
import { detectKnowledgeGaps, formatKnowledgeGaps } from '../src/collaboration/knowledge-gaps.js';
import type { RunState } from '../src/state/run-state-store.js';
import type { MemoryRecord } from '../src/state/memory-store.js';

function buildRun(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: `run-${Math.random().toString(36).slice(2, 8)}`,
    queue_key: 'qk', conversation_key: 'ck', project_alias: 'proj-a',
    chat_id: 'chat-1', actor_id: 'user-1', prompt_excerpt: 'do something',
    status: 'success', started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    scope: 'project', project_alias: 'proj-a', title: 'test', content: 'test',
    tags: [], source: 'manual', pinned: false, confidence: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('knowledge gap detection', () => {
  it('detects topics asked frequently with no knowledge', () => {
    const runs = [
      buildRun({ actor_id: 'alice', prompt_excerpt: '认证模块怎么配置' }),
      buildRun({ actor_id: 'bob', prompt_excerpt: '认证模块的配置方法' }),
      buildRun({ actor_id: 'alice', prompt_excerpt: '认证配置问题' }),
      buildRun({ actor_id: 'charlie', prompt_excerpt: '认证模块配置' }),
    ];

    const gaps = detectKnowledgeGaps(runs, [], 2);
    const authGap = gaps.find((g) => g.topic.includes('认证'));
    expect(authGap).toBeDefined();
    expect(authGap!.has_knowledge).toBe(false);
    expect(authGap!.frequency).toBeGreaterThanOrEqual(2);
  });

  it('flags topics with existing knowledge but still frequently asked', () => {
    const runs = [
      buildRun({ actor_id: 'alice', prompt_excerpt: 'Redis连接池配置' }),
      buildRun({ actor_id: 'bob', prompt_excerpt: 'Redis连接池怎么设置' }),
      buildRun({ actor_id: 'charlie', prompt_excerpt: 'Redis连接池问题' }),
      buildRun({ actor_id: 'dave', prompt_excerpt: 'Redis连接池配置方法' }),
    ];

    const knowledge = [
      buildMemory({ title: 'Redis连接池', content: '最大连接数设置为 50' }),
    ];

    const gaps = detectKnowledgeGaps(runs, knowledge, 2);
    const redisGap = gaps.find((g) => g.topic.toLowerCase().includes('redis'));
    expect(redisGap).toBeDefined();
    expect(redisGap!.has_knowledge).toBe(true);
    expect(redisGap!.suggestion).toContain('更新或补充');
  });

  it('ignores infrequent topics', () => {
    const runs = [
      buildRun({ prompt_excerpt: 'some unique question about quantum physics' }),
    ];
    const gaps = detectKnowledgeGaps(runs, [], 3);
    expect(gaps).toHaveLength(0);
  });

  it('filters by time window', () => {
    const oldRun = buildRun({
      actor_id: 'alice',
      prompt_excerpt: '部署流程是什么',
      started_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(), // 30 days ago
    });
    const recentRun = buildRun({
      actor_id: 'bob',
      prompt_excerpt: '部署流程是什么',
    });

    const gaps = detectKnowledgeGaps([oldRun, recentRun], [], 2, 168);
    // Only 1 recent run, which is below minFrequency=2
    const deployGap = gaps.find((g) => g.topic.includes('部署'));
    expect(deployGap).toBeUndefined();
  });

  it('ignores archived knowledge', () => {
    const runs = [
      buildRun({ actor_id: 'alice', prompt_excerpt: 'database migration steps' }),
      buildRun({ actor_id: 'bob', prompt_excerpt: 'database migration process' }),
      buildRun({ actor_id: 'charlie', prompt_excerpt: 'database migration guide' }),
    ];

    const archivedKnowledge = [
      buildMemory({ title: 'Database migration', content: 'Run migrate.sh', archived_at: new Date().toISOString() }),
    ];

    const gaps = detectKnowledgeGaps(runs, archivedKnowledge, 2);
    const dbGap = gaps.find((g) => g.topic.includes('database') || g.topic.includes('migration'));
    if (dbGap) {
      expect(dbGap.has_knowledge).toBe(false);
    }
  });

  it('limits output to 10 gaps', () => {
    // Create many different topics
    const runs: RunState[] = [];
    for (let i = 0; i < 15; i++) {
      const topic = `topic${String(i).padStart(3, '0')}`;
      runs.push(
        buildRun({ actor_id: 'alice', prompt_excerpt: `${topic} question one` }),
        buildRun({ actor_id: 'bob', prompt_excerpt: `${topic} question two` }),
        buildRun({ actor_id: 'charlie', prompt_excerpt: `${topic} question three` }),
      );
    }
    const gaps = detectKnowledgeGaps(runs, [], 2);
    expect(gaps.length).toBeLessThanOrEqual(10);
  });
});

describe('formatKnowledgeGaps', () => {
  it('shows empty message when no gaps', () => {
    const text = formatKnowledgeGaps([]);
    expect(text).toContain('未发现明显缺口');
  });

  it('shows sections for missing and needs-update', () => {
    const gaps = [
      { topic: '认证', frequency: 5, actors: ['a', 'b'], projects: ['p1'], has_knowledge: false, knowledge_count: 0, suggestion: 'save it' },
      { topic: 'Redis', frequency: 4, actors: ['a', 'c'], projects: ['p1'], has_knowledge: true, knowledge_count: 1, suggestion: 'update it' },
    ];
    const text = formatKnowledgeGaps(gaps);
    expect(text).toContain('缺失知识');
    expect(text).toContain('需要补充');
    expect(text).toContain('认证');
    expect(text).toContain('Redis');
    expect(text).toContain('/learn');
  });
});
