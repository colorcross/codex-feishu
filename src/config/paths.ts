import os from 'node:os';
import path from 'node:path';

export const PROJECT_CONFIG_RELATIVE_PATH = path.join('.codex-feishu', 'config.toml');

export function getGlobalConfigPath(): string {
  return path.join(os.homedir(), '.codex-feishu', 'config.toml');
}

export function getDefaultStateDir(): string {
  return path.join(os.homedir(), '.codex-feishu', 'state');
}
