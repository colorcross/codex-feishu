export class TaskQueue {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pendingCounts = new Map<string, number>();

  public run<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.pendingCounts.set(key, (this.pendingCounts.get(key) ?? 0) + 1);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(
      key,
      next.finally(() => {
        if (this.queues.get(key) === next) {
          this.queues.delete(key);
        }
        const remaining = (this.pendingCounts.get(key) ?? 1) - 1;
        if (remaining > 0) {
          this.pendingCounts.set(key, remaining);
        } else {
          this.pendingCounts.delete(key);
        }
      }),
    );
    return next;
  }

  public getPendingCount(key: string): number {
    return this.pendingCounts.get(key) ?? 0;
  }
}
