export type BridgeCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'projects' }
  | { kind: 'new' }
  | { kind: 'cancel' }
  | { kind: 'kb'; action: 'search' | 'status'; query?: string }
  | { kind: 'wiki'; action: 'spaces' | 'search' | 'read' | 'create' | 'rename'; value?: string; extra?: string }
  | { kind: 'project'; alias?: string }
  | { kind: 'session'; action: 'list' | 'use' | 'new' | 'drop'; threadId?: string }
  | { kind: 'prompt'; prompt: string };

export function parseBridgeCommand(input: string): BridgeCommand {
  const trimmed = normalizeIncomingText(input);

  if (!trimmed.startsWith('/')) {
    return { kind: 'prompt', prompt: trimmed };
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  const argument = rest.join(' ').trim();

  switch (command) {
    case '/help':
      return { kind: 'help' };
    case '/status':
      return { kind: 'status' };
    case '/projects':
      return { kind: 'projects' };
    case '/new':
      return { kind: 'new' };
    case '/cancel':
      return { kind: 'cancel' };
    case '/kb':
      return parseKnowledgeCommand(argument);
    case '/wiki':
      return parseWikiCommand(argument);
    case '/project':
      return { kind: 'project', alias: argument || undefined };
    case '/session':
      return parseSessionCommand(argument);
    default:
      return { kind: 'prompt', prompt: trimmed };
  }
}

export function normalizeIncomingText(input: string): string {
  return input
    .trim()
    .replace(/^@[^\s]+\s+/, '')
    .replace(/\u00a0/g, ' ')
    .trim();
}

export function buildHelpText(): string {
  return [
    'Codex Feishu',
    '',
    '/help 查看帮助',
    '/projects 列出可用项目',
    '/project <alias> 切换当前项目',
    '/status 查看当前项目、会话与运行状态',
    '/new 为当前项目新开会话',
    '/cancel 取消当前项目正在运行的任务',
    '/kb status 查看当前项目知识库目录',
    '/kb search <query> 搜索项目文档/知识库',
    '/wiki spaces 列出可访问的飞书知识空间',
    '/wiki search <query> 搜索飞书知识库',
    '/wiki read <url|token> 读取飞书文档纯文本摘要',
    '/wiki create <title> 在默认知识空间创建文档',
    '/wiki create <space_id> <title> 在指定知识空间创建文档',
    '/wiki rename <node_token> <title> 更新知识库节点标题',
    '/session list 列出当前项目保存过的会话',
    '/session use <thread_id> 切换到指定会话',
    '/session new 让下一条消息新开会话',
    '/session drop [thread_id] 删除指定或当前会话',
    '',
    '直接发送文本会进入当前项目的 Codex 会话。',
  ].join('\n');
}

function parseSessionCommand(argument: string): BridgeCommand {
  const [subcommand, ...rest] = argument.split(/\s+/).filter(Boolean);
  const threadId = rest.join(' ').trim() || undefined;

  switch (subcommand) {
    case 'list':
      return { kind: 'session', action: 'list' };
    case 'use':
      return { kind: 'session', action: 'use', threadId };
    case 'new':
      return { kind: 'session', action: 'new' };
    case 'drop':
      return { kind: 'session', action: 'drop', threadId };
    default:
      return { kind: 'prompt', prompt: `/session${argument ? ` ${argument}` : ''}`.trim() };
  }
}

function parseKnowledgeCommand(argument: string): BridgeCommand {
  const [subcommand, ...rest] = argument.split(/\s+/).filter(Boolean);
  const query = rest.join(' ').trim() || undefined;

  switch (subcommand) {
    case 'status':
      return { kind: 'kb', action: 'status' };
    case 'search':
      return { kind: 'kb', action: 'search', query };
    default:
      return { kind: 'prompt', prompt: `/kb${argument ? ` ${argument}` : ''}`.trim() };
  }
}

function parseWikiCommand(argument: string): BridgeCommand {
  const [subcommand, ...rest] = argument.split(/\s+/).filter(Boolean);
  const value = rest.join(' ').trim() || undefined;

  switch (subcommand) {
    case 'spaces':
      return { kind: 'wiki', action: 'spaces' };
    case 'search':
      return { kind: 'wiki', action: 'search', value };
    case 'read':
      return { kind: 'wiki', action: 'read', value };
    case 'create': {
      if (rest.length <= 1) {
        return { kind: 'wiki', action: 'create', value };
      }
      return { kind: 'wiki', action: 'create', value: rest.slice(1).join(' ').trim(), extra: rest[0] };
    }
    case 'rename': {
      const token = rest[0];
      const title = rest.slice(1).join(' ').trim() || undefined;
      return { kind: 'wiki', action: 'rename', value: title, extra: token };
    }
    default:
      return { kind: 'prompt', prompt: `/wiki${argument ? ` ${argument}` : ''}`.trim() };
  }
}
