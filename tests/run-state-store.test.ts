import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStateStore } from '../src/state/run-state-store.js';

const stores: RunStateStore[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeStoreAsync(): Promise<{ store: RunStateStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-runs-'));
  tempDirs.push(dir);
  const store = new RunStateStore(dir);
  stores.push(store);
  return { store, dir };
}

describe('run state store', () => {
  it('tracks active runs and recovers stale ones', async () => {
    const { store } = await makeStoreAsync();

    await store.upsertRun('run-1', {
      queue_key: 'queue-a',
      conversation_key: 'conv-a',
      project_alias: 'repo-a',
      chat_id: 'chat-a',
      prompt_excerpt: 'hello',
      status: 'running',
      pid: 999999,
    });

    expect((await store.listActiveRuns()).map((run) => run.run_id)).toEqual(['run-1']);

    const recovered = await store.recoverOrphanedRuns();
    expect(recovered[0]?.status).toBe('stale');
    expect((await store.getRun('run-1'))?.status).toBe('stale');
  });

  it('keeps queued runs visible without marking them finished', async () => {
    const { store } = await makeStoreAsync();

    await store.upsertRun('run-running', {
      queue_key: 'queue-a',
      conversation_key: 'conv-a',
      project_alias: 'repo-a',
      chat_id: 'chat-a',
      project_root: '/tmp/repo-a',
      prompt_excerpt: 'running',
      status: 'running',
      pid: 999999,
    });
    await store.upsertRun('run-queued', {
      queue_key: 'queue-b',
      conversation_key: 'conv-b',
      project_alias: 'repo-a',
      chat_id: 'chat-b',
      project_root: '/tmp/repo-a',
      prompt_excerpt: 'queued',
      status: 'queued',
      status_detail: '当前仓库正在被其他会话操作，已进入排队。',
    });

    expect((await store.getRun('run-queued'))?.finished_at).toBeUndefined();
    expect((await store.listActiveRuns()).map((run) => run.run_id)).toEqual(['run-queued', 'run-running']);
    expect((await store.getLatestVisibleRun('queue-b'))?.run_id).toBe('run-queued');
    expect((await store.getExecutionRunByProjectRoot('/tmp/repo-a'))?.run_id).toBe('run-running');
  });

  it('marks queued runs stale during recovery because queue state cannot survive a restart', async () => {
    const { store } = await makeStoreAsync();

    await store.upsertRun('run-queued', {
      queue_key: 'queue-a',
      conversation_key: 'conv-a',
      project_alias: 'repo-a',
      chat_id: 'chat-a',
      prompt_excerpt: 'queued',
      status: 'queued',
      status_detail: '当前仓库正在被其他会话操作，已进入排队。',
    });

    const recovered = await store.recoverOrphanedRuns();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('stale');
    expect((await store.getRun('run-queued'))?.status).toBe('stale');
    expect(await store.listActiveRuns()).toEqual([]);
  });

  it('upsert updates existing run and preserves started_at', async () => {
    const { store } = await makeStoreAsync();

    const created = await store.upsertRun('run-u', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'p',
      chat_id: 'ch', prompt_excerpt: 'first', status: 'running',
    });
    const updated = await store.upsertRun('run-u', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'p',
      chat_id: 'ch', prompt_excerpt: 'first', status: 'success',
    });

    expect(updated.started_at).toBe(created.started_at);
    expect(updated.status).toBe('success');
    expect(updated.finished_at).toBeDefined();
  });

  it('listRuns returns all runs ordered by updated_at descending', async () => {
    const { store } = await makeStoreAsync();

    await store.upsertRun('run-a', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'p',
      chat_id: 'ch', prompt_excerpt: 'a', status: 'success',
    });
    await store.upsertRun('run-b', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'p',
      chat_id: 'ch', prompt_excerpt: 'b', status: 'running',
    });

    const runs = await store.listRuns();
    expect(runs.map((r) => r.run_id)).toEqual(['run-b', 'run-a']);
  });

  it('getActiveRun returns running/orphaned run for queue key', async () => {
    const { store } = await makeStoreAsync();

    await store.upsertRun('run-done', {
      queue_key: 'q1', conversation_key: 'c', project_alias: 'p',
      chat_id: 'ch', prompt_excerpt: 'done', status: 'success',
    });
    await store.upsertRun('run-active', {
      queue_key: 'q1', conversation_key: 'c', project_alias: 'p',
      chat_id: 'ch', prompt_excerpt: 'active', status: 'running',
    });

    const active = await store.getActiveRun('q1');
    expect(active?.run_id).toBe('run-active');

    const none = await store.getActiveRun('nonexistent');
    expect(none).toBeNull();
  });

  it('getRun returns null for unknown run', async () => {
    const { store } = await makeStoreAsync();
    expect(await store.getRun('nope')).toBeNull();
  });

  it('creates runs.db file in the state directory', async () => {
    const { store, dir } = await makeStoreAsync();

    await store.upsertRun('run-x', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'p',
      chat_id: 'ch', prompt_excerpt: 'x', status: 'running',
    });

    const files = await fs.readdir(dir);
    expect(files.some((f) => f === 'runs.db')).toBe(true);
  });
});
