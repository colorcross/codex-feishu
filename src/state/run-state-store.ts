import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SerialExecutor } from '../utils/serial-executor.js';
import { isProcessAlive } from '../runtime/process.js';

export type RunStatus = 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'stale' | 'orphaned';

export interface RunState {
  run_id: string;
  queue_key: string;
  conversation_key: string;
  project_alias: string;
  chat_id: string;
  actor_id?: string;
  session_id?: string;
  project_root?: string;
  pid?: number;
  prompt_excerpt: string;
  status: RunStatus;
  status_detail?: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  error?: string;
}

/** Retention: auto-delete completed/failed/cancelled runs older than 30 days. */
const RETENTION_DAYS = 30;

export class RunStateStore {
  private readonly db: DatabaseSync;
  private readonly serial = new SerialExecutor();

  public constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, 'runs.db');
    this.db = new DatabaseSync(dbPath);
    initializeSchema(this.db);
  }

  public close(): void {
    this.db.close();
  }

  public async upsertRun(
    runId: string,
    patch: Partial<RunState> & Pick<RunState, 'queue_key' | 'conversation_key' | 'project_alias' | 'chat_id' | 'prompt_excerpt' | 'status'>,
  ): Promise<RunState> {
    return this.serial.run(async () => {
      const existing = this.getRunSync(runId);
      const now = this.nextMonotonicTimestamp();
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
        actor_id: pickPatchedValue(patch, 'actor_id', existing?.actor_id),
        session_id: pickPatchedValue(patch, 'session_id', existing?.session_id),
        project_root: pickPatchedValue(patch, 'project_root', existing?.project_root),
        pid: pickPatchedValue(patch, 'pid', existing?.pid),
        status_detail: pickPatchedValue(patch, 'status_detail', existing?.status_detail),
        finished_at: pickPatchedValue(patch, 'finished_at', existing?.finished_at),
        error: pickPatchedValue(patch, 'error', existing?.error),
      };
      if (isTerminalRunStatus(next.status)) {
        next.finished_at = patch.finished_at ?? now;
      } else {
        next.finished_at = undefined;
      }

      this.db.prepare(`
        INSERT OR REPLACE INTO runs (
          run_id, queue_key, conversation_key, project_alias, chat_id,
          actor_id, session_id, project_root, pid, prompt_excerpt,
          status, status_detail, started_at, updated_at, finished_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        next.run_id,
        next.queue_key,
        next.conversation_key,
        next.project_alias,
        next.chat_id,
        next.actor_id ?? null,
        next.session_id ?? null,
        next.project_root ?? null,
        next.pid ?? null,
        next.prompt_excerpt,
        next.status,
        next.status_detail ?? null,
        next.started_at,
        next.updated_at,
        next.finished_at ?? null,
        next.error ?? null,
      );

      this.pruneOldRuns();

      return next;
    });
  }

  public async getRun(runId: string): Promise<RunState | null> {
    await this.serial.wait();
    return this.getRunSync(runId);
  }

  public async listRuns(): Promise<RunState[]> {
    await this.serial.wait();
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY updated_at DESC').all() as unknown as RunRow[];
    return rows.map(mapRunRow);
  }

  public async getActiveRun(queueKey: string): Promise<RunState | null> {
    await this.serial.wait();
    const row = this.db.prepare(
      "SELECT * FROM runs WHERE queue_key = ? AND status IN ('running', 'orphaned') ORDER BY updated_at DESC LIMIT 1",
    ).get(queueKey) as unknown as RunRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  public async getLatestVisibleRun(queueKey: string): Promise<RunState | null> {
    await this.serial.wait();
    const row = this.db.prepare(
      "SELECT * FROM runs WHERE queue_key = ? AND status IN ('queued', 'running', 'orphaned') ORDER BY updated_at DESC LIMIT 1",
    ).get(queueKey) as unknown as RunRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  public async listActiveRuns(): Promise<RunState[]> {
    await this.serial.wait();
    const rows = this.db.prepare(
      "SELECT * FROM runs WHERE status IN ('queued', 'running', 'orphaned') ORDER BY updated_at DESC",
    ).all() as unknown as RunRow[];
    return rows.map(mapRunRow);
  }

  public async getExecutionRunByProjectRoot(projectRoot: string): Promise<RunState | null> {
    await this.serial.wait();
    const row = this.db.prepare(
      "SELECT * FROM runs WHERE project_root = ? AND status IN ('running', 'orphaned') ORDER BY updated_at DESC LIMIT 1",
    ).get(projectRoot) as unknown as RunRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  public async recoverOrphanedRuns(): Promise<RunState[]> {
    return this.serial.run(async () => {
      const rows = this.db.prepare(
        "SELECT * FROM runs WHERE status IN ('queued', 'running')",
      ).all() as unknown as RunRow[];

      const recovered: RunState[] = [];
      const now = new Date().toISOString();

      for (const row of rows) {
        const run = mapRunRow(row);
        if (run.status === 'queued') {
          run.status = 'stale';
          run.finished_at = now;
          run.updated_at = now;
          this.updateRunInPlace(run);
          recovered.push({ ...run });
          continue;
        }
        if (run.status !== 'running') {
          continue;
        }
        if (run.pid && isProcessAlive(run.pid)) {
          run.status = 'orphaned';
          run.updated_at = now;
          this.updateRunInPlace(run);
          recovered.push({ ...run });
          continue;
        }
        run.status = 'stale';
        run.finished_at = now;
        run.updated_at = now;
        this.updateRunInPlace(run);
        recovered.push({ ...run });
      }

      return recovered;
    });
  }

  // ── private helpers ──

  private getRunSync(runId: string): RunState | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as unknown as RunRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  private updateRunInPlace(run: RunState): void {
    this.db.prepare(`
      UPDATE runs SET
        queue_key = ?, conversation_key = ?, project_alias = ?, chat_id = ?,
        actor_id = ?, session_id = ?, project_root = ?, pid = ?,
        prompt_excerpt = ?, status = ?, status_detail = ?,
        started_at = ?, updated_at = ?, finished_at = ?, error = ?
      WHERE run_id = ?
    `).run(
      run.queue_key,
      run.conversation_key,
      run.project_alias,
      run.chat_id,
      run.actor_id ?? null,
      run.session_id ?? null,
      run.project_root ?? null,
      run.pid ?? null,
      run.prompt_excerpt,
      run.status,
      run.status_detail ?? null,
      run.started_at,
      run.updated_at,
      run.finished_at ?? null,
      run.error ?? null,
      run.run_id,
    );
  }

  private pruneOldRuns(): void {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(
      "DELETE FROM runs WHERE status IN ('success', 'failure', 'cancelled') AND finished_at IS NOT NULL AND finished_at < ?",
    ).run(cutoff);
  }

  private nextMonotonicTimestamp(): string {
    const row = this.db.prepare('SELECT MAX(updated_at) AS latest FROM runs').get() as { latest?: string | null } | undefined;
    const latestStr = row?.latest;
    const latestMs = latestStr ? Date.parse(latestStr) : 0;
    const now = Date.now();
    return new Date(Math.max(now, (Number.isNaN(latestMs) ? 0 : latestMs) + 1)).toISOString();
  }
}

// ── Row type (SQLite returns all columns) ──

interface RunRow {
  run_id: string;
  queue_key: string;
  conversation_key: string;
  project_alias: string;
  chat_id: string;
  actor_id: string | null;
  session_id: string | null;
  project_root: string | null;
  pid: number | null;
  prompt_excerpt: string;
  status: string;
  status_detail: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  error: string | null;
}

function mapRunRow(row: RunRow): RunState {
  return {
    run_id: row.run_id,
    queue_key: row.queue_key,
    conversation_key: row.conversation_key,
    project_alias: row.project_alias,
    chat_id: row.chat_id,
    actor_id: row.actor_id ?? undefined,
    session_id: row.session_id ?? undefined,
    project_root: row.project_root ?? undefined,
    pid: row.pid ?? undefined,
    prompt_excerpt: row.prompt_excerpt,
    status: row.status as RunStatus,
    status_detail: row.status_detail ?? undefined,
    started_at: row.started_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at ?? undefined,
    error: row.error ?? undefined,
  };
}

// ── Schema bootstrap ──

function initializeSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      queue_key TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      project_alias TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      actor_id TEXT,
      session_id TEXT,
      project_root TEXT,
      pid INTEGER,
      prompt_excerpt TEXT NOT NULL,
      status TEXT NOT NULL,
      status_detail TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_status_project ON runs(status, project_alias);
    CREATE INDEX IF NOT EXISTS idx_runs_project_root_status ON runs(project_root, status);
    CREATE INDEX IF NOT EXISTS idx_runs_queue_key_status ON runs(queue_key, status);
    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
  `);
}

// ── Utility functions (unchanged public contract) ──

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'success' || status === 'failure' || status === 'cancelled' || status === 'stale';
}

function pickPatchedValue<T extends keyof RunState>(patch: Partial<RunState>, key: T, fallback: RunState[T]): RunState[T] {
  return (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : fallback) as RunState[T];
}
