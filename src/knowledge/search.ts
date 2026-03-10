import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ProjectConfig } from '../config/schema.js';

export interface KnowledgeSearchResult {
  roots: string[];
  matches: Array<{
    file: string;
    line: number;
    text: string;
  }>;
}

const DEFAULT_KNOWLEDGE_PATHS = ['docs', 'README.md', 'README.en.md', 'CHANGELOG.md'];
const SEARCH_FILE_GLOBS = ['*.md', '*.mdx', '*.txt', '*.rst', '*.adoc'];

export async function searchKnowledgeBase(project: ProjectConfig, query: string, limit: number = 5): Promise<KnowledgeSearchResult> {
  const roots = await resolveKnowledgeRoots(project);
  if (roots.length === 0) {
    return { roots: [], matches: [] };
  }

  const output = await runSearch(query, roots);
  return {
    roots,
    matches: output
      .split('\n')
      .map(parseResultLine)
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .slice(0, limit),
  };
}

export async function resolveKnowledgeRoots(project: ProjectConfig): Promise<string[]> {
  const candidates = (project.knowledge_paths.length > 0 ? project.knowledge_paths : DEFAULT_KNOWLEDGE_PATHS).map((entry) =>
    path.isAbsolute(entry) ? entry : path.join(project.root, entry),
  );
  const resolved: string[] = [];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      resolved.push(candidate);
    }
  }

  return resolved;
}

async function runSearch(query: string, roots: string[]): Promise<string> {
  try {
    return await execSearch(
      'rg',
      ['-n', '-i', '--color', 'never', ...SEARCH_FILE_GLOBS.flatMap((glob) => ['--glob', glob]), query, ...roots],
      false,
    );
  } catch {
    const includeArgs = SEARCH_FILE_GLOBS.flatMap((glob) => ['--include', glob]);
    return execSearch('grep', ['-RIn', ...includeArgs, query, ...roots], true);
  }
}

function parseResultLine(line: string): { file: string; line: number; text: string } | null {
  const match = line.match(/^(.*?):(\d+):(.*)$/);
  if (!match) {
    return null;
  }
  return {
    file: match[1] ?? '',
    line: Number(match[2] ?? '0'),
    text: (match[3] ?? '').trim(),
  };
}

async function execSearch(command: string, args: string[], tolerateNoMatches: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || (tolerateNoMatches && code === 1)) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
