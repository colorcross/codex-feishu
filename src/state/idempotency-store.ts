import path from 'node:path';
import { SerialExecutor } from '../utils/serial-executor.js';
import { ensureDir, fileExists, readUtf8, writeUtf8Atomic } from '../utils/fs.js';

export interface IdempotencyEntry {
  key: string;
  kind: 'message' | 'card';
  first_seen_at: string;
  last_seen_at: string;
  duplicate_count: number;
}

interface IdempotencyStateFile {
  version: 1;
  entries: Record<string, IdempotencyEntry>;
}

const DEFAULT_STATE: IdempotencyStateFile = {
  version: 1,
  entries: {},
};

export class IdempotencyStore {
  private readonly filePath: string;
  private readonly serial = new SerialExecutor();

  public constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'idempotency.json');
  }

  public async register(key: string, kind: 'message' | 'card', ttlSeconds: number): Promise<{ duplicate: boolean; entry: IdempotencyEntry }> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const now = new Date();
      pruneExpiredEntries(state, now, ttlSeconds);
      const isoNow = now.toISOString();
      const existing = state.entries[key];
      if (existing) {
        const updated: IdempotencyEntry = {
          ...existing,
          last_seen_at: isoNow,
          duplicate_count: existing.duplicate_count + 1,
        };
        state.entries[key] = updated;
        await this.writeState(state);
        return {
          duplicate: true,
          entry: updated,
        };
      }

      const created: IdempotencyEntry = {
        key,
        kind,
        first_seen_at: isoNow,
        last_seen_at: isoNow,
        duplicate_count: 0,
      };
      state.entries[key] = created;
      await this.writeState(state);
      return {
        duplicate: false,
        entry: created,
      };
    });
  }

  public async tail(limit: number): Promise<IdempotencyEntry[]> {
    await this.serial.wait();
    const state = await this.readState();
    return Object.values(state.entries)
      .sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at))
      .slice(0, limit);
  }

  private async readState(): Promise<IdempotencyStateFile> {
    if (!(await fileExists(this.filePath))) {
      return structuredClone(DEFAULT_STATE);
    }

    const content = await readUtf8(this.filePath);
    const parsed = JSON.parse(content) as Partial<IdempotencyStateFile>;
    return {
      version: 1,
      entries: parsed.entries ?? {},
    };
  }

  private async writeState(state: IdempotencyStateFile): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await writeUtf8Atomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function pruneExpiredEntries(state: IdempotencyStateFile, now: Date, ttlSeconds: number): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return;
  }

  const cutoff = now.getTime() - ttlSeconds * 1000;
  for (const [key, entry] of Object.entries(state.entries)) {
    const timestamp = Date.parse(entry.last_seen_at || entry.first_seen_at);
    if (!Number.isFinite(timestamp) || timestamp < cutoff) {
      delete state.entries[key];
    }
  }
}
