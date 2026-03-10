import type { Logger } from '../logging.js';

export interface ShutdownSignalTarget {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

const DEFAULT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export async function waitForShutdownSignal(options: {
  logger: Logger;
  onShutdown: (signal: NodeJS.Signals) => Promise<void> | void;
  target?: ShutdownSignalTarget;
  signals?: NodeJS.Signals[];
}): Promise<NodeJS.Signals> {
  const target = options.target ?? process;
  const signals = options.signals ?? DEFAULT_SIGNALS;

  return new Promise<NodeJS.Signals>((resolve, reject) => {
    let settled = false;
    const listeners = new Map<NodeJS.Signals, () => void>();

    const cleanup = () => {
      for (const [signal, listener] of listeners) {
        target.off(signal, listener);
      }
      listeners.clear();
    };

    const finish = async (signal: NodeJS.Signals) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      options.logger.info({ signal }, 'Received shutdown signal');

      try {
        await options.onShutdown(signal);
        resolve(signal);
      } catch (error) {
        reject(error);
      }
    };

    for (const signal of signals) {
      const listener = () => {
        void finish(signal);
      };
      listeners.set(signal, listener);
      target.on(signal, listener);
    }
  });
}
