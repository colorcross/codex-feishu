import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import packageJson from '../../package.json' with { type: 'json' };
import { loadBridgeConfig, loadRuntimeConfig } from '../config/load.js';
import { ConfigHistoryStore } from '../state/config-history-store.js';
import { RunStateStore } from '../state/run-state-store.js';
import { fileExists, writeUtf8Atomic } from '../utils/fs.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'projects.list',
    description: 'List configured projects and their key isolation settings.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'status.get',
    description: 'Return runtime status, pid, active runs, and key storage paths.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'runs.list',
    description: 'List active runs or all saved runs from the local state store.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        all: { type: 'boolean' },
      },
    },
  },
  {
    name: 'config.history',
    description: 'Return recent config snapshots recorded by admin operations.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: 'config.rollback',
    description: 'Roll back the writable config file to a previous snapshot. A service restart may still be required.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string' },
      },
    },
  },
  {
    name: 'service.restart',
    description: 'Restart the codex-feishu background service with the current config.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
];

export async function startMcpServer(options: { cwd: string; configPath?: string }): Promise<void> {
  const parser = new StdioMessageParser(async (request) => {
    const response = await handleRequest(request, options);
    if (response) {
      process.stdout.write(encodeMessage(response));
    }
  });

  process.stdin.on('data', (chunk: Buffer) => {
    parser.push(chunk);
  });
  process.stdin.on('end', () => {
    process.exit(0);
  });
  process.stdin.resume();
}

async function handleRequest(request: JsonRpcRequest, options: { cwd: string; configPath?: string }): Promise<JsonRpcResponse | null> {
  if (request.method === 'notifications/initialized') {
    return null;
  }

  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-03-26',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'codex-feishu',
          version: packageJson.version,
        },
        instructions: 'Use the provided tools to inspect codex-feishu projects, runtime status, runs, and config history.',
      },
    };
  }

  if (request.method === 'ping') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {},
    };
  }

  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        tools: TOOL_DEFINITIONS,
      },
    };
  }

  if (request.method === 'tools/call') {
    try {
      const result = await handleToolCall(request.params ?? {}, options);
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result,
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    error: {
      code: -32601,
      message: `Method not found: ${request.method}`,
    },
  };
}

async function handleToolCall(params: Record<string, unknown>, options: { cwd: string; configPath?: string }): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}> {
  const name = typeof params.name === 'string' ? params.name : '';
  const argumentsObject = isPlainObject(params.arguments) ? (params.arguments as Record<string, unknown>) : {};

  switch (name) {
    case 'projects.list': {
      const { config } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const projects = Object.entries(config.projects).map(([alias, project]) => ({
        alias,
        root: project.root,
        session_scope: project.session_scope,
        mention_required: project.mention_required,
        admin_chat_ids: project.admin_chat_ids,
        download_dir: project.download_dir ?? null,
        temp_dir: project.temp_dir ?? null,
        chat_rate_limit_window_seconds: project.chat_rate_limit_window_seconds,
        chat_rate_limit_max_runs: project.chat_rate_limit_max_runs,
      }));
      return {
        content: [{ type: 'text', text: projects.length > 0 ? renderJson(projects) : 'No projects configured.' }],
        structuredContent: { projects },
      };
    }
    case 'status.get': {
      const { config } = await loadRuntimeConfig({ cwd: options.cwd, configPath: options.configPath });
      const status = await inspectRuntimeStatus(config);
      return {
        content: [{ type: 'text', text: renderJson(status) }],
        structuredContent: status,
      };
    }
    case 'runs.list': {
      const { config } = await loadRuntimeConfig({ cwd: options.cwd, configPath: options.configPath });
      const runStateStore = new RunStateStore(config.storage.dir);
      const runs = argumentsObject.all === true ? await runStateStore.listRuns() : await runStateStore.listActiveRuns();
      return {
        content: [{ type: 'text', text: renderJson(runs) }],
        structuredContent: { runs },
      };
    }
    case 'config.history': {
      const { config, sources } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const writableConfigPath = resolveWritableConfigPath(options.configPath, sources);
      const store = new ConfigHistoryStore(config.storage.dir);
      const limit = typeof argumentsObject.limit === 'number' ? Math.max(1, Math.min(20, Math.trunc(argumentsObject.limit))) : 5;
      const snapshots = await store.listSnapshots(limit);
      return {
        content: [{ type: 'text', text: renderJson({ writableConfigPath, snapshots }) }],
        structuredContent: { writableConfigPath, snapshots },
      };
    }
    case 'config.rollback': {
      const { config, sources } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const writableConfigPath = resolveWritableConfigPath(options.configPath, sources);
      if (!writableConfigPath) {
        throw new Error('No writable config path resolved for rollback.');
      }
      const store = new ConfigHistoryStore(config.storage.dir);
      const target = await store.getSnapshot(typeof argumentsObject.target === 'string' ? argumentsObject.target : undefined);
      if (!target) {
        throw new Error('Target config snapshot not found.');
      }
      await writeUtf8Atomic(writableConfigPath, target.content);
      return {
        content: [{ type: 'text', text: `Rolled back config to snapshot ${target.id}. Restart the service if you need in-memory config to reload.` }],
        structuredContent: { snapshot: target.id, configPath: writableConfigPath },
      };
    }
    case 'service.restart': {
      const { config, sources } = await loadBridgeConfig({ cwd: options.cwd, configPath: options.configPath });
      const writableConfigPath = resolveWritableConfigPath(options.configPath, sources);
      await restartServiceProcess(options.cwd, writableConfigPath, config.service.name);
      return {
        content: [{ type: 'text', text: 'Service restart command submitted.' }],
        structuredContent: { restarted: true, service: config.service.name },
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

class StdioMessageParser {
  private buffer = Buffer.alloc(0);

  public constructor(private readonly onMessage: (request: JsonRpcRequest) => Promise<void>) {}

  public push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        throw new Error('Missing Content-Length header.');
      }
      const contentLength = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) {
        return;
      }
      const payload = this.buffer.slice(messageStart, messageEnd).toString('utf8');
      this.buffer = this.buffer.slice(messageEnd);
      await this.onMessage(JSON.parse(payload) as JsonRpcRequest);
    }
  }
}

function encodeMessage(payload: JsonRpcResponse): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

async function inspectRuntimeStatus(config: { service: { name: string }; storage: { dir: string } }): Promise<{
  running: boolean;
  pid?: number;
  pidPath: string;
  logPath: string;
  activeRuns: number;
}> {
  const pidPath = path.join(config.storage.dir, `${config.service.name}.pid`);
  const logPath = path.join(config.storage.dir, `${config.service.name}.log`);
  const pid = await readPid(pidPath);
  const runStateStore = new RunStateStore(config.storage.dir);
  return {
    running: pid !== null && (await isRunningPid(pid)),
    ...(pid !== null ? { pid } : {}),
    pidPath,
    logPath,
    activeRuns: (await runStateStore.listActiveRuns()).length,
  };
}

async function readPid(filePath: string): Promise<number | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }
  const raw = (await fs.readFile(filePath, 'utf8')).trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function isRunningPid(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveWritableConfigPath(explicitConfigPath: string | undefined, sources: string[]): string | null {
  if (explicitConfigPath) {
    return path.resolve(explicitConfigPath);
  }
  return sources[0] ?? null;
}

async function restartServiceProcess(cwd: string, configPath: string | null, serviceName: string): Promise<void> {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('Unable to resolve CLI entry for restart.');
  }
  await new Promise<void>((resolve, reject) => {
    const args = [...process.execArgv, cliEntry, 'restart'];
    if (configPath) {
      args.push('--config', path.resolve(configPath));
    }
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => resolve());
  });
  void serviceName;
}

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
