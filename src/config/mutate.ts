import path from 'node:path';
import type { SandboxMode } from './schema.js';
import { readRawToml, writeToml } from './load.js';

export async function bindProjectAlias(input: {
  configPath: string;
  alias: string;
  root: string;
  profile?: string;
  sandbox?: SandboxMode;
}): Promise<void> {
  const raw = await readRawToml(input.configPath);
  const projects = ensureObject(raw.projects);
  projects[input.alias] = {
    ...(ensureObject(projects[input.alias]) ?? {}),
    root: path.resolve(input.root),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
  };
  raw.projects = projects;
  await writeToml(input.configPath, raw);
}

function ensureObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
