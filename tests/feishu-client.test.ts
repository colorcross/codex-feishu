import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuClient } from '../src/feishu/client.js';
import type { BridgeConfig } from '../src/config/schema.js';

const { requestMock, clientCtorMock, wsClientCtorMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  clientCtorMock: vi.fn(),
  wsClientCtorMock: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    public constructor(...args: unknown[]) {
      clientCtorMock(...args);
    }

    public request = requestMock;
  },
  WSClient: class MockWsClient {
    public constructor(...args: unknown[]) {
      wsClientCtorMock(...args);
    }
  },
  Domain: { Feishu: 'Feishu' },
  AppType: { SelfBuild: 'SelfBuild' },
  LoggerLevel: { warn: 'warn' },
}));

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as any;

const config: BridgeConfig['feishu'] = {
  app_id: 'app-id',
  app_secret: 'app-secret',
  dry_run: false,
  transport: 'long-connection',
  host: '0.0.0.0',
  port: 3333,
  event_path: '/webhook/event',
  card_path: '/webhook/card',
  allowed_chat_ids: [],
  allowed_group_ids: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  requestMock.mockReset();
  clientCtorMock.mockClear();
  wsClientCtorMock.mockClear();
  logger.debug.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FeishuClient', () => {
  it('retries transient HTTP failures and succeeds', async () => {
    requestMock
      .mockRejectedValueOnce({
        message: 'Too Many Requests',
        response: { status: 429, headers: { 'retry-after': '1' } },
      })
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'message-1' } });

    const client = new FeishuClient(config, logger);
    const promise = client.sendText('chat-1', 'hello');

    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toEqual({ message_id: 'message-1' });
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retryable API errors', async () => {
    requestMock.mockResolvedValueOnce({ code: 9999, msg: 'invalid app credential' });

    const client = new FeishuClient(config, logger);

    await expect(client.sendCard('chat-1', { type: 'status' })).rejects.toThrow('Feishu API error 9999: invalid app credential');
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips outbound API calls when dry_run is enabled', async () => {
    const client = new FeishuClient(
      {
        ...config,
        dry_run: true,
      },
      logger,
    );

    await expect(client.sendText('chat-1', 'hello dry run')).resolves.toMatchObject({
      message_id: expect.stringContaining('dry-run-'),
      open_message_id: expect.stringContaining('dry-run-'),
    });
    expect(requestMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        receiveIdType: 'chat_id',
        receiveId: 'chat-1',
        msgType: 'text',
      }),
      'Skipped Feishu outbound send because dry_run is enabled',
    );
  });

  it('uses the native reply API when replyToMessageId is provided', async () => {
    requestMock.mockResolvedValueOnce({ code: 0, data: { message_id: 'reply-1', root_id: 'message-1' } });

    const client = new FeishuClient(config, logger);

    await expect(client.sendText('chat-1', 'reply body', { replyToMessageId: 'message-1' })).resolves.toEqual({
      message_id: 'reply-1',
      root_id: 'message-1',
    });

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/open-apis/im/v1/messages/message-1/reply',
        data: expect.objectContaining({
          msg_type: 'text',
          content: JSON.stringify({ text: 'reply body' }),
          reply_in_thread: false,
        }),
      }),
    );
  });
});
