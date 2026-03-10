import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDir } from '../utils/fs.js';

interface LockPayload {
  instance_id: string;
  pid: number;
  started_at: string;
  cwd: string;
  transport?: string;
}

export interface InstanceLock {
  lockPath: string;
  release(): Promise<void>;
}

export async function acquireInstanceLock(options: {
  storageDir: string;
  serviceName: string;
  cwd?: string;
  ownerPid?: number;
  transport?: string;
  isProcessAlive?: (pid: number) => boolean;
}): Promise<InstanceLock> {
  await ensureDir(options.storageDir);

  const lockPath = path.join(options.storageDir, `${options.serviceName}.lock`);
  const payload: LockPayload = {
    instance_id: randomUUID(),
    pid: options.ownerPid ?? process.pid,
    started_at: new Date().toISOString(),
    cwd: options.cwd ?? process.cwd(),
    ...(options.transport ? { transport: options.transport } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(lockPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
      return {
        lockPath,
        release: async () => {
          try {
            const current = await readLockPayload(lockPath);
            if (!current || current.instance_id !== payload.instance_id) {
              return;
            }
            await fs.unlink(lockPath);
          } catch (error) {
            if (isMissingFileError(error)) {
              return;
            }
            throw error;
          }
        },
      };
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }

      const existing = await readLockPayload(lockPath);
      if (existing && isKnownLiveProcess(existing.pid, options.isProcessAlive)) {
        throw new Error(`Another ${options.serviceName} instance is already running (pid ${existing.pid}). Lock: ${lockPath}`);
      }

      await fs.rm(lockPath, { force: true });
    }
  }

  throw new Error(`Unable to acquire instance lock: ${lockPath}`);
}

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const content = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(content) as Partial<LockPayload>;
    if (typeof parsed.instance_id !== 'string' || typeof parsed.pid !== 'number' || typeof parsed.started_at !== 'string') {
      return null;
    }
    return {
      instance_id: parsed.instance_id,
      pid: parsed.pid,
      started_at: parsed.started_at,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      transport: typeof parsed.transport === 'string' ? parsed.transport : undefined,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    return null;
  }
}

function isKnownLiveProcess(pid: number, checker?: (pid: number) => boolean): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (checker) {
    return checker(pid);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function isFileExistsError(error: unknown): boolean {
  return isErrorWithCode(error, 'EEXIST');
}

function isMissingFileError(error: unknown): boolean {
  return isErrorWithCode(error, 'ENOENT');
}

function isMissingProcessError(error: unknown): boolean {
  return isErrorWithCode(error, 'ESRCH');
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
