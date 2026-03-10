import { spawnSync } from 'node:child_process';

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }

  const unixState = readUnixProcessState(pid);
  if (unixState?.startsWith('Z')) {
    return false;
  }
  return true;
}

export function terminateProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function readUnixProcessState(pid: number): string | null {
  if (process.platform === 'win32') {
    return null;
  }

  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return null;
  }
  const output = result.stdout.trim();
  return output.length > 0 ? output : null;
}
