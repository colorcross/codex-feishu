/**
 * JSON-backed store for per-project trust state.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { TrustState } from '../collaboration/trust.js';
import { createInitialTrustState } from '../collaboration/trust.js';
import { SerialExecutor } from '../utils/serial-executor.js';

type TrustStoreData = Record<string, TrustState>;

export class TrustStore {
  private readonly filePath: string;
  private readonly executor = new SerialExecutor();

  public constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'trust.json');
  }

  private async load(): Promise<TrustStoreData> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(content) as TrustStoreData;
    } catch {
      return {};
    }
  }

  private async save(data: TrustStoreData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  async getOrCreate(projectAlias: string): Promise<TrustState> {
    return this.executor.run(async () => {
      const data = await this.load();
      if (!data[projectAlias]) {
        data[projectAlias] = createInitialTrustState(projectAlias);
        await this.save(data);
      }
      return data[projectAlias];
    });
  }

  async update(projectAlias: string, state: TrustState): Promise<void> {
    await this.executor.run(async () => {
      const data = await this.load();
      data[projectAlias] = state;
      await this.save(data);
    });
  }

  async get(projectAlias: string): Promise<TrustState | null> {
    const data = await this.executor.run(() => this.load());
    return data[projectAlias] ?? null;
  }

  async listAll(): Promise<TrustState[]> {
    const data = await this.executor.run(() => this.load());
    return Object.values(data);
  }
}
