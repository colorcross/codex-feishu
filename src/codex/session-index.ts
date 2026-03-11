import fs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CodexSessionSource = 'sessions' | 'archived';
export type CodexSessionMatchKind = 'exact-root' | 'basename' | 'normalized-name' | 'basename-contains';

export interface IndexedCodexSession {
  threadId: string;
  cwd: string;
  updatedAt: string;
  createdAt?: string;
  filePath: string;
  source: CodexSessionSource;
  matchKind?: CodexSessionMatchKind;
  matchScore?: number;
}

interface SessionMatch {
  kind: CodexSessionMatchKind;
  score: number;
}

const FUZZY_SUFFIX_TOKENS = new Set(['bridge', 'repo', 'project', 'workspace']);

export class CodexSessionIndex {
  public constructor(private readonly codexHomeDir: string = resolveCodexHomeDir()) {}

  public async listProjectSessions(projectRoot: string, limit: number = 10): Promise<IndexedCodexSession[]> {
    const sessions = await this.listSessions();
    const matches: IndexedCodexSession[] = [];
    for (const session of sessions) {
      const match = scoreSessionProjectMatch(projectRoot, session.cwd);
      if (!match) {
        continue;
      }
      matches.push({
        ...session,
        matchKind: match.kind,
        matchScore: match.score,
      });
    }
    return matches.sort(compareIndexedSessions).slice(0, limit);
  }

  public async findLatestProjectSession(projectRoot: string): Promise<IndexedCodexSession | null> {
    const [session] = await this.listProjectSessions(projectRoot, 1);
    return session ?? null;
  }

  public async findProjectSessionById(projectRoot: string, threadId: string): Promise<IndexedCodexSession | null> {
    const sessions = await this.listSessions();
    const candidate = sessions.find((session) => session.threadId === threadId);
    if (!candidate) {
      return null;
    }

    const match = scoreSessionProjectMatch(projectRoot, candidate.cwd);
    if (!match) {
      return null;
    }

    return {
      ...candidate,
      matchKind: match.kind,
      matchScore: match.score,
    };
  }

  private async listSessions(): Promise<IndexedCodexSession[]> {
    const roots: Array<{ root: string; source: CodexSessionSource }> = [
      { root: path.join(this.codexHomeDir, 'sessions'), source: 'sessions' },
      { root: path.join(this.codexHomeDir, 'archived_sessions'), source: 'archived' },
    ];

    const sessions = new Map<string, IndexedCodexSession>();
    for (const entry of roots) {
      const filePaths = await walkJsonlFiles(entry.root);
      for (const filePath of filePaths) {
        const session = await readIndexedSession(filePath, entry.source);
        if (!session) {
          continue;
        }
        const previous = sessions.get(session.threadId);
        if (!previous || previous.updatedAt < session.updatedAt) {
          sessions.set(session.threadId, session);
        }
      }
    }

    return [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

export function resolveCodexHomeDir(): string {
  const configured = process.env.CODEX_HOME?.trim();
  if (!configured) {
    return path.join(os.homedir(), '.codex');
  }

  if (configured === '~') {
    return os.homedir();
  }

  if (configured.startsWith('~/')) {
    return path.join(os.homedir(), configured.slice(2));
  }

  return path.resolve(configured);
}

export function renderSessionMatchLabel(session: Pick<IndexedCodexSession, 'matchKind'>): string {
  switch (session.matchKind) {
    case 'exact-root':
      return 'exact-root';
    case 'basename':
      return 'basename';
    case 'normalized-name':
      return 'normalized-name';
    case 'basename-contains':
      return 'basename-contains';
    default:
      return 'unknown';
  }
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const filePaths: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...(await walkJsonlFiles(filePath)));
      continue;
    }
    if (entry.isFile() && filePath.endsWith('.jsonl')) {
      filePaths.push(filePath);
    }
  }
  return filePaths;
}

async function readIndexedSession(filePath: string, source: CodexSessionSource): Promise<IndexedCodexSession | null> {
  let content: string;
  let stat: Stats;
  try {
    [content, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }

  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    return null;
  }

  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: {
        id?: string;
        cwd?: string;
        timestamp?: string;
      };
    };
    const threadId = parsed.payload?.id;
    const cwd = parsed.payload?.cwd;
    if (parsed.type !== 'session_meta' || !threadId || !cwd) {
      return null;
    }

    const createdAt = parsed.payload?.timestamp;
    const updatedAtCandidate = createdAt ? Date.parse(createdAt) : Number.NaN;
    const updatedAt = new Date(
      Number.isFinite(updatedAtCandidate) ? Math.max(updatedAtCandidate, stat.mtimeMs) : stat.mtimeMs,
    ).toISOString();

    return {
      threadId,
      cwd,
      updatedAt,
      createdAt,
      filePath,
      source,
    };
  } catch {
    return null;
  }
}

function scoreSessionProjectMatch(projectRoot: string, sessionCwd: string): SessionMatch | null {
  const normalizedProjectRoot = normalizePath(projectRoot);
  const normalizedSessionRoot = normalizePath(sessionCwd);
  if (normalizedProjectRoot === normalizedSessionRoot) {
    return { kind: 'exact-root', score: 100 };
  }

  const projectBase = path.basename(normalizedProjectRoot);
  const sessionBase = path.basename(normalizedSessionRoot);
  if (projectBase === sessionBase) {
    return { kind: 'basename', score: 80 };
  }

  const normalizedProjectName = normalizeProjectName(projectBase);
  const normalizedSessionName = normalizeProjectName(sessionBase);
  if (normalizedProjectName && normalizedProjectName === normalizedSessionName) {
    return { kind: 'normalized-name', score: 60 };
  }

  if (normalizedProjectName.length >= 5 && normalizedSessionName.includes(normalizedProjectName)) {
    return { kind: 'basename-contains', score: 40 };
  }

  return null;
}

function normalizePath(input: string): string {
  return path.resolve(input).replace(/\/+$/, '').toLowerCase();
}

function normalizeProjectName(input: string): string {
  const tokens = input
    .toLowerCase()
    .replace(/\.git$/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const filtered = tokens.filter((token) => !FUZZY_SUFFIX_TOKENS.has(token));
  return (filtered.length > 0 ? filtered : tokens).join('-');
}

function compareIndexedSessions(left: IndexedCodexSession, right: IndexedCodexSession): number {
  const scoreDelta = (right.matchScore ?? 0) - (left.matchScore ?? 0);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const updatedAtDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedAtDelta !== 0) {
    return updatedAtDelta;
  }

  return left.threadId.localeCompare(right.threadId);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}
