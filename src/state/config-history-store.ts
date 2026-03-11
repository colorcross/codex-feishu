import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SerialExecutor } from '../utils/serial-executor.js';
import { ensureDir, fileExists, readUtf8, writeUtf8Atomic } from '../utils/fs.js';

export interface ConfigSnapshot {
  id: string;
  at: string;
  chat_id?: string;
  actor_id?: string;
  action: string;
  summary?: string;
  config_path: string;
  content: string;
}

interface ConfigHistoryState {
  version: 1;
  snapshots: ConfigSnapshot[];
}

const DEFAULT_STATE: ConfigHistoryState = {
  version: 1,
  snapshots: [],
};

export class ConfigHistoryStore {
  private readonly filePath: string;
  private readonly serial = new SerialExecutor();

  public constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'config-history.json');
  }

  public async recordSnapshot(input: {
    configPath: string;
    action: string;
    summary?: string;
    chatId?: string;
    actorId?: string;
    limit?: number;
  }): Promise<ConfigSnapshot> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const content = await fs.readFile(input.configPath, 'utf8');
      const snapshot: ConfigSnapshot = {
        id: randomUUID(),
        at: new Date().toISOString(),
        chat_id: input.chatId,
        actor_id: input.actorId,
        action: input.action,
        summary: input.summary,
        config_path: path.resolve(input.configPath),
        content,
      };
      const limit = input.limit ?? 5;
      state.snapshots = [snapshot, ...state.snapshots].slice(0, limit);
      await this.writeState(state);
      return snapshot;
    });
  }

  public async listSnapshots(limit: number = 5): Promise<ConfigSnapshot[]> {
    await this.serial.wait();
    const state = await this.readState();
    return state.snapshots.slice(0, limit);
  }

  public async getSnapshot(idOrLatest?: string): Promise<ConfigSnapshot | null> {
    await this.serial.wait();
    const state = await this.readState();
    if (!idOrLatest || idOrLatest === 'latest') {
      return state.snapshots[0] ?? null;
    }
    return state.snapshots.find((snapshot) => snapshot.id === idOrLatest) ?? null;
  }

  private async readState(): Promise<ConfigHistoryState> {
    if (!(await fileExists(this.filePath))) {
      return structuredClone(DEFAULT_STATE);
    }

    const content = await readUtf8(this.filePath);
    const parsed = JSON.parse(content) as Partial<ConfigHistoryState>;
    return {
      version: 1,
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
    };
  }

  private async writeState(state: ConfigHistoryState): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await writeUtf8Atomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}
