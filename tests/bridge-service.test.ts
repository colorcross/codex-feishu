import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCodexTurnMock = vi.fn();

vi.mock('../src/codex/runner.js', () => ({
  runCodexTurn: (...args: unknown[]) => runCodexTurnMock(...args),
  summarizeCodexEvent: vi.fn(() => null),
}));

import type { BridgeConfig } from '../src/config/schema.js';
import { CodexFeishuService } from '../src/bridge/service.js';
import { SessionStore, buildConversationKey } from '../src/state/session-store.js';
import { AuditLog } from '../src/state/audit-log.js';
import { IdempotencyStore } from '../src/state/idempotency-store.js';
import { RunStateStore } from '../src/state/run-state-store.js';

const tempDirs: string[] = [];
const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as any;

beforeEach(() => {
  runCodexTurnMock.mockReset();
  logger.debug.mockClear();
  logger.warn.mockClear();
  logger.info.mockClear();
  logger.error.mockClear();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('bridge service', () => {
  it('ignores duplicate inbound messages by message_id', async () => {
    const setup = await createService();
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-1',
      finalMessage: 'done',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'codex-cli 0.98.0', exec: {}, resume: {} },
    });

    const message = buildMessage('fix this');
    await setup.service.handleIncomingMessage(message);
    await setup.service.handleIncomingMessage(message);

    expect(runCodexTurnMock).toHaveBeenCalledTimes(1);
    expect(setup.sendText).toHaveBeenCalledTimes(1);
    expect((await setup.idempotencyStore.tail(10))[0]?.duplicate_count).toBe(1);
  });

  it('uses native Feishu reply when reply_quote_user_message is enabled', async () => {
    const setup = await createService({
      service: {
        reply_quote_user_message: true,
        reply_quote_max_chars: 120,
      },
    });
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-1',
      finalMessage: 'done',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'codex-cli 0.98.0', exec: {}, resume: {} },
    });

    await setup.service.handleIncomingMessage(buildMessage('请帮我看下当前路径', { message_id: 'm-reply' }));
    expect(setup.sendText).toHaveBeenCalledWith(
      'chat',
      expect.stringContaining('项目: default'),
      expect.objectContaining({ replyToMessageId: 'm-reply' }),
    );
  });

  it('supports listing and switching saved sessions', async () => {
    const setup = await createService();
    runCodexTurnMock
      .mockResolvedValueOnce({ sessionId: 'thread-1', finalMessage: 'first', stderr: '', exitCode: 0, capabilities: { version: 'v', exec: {}, resume: {} } })
      .mockResolvedValueOnce({ sessionId: 'thread-2', finalMessage: 'second', stderr: '', exitCode: 0, capabilities: { version: 'v', exec: {}, resume: {} } });

    await setup.service.handleIncomingMessage(buildMessage('first'));
    await setup.service.handleIncomingMessage(buildMessage('/session new', { message_id: 'm-new' }));
    await setup.service.handleIncomingMessage(buildMessage('second', { message_id: 'm-2' }));
    await setup.service.handleIncomingMessage(buildMessage('/session use thread-1', { message_id: 'm-use' }));

    const sessionKey = buildConversationKey({ tenantKey: 'tenant', chatId: 'chat', actorId: 'user', scope: 'chat' });
    const conversation = await setup.sessionStore.getConversation(sessionKey);
    expect(conversation?.projects.default?.thread_id).toBe('thread-1');

    await setup.service.handleIncomingMessage(buildMessage('/session list', { message_id: 'm-list' }));
    const lastReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(lastReply).toContain('thread-1');
    expect(lastReply).toContain('thread-2');
  });

  it('cancels an active run and records cancelled status', async () => {
    const setup = await createService();
    runCodexTurnMock.mockImplementation(
      (options: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const error = new Error(String(options.signal?.reason ?? 'aborted'));
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    const promptPromise = setup.service.handleIncomingMessage(buildMessage('long task'));
    await waitFor(() => expect(runCodexTurnMock).toHaveBeenCalledTimes(1));

    await setup.service.handleIncomingMessage(buildMessage('/cancel', { message_id: 'm-cancel' }));
    await promptPromise;

    const runs = await setup.runStateStore.listRuns();
    expect(runs[0]?.status).toBe('cancelled');
    expect(setup.sendText).toHaveBeenCalledWith('chat', expect.stringContaining('已提交取消请求'));
  });

  it('runs different projects in parallel within the same Feishu chat', async () => {
    const setup = await createService({
      projects: {
        'repo-a': { root: '/tmp/repo-a', session_scope: 'chat', mention_required: false, knowledge_paths: [], wiki_space_ids: [] },
        'repo-b': { root: '/tmp/repo-b', session_scope: 'chat', mention_required: false, knowledge_paths: [], wiki_space_ids: [] },
      },
      service: { name: 'test-bridge', default_project: 'repo-a', reply_mode: 'text', emit_progress_updates: false, progress_update_interval_ms: 4000, metrics_host: '127.0.0.1', idempotency_ttl_seconds: 86400, session_history_limit: 20, log_tail_lines: 100, reply_quote_user_message: false, reply_quote_max_chars: 120 },
    });

    const resolvers: Array<(value: unknown) => void> = [];
    runCodexTurnMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const first = setup.service.handleIncomingMessage(buildMessage('run a'));
    await waitFor(() => expect(runCodexTurnMock).toHaveBeenCalledTimes(1));

    await setup.service.handleIncomingMessage(buildMessage('/project repo-b', { message_id: 'm-project-b' }));
    const second = setup.service.handleIncomingMessage(buildMessage('run b', { message_id: 'm-run-b' }));
    await waitFor(() => expect(runCodexTurnMock).toHaveBeenCalledTimes(2));

    resolvers.shift()?.({ sessionId: 'thread-a', finalMessage: 'done-a', stderr: '', exitCode: 0, capabilities: { version: 'v', exec: {}, resume: {} } });
    resolvers.shift()?.({ sessionId: 'thread-b', finalMessage: 'done-b', stderr: '', exitCode: 0, capabilities: { version: 'v', exec: {}, resume: {} } });

    await Promise.all([first, second]);
    expect(runCodexTurnMock).toHaveBeenCalledTimes(2);
  });

  it('injects attachment metadata into the Codex prompt for media messages', async () => {
    const setup = await createService();
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-media',
      finalMessage: 'processed media',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });

    await setup.service.handleIncomingMessage({
      ...buildMessage('', { message_id: 'm-media' }),
      message_type: 'image',
      attachments: [{ kind: 'image', key: 'img_123', summary: 'image | key=img_123' }],
      text: '',
    });

    expect(runCodexTurnMock).toHaveBeenCalledTimes(1);
    expect(runCodexTurnMock.mock.calls[0]?.[0]?.prompt).toContain('Message attachments:');
    expect(runCodexTurnMock.mock.calls[0]?.[0]?.prompt).toContain('image | key=img_123');
  });

  it('searches project knowledge base through /kb search', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-kb-service-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'guide.md'), 'Use codex-feishu init --mode global\n', 'utf8');

    const setup = await createService({
      projects: {
        default: {
          root,
          session_scope: 'chat',
          mention_required: false,
          knowledge_paths: ['docs'],
          wiki_space_ids: [],
        },
      },
    });

    await setup.service.handleIncomingMessage(buildMessage('/kb search init', { message_id: 'm-kb' }));
    const reply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(reply).toContain('知识库搜索: init');
    expect(reply).toContain('docs/guide.md');
  });

  it('searches Feishu wiki documents through /wiki search', async () => {
    const setup = await createService();
    setup.feishuClient.createSdkClient.mockReturnValue({
      wiki: {
        v1: {
          node: {
            search: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                items: [
                  {
                    title: '部署手册',
                    space_id: 'space-1',
                    node_id: 'node-1',
                    obj_token: 'doxcn123',
                    url: 'https://example.feishu.cn/docx/doxcn123',
                  },
                ],
              },
            }),
          },
        },
        v2: {
          space: {
            list: vi.fn().mockResolvedValue({
              code: 0,
              data: { items: [], has_more: false },
            }),
          },
        },
      },
      docx: {
        v1: {
          document: {
            get: vi.fn(),
            rawContent: vi.fn(),
          },
        },
      },
    });

    await setup.service.handleIncomingMessage(buildMessage('/wiki search 部署', { message_id: 'm-wiki' }));
    const reply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(reply).toContain('飞书知识库搜索: 部署');
    expect(reply).toContain('部署手册');
    expect(reply).toContain('doxcn123');
  });

  it('creates a Feishu wiki document through /wiki create', async () => {
    const setup = await createService({
      projects: {
        default: {
          root: '/tmp/project',
          session_scope: 'chat',
          mention_required: false,
          knowledge_paths: [],
          wiki_space_ids: ['space-1'],
        },
      },
    });
    setup.feishuClient.createSdkClient.mockReturnValue({
      wiki: {
        v2: {
          spaceNode: {
            create: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                node: {
                  title: '部署手册',
                  space_id: 'space-1',
                  node_token: 'wikcn123',
                  obj_token: 'doxcn123',
                  obj_type: 'docx',
                },
              },
            }),
          },
        },
      },
    });

    await setup.service.handleIncomingMessage(buildMessage('/wiki create 部署手册', { message_id: 'm-wiki-create' }));
    const reply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(reply).toContain('已创建飞书文档: 部署手册');
    expect(reply).toContain('空间: space-1');
    expect(reply).toContain('文档: doxcn123');
  });

  it('renames a Feishu wiki node through /wiki rename', async () => {
    const updateTitle = vi.fn().mockResolvedValue({ code: 0, data: {} });
    const setup = await createService({
      projects: {
        default: {
          root: '/tmp/project',
          session_scope: 'chat',
          mention_required: false,
          knowledge_paths: [],
          wiki_space_ids: ['space-1'],
        },
      },
    });
    setup.feishuClient.createSdkClient.mockReturnValue({
      wiki: {
        v2: {
          spaceNode: {
            updateTitle,
          },
        },
      },
    });

    await setup.service.handleIncomingMessage(buildMessage('/wiki rename wikcn123 新标题', { message_id: 'm-wiki-rename' }));
    const reply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(reply).toContain('已更新知识库节点标题');
    expect(reply).toContain('节点: wikcn123');
    expect(reply).toContain('标题: 新标题');
    expect(updateTitle).toHaveBeenCalled();
  });
});

interface TestConfigOverrides extends Partial<Omit<BridgeConfig, 'service' | 'codex' | 'storage' | 'security' | 'feishu' | 'projects'>> {
  service?: Partial<BridgeConfig['service']>;
  codex?: Partial<BridgeConfig['codex']>;
  storage?: Partial<BridgeConfig['storage']>;
  security?: Partial<BridgeConfig['security']>;
  feishu?: Partial<BridgeConfig['feishu']>;
  projects?: BridgeConfig['projects'];
}

async function createService(overrides: TestConfigOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-service-'));
  tempDirs.push(dir);

  const config = buildConfig(dir, overrides);
  const sessionStore = new SessionStore(config.storage.dir);
  const auditLog = new AuditLog(config.storage.dir);
  const idempotencyStore = new IdempotencyStore(config.storage.dir);
  const runStateStore = new RunStateStore(config.storage.dir);
  const sendText = vi.fn().mockResolvedValue({ message_id: 'm-1', open_message_id: 'm-1' });
  const sendCard = vi.fn().mockResolvedValue({ message_id: 'm-card', open_message_id: 'm-card' });
  const createSdkClient = vi.fn(() => ({}));
  const feishuClient = { sendText, sendCard, createSdkClient } as any;
  const service = new CodexFeishuService(config, feishuClient, sessionStore, auditLog, logger, undefined, idempotencyStore, runStateStore);

  return {
    config,
    service,
    sendText,
    sendCard,
    feishuClient,
    sessionStore,
    idempotencyStore,
    runStateStore,
  };
}

function buildConfig(dir: string, overrides: TestConfigOverrides): BridgeConfig {
  const base: BridgeConfig = {
    version: 1,
    service: {
      name: 'test-bridge',
      default_project: 'default',
      reply_mode: 'text',
      emit_progress_updates: false,
      progress_update_interval_ms: 4000,
      metrics_host: '127.0.0.1',
      idempotency_ttl_seconds: 86400,
      session_history_limit: 20,
      log_tail_lines: 100,
      reply_quote_user_message: false,
      reply_quote_max_chars: 120,
    },
    codex: {
      bin: 'codex',
      default_sandbox: 'workspace-write',
      skip_git_repo_check: true,
      output_token_limit: 4000,
      bridge_instructions: '',
      run_timeout_ms: 600000,
    },
    storage: {
      dir,
    },
    security: {
      allowed_project_roots: [],
      require_group_mentions: true,
    },
    feishu: {
      app_id: 'cli_test',
      app_secret: 'secret',
      dry_run: false,
      transport: 'long-connection',
      host: '127.0.0.1',
      port: 3333,
      event_path: '/webhook/event',
      card_path: '/webhook/card',
      allowed_chat_ids: [],
      allowed_group_ids: [],
    },
    projects: {
      default: {
        root: '/tmp/project',
        session_scope: 'chat',
        mention_required: false,
        knowledge_paths: [],
        wiki_space_ids: [],
      },
    },
  };

  return {
    ...base,
    ...overrides,
    service: { ...base.service, ...overrides.service },
    codex: { ...base.codex, ...overrides.codex },
    storage: { ...base.storage, ...overrides.storage },
    security: { ...base.security, ...overrides.security },
    feishu: { ...base.feishu, ...overrides.feishu },
    projects: overrides.projects ?? base.projects,
  };
}

function buildMessage(text: string, overrides: Partial<Parameters<CodexFeishuService['handleIncomingMessage']>[0]> = {}) {
  return {
    tenant_key: 'tenant',
    chat_id: 'chat',
    chat_type: 'p2p' as const,
    actor_id: 'user',
    message_id: overrides.message_id ?? `m-${Math.random()}`,
    message_type: 'text',
    text,
    attachments: [],
    mentions: [],
    raw: {},
    ...overrides,
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assertion();
}
