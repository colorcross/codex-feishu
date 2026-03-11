import path from 'node:path';
import { SerialExecutor } from '../utils/serial-executor.js';
import { ensureDir, fileExists, readUtf8, writeUtf8Atomic } from '../utils/fs.js';
import type { BridgeCommand } from '../bridge/commands.js';

export interface PendingCommandRecord {
  key: string;
  chat_id: string;
  actor_id?: string;
  source_text: string;
  summary: string;
  command: BridgeCommand;
  created_at: string;
  expires_at: string;
}

interface PendingCommandState {
  version: 1;
  records: Record<string, PendingCommandRecord>;
}

const DEFAULT_STATE: PendingCommandState = {
  version: 1,
  records: {},
};

export class PendingCommandStore {
  private readonly filePath: string;
  private readonly serial = new SerialExecutor();

  public constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'pending-commands.json');
  }

  public async save(input: {
    chatId: string;
    actorId?: string;
    sourceText: string;
    summary: string;
    command: BridgeCommand;
    ttlSeconds: number;
  }): Promise<PendingCommandRecord> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const now = new Date();
      const key = buildPendingCommandKey(input.chatId, input.actorId);
      const record: PendingCommandRecord = {
        key,
        chat_id: input.chatId,
        ...(input.actorId ? { actor_id: input.actorId } : {}),
        source_text: input.sourceText,
        summary: input.summary,
        command: input.command,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
      };
      state.records[key] = record;
      pruneExpiredRecords(state, now.toISOString());
      await this.writeState(state);
      return record;
    });
  }

  public async get(chatId: string, actorId?: string): Promise<PendingCommandRecord | null> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const now = new Date().toISOString();
      const key = buildPendingCommandKey(chatId, actorId);
      const record = state.records[key];
      if (!record) {
        return null;
      }
      if (Date.parse(record.expires_at) <= Date.parse(now)) {
        delete state.records[key];
        await this.writeState(state);
        return null;
      }
      return record;
    });
  }

  public async consume(chatId: string, actorId?: string): Promise<PendingCommandRecord | null> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const now = new Date().toISOString();
      const key = buildPendingCommandKey(chatId, actorId);
      const record = state.records[key];
      if (!record) {
        return null;
      }
      delete state.records[key];
      pruneExpiredRecords(state, now);
      await this.writeState(state);
      if (Date.parse(record.expires_at) <= Date.parse(now)) {
        return null;
      }
      return record;
    });
  }

  public async clear(chatId: string, actorId?: string): Promise<void> {
    await this.serial.run(async () => {
      const state = await this.readState();
      delete state.records[buildPendingCommandKey(chatId, actorId)];
      await this.writeState(state);
    });
  }

  private async readState(): Promise<PendingCommandState> {
    if (!(await fileExists(this.filePath))) {
      return structuredClone(DEFAULT_STATE);
    }

    try {
      const content = await readUtf8(this.filePath);
      const parsed = JSON.parse(content) as Partial<PendingCommandState>;
      return {
        version: 1,
        records: parsed.records ?? {},
      };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  private async writeState(state: PendingCommandState): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await writeUtf8Atomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export function buildPendingCommandKey(chatId: string, actorId?: string): string {
  return `${chatId}::${actorId ?? 'actor'}`;
}

function pruneExpiredRecords(state: PendingCommandState, nowIso: string): void {
  for (const [key, record] of Object.entries(state.records)) {
    if (Date.parse(record.expires_at) <= Date.parse(nowIso)) {
      delete state.records[key];
    }
  }
}
