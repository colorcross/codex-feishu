import { tryParseJson } from '../utils/json.js';
import type { IncomingCardActionContext, IncomingMessageContext, Mention } from '../bridge/types.js';

interface FeishuTextContent {
  text?: string;
}

export function extractIncomingMessage(raw: unknown): IncomingMessageContext | null {
  const body = asObject(raw);
  const event = asObject(body?.event);
  const source = event ?? body;
  const header = asObject(body?.header);
  const message = asObject(source?.message);
  if (!message) {
    return null;
  }

  const contentText = extractTextContent(message.content);
  if (!contentText) {
    return null;
  }

  const sender = asObject(source?.sender);
  const senderId = firstString(asObject(sender?.sender_id)?.open_id, asObject(sender?.sender_id)?.user_id, asObject(sender?.sender_id)?.union_id);
  const senderName = typeof sender?.sender_type === 'string' ? undefined : firstString((sender as Record<string, unknown>).name);
  const mentions = Array.isArray(message.mentions)
    ? message.mentions.map((mention) => {
        const mentionObject = asObject(mention);
        const mentionId = firstString(
          asObject(mentionObject?.id)?.open_id,
          asObject(mentionObject?.id)?.user_id,
          asObject(mentionObject?.id)?.union_id,
        );
        const mentionName = firstString(mentionObject?.name, asObject(mentionObject?.name)?.name);
        return { id: mentionId, name: mentionName } satisfies Mention;
      })
    : [];

  return {
    tenant_key: firstString(header?.tenant_key, body?.tenant_key),
    chat_id: firstString(message.chat_id) ?? '',
    chat_type: normalizeChatType(firstString(message.chat_type)),
    actor_id: senderId,
    actor_name: senderName,
    sender_type: firstString(sender?.sender_type),
    message_id: firstString(message.message_id) ?? '',
    text: contentText,
    mentions,
    raw,
  };
}

export function extractCardAction(raw: unknown): IncomingCardActionContext | null {
  const body = asObject(raw);
  const event = asObject(body?.event);
  const source = event ?? body;
  const openMessageId = firstString(source?.open_message_id, source?.openMessageId);
  const operator = asObject(source?.operator);
  const action = asObject(source?.action);
  const tenantKey = firstString(source?.tenant_key, asObject(source?.tenant_key)?.tenant_key, body?.tenant_key, asObject(body?.tenant_key)?.tenant_key);
  const chatId = firstString(source?.open_chat_id, source?.chat_id);
  const actorId = firstString(asObject(operator?.open_id)?.open_id, operator?.open_id, operator?.user_id, operator?.union_id);
  const actionValue = asObject(action?.value) ?? {};

  return {
    tenant_key: tenantKey,
    chat_id: chatId,
    actor_id: actorId,
    open_message_id: openMessageId,
    action_value: actionValue,
    raw,
  };
}

export function shouldAllowChat(config: { allowed_chat_ids: string[]; allowed_group_ids: string[] }, chatId: string, chatType: string): boolean {
  if (chatType === 'p2p') {
    return config.allowed_chat_ids.length === 0 || config.allowed_chat_ids.includes(chatId);
  }
  return config.allowed_group_ids.length === 0 || config.allowed_group_ids.includes(chatId);
}

function extractTextContent(content: unknown): string | null {
  if (typeof content !== 'string') {
    return null;
  }
  const parsed = tryParseJson<FeishuTextContent>(content);
  if (parsed?.text) {
    return parsed.text.trim();
  }
  return null;
}

function normalizeChatType(input: string | undefined): IncomingMessageContext['chat_type'] {
  if (input === 'p2p') {
    return 'p2p';
  }
  if (input === 'group') {
    return 'group';
  }
  return 'unknown';
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value) => typeof value === 'string' && value.length > 0) as string | undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
