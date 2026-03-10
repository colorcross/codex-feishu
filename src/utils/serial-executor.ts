export class SerialExecutor {
  private tail: Promise<unknown> = Promise.resolve();

  public async wait(): Promise<void> {
    await this.tail.then(
      () => undefined,
      () => undefined,
    );
  }

  public run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
