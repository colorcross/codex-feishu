/**
 * JSON-backed store for handoff records and review records.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { HandoffRecord, ReviewRecord } from '../collaboration/handoff.js';
import { SerialExecutor } from '../utils/serial-executor.js';

interface HandoffStoreData {
  handoffs: HandoffRecord[];
  reviews: ReviewRecord[];
}

const MAX_RECORDS = 100;

export class HandoffStore {
  private readonly filePath: string;
  private readonly executor = new SerialExecutor();
  private data: HandoffStoreData | null = null;

  public constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'handoffs.json');
  }

  private async load(): Promise<HandoffStoreData> {
    if (this.data) return this.data;

    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      this.data = JSON.parse(content) as HandoffStoreData;
    } catch {
      this.data = { handoffs: [], reviews: [] };
    }

    return this.data;
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  async addHandoff(record: HandoffRecord): Promise<void> {
    await this.executor.run(async () => {
      const data = await this.load();
      data.handoffs.unshift(record);
      if (data.handoffs.length > MAX_RECORDS) {
        data.handoffs = data.handoffs.slice(0, MAX_RECORDS);
      }
      await this.save();
    });
  }

  async updateHandoff(id: string, patch: Partial<HandoffRecord>): Promise<HandoffRecord | null> {
    return this.executor.run(async () => {
      const data = await this.load();
      const index = data.handoffs.findIndex((h) => h.id === id || h.id.startsWith(id));
      if (index < 0) return null;

      const record = data.handoffs[index]!;
      const updated: HandoffRecord = Object.assign(record, patch);
      data.handoffs[index] = updated;
      await this.save();
      return updated;
    });
  }

  async getPendingHandoff(projectAlias?: string): Promise<HandoffRecord | null> {
    const data = await this.executor.run(() => this.load());
    return (
      data.handoffs.find(
        (h) =>
          h.status === 'pending' &&
          (!projectAlias || h.project_alias === projectAlias),
      ) ?? null
    );
  }

  async getPendingHandoffForActor(
    actorId: string,
    projectAlias?: string,
  ): Promise<HandoffRecord | null> {
    const data = await this.executor.run(() => this.load());
    return (
      data.handoffs.find(
        (h) =>
          h.status === 'pending' &&
          (!h.to_actor_id || h.to_actor_id === actorId) &&
          (!projectAlias || h.project_alias === projectAlias),
      ) ?? null
    );
  }

  async listHandoffs(limit: number = 10): Promise<HandoffRecord[]> {
    const data = await this.executor.run(() => this.load());
    return data.handoffs.slice(0, limit);
  }

  async addReview(record: ReviewRecord): Promise<void> {
    await this.executor.run(async () => {
      const data = await this.load();
      data.reviews.unshift(record);
      if (data.reviews.length > MAX_RECORDS) {
        data.reviews = data.reviews.slice(0, MAX_RECORDS);
      }
      await this.save();
    });
  }

  async updateReview(id: string, patch: Partial<ReviewRecord>): Promise<ReviewRecord | null> {
    return this.executor.run(async () => {
      const data = await this.load();
      const index = data.reviews.findIndex((r) => r.id === id || r.id.startsWith(id));
      if (index < 0) return null;

      const record = data.reviews[index]!;
      const updated: ReviewRecord = Object.assign(record, patch);
      data.reviews[index] = updated;
      await this.save();
      return updated;
    });
  }

  async getPendingReview(chatId: string): Promise<ReviewRecord | null> {
    const data = await this.executor.run(() => this.load());
    return data.reviews.find((r) => r.status === 'pending' && r.chat_id === chatId) ?? null;
  }

  async listReviews(limit: number = 10): Promise<ReviewRecord[]> {
    const data = await this.executor.run(() => this.load());
    return data.reviews.slice(0, limit);
  }
}
