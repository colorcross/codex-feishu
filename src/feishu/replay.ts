import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export function buildReplayMessageEvent(input: {
  appId?: string;
  tenantKey?: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  actorId: string;
  senderType?: string;
  text: string;
  messageId?: string;
}): Record<string, unknown> {
  const now = Date.now();
  return {
    schema: '2.0',
    header: {
      event_id: `evt_${now}`,
      event_type: 'im.message.receive_v1',
      create_time: String(now),
      token: 'local-replay',
      app_id: input.appId ?? 'local-app',
      tenant_key: input.tenantKey ?? 'tenant-local',
    },
    event: {
      sender: {
        sender_id: {
          open_id: input.actorId,
        },
        sender_type: input.senderType ?? 'user',
      },
      message: {
        message_id: input.messageId ?? `om_${now}`,
        create_time: String(now),
        chat_id: input.chatId,
        chat_type: input.chatType,
        message_type: 'text',
        content: JSON.stringify({ text: input.text }),
        mentions: [],
      },
    },
  };
}

export function buildReplayCardAction(input: {
  appId?: string;
  tenantKey?: string;
  chatId: string;
  actorId: string;
  openMessageId: string;
  action: string;
  projectAlias?: string;
  conversationKey?: string;
}): Record<string, unknown> {
  const now = Date.now();
  return {
    schema: '2.0',
    header: {
      event_id: `evt_${now}`,
      event_type: 'card.action.trigger',
      create_time: String(now),
      token: 'local-replay',
      app_id: input.appId ?? 'local-app',
      tenant_key: input.tenantKey ?? 'tenant-local',
    },
    event: {
      open_message_id: input.openMessageId,
      open_chat_id: input.chatId,
      tenant_key: input.tenantKey ?? 'tenant-local',
      operator: {
        open_id: input.actorId,
      },
      action: {
        value: {
          action: input.action,
          ...(input.projectAlias ? { project_alias: input.projectAlias } : {}),
          ...(input.conversationKey ? { conversation_key: input.conversationKey } : {}),
          chat_id: input.chatId,
        },
      },
    },
  };
}

export async function postWebhookPayload(input: {
  url: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{
  statusCode: number;
  body: string;
}> {
  return requestWebhookEndpoint({
    url: input.url,
    payload: input.payload,
    timeoutMs: input.timeoutMs,
  });
}

export async function requestWebhookEndpoint(input: {
  url: string;
  method?: 'GET' | 'POST';
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{
  statusCode: number;
  body: string;
}> {
  const target = new URL(input.url);
  const method = input.method ?? (input.payload ? 'POST' : 'GET');
  const body = input.payload ? JSON.stringify(input.payload) : undefined;

  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80,
        method,
        path: `${target.pathname}${target.search}`,
        ...(body
          ? {
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'content-length': Buffer.byteLength(body),
              },
            }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    request.setTimeout(input.timeoutMs ?? 5000, () => {
      request.destroy(new Error(`Webhook replay timed out after ${input.timeoutMs ?? 5000}ms`));
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}
