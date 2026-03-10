import os from 'node:os';
import path from 'node:path';

export function expandHomePath(input: string): string {
  if (input === '~') {
    return os.homedir();
  }

  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

export function resolveMaybeRelative(input: string, baseDir: string): string {
  const expanded = expandHomePath(input);
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.resolve(baseDir, expanded);
}

export function normalizePath(input: string): string {
  return path.normalize(expandHomePath(input));
}
