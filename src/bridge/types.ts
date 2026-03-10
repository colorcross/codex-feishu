export interface Mention {
  id?: string;
  name?: string;
}

export interface IncomingMessageContext {
  tenant_key?: string;
  chat_id: string;
  chat_type: 'p2p' | 'group' | 'unknown';
  actor_id?: string;
  actor_name?: string;
  sender_type?: string;
  message_id: string;
  text: string;
  mentions: Mention[];
  raw: unknown;
}

export interface IncomingCardActionContext {
  tenant_key?: string;
  chat_id?: string;
  actor_id?: string;
  open_message_id?: string;
  action_value: Record<string, unknown>;
  raw: unknown;
}

export interface BridgeReply {
  kind: 'text' | 'card';
  text?: string;
  card?: Record<string, unknown>;
}
