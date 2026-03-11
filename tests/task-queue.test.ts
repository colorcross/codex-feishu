import { describe, expect, it } from 'vitest';
import { TaskQueue } from '../src/bridge/task-queue.js';

describe('task queue', () => {
  it('prefers higher priority tasks while preserving FIFO within the same priority', async () => {
    const queue = new TaskQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = queue.run(
      'root',
      async () =>
        new Promise<void>((resolve) => {
          releaseFirst = () => {
            order.push('first');
            resolve();
          };
        }),
      { priority: 10 },
    );

    const low = queue.run(
      'root',
      async () => {
        order.push('low');
      },
      { priority: 10 },
    );

    const high = queue.run(
      'root',
      async () => {
        order.push('high');
      },
      { priority: 100 },
    );

    releaseFirst?.();
    await Promise.all([first, low, high]);

    expect(order).toEqual(['first', 'high', 'low']);
  });
});
