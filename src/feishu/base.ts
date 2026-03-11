import * as lark from '@larksuiteoapi/node-sdk';

export interface FeishuBaseTable {
  tableId: string;
  name?: string;
  revision?: number;
}

export interface FeishuBaseRecord {
  recordId: string;
  fields: Record<string, unknown>;
  recordUrl?: string;
}

export class FeishuBaseClient {
  public constructor(private readonly client: lark.Client) {}

  public async listTables(appToken: string, limit: number = 10): Promise<FeishuBaseTable[]> {
    const response = await this.client.bitable.v1.appTable.list({
      path: {
        app_token: appToken,
      },
      params: {
        page_size: Math.min(limit, 50),
      },
    });
    ensureSuccess(response);
    return (response.data?.items ?? [])
      .filter((item) => item.table_id)
      .map((item) => ({
        tableId: item.table_id!,
        name: item.name,
        revision: item.revision,
      }));
  }

  public async listRecords(appToken: string, tableId: string, limit: number = 10): Promise<FeishuBaseRecord[]> {
    const response = await this.client.bitable.v1.appTableRecord.list({
      path: {
        app_token: appToken,
        table_id: tableId,
      },
      params: {
        page_size: Math.min(limit, 100),
      },
    });
    ensureSuccess(response);
    return (response.data?.items ?? [])
      .filter((item) => item.record_id)
      .map((item) => ({
        recordId: item.record_id!,
        fields: item.fields ?? {},
        recordUrl: item.record_url,
      }));
  }

  public async createRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<FeishuBaseRecord> {
    const response = await this.client.bitable.v1.appTableRecord.create({
      path: {
        app_token: appToken,
        table_id: tableId,
      },
      data: {
        fields: fields as Record<string, any>,
      },
    });
    ensureSuccess(response);
    const record = response.data?.record;
    if (!record?.record_id) {
      throw new Error('Feishu Base create returned no record_id.');
    }
    return {
      recordId: record.record_id,
      fields: record.fields ?? {},
      recordUrl: record.record_url,
    };
  }

  public async updateRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<FeishuBaseRecord> {
    const response = await this.client.bitable.v1.appTableRecord.update({
      path: {
        app_token: appToken,
        table_id: tableId,
        record_id: recordId,
      },
      data: {
        fields: fields as Record<string, any>,
      },
    });
    ensureSuccess(response);
    const record = response.data?.record;
    if (!record?.record_id) {
      throw new Error('Feishu Base update returned no record_id.');
    }
    return {
      recordId: record.record_id,
      fields: record.fields ?? {},
      recordUrl: record.record_url,
    };
  }
}

function ensureSuccess(response: { code?: number; msg?: string }): void {
  if (response.code === undefined || response.code === 0) {
    return;
  }
  throw new Error(`Feishu API error ${response.code}: ${response.msg ?? 'unknown error'}`);
}
