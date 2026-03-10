import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForShutdownSignal } from '../src/runtime/shutdown.js';

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as any;

afterEach(() => {
  logger.info.mockClear();
});

describe('waitForShutdownSignal', () => {
  it('runs shutdown callback and resolves with the signal', async () => {
    const target = new EventEmitter();
    const onShutdown = vi.fn();

    const promise = waitForShutdownSignal({
      logger,
      onShutdown,
      target: target as any,
      signals: ['SIGTERM'],
    });

    target.emit('SIGTERM');

    await expect(promise).resolves.toBe('SIGTERM');
    expect(onShutdown).toHaveBeenCalledWith('SIGTERM');
    expect(logger.info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'Received shutdown signal');
  });
});
