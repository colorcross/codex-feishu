import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = path.join(repoRoot, 'src', 'cli.ts');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('mcp server', () => {
  it('serves initialize, tools/list, and status.get over stdio MCP', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-mcp-'));
    tempDirs.push(cwd);
    const configPath = path.join(cwd, 'bridge.toml');
    await fs.writeFile(
      configPath,
      [
        'version = 1',
        '',
        '[service]',
        'name = "test-bridge"',
        '',
        '[storage]',
        `dir = "${path.join(cwd, 'state')}"`,
        '',
        '[feishu]',
        'app_id = "app-id"',
        'app_secret = "app-secret"',
        '',
        '[projects.default]',
        `root = "${cwd}"`,
      ].join('\n'),
      'utf8',
    );

    const child = spawn(tsxBin, [cliEntry, 'mcp', '--config', configPath], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);

    const client = new McpTestClient(child);
    const init = await client.request(1, 'initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '1.0.0' } });
    expect(init.result).toMatchObject({
      serverInfo: {
        name: 'codex-feishu',
      },
      capabilities: {
        tools: {},
      },
    });

    await client.notify('notifications/initialized', {});

    const tools = await client.request(2, 'tools/list', {});
    const toolNames = ((tools.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
    expect(toolNames).toContain('projects.list');
    expect(toolNames).toContain('status.get');
    expect(toolNames).toContain('config.history');

    const status = await client.request(3, 'tools/call', { name: 'status.get', arguments: {} });
    expect((status.result as { structuredContent?: { running: boolean } }).structuredContent?.running).toBe(false);
  });
});

class McpTestClient {
  private buffer = Buffer.alloc(0);

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    });
  }

  public async request(id: number, method: string, params: Record<string, unknown>): Promise<{ id: number; result?: unknown; error?: unknown }> {
    this.write({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });
    return this.readMessage(id);
  }

  public async notify(method: string, params: Record<string, unknown>): Promise<void> {
    this.write({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  private write(payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  private async readMessage(expectedId: number): Promise<{ id: number; result?: unknown; error?: unknown }> {
    const deadline = Date.now() + 5000;
    while (true) {
      const parsed = this.tryParseMessage();
      if (parsed) {
        if (parsed.id === expectedId) {
          return parsed as { id: number; result?: unknown; error?: unknown };
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for MCP response.');
      }
      if (this.child.exitCode !== null) {
        throw new Error('MCP child exited before sending a response.');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private tryParseMessage(): Record<string, unknown> | null {
    const headerEnd = this.buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      return null;
    }
    const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
    const match = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      throw new Error('Missing Content-Length header in MCP response.');
    }
    const contentLength = Number(match[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (this.buffer.length < messageEnd) {
      return null;
    }
    const payload = this.buffer.slice(messageStart, messageEnd).toString('utf8');
    this.buffer = this.buffer.slice(messageEnd);
    return JSON.parse(payload) as Record<string, unknown>;
  }
}
