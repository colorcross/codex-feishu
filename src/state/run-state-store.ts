import path from 'node:path';
import { SerialExecutor } from '../utils/serial-executor.js';
import { ensureDir, fileExists, readUtf8, writeUtf8Atomic } from '../utils/fs.js';
import { isProcessAlive } from '../runtime/process.js';

export type RunStatus = 'running' | 'success' | 'failure' | 'cancelled' | 'stale' | 'orphaned';

export interface RunState {
  run_id: string;
  queue_key: string;
  conversation_key: string;
  project_alias: string;
  chat_id: string;
  actor_id?: string;
  session_id?: string;
  pid?: number;
  prompt_excerpt: string;
  status: RunStatus;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  error?: string;
}

interface RunStateFile {
  version: 1;
  runs: Record<string, RunState>;
}

const DEFAULT_STATE: RunStateFile = {
  version: 1,
  runs: {},
};

export class RunStateStore {
  private readonly filePath: string;
  private readonly serial = new SerialExecutor();

  public constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'runs.json');
  }

  public async upsertRun(
    runId: string,
    patch: Partial<RunState> & Pick<RunState, 'queue_key' | 'conversation_key' | 'project_alias' | 'chat_id' | 'prompt_excerpt' | 'status'>,
  ): Promise<RunState> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const existing = state.runs[runId];
      const now = new Date().toISOString();
      const next: RunState = {
        run_id: runId,
        queue_key: patch.queue_key,
        conversation_key: patch.conversation_key,
        project_alias: patch.project_alias,
        chat_id: patch.chat_id,
        prompt_excerpt: patch.prompt_excerpt,
        status: patch.status,
        started_at: existing?.started_at ?? now,
        updated_at: now,
        actor_id: patch.actor_id ?? existing?.actor_id,
        session_id: patch.session_id ?? existing?.session_id,
        pid: patch.pid ?? existing?.pid,
        finished_at: patch.finished_at ?? existing?.finished_at,
        error: patch.error ?? existing?.error,
      };
      if (next.status !== 'running') {
        next.finished_at = patch.finished_at ?? now;
      }
      state.runs[runId] = next;
      await this.writeState(state);
      return next;
    });
  }

  public async getRun(runId: string): Promise<RunState | null> {
    await this.serial.wait();
    const state = await this.readState();
    return state.runs[runId] ?? null;
  }

  public async listRuns(): Promise<RunState[]> {
    await this.serial.wait();
    const state = await this.readState();
    return Object.values(state.runs).sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  public async getActiveRun(queueKey: string): Promise<RunState | null> {
    await this.serial.wait();
    const state = await this.readState();
    const active = Object.values(state.runs)
      .filter((run) => run.queue_key === queueKey && (run.status === 'running' || run.status === 'orphaned'))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    return active ?? null;
  }

  public async listActiveRuns(): Promise<RunState[]> {
    await this.serial.wait();
    const state = await this.readState();
    return Object.values(state.runs)
      .filter((run) => run.status === 'running' || run.status === 'orphaned')
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  public async recoverOrphanedRuns(): Promise<RunState[]> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const recovered: RunState[] = [];
      const now = new Date().toISOString();

      for (const run of Object.values(state.runs)) {
        if (run.status !== 'running') {
          continue;
        }
        if (run.pid && isProcessAlive(run.pid)) {
          run.status = 'orphaned';
          run.updated_at = now;
          recovered.push({ ...run });
          continue;
        }
        run.status = 'stale';
        run.finished_at = now;
        run.updated_at = now;
        recovered.push({ ...run });
      }

      if (recovered.length > 0) {
        await this.writeState(state);
      }
      return recovered;
    });
  }

  private async readState(): Promise<RunStateFile> {
    if (!(await fileExists(this.filePath))) {
      return structuredClone(DEFAULT_STATE);
    }

    const content = await readUtf8(this.filePath);
    const parsed = JSON.parse(content) as Partial<RunStateFile>;
    return {
      version: 1,
      runs: parsed.runs ?? {},
    };
  }

  private async writeState(state: RunStateFile): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await writeUtf8Atomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}
