import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, writeUtf8Atomic } from '../utils/fs.js';
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

export interface AuditCleanupResult {
  kept: number;
  archived: number;
  removed: number;
  filePath: string;
  archivePath?: string;
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
      const normalized = content.trim();
      if (!normalized) {
        return [];
      }
      return normalized
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line) as AuditEvent);
    } catch {
      return [];
    }
  }

  public async cleanup(options: {
    retentionDays: number;
    archiveAfterDays?: number;
    archiveDir?: string;
    archiveFileName?: string;
    now?: Date;
  }): Promise<AuditCleanupResult> {
    return this.serial.run(async () => {
      const lines = await this.readLines();
      if (lines.length === 0) {
        return {
          kept: 0,
          archived: 0,
          removed: 0,
          filePath: this.filePath,
        };
      }

      const now = options.now ?? new Date();
      const archiveCutoff = options.archiveAfterDays ? now.getTime() - options.archiveAfterDays * 24 * 60 * 60 * 1000 : null;
      const retentionCutoff = now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000;
      const kept: string[] = [];
      const archived: string[] = [];
      let removed = 0;

      for (const line of lines) {
        const event = parseAuditLine(line);
        const timestamp = event?.at ? Date.parse(event.at) : Number.NaN;
        if (Number.isNaN(timestamp)) {
          kept.push(line);
          continue;
        }
        if (timestamp < retentionCutoff) {
          removed += 1;
          continue;
        }
        if (archiveCutoff !== null && timestamp < archiveCutoff) {
          archived.push(line);
          continue;
        }
        kept.push(line);
      }

      let archivePath: string | undefined;
      if (archived.length > 0 && options.archiveDir) {
        archivePath = path.join(options.archiveDir, options.archiveFileName ?? path.basename(this.filePath));
        await ensureDir(path.dirname(archivePath));
        await fs.appendFile(archivePath, `${archived.join('\n')}\n`, 'utf8');
      } else if (archived.length > 0) {
        kept.push(...archived);
      }

      await writeUtf8Atomic(this.filePath, kept.length > 0 ? `${kept.join('\n')}\n` : '');

      return {
        kept: kept.length,
        archived: archived.length,
        removed,
        filePath: this.filePath,
        ...(archivePath ? { archivePath } : {}),
      };
    });
  }

  public get path(): string {
    return this.filePath;
  }

  private async readLines(): Promise<string[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

function parseAuditLine(line: string): AuditEvent | null {
  try {
    return JSON.parse(line) as AuditEvent;
  } catch {
    return null;
  }
}
