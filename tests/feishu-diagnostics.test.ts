import { describe, expect, it } from 'vitest';
import { formatFeishuInspect, inspectFeishuEnvironment } from '../src/feishu/diagnostics.js';
import type { BridgeConfig } from '../src/config/schema.js';

const config: BridgeConfig['feishu'] = {
  app_id: 'cli_test',
  app_secret: 'secret',
  dry_run: false,
  transport: 'long-connection',
  host: '0.0.0.0',
  port: 3333,
  event_path: '/webhook/event',
  card_path: '/webhook/card',
  allowed_chat_ids: [],
  allowed_group_ids: [],
};

describe('feishu diagnostics', () => {
  it('summarizes app, bot, and chat probe responses', async () => {
    const requester = async ({ method, url }: { method: string; url: string }) => {
      if (method === 'POST' && url.endsWith('/tenant_access_token/internal')) {
        return {
          status: 200,
          body: {
            code: 0,
            msg: 'ok',
            expire: 7200,
            tenant_access_token: 'token',
          },
        };
      }
      if (url.includes('/applications/')) {
        return {
          status: 200,
          body: {
            code: 0,
            msg: 'ok',
            data: {
              app: {
                app_name: '源码牛',
                status: 2,
                pc_default_ability: null,
                mobile_default_ability: 'bot',
              },
            },
          },
        };
      }
      if (url.endsWith('/bot/v3/info')) {
        return {
          status: 200,
          body: {
            code: 0,
            msg: 'ok',
            bot: {
              app_name: '源码牛',
              open_id: 'ou_1234567890',
              activate_status: 1,
            },
          },
        };
      }
      return {
        status: 400,
        body: {
          code: 232034,
          msg: 'The app is unavailable or inactivate in the tenant.',
          data: {
            items: [],
          },
        },
      };
    };

    const result = await inspectFeishuEnvironment(config, requester as any);
    expect(result.token.ok).toBe(true);
    expect(result.app.ok).toBe(true);
    expect(result.app.name).toBe('源码牛');
    expect(result.bot.open_id).toBe('ou_1234567890');
    expect(result.chats_probe.ok).toBe(false);
    expect(result.chats_probe.code).toBe(232034);
  });

  it('formats the inspect result for terminal output', () => {
    const text = formatFeishuInspect({
      app_id: 'cli_test',
      transport: 'webhook',
      token: {
        ok: true,
        code: 0,
        msg: 'ok',
        expire: 7200,
      },
      app: {
        ok: true,
        code: 0,
        msg: 'ok',
        name: '源码牛',
        status: 2,
        pc_default_ability: null,
        mobile_default_ability: 'bot',
      },
      bot: {
        ok: true,
        code: 0,
        msg: 'ok',
        name: '源码牛',
        open_id: 'ou_1234567890',
        activate_status: 1,
      },
      chats_probe: {
        ok: false,
        code: 232034,
        msg: 'The app is unavailable or inactivate in the tenant.',
        count: 0,
      },
    });

    expect(text).toContain('App ID: cli_test');
    expect(text).toContain('[im.chats] ok=false code=232034');
    expect(text).toContain('ou_123...');
  });
});
