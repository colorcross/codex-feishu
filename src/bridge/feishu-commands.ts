import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import type { IncomingMessageContext } from './types.js';
import type { FeishuClient } from '../feishu/client.js';
import type { AuditLog } from '../state/audit-log.js';
import { FeishuDocClient } from '../feishu/doc.js';
import { FeishuTaskClient } from '../feishu/task.js';
import { FeishuBaseClient } from '../feishu/base.js';
import { FeishuWikiClient } from '../feishu/wiki.js';
import { canAccessProject } from '../security/access.js';
import { truncateExcerpt, clampListLimit, parseJsonObject } from './service-utils.js';

/**
 * Subset of FeiqueService that the Feishu vertical command handlers
 * (doc / task / base / wiki) need access to. Declared as a structural
 * interface so the handlers can be unit-tested with a hand-rolled mock,
 * and so each new handler explicitly states its host requirements.
 *
 * Reads on `config` and `feishuClient` are intentional — the handlers need
 * the live config (it can be hot-reloaded) and a fresh SDK client per call.
 */
export interface FeishuCommandHost {
  readonly config: BridgeConfig;
  readonly feishuClient: FeishuClient;
  readonly auditLog: AuditLog;
  sendTextReply(
    chatId: string,
    body: string,
    replyToMessageId?: string,
    originalText?: string,
  ): Promise<unknown>;
}

export interface FeishuCommandProjectContext {
  projectAlias: string;
  project: ProjectConfig;
}

// ---------------------------------------------------------------------------
// /doc — Feishu Docs
// ---------------------------------------------------------------------------

export async function handleDocCommand(
  host: FeishuCommandHost,
  context: IncomingMessageContext,
  projectContext: FeishuCommandProjectContext,
  action: 'read' | 'create',
  value?: string,
  extra?: string,
): Promise<void> {
  if (!canAccessProject(host.config, projectContext.projectAlias, context.chat_id, action === 'create' ? 'operator' : 'viewer')) {
    await host.sendTextReply(context.chat_id, `当前 chat_id 无权${action === 'create' ? '写入' : '读取'}项目 ${projectContext.projectAlias} 关联的飞书文档。`, context.message_id, context.text);
    return;
  }
  const docClient = new FeishuDocClient(host.feishuClient.createSdkClient());

  if (action === 'create') {
    const title = value?.trim();
    if (!title) {
      await host.sendTextReply(context.chat_id, '用法: /doc create <title>', context.message_id, context.text);
      return;
    }
    const created = await docClient.create(title, extra?.trim());
    await host.auditLog.append({
      type: 'doc.create',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      document_id: created.documentId,
      title: created.title,
    });
    await host.sendTextReply(
      context.chat_id,
      ['已创建飞书文档', `标题: ${created.title ?? title}`, `文档: ${created.documentId}`, ...(created.url ? [`链接: ${created.url}`] : [])].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (!value) {
    await host.sendTextReply(context.chat_id, '用法: /doc read <url|token>', context.message_id, context.text);
    return;
  }

  const document = await docClient.read(value);
  await host.auditLog.append({
    type: 'doc.read',
    chat_id: context.chat_id,
    actor_id: context.actor_id,
    project_alias: projectContext.projectAlias,
    document_id: document.documentId,
    title: document.title,
  });
  await host.sendTextReply(
    context.chat_id,
    [
      `标题: ${document.title ?? '未知'}`,
      `文档: ${document.documentId}`,
      ...(document.url ? [`链接: ${document.url}`] : []),
      '',
      truncateExcerpt(document.content?.replace(/\s+/g, ' ').trim() ?? '文档暂无可读取的纯文本内容。', 1200),
    ].join('\n'),
    context.message_id,
    context.text,
  );
}

// ---------------------------------------------------------------------------
// /task — Feishu Tasks
// ---------------------------------------------------------------------------

export async function handleTaskCommand(
  host: FeishuCommandHost,
  context: IncomingMessageContext,
  projectContext: FeishuCommandProjectContext,
  action: 'list' | 'get' | 'create' | 'complete',
  value?: string,
): Promise<void> {
  if (!canAccessProject(host.config, projectContext.projectAlias, context.chat_id, action === 'create' || action === 'complete' ? 'operator' : 'viewer')) {
    await host.sendTextReply(context.chat_id, `当前 chat_id 无权${action === 'create' || action === 'complete' ? '写入' : '查看'}项目 ${projectContext.projectAlias} 关联的飞书任务。`, context.message_id, context.text);
    return;
  }
  const taskClient = new FeishuTaskClient(host.feishuClient.createSdkClient());

  if (action === 'list') {
    const limit = clampListLimit(value, 10, 20);
    const tasks = await taskClient.list(limit);
    const lines = tasks.length > 0
      ? tasks.map((task, index) => `${index + 1}. ${task.summary ?? '(无标题)'}\n   guid: ${task.guid}\n   status: ${task.status ?? 'unknown'}${task.url ? `\n   url: ${task.url}` : ''}`)
      : ['当前没有可见任务。'];
    await host.sendTextReply(context.chat_id, ['最近任务', '', ...lines].join('\n'), context.message_id, context.text);
    return;
  }

  if (action === 'get') {
    if (!value) {
      await host.sendTextReply(context.chat_id, '用法: /task get <task_guid>', context.message_id, context.text);
      return;
    }
    const task = await taskClient.get(value);
    await host.auditLog.append({
      type: 'task.read',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      task_guid: task.guid,
    });
    await host.sendTextReply(
      context.chat_id,
      [
        `任务: ${task.summary ?? '(无标题)'}`,
        `guid: ${task.guid}`,
        `status: ${task.status ?? 'unknown'}`,
        ...(task.url ? [`链接: ${task.url}`] : []),
        '',
        task.description ?? '无描述',
      ].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (action === 'create') {
    const summary = value?.trim();
    if (!summary) {
      await host.sendTextReply(context.chat_id, '用法: /task create <summary>', context.message_id, context.text);
      return;
    }
    const task = await taskClient.create(summary);
    await host.auditLog.append({
      type: 'task.create',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      task_guid: task.guid,
      summary: task.summary,
    });
    await host.sendTextReply(
      context.chat_id,
      [`已创建任务`, `标题: ${task.summary ?? summary}`, `guid: ${task.guid}`, ...(task.url ? [`链接: ${task.url}`] : [])].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (!value) {
    await host.sendTextReply(context.chat_id, '用法: /task complete <task_guid>', context.message_id, context.text);
    return;
  }
  const task = await taskClient.complete(value);
  await host.auditLog.append({
    type: 'task.complete',
    chat_id: context.chat_id,
    actor_id: context.actor_id,
    project_alias: projectContext.projectAlias,
    task_guid: task.guid,
    summary: task.summary,
  });
  await host.sendTextReply(
    context.chat_id,
    [`已完成任务`, `标题: ${task.summary ?? '(无标题)'}`, `guid: ${task.guid}`, `status: ${task.status ?? 'unknown'}`].join('\n'),
    context.message_id,
    context.text,
  );
}

// ---------------------------------------------------------------------------
// /base — Feishu Bitable
// ---------------------------------------------------------------------------

export async function handleBaseCommand(
  host: FeishuCommandHost,
  context: IncomingMessageContext,
  projectContext: FeishuCommandProjectContext,
  action: 'tables' | 'records' | 'create' | 'update',
  appToken?: string,
  tableId?: string,
  recordId?: string,
  value?: string,
): Promise<void> {
  if (!canAccessProject(host.config, projectContext.projectAlias, context.chat_id, action === 'create' || action === 'update' ? 'operator' : 'viewer')) {
    await host.sendTextReply(context.chat_id, `当前 chat_id 无权${action === 'create' || action === 'update' ? '写入' : '查看'}项目 ${projectContext.projectAlias} 关联的多维表格。`, context.message_id, context.text);
    return;
  }
  const baseClient = new FeishuBaseClient(host.feishuClient.createSdkClient());

  if (action === 'tables') {
    if (!appToken) {
      await host.sendTextReply(context.chat_id, '用法: /base tables <app_token>', context.message_id, context.text);
      return;
    }
    const tables = await baseClient.listTables(appToken, 20);
    const lines = tables.length > 0
      ? tables.map((table, index) => `${index + 1}. ${table.name ?? '(未命名表)'}\n   table_id: ${table.tableId}${table.revision !== undefined ? `\n   revision: ${table.revision}` : ''}`)
      : ['当前 Base 中没有可见数据表。'];
    await host.sendTextReply(context.chat_id, [`Base: ${appToken}`, '', ...lines].join('\n'), context.message_id, context.text);
    return;
  }

  if (action === 'records') {
    if (!appToken || !tableId) {
      await host.sendTextReply(context.chat_id, '用法: /base records <app_token> <table_id> [limit]', context.message_id, context.text);
      return;
    }
    const limit = clampListLimit(value, 10, 20);
    const records = await baseClient.listRecords(appToken, tableId, limit);
    const lines = records.length > 0
      ? records.map((record, index) => `${index + 1}. ${record.recordId}\n   fields: ${truncateExcerpt(JSON.stringify(record.fields), 240)}${record.recordUrl ? `\n   url: ${record.recordUrl}` : ''}`)
      : ['当前数据表没有可见记录。'];
    await host.sendTextReply(context.chat_id, [`Base: ${appToken}`, `Table: ${tableId}`, '', ...lines].join('\n'), context.message_id, context.text);
    return;
  }

  if (action === 'create') {
    if (!appToken || !tableId || !value) {
      await host.sendTextReply(context.chat_id, '用法: /base create <app_token> <table_id> <json>', context.message_id, context.text);
      return;
    }
    const fields = parseJsonObject(value);
    const record = await baseClient.createRecord(appToken, tableId, fields);
    await host.auditLog.append({
      type: 'base.record.create',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      app_token: appToken,
      table_id: tableId,
      record_id: record.recordId,
    });
    await host.sendTextReply(
      context.chat_id,
      [`已创建 Base 记录`, `app: ${appToken}`, `table: ${tableId}`, `record: ${record.recordId}`, `fields: ${truncateExcerpt(JSON.stringify(record.fields), 240)}`].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (!appToken || !tableId || !recordId || !value) {
    await host.sendTextReply(context.chat_id, '用法: /base update <app_token> <table_id> <record_id> <json>', context.message_id, context.text);
    return;
  }
  const fields = parseJsonObject(value);
  const record = await baseClient.updateRecord(appToken, tableId, recordId, fields);
  await host.auditLog.append({
    type: 'base.record.update',
    chat_id: context.chat_id,
    actor_id: context.actor_id,
    project_alias: projectContext.projectAlias,
    app_token: appToken,
    table_id: tableId,
    record_id: record.recordId,
  });
  await host.sendTextReply(
    context.chat_id,
    [`已更新 Base 记录`, `app: ${appToken}`, `table: ${tableId}`, `record: ${record.recordId}`, `fields: ${truncateExcerpt(JSON.stringify(record.fields), 240)}`].join('\n'),
    context.message_id,
    context.text,
  );
}

// ---------------------------------------------------------------------------
// /wiki — Feishu Wiki
// ---------------------------------------------------------------------------

export async function handleWikiCommand(
  host: FeishuCommandHost,
  context: IncomingMessageContext,
  projectContext: FeishuCommandProjectContext,
  action: 'spaces' | 'search' | 'read' | 'create' | 'rename' | 'copy' | 'move' | 'members' | 'grant' | 'revoke',
  value?: string,
  extra?: string,
  target?: string,
  role?: string,
): Promise<void> {
  const wikiClient = new FeishuWikiClient(host.feishuClient.createSdkClient());

  if (action === 'spaces') {
    const spaces = await wikiClient.listSpaces(10);
    const lines = spaces.length > 0
      ? spaces.map((space) => `- ${space.name} (${space.id})${space.description ? ` | ${space.description}` : ''}`)
      : ['当前应用可访问的知识空间为空。请确认机器人已被加入目标空间。'];
    await host.sendTextReply(
      context.chat_id,
      [`项目: ${projectContext.projectAlias}`, `配置过滤空间数: ${projectContext.project.wiki_space_ids.length}`, '', ...lines].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (action === 'search') {
    if (!value) {
      await host.sendTextReply(context.chat_id, '用法: /wiki search <query>', context.message_id, context.text);
      return;
    }
    const hits = await wikiClient.search(value, projectContext.project.wiki_space_ids, 5);
    await host.auditLog.append({
      type: 'wiki.search',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      query: value,
      result_count: hits.length,
    });
    if (hits.length === 0) {
      await host.sendTextReply(
        context.chat_id,
        [`项目: ${projectContext.projectAlias}`, `飞书知识库搜索: ${value}`, '未找到匹配结果。', '', '提示: 确认机器人有目标空间访问权限，或在项目配置里设置 wiki_space_ids。'].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }
    const lines = hits.map((hit, index) =>
      [
        `${index + 1}. ${hit.title}`,
        `   space: ${hit.spaceId}`,
        `   token: ${hit.objToken}`,
        ...(hit.url ? [`   url: ${hit.url}`] : []),
      ].join('\n'),
    );
    await host.sendTextReply(
      context.chat_id,
      [`项目: ${projectContext.projectAlias}`, `飞书知识库搜索: ${value}`, '', ...lines].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (action === 'members') {
    const spaceId = value?.trim() || projectContext.project.wiki_space_ids[0];
    if (!spaceId) {
      await host.sendTextReply(context.chat_id, '用法: /wiki members [space_id]，或先在项目配置里设置默认 wiki_space_ids。', context.message_id, context.text);
      return;
    }
    const members = await wikiClient.listMembers(spaceId, 20);
    await host.auditLog.append({
      type: 'wiki.members',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      space_id: spaceId,
      result_count: members.length,
    });
    const lines = members.length > 0
      ? members.map((member, index) => `${index + 1}. ${member.memberId}\n   member_type: ${member.memberType}\n   role: ${member.memberRole}${member.type ? `\n   type: ${member.type}` : ''}`)
      : ['当前知识空间没有可见成员，或机器人没有成员读取权限。'];
    await host.sendTextReply(
      context.chat_id,
      [`项目: ${projectContext.projectAlias}`, `知识空间成员: ${spaceId}`, '', ...lines].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (action === 'create') {
    const defaultSpaceId = projectContext.project.wiki_space_ids[0];
    const spaceId = extra ?? defaultSpaceId;
    const title = value?.trim();
    if (!title) {
      await host.sendTextReply(context.chat_id, '用法: /wiki create <title> 或 /wiki create <space_id> <title>', context.message_id, context.text);
      return;
    }
    if (!spaceId) {
      await host.sendTextReply(
        context.chat_id,
        '当前项目未配置默认 wiki_space_ids，请使用 `/wiki create <space_id> <title>`。',
        context.message_id,
        context.text,
      );
      return;
    }

    const created = await wikiClient.createDoc(spaceId, title);
    await host.auditLog.append({
      type: 'wiki.create',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      title,
      space_id: created.spaceId,
      obj_token: created.objToken,
      node_token: created.nodeToken,
    });
    await host.sendTextReply(
      context.chat_id,
      [
        `项目: ${projectContext.projectAlias}`,
        `已创建飞书文档: ${created.title ?? title}`,
        `空间: ${created.spaceId ?? spaceId}`,
        ...(created.nodeToken ? [`节点: ${created.nodeToken}`] : []),
        ...(created.objToken ? [`文档: ${created.objToken}`] : []),
      ].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (action === 'grant') {
    const spaceId = extra?.trim();
    const memberType = target?.trim();
    const memberId = value?.trim();
    const memberRole = role?.trim() || 'member';
    if (!spaceId || !memberType || !memberId) {
      await host.sendTextReply(context.chat_id, '用法: /wiki grant <space_id> <member_type> <member_id> [member|admin]', context.message_id, context.text);
      return;
    }

    const granted = await wikiClient.addMember(spaceId, memberType, memberId, memberRole);
    await host.auditLog.append({
      type: 'wiki.member.grant',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      space_id: spaceId,
      member_id: granted.memberId,
      member_type: granted.memberType,
      member_role: granted.memberRole,
    });
    await host.sendTextReply(
      context.chat_id,
      [
        `项目: ${projectContext.projectAlias}`,
        '已添加知识空间成员',
        `空间: ${spaceId}`,
        `member_type: ${granted.memberType}`,
        `member_id: ${granted.memberId}`,
        `role: ${granted.memberRole}`,
      ].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (action === 'rename') {
    const nodeToken = extra?.trim();
    const title = value?.trim();
    if (!nodeToken || !title) {
      await host.sendTextReply(context.chat_id, '用法: /wiki rename <node_token> <title>', context.message_id, context.text);
      return;
    }

    await wikiClient.renameNode(nodeToken, title, projectContext.project.wiki_space_ids[0]);
    await host.auditLog.append({
      type: 'wiki.rename',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      node_token: nodeToken,
      title,
    });
    await host.sendTextReply(
      context.chat_id,
      [`项目: ${projectContext.projectAlias}`, `已更新知识库节点标题`, `节点: ${nodeToken}`, `标题: ${title}`].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (action === 'copy') {
    const nodeToken = value?.trim();
    const targetSpaceId = extra?.trim() || projectContext.project.wiki_space_ids[0];
    if (!nodeToken) {
      await host.sendTextReply(context.chat_id, '用法: /wiki copy <node_token> [target_space_id]', context.message_id, context.text);
      return;
    }
    if (!targetSpaceId) {
      await host.sendTextReply(context.chat_id, '当前项目未配置默认 wiki_space_ids，请显式传入 target_space_id。', context.message_id, context.text);
      return;
    }

    const copied = await wikiClient.copyNode(nodeToken, targetSpaceId);
    await host.auditLog.append({
      type: 'wiki.copy',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      node_token: nodeToken,
      target_space_id: copied.spaceId,
      obj_token: copied.objToken,
    });
    await host.sendTextReply(
      context.chat_id,
      [
        `项目: ${projectContext.projectAlias}`,
        `已复制知识库节点`,
        `源节点: ${nodeToken}`,
        `目标空间: ${copied.spaceId ?? targetSpaceId}`,
        ...(copied.nodeToken ? [`新节点: ${copied.nodeToken}`] : []),
        ...(copied.objToken ? [`对象: ${copied.objToken}`] : []),
      ].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (action === 'move') {
    const sourceSpaceId = extra?.trim();
    const nodeToken = value?.trim();
    const targetSpaceId = target?.trim() || projectContext.project.wiki_space_ids[0];
    if (!sourceSpaceId || !nodeToken) {
      await host.sendTextReply(context.chat_id, '用法: /wiki move <source_space_id> <node_token> [target_space_id]', context.message_id, context.text);
      return;
    }
    if (!targetSpaceId) {
      await host.sendTextReply(context.chat_id, '当前项目未配置默认 wiki_space_ids，请显式传入 target_space_id。', context.message_id, context.text);
      return;
    }

    const moved = await wikiClient.moveNode(sourceSpaceId, nodeToken, targetSpaceId);
    await host.auditLog.append({
      type: 'wiki.move',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      node_token: nodeToken,
      source_space_id: sourceSpaceId,
      target_space_id: moved.spaceId,
      obj_token: moved.objToken,
    });
    await host.sendTextReply(
      context.chat_id,
      [
        `项目: ${projectContext.projectAlias}`,
        `已移动知识库节点`,
        `源空间: ${sourceSpaceId}`,
        `源节点: ${nodeToken}`,
        `目标空间: ${moved.spaceId ?? targetSpaceId}`,
        ...(moved.nodeToken ? [`当前节点: ${moved.nodeToken}`] : []),
      ].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  if (action === 'revoke') {
    const spaceId = extra?.trim();
    const memberType = target?.trim();
    const memberId = value?.trim();
    const memberRole = role?.trim() || 'member';
    if (!spaceId || !memberType || !memberId) {
      await host.sendTextReply(context.chat_id, '用法: /wiki revoke <space_id> <member_type> <member_id> [member|admin]', context.message_id, context.text);
      return;
    }

    const revoked = await wikiClient.removeMember(spaceId, memberType, memberId, memberRole);
    await host.auditLog.append({
      type: 'wiki.member.revoke',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      space_id: spaceId,
      member_id: revoked.memberId,
      member_type: revoked.memberType,
      member_role: revoked.memberRole,
    });
    await host.sendTextReply(
      context.chat_id,
      [
        `项目: ${projectContext.projectAlias}`,
        '已移除知识空间成员',
        `空间: ${spaceId}`,
        `member_type: ${revoked.memberType}`,
        `member_id: ${revoked.memberId}`,
        `role: ${revoked.memberRole}`,
      ].join('\n'),
      context.message_id,
      context.text,
    );
    return;
  }

  // Default: 'read'
  if (!value) {
    await host.sendTextReply(context.chat_id, '用法: /wiki read <url|token>', context.message_id, context.text);
    return;
  }

  const result = await wikiClient.read(value);
  await host.auditLog.append({
    type: 'wiki.read',
    chat_id: context.chat_id,
    actor_id: context.actor_id,
    project_alias: projectContext.projectAlias,
    target: value,
    obj_type: result.objType,
    obj_token: result.objToken,
  });

  const summary = result.content ? truncateExcerpt(result.content.replace(/\s+/g, ' ').trim(), 1200) : '当前对象不是 docx 文档，暂不支持直接拉取纯文本内容。';
  await host.sendTextReply(
    context.chat_id,
    [
      `项目: ${projectContext.projectAlias}`,
      `标题: ${result.title ?? '未知'}`,
      `类型: ${result.objType ?? '未知'}`,
      ...(result.spaceId ? [`空间: ${result.spaceId}`] : []),
      ...(result.objToken ? [`对象: ${result.objToken}`] : []),
      ...(result.url ? [`链接: ${result.url}`] : []),
      '',
      summary,
    ].join('\n'),
    context.message_id,
    context.text,
  );
}
