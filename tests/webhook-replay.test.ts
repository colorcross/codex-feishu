import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReplayCardAction, buildReplayMessageEvent, postWebhookPayload, requestWebhookEndpoint } from '../src/feishu/replay.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

describe('webhook replay helpers', () => {
  it('builds a replayable message event payload', () => {
    const payload = buildReplayMessageEvent({
      chatId: 'oc_123',
      actorId: 'ou_123',
      text: 'hello',
      chatType: 'p2p',
    });

    expect(payload).toMatchObject({
      schema: '2.0',
      header: {
        event_type: 'im.message.receive_v1',
      },
      event: {
        message: {
          chat_id: 'oc_123',
          chat_type: 'p2p',
        },
      },
    });
  });

  it('posts replay payloads to a local webhook endpoint', async () => {
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(body);
      });
    });
    servers.push(server);

    const address = await new Promise<{ port: number }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(server.address() as { port: number });
      });
    });

    const payload = buildReplayCardAction({
      chatId: 'oc_123',
      actorId: 'ou_123',
      openMessageId: 'om_123',
      action: 'status',
      projectAlias: 'repo-a',
      conversationKey: 'tenant/chat/ou_123',
    });

    const response = await postWebhookPayload({
      url: `http://127.0.0.1:${address.port}/webhook/card`,
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      header: {
        event_type: 'card.action.trigger',
      },
      event: {
        open_message_id: 'om_123',
      },
    });
  });

  it('issues GET requests for smoke health probes', async () => {
    const server = http.createServer((request, response) => {
      response.statusCode = request.url === '/healthz' ? 200 : 404;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: request.url === '/healthz' }));
    });
    servers.push(server);

    const address = await new Promise<{ port: number }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(server.address() as { port: number });
      });
    });

    const response = await requestWebhookEndpoint({
      url: `http://127.0.0.1:${address.port}/healthz`,
      method: 'GET',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ok: true });
  });
});
