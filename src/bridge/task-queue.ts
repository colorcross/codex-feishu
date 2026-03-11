export class TaskQueue {
  private readonly queues = new Map<string, QueueTask<any>[]>();
  private readonly pendingCounts = new Map<string, number>();
  private readonly activeKeys = new Set<string>();
  private nextSequence = 0;

  public run<T>(key: string, task: () => Promise<T>, options: QueueRunOptions = {}): Promise<T> {
    this.pendingCounts.set(key, (this.pendingCounts.get(key) ?? 0) + 1);
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(key) ?? [];
      queue.push({
        task,
        resolve,
        reject,
        priority: options.priority ?? 0,
        sequence: this.nextSequence++,
      });
      this.queues.set(key, queue);
      this.pump(key);
    });
  }

  public getPendingCount(key: string): number {
    return this.pendingCounts.get(key) ?? 0;
  }

  private pump(key: string): void {
    if (this.activeKeys.has(key)) {
      return;
    }
    this.activeKeys.add(key);
    void this.consume(key);
  }

  private async consume(key: string): Promise<void> {
    try {
      while (true) {
        const queue = this.queues.get(key);
        if (!queue || queue.length === 0) {
          this.queues.delete(key);
          return;
        }

        const nextIndex = selectNextTaskIndex(queue);
        const [entry] = queue.splice(nextIndex, 1);
        if (queue.length === 0) {
          this.queues.delete(key);
        }

        try {
          const result = await entry!.task();
          entry!.resolve(result);
        } catch (error) {
          entry!.reject(error);
        } finally {
          const remaining = (this.pendingCounts.get(key) ?? 1) - 1;
          if (remaining > 0) {
            this.pendingCounts.set(key, remaining);
          } else {
            this.pendingCounts.delete(key);
          }
        }
      }
    } finally {
      this.activeKeys.delete(key);
      if ((this.queues.get(key)?.length ?? 0) > 0) {
        this.pump(key);
      }
    }
  }
}

interface QueueRunOptions {
  priority?: number;
}

interface QueueTask<T> {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  priority: number;
  sequence: number;
}

function selectNextTaskIndex(queue: QueueTask<unknown>[]): number {
  let bestIndex = 0;
  for (let index = 1; index < queue.length; index += 1) {
    const current = queue[index]!;
    const best = queue[bestIndex]!;
    if (current.priority > best.priority || (current.priority === best.priority && current.sequence < best.sequence)) {
      bestIndex = index;
    }
  }
  return bestIndex;
}
