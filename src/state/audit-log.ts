import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../utils/fs.js';
import { SerialExecutor } from '../utils/serial-executor.js';

export interface AuditEvent {
  type: string;
  at: string;
  [key: string]: unknown;
}

export interface AppendAuditEvent {
  type: string;
  at?: string;
  [key: string]: unknown;
}

export class AuditLog {
  private readonly filePath: string;
  private readonly serial = new SerialExecutor();

  public constructor(stateDir: string, fileName: string = 'audit.jsonl') {
    this.filePath = path.join(stateDir, fileName);
  }

  public async append(event: AppendAuditEvent): Promise<void> {
    await this.serial.run(async () => {
      await ensureDir(path.dirname(this.filePath));
      const payload: AuditEvent = {
        ...event,
        at: event.at ?? new Date().toISOString(),
      };
      await fs.appendFile(this.filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    });
  }

  public async tail(limit: number): Promise<AuditEvent[]> {
    await this.serial.wait();
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      return content
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line) as AuditEvent);
    } catch {
      return [];
    }
  }

  public get path(): string {
    return this.filePath;
  }
}
