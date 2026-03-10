import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logging.js';
import { extractIncomingMessage, shouldAllowChat } from './extractors.js';
import type { BridgeConfig } from '../config/schema.js';
import { CodexFeishuService } from '../bridge/service.js';
import { FeishuClient } from './client.js';
import { waitForShutdownSignal } from '../runtime/shutdown.js';

export async function startLongConnectionBridge(input: {
  config: BridgeConfig;
  service: CodexFeishuService;
  feishuClient: FeishuClient;
  logger: Logger;
}): Promise<NodeJS.Signals> {
  const client = input.feishuClient.createWsClient();

  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (payload: unknown) => {
      const message = extractIncomingMessage(payload);
      if (!message) {
        return;
      }
      if (message.sender_type && message.sender_type !== 'user') {
        input.logger.info({ chatId: message.chat_id, senderType: message.sender_type, messageId: message.message_id }, 'Ignoring non-user message');
        return;
      }
      if (!shouldAllowChat(input.config.feishu, message.chat_id, message.chat_type)) {
        input.logger.info({ chatId: message.chat_id }, 'Ignoring message from disallowed chat');
        return;
      }
      await input.service.handleIncomingMessage(message);
    },
  });

  await client.start({ eventDispatcher: dispatcher });
  input.logger.info('Feishu long-connection bridge started');

  return waitForShutdownSignal({
    logger: input.logger,
    onShutdown: (signal) => {
      client.close();
      input.logger.info({ signal }, 'Feishu long-connection bridge stopped');
    },
  });
}
