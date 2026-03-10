export class TaskQueue {
  private readonly queues = new Map<string, Promise<unknown>>();

  public run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(
      key,
      next.finally(() => {
        if (this.queues.get(key) === next) {
          this.queues.delete(key);
        }
      }),
    );
    return next;
  }
}
