import * as lark from '@larksuiteoapi/node-sdk';

export interface FeishuDocRecord {
  documentId: string;
  title?: string;
  content?: string;
  url?: string;
}

export class FeishuDocClient {
  public constructor(private readonly client: lark.Client) {}

  public async create(title: string, folderToken?: string): Promise<FeishuDocRecord> {
    const response = await this.client.docx.v1.document.create({
      data: {
        title,
        ...(folderToken ? { folder_token: folderToken } : {}),
      },
    });
    ensureSuccess(response);
    const documentId = response.data?.document?.document_id;
    if (!documentId) {
      throw new Error('Feishu doc create returned no document_id.');
    }
    return {
      documentId,
      title: response.data?.document?.title ?? title,
      url: `https://feishu.cn/docx/${documentId}`,
    };
  }

  public async read(target: string): Promise<FeishuDocRecord> {
    const documentId = parseDocumentId(target);
    const [metaResponse, contentResponse] = await Promise.all([
      this.client.docx.v1.document.get({
        path: {
          document_id: documentId,
        },
      }),
      this.client.docx.v1.document.rawContent({
        path: {
          document_id: documentId,
        },
      }),
    ]);
    ensureSuccess(metaResponse);
    ensureSuccess(contentResponse);
    return {
      documentId,
      title: metaResponse.data?.document?.title,
      content: contentResponse.data?.content,
      url: `https://feishu.cn/docx/${documentId}`,
    };
  }
}

function parseDocumentId(target: string): string {
  const trimmed = target.trim();
  const match = trimmed.match(/\/docx\/([A-Za-z0-9]+)/i);
  return match?.[1] ?? trimmed;
}

function ensureSuccess(response: { code?: number; msg?: string }): void {
  if (response.code === undefined || response.code === 0) {
    return;
  }
  throw new Error(`Feishu API error ${response.code}: ${response.msg ?? 'unknown error'}`);
}
