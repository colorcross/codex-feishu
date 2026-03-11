import * as lark from '@larksuiteoapi/node-sdk';

export interface FeishuTaskRecord {
  guid: string;
  taskId?: string;
  summary?: string;
  description?: string;
  status?: string;
  completedAt?: string;
  url?: string;
}

export class FeishuTaskClient {
  public constructor(private readonly client: lark.Client) {}

  public async list(limit: number = 10): Promise<FeishuTaskRecord[]> {
    const response = await this.client.task.v2.task.list({
      params: {
        page_size: Math.min(limit, 50),
      },
    });
    ensureSuccess(response);
    return (response.data?.items ?? [])
      .filter((item) => item.guid)
      .map((item) => ({
        guid: item.guid!,
        taskId: item.task_id,
        summary: item.summary,
        description: item.description,
        status: item.status,
        completedAt: item.completed_at,
        url: item.url,
      }));
  }

  public async get(taskGuid: string): Promise<FeishuTaskRecord> {
    const response = await this.client.task.v2.task.get({
      path: {
        task_guid: taskGuid,
      },
    });
    ensureSuccess(response);
    const task = response.data?.task;
    if (!task?.guid) {
      throw new Error('Feishu Task get returned no task.');
    }
    return {
      guid: task.guid,
      taskId: task.task_id,
      summary: task.summary,
      description: task.description,
      status: task.status,
      completedAt: task.completed_at,
      url: task.url,
    };
  }

  public async create(summary: string, description?: string): Promise<FeishuTaskRecord> {
    const response = await this.client.task.v2.task.create({
      data: {
        summary,
        ...(description ? { description } : {}),
      } as any,
    });
    ensureSuccess(response);
    const task = response.data?.task;
    if (!task?.guid) {
      throw new Error('Feishu Task create returned no task guid.');
    }
    return {
      guid: task.guid,
      taskId: task.task_id,
      summary: task.summary ?? summary,
      description: task.description ?? description,
      status: task.status,
      completedAt: task.completed_at,
      url: task.url,
    };
  }

  public async complete(taskGuid: string): Promise<FeishuTaskRecord> {
    const task = await this.get(taskGuid);
    const taskId = task.taskId ?? taskGuid;
    const response = await this.client.task.v1.task.complete({
      path: {
        task_id: taskId,
      },
    } as any);
    ensureSuccess(response);
    return this.get(taskGuid);
  }
}

function ensureSuccess(response: { code?: number; msg?: string }): void {
  if (response.code === undefined || response.code === 0) {
    return;
  }
  throw new Error(`Feishu API error ${response.code}: ${response.msg ?? 'unknown error'}`);
}
