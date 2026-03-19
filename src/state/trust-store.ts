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
  private data: TrustStoreData | null = null;

  public constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'trust.json');
  }

  private async load(): Promise<TrustStoreData> {
    if (this.data) return this.data;

    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      this.data = JSON.parse(content) as TrustStoreData;
    } catch {
      this.data = {};
    }

    return this.data;
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  async getOrCreate(projectAlias: string): Promise<TrustState> {
    return this.executor.run(async () => {
      const data = await this.load();
      if (!data[projectAlias]) {
        data[projectAlias] = createInitialTrustState(projectAlias);
        await this.save();
      }
      return data[projectAlias];
    });
  }

  async update(projectAlias: string, state: TrustState): Promise<void> {
    await this.executor.run(async () => {
      const data = await this.load();
      data[projectAlias] = state;
      await this.save();
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
