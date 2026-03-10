import pino, { type LoggerOptions } from 'pino';

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info') {
  const options: LoggerOptions = { level };
  if (process.env.NODE_ENV !== 'test') {
    options.transport = {
      target: 'pino/file',
      options: { destination: 1 },
    };
  }
  return pino(options);
}

export type Logger = ReturnType<typeof createLogger>;
