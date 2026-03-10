import https from 'node:https';
import { URL } from 'node:url';
import type { BridgeConfig } from '../config/schema.js';

interface FeishuAppInfo {
  app_id?: string;
  app_name?: string;
  status?: number;
  pc_default_ability?: string | null;
  mobile_default_ability?: string | null;
}

interface FeishuBotInfo {
  app_name?: string;
  open_id?: string;
  avatar_url?: string;
  activate_status?: number;
}

interface HttpJsonResponse {
  status: number;
  body: unknown;
}

type Requester = (request: {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<HttpJsonResponse>;

export interface FeishuProbeSummary {
  ok: boolean;
  code?: number | string;
  msg?: string;
  http_status?: number;
}

export interface FeishuInspectResult {
  app_id: string;
  transport: BridgeConfig['feishu']['transport'];
  token: FeishuProbeSummary & {
    expire?: number;
  };
  app: FeishuProbeSummary & {
    name?: string;
    status?: number;
    pc_default_ability?: string | null;
    mobile_default_ability?: string | null;
  };
  bot: FeishuProbeSummary & {
    name?: string;
    open_id?: string;
    activate_status?: number;
  };
  chats_probe: FeishuProbeSummary & {
    count?: number;
  };
}

interface FeishuEnvelope<T = unknown> {
  code?: number | string;
  msg?: string;
  expire?: number;
  tenant_access_token?: string;
  data?: T;
  bot?: FeishuBotInfo;
}

interface TokenResponse {
  envelope: FeishuEnvelope;
  httpStatus?: number;
}

export async function inspectFeishuEnvironment(
  config: BridgeConfig['feishu'],
  requester: Requester = requestJsonOverHttps,
): Promise<FeishuInspectResult> {
  const tokenResponse = await fetchTenantAccessToken(config, requester);
  const token = tokenResponse.envelope.tenant_access_token;

  if (!token || !isEnvelopeOk(tokenResponse.envelope)) {
    return {
      app_id: config.app_id,
      transport: config.transport,
      token: {
        ok: false,
        code: tokenResponse.envelope.code,
        msg: tokenResponse.envelope.msg,
        http_status: tokenResponse.httpStatus,
        expire: tokenResponse.envelope.expire,
      },
      app: { ok: false, msg: 'Skipped because token acquisition failed.' },
      bot: { ok: false, msg: 'Skipped because token acquisition failed.' },
      chats_probe: { ok: false, msg: 'Skipped because token acquisition failed.' },
    };
  }

  const [appResponse, botResponse, chatsResponse] = await Promise.all([
    feishuGet<{ app?: FeishuAppInfo }>(token, `https://open.feishu.cn/open-apis/application/v6/applications/${config.app_id}?lang=zh_cn`, requester),
    feishuGet<unknown>(token, 'https://open.feishu.cn/open-apis/bot/v3/info', requester),
    feishuGet<{ items?: unknown[] }>(token, 'https://open.feishu.cn/open-apis/im/v1/chats?page_size=1', requester),
  ]);

  const botInfo = botResponse.envelope.bot ?? (isRecord(botResponse.envelope.data) ? (botResponse.envelope.data as FeishuBotInfo) : undefined);

  return {
    app_id: config.app_id,
    transport: config.transport,
    token: {
      ok: true,
      code: tokenResponse.envelope.code,
      msg: tokenResponse.envelope.msg,
      http_status: tokenResponse.httpStatus,
      expire: tokenResponse.envelope.expire,
    },
    app: {
      ...toProbeSummary(appResponse),
      name: appResponse.envelope.data?.app?.app_name,
      status: appResponse.envelope.data?.app?.status,
      pc_default_ability: appResponse.envelope.data?.app?.pc_default_ability ?? null,
      mobile_default_ability: appResponse.envelope.data?.app?.mobile_default_ability ?? null,
    },
    bot: {
      ...toProbeSummary(botResponse),
      name: botInfo?.app_name,
      open_id: botInfo?.open_id,
      activate_status: botInfo?.activate_status,
    },
    chats_probe: {
      ...toProbeSummary(chatsResponse),
      count: chatsResponse.envelope.data?.items?.length,
    },
  };
}

export function formatFeishuInspect(result: FeishuInspectResult): string {
  return [
    `App ID: ${result.app_id}`,
    `Transport: ${result.transport}`,
    '',
    `[token] ok=${result.token.ok} code=${stringOrDash(result.token.code)} msg=${stringOrDash(result.token.msg)} expire=${stringOrDash(result.token.expire)}`,
    `[app] ok=${result.app.ok} code=${stringOrDash(result.app.code)} msg=${stringOrDash(result.app.msg)}`,
    `  name=${stringOrDash(result.app.name)} status=${stringOrDash(result.app.status)} pc_default_ability=${stringOrDash(result.app.pc_default_ability)} mobile_default_ability=${stringOrDash(result.app.mobile_default_ability)}`,
    `[bot] ok=${result.bot.ok} code=${stringOrDash(result.bot.code)} msg=${stringOrDash(result.bot.msg)}`,
    `  name=${stringOrDash(result.bot.name)} activate_status=${stringOrDash(result.bot.activate_status)} open_id=${mask(result.bot.open_id)}`,
    `[im.chats] ok=${result.chats_probe.ok} code=${stringOrDash(result.chats_probe.code)} msg=${stringOrDash(result.chats_probe.msg)} count=${stringOrDash(result.chats_probe.count)}`,
  ].join('\n');
}

async function fetchTenantAccessToken(config: BridgeConfig['feishu'], requester: Requester): Promise<TokenResponse> {
  try {
    const response = await requester({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        connection: 'close',
      },
      body: JSON.stringify({
        app_id: config.app_id,
        app_secret: config.app_secret,
      }),
      timeoutMs: 5000,
    });

    return {
      httpStatus: response.status,
      envelope: normalizeEnvelope(response.body),
    };
  } catch (error) {
    return {
      envelope: {
        msg: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function feishuGet<T>(token: string, url: string, requester: Requester): Promise<{ httpStatus?: number; envelope: FeishuEnvelope<T> }> {
  try {
    const response = await requester({
      method: 'GET',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        connection: 'close',
      },
      timeoutMs: 5000,
    });

    return {
      httpStatus: response.status,
      envelope: normalizeEnvelope<T>(response.body),
    };
  } catch (error) {
    return {
      envelope: {
        msg: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function toProbeSummary<T>(response: { httpStatus?: number; envelope: FeishuEnvelope<T> }): FeishuProbeSummary {
  return {
    ok: isEnvelopeOk(response.envelope),
    code: response.envelope.code,
    msg: response.envelope.msg,
    http_status: response.httpStatus,
  };
}

function normalizeEnvelope<T = unknown>(value: unknown): FeishuEnvelope<T> {
  return isRecord(value) ? (value as FeishuEnvelope<T>) : {};
}

function isEnvelopeOk(envelope: FeishuEnvelope): boolean {
  return envelope.code === undefined || envelope.code === 0 || envelope.code === '0';
}

function stringOrDash(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  return String(value);
}

function mask(value: string | undefined): string {
  if (!value) {
    return '-';
  }
  if (value.length <= 8) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestJsonOverHttps(request: {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<HttpJsonResponse> {
  return new Promise<HttpJsonResponse>((resolve, reject) => {
    const target = new URL(request.url);
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: request.headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          try {
            const bodyText = Buffer.concat(chunks).toString('utf8');
            const body = bodyText ? JSON.parse(bodyText) : {};
            resolve({
              status: response.statusCode ?? 0,
              body,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.setTimeout(request.timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${request.timeoutMs}ms`));
    });
    req.on('error', reject);
    if (request.body) {
      req.write(request.body);
    }
    req.end();
  });
}
