import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStateStore } from '../src/state/run-state-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('run state store', () => {
  it('tracks active runs and recovers stale ones', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-runs-'));
    tempDirs.push(dir);
    const store = new RunStateStore(dir);

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
});
