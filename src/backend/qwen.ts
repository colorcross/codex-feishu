import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { Backend, BackendEvent, BackendRunOptions, BackendRunResult, IndexedSession, SessionMatchKind, SessionSource } from './types.js';
import type { Logger } from '../logging.js';
import type { BackendDefinition } from './registry.js';
import { registerBackend } from './registry.js';

/**
 * Qwen Code CLI backend. Near-identical event + arg surface to
 * ClaudeBackend — both CLIs speak `--output-format stream-json` with
 * `system/init → assistant → result` event frames. The main differences:
 *
 *   1. `--approval-mode plan|default|auto-edit|yolo` instead of
 *      `--permission-mode ...`
 *   2. Session storage layout: qwen writes JSONL chats under
 *      `~/.qwen/projects/<encoded-cwd>/chats/<uuid>.jsonl`. The first
 *      line of each chat is a `type: system` frame with `cwd`, `version`,
 *      and `timestamp`, which we parse to drive session adoption.
 *   3. No `--max-budget-usd` equivalent.
 *
 * Qwen Code version validated against: 0.14.1.
 */

export type QwenApprovalMode = 'plan' | 'default' | 'auto-edit' | 'yolo';

export interface QwenBackendConfig {
  bin: string;
  shell?: string;
  preExec?: string;
  defaultApprovalMode: QwenApprovalMode;
  defaultModel?: string;
  allowedTools?: string[];
  systemPromptAppend?: string;
  runTimeoutMs: number;
}

export interface QwenProjectConfig {
  approvalMode?: QwenApprovalMode;
  model?: string;
  allowedTools?: string[];
  systemPromptAppend?: string;
}

interface QwenStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  message?: {
    id?: string;
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

/**
 * First-line header of a qwen JSONL chat. We only read enough fields
 * to drive session adoption.
 */
interface QwenChatHeader {
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  type?: string;
}

export class QwenBackend implements Backend {
  public readonly name = 'qwen' as const;

  public constructor(
    private readonly config: QwenBackendConfig,
    private readonly qwenHomeDir: string = resolveQwenHomeDir(),
  ) {}

  public async run(options: BackendRunOptions & { projectConfig?: QwenProjectConfig }): Promise<BackendRunResult> {
    const args = this.buildArgs(options);
    const spawnSpec = this.buildSpawnSpec(args);

    options.logger.info(
      { command: spawnSpec.command, args: spawnSpec.args, workdir: options.workdir },
      'Starting Qwen turn',
    );

    return await new Promise<BackendRunResult>((resolve, reject) => {
      const processRef = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: options.workdir,
        env: {
          ...process.env,
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let stdoutBuffer = '';
      let sessionId = options.sessionId;
      let finalMessage = '';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let abortCleanup: (() => void) | undefined;

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const finishResolve = (result: BackendRunResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        abortCleanup?.();
        abortCleanup = undefined;
      };

      const abortRun = (reason: unknown) => {
        if (processRef.killed) return;
        const message = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'Qwen run aborted';
        const error = new Error(message);
        error.name = 'AbortError';
        processRef.kill('SIGTERM');
        setTimeout(() => {
          if (!processRef.killed) processRef.kill('SIGKILL');
        }, 3000).unref();
        finishReject(error);
      };

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          abortRun(`Qwen timed out after ${options.timeoutMs}ms`);
        }, options.timeoutMs);
        timeoutHandle.unref();
      }

      if (options.signal) {
        const onAbort = () => abortRun(options.signal?.reason ?? 'Qwen run aborted');
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
        abortCleanup = () => options.signal?.removeEventListener('abort', onAbort);
      }

      if (typeof processRef.pid === 'number') {
        void options.onSpawn?.(processRef.pid);
      }

      processRef.stdout.on('data', async (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;

          try {
            const event = JSON.parse(trimmed) as QwenStreamEvent;

            // Session id is emitted on both init and result events.
            if (event.session_id) {
              sessionId = event.session_id;
            }

            // Extract final text + usage from result event.
            if (event.type === 'result') {
              if (typeof event.result === 'string') {
                finalMessage = event.result;
              }
              if (event.usage) {
                if (typeof event.usage.input_tokens === 'number') inputTokens = event.usage.input_tokens;
                if (typeof event.usage.output_tokens === 'number') outputTokens = event.usage.output_tokens;
              }
            }

            // Fall back to assistant text content if result event never arrives.
            if (event.type === 'assistant' && event.message?.content) {
              const texts = event.message.content
                .filter(c => c.type === 'text' && typeof c.text === 'string')
                .map(c => c.text!)
                .join('\n');
              if (texts) {
                finalMessage = texts;
              }
            }

            const backendEvent: BackendEvent = {
              type: event.type,
              session_id: event.session_id ?? sessionId,
              message: typeof event.result === 'string' ? event.result : undefined,
            };
            await options.onEvent?.(backendEvent);
          } catch {
            options.logger.debug({ line }, 'Ignoring unparsable Qwen line');
          }
        }
      });

      processRef.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      processRef.on('error', (error) => {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      });

      processRef.on('close', (exitCode) => {
        if (settled) return;

        if ((exitCode ?? 1) !== 0 && !finalMessage) {
          finishReject(new Error(`Qwen exited with code ${exitCode ?? 1}: ${stderr.trim() || 'no stderr output'}`));
          return;
        }

        finishResolve({
          sessionId,
          finalMessage: finalMessage.trim(),
          stderr: stderr.trim(),
          exitCode: exitCode ?? 0,
          inputTokens,
          outputTokens,
        });
      });
    });
  }

  public summarizeEvent(event: BackendEvent): string | null {
    if (event.type === 'error' && typeof event.message === 'string') {
      return `Qwen 错误：${event.message}`;
    }
    return null;
  }

  public async listProjectSessions(projectRoot: string, limit: number = 10): Promise<IndexedSession[]> {
    const sessions = await this.scanSessions();
    const matches: IndexedSession[] = [];
    for (const session of sessions) {
      const match = scoreSessionMatch(projectRoot, session.cwd);
      if (!match) continue;
      matches.push({
        ...session,
        matchKind: match.kind,
        matchScore: match.score,
      });
    }
    return matches
      .sort((a, b) => {
        const scoreDelta = (b.matchScore ?? 0) - (a.matchScore ?? 0);
        if (scoreDelta !== 0) return scoreDelta;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, limit);
  }

  public async findLatestSession(projectRoot: string): Promise<IndexedSession | null> {
    const [session] = await this.listProjectSessions(projectRoot, 1);
    return session ?? null;
  }

  public async findSessionById(projectRoot: string, sessionId: string): Promise<IndexedSession | null> {
    const sessions = await this.scanSessions();
    const candidate = sessions.find(s => s.sessionId === sessionId);
    if (!candidate) return null;
    const match = scoreSessionMatch(projectRoot, candidate.cwd);
    if (!match) return null;
    return { ...candidate, matchKind: match.kind, matchScore: match.score };
  }

  private buildArgs(options: BackendRunOptions & { projectConfig?: QwenProjectConfig }): string[] {
    const args: string[] = ['-p'];
    args.push('--output-format', 'stream-json');

    const approvalMode = options.projectConfig?.approvalMode ?? this.config.defaultApprovalMode;
    args.push('--approval-mode', approvalMode);

    const model = options.projectConfig?.model ?? this.config.defaultModel;
    if (model) {
      args.push('--model', model);
    }

    const allowedTools = options.projectConfig?.allowedTools ?? this.config.allowedTools;
    if (allowedTools && allowedTools.length > 0) {
      args.push('--allowed-tools', ...allowedTools);
    }

    const systemPromptAppend = options.projectConfig?.systemPromptAppend ?? this.config.systemPromptAppend;
    if (systemPromptAppend) {
      args.push('--append-system-prompt', systemPromptAppend);
    }

    if (options.sessionId) {
      args.push('--resume', options.sessionId);
    }

    args.push(options.prompt);
    return args;
  }

  private buildSpawnSpec(qwenArgs: string[]): { command: string; args: string[] } {
    if (!this.config.preExec) {
      return { command: this.config.bin, args: qwenArgs };
    }
    const shell = this.config.shell ?? process.env.SHELL ?? '/bin/zsh';
    const chainedCommand = `${this.config.preExec} && ${quoteShellCommand([this.config.bin, ...qwenArgs])}`;
    return { command: shell, args: ['-ic', chainedCommand] };
  }

  /**
   * Walk `~/.qwen/projects/<slug>/chats/*.jsonl` and parse the first
   * line of each file to extract `sessionId` + `cwd` + `timestamp`.
   *
   * Qwen encodes the project directory as the slug (e.g. `/Users/dh` →
   * `-Users-dh`). We don't depend on that mapping — we walk every slug
   * and match by parsed `cwd`.
   */
  private async scanSessions(): Promise<IndexedSession[]> {
    const projectsDir = path.join(this.qwenHomeDir, 'projects');
    const sessions = new Map<string, IndexedSession>();

    let slugEntries: string[];
    try {
      slugEntries = await fs.readdir(projectsDir);
    } catch {
      return [];
    }

    for (const slug of slugEntries) {
      const chatsDir = path.join(projectsDir, slug, 'chats');
      const chatFiles = await fs.readdir(chatsDir).catch(() => [] as string[]);

      for (const chatFile of chatFiles) {
        if (!chatFile.endsWith('.jsonl')) continue;
        const filePath = path.join(chatsDir, chatFile);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat?.isFile()) continue;

        try {
          const content = await fs.readFile(filePath, 'utf8');
          const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
          if (!firstLine) continue;

          const parsed = JSON.parse(firstLine) as QwenChatHeader;
          const sessionId = parsed.sessionId;
          const cwd = parsed.cwd;
          if (!sessionId || !cwd) continue;

          const createdAt = parsed.timestamp;
          const updatedAt = new Date(stat.mtimeMs).toISOString();

          const existing = sessions.get(sessionId);
          if (!existing || existing.updatedAt < updatedAt) {
            const record: IndexedSession = {
              sessionId,
              cwd,
              updatedAt,
              filePath,
              source: 'sessions' satisfies SessionSource,
              backend: 'qwen',
            };
            if (createdAt) {
              record.createdAt = createdAt;
            }
            sessions.set(sessionId, record);
          }
        } catch {
          continue;
        }
      }
    }

    return [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

function resolveQwenHomeDir(): string {
  const configured = process.env.QWEN_HOME?.trim();
  if (!configured) return path.join(os.homedir(), '.qwen');
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/')) return path.join(os.homedir(), configured.slice(2));
  return path.resolve(configured);
}

function quoteShellArg(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteShellCommand(parts: string[]): string {
  return parts.map(quoteShellArg).join(' ');
}

const FUZZY_SUFFIX_TOKENS = new Set(['bridge', 'repo', 'project', 'workspace']);

function scoreSessionMatch(projectRoot: string, sessionCwd: string): { kind: SessionMatchKind; score: number } | null {
  const normalizedProjectRoot = path.resolve(projectRoot).replace(/\/+$/, '').toLowerCase();
  const normalizedSessionRoot = path.resolve(sessionCwd).replace(/\/+$/, '').toLowerCase();

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

function normalizeProjectName(input: string): string {
  const tokens = input
    .toLowerCase()
    .replace(/\.git$/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const filtered = tokens.filter(token => !FUZZY_SUFFIX_TOKENS.has(token));
  return (filtered.length > 0 ? filtered : tokens).join('-');
}

// ---------------------------------------------------------------------------
// Registry definition
// ---------------------------------------------------------------------------

export const qwenBackendDefinition: BackendDefinition = {
  name: 'qwen',
  create(config) {
    return new QwenBackend({
      bin: config.qwen?.bin ?? 'qwen',
      shell: config.qwen?.shell ?? config.codex.shell,
      preExec: config.qwen?.pre_exec ?? config.codex.pre_exec,
      defaultApprovalMode: config.qwen?.default_approval_mode ?? 'default',
      defaultModel: config.qwen?.default_model,
      allowedTools: config.qwen?.allowed_tools,
      systemPromptAppend: config.qwen?.system_prompt_append,
      runTimeoutMs: config.qwen?.run_timeout_ms ?? config.codex.run_timeout_ms,
    });
  },
  probeSpec(config) {
    return {
      bin: config.qwen?.bin ?? 'qwen',
      shell: config.qwen?.shell ?? config.codex.shell,
      preExec: config.qwen?.pre_exec ?? config.codex.pre_exec,
    };
  },
  defaultFallback: ['claude', 'codex'],
};

registerBackend(qwenBackendDefinition);
