import { describe, expect, it, vi } from 'vitest';
import { FeishuWikiClient } from '../src/feishu/wiki.js';

describe('feishu wiki client', () => {
  it('lists spaces and normalizes fields', async () => {
    const client = new FeishuWikiClient({
      wiki: {
        v2: {
          space: {
            list: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                items: [
                  {
                    space_id: 'space-1',
                    name: '工程空间',
                    description: '发布文档',
                    visibility: 'private',
                    space_type: 'team',
                  },
                ],
                has_more: false,
              },
            }),
          },
        },
      },
    } as any);

    const spaces = await client.listSpaces();
    expect(spaces).toEqual([
      {
        id: 'space-1',
        name: '工程空间',
        description: '发布文档',
        visibility: 'private',
        spaceType: 'team',
      },
    ]);
  });

  it('searches wiki nodes and reads docx raw content', async () => {
    const client = new FeishuWikiClient({
      wiki: {
        v1: {
          node: {
            search: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                items: [
                  {
                    title: '发布流程',
                    space_id: 'space-1',
                    node_id: 'node-1',
                    obj_token: 'doxcn123',
                    url: 'https://example.feishu.cn/docx/doxcn123',
                  },
                ],
              },
            }),
          },
        },
        v2: {
          space: {
            getNode: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                node: {
                  title: '发布流程',
                  space_id: 'space-1',
                  node_token: 'wikcn123',
                  obj_token: 'doxcn123',
                  obj_type: 'docx',
                  node_type: 'origin',
                },
              },
            }),
          },
        },
      },
      docx: {
        v1: {
          document: {
            get: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                document: {
                  title: '发布流程',
                },
              },
            }),
            rawContent: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                content: '先执行 npm publish，再校验 dist-tags。',
              },
            }),
          },
        },
      },
    } as any);

    const hits = await client.search('发布', ['space-1']);
    expect(hits[0]).toEqual(
      expect.objectContaining({
        title: '发布流程',
        objToken: 'doxcn123',
      }),
    );

    const read = await client.read('https://example.feishu.cn/wiki/wikcn123');
    expect(read).toEqual(
      expect.objectContaining({
        title: '发布流程',
        objType: 'docx',
        objToken: 'doxcn123',
        content: '先执行 npm publish，再校验 dist-tags。',
      }),
    );
  });

  it('creates docx nodes inside a wiki space', async () => {
    const client = new FeishuWikiClient({
      wiki: {
        v2: {
          spaceNode: {
            create: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                node: {
                  title: '部署手册',
                  space_id: 'space-1',
                  node_token: 'wikcn123',
                  obj_token: 'doxcn123',
                  obj_type: 'docx',
                },
              },
            }),
          },
        },
      },
    } as any);

    const created = await client.createDoc('space-1', '部署手册');
    expect(created).toEqual({
      title: '部署手册',
      spaceId: 'space-1',
      nodeToken: 'wikcn123',
      objToken: 'doxcn123',
      objType: 'docx',
    });
  });

  it('renames wiki nodes', async () => {
    const updateTitle = vi.fn().mockResolvedValue({ code: 0, data: {} });
    const client = new FeishuWikiClient({
      wiki: {
        v2: {
          spaceNode: {
            updateTitle,
          },
        },
      },
    } as any);

    await client.renameNode('wikcn123', '新标题', 'space-1');
    expect(updateTitle).toHaveBeenCalledWith({
      path: {
        space_id: 'space-1',
        node_token: 'wikcn123',
      },
      data: {
        title: '新标题',
      },
    });
  });
});
