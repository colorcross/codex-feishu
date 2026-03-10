import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig, ProjectConfig, SessionScope } from '../config/schema.js';
import { buildHelpText, normalizeIncomingText, parseBridgeCommand } from './commands.js';
import type { IncomingCardActionContext, IncomingMessageContext } from './types.js';
import { SessionStore, buildConversationKey, type ConversationState } from '../state/session-store.js';
import type { Logger } from '../logging.js';
import { FeishuClient } from '../feishu/client.js';
import { buildStatusCard } from '../feishu/cards.js';
import { runCodexTurn, summarizeCodexEvent } from '../codex/runner.js';
import { TaskQueue } from './task-queue.js';
import { AuditLog } from '../state/audit-log.js';
import { truncateForFeishuCard } from '../feishu/text.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import { IdempotencyStore } from '../state/idempotency-store.js';
import { RunStateStore, type RunState } from '../state/run-state-store.js';
import { isProcessAlive, terminateProcess } from '../runtime/process.js';
import { resolveKnowledgeRoots, searchKnowledgeBase } from '../knowledge/search.js';

interface ActiveRunHandle {
  runId: string;
  controller: AbortController;
  pid?: number;
  cancelReason?: 'user' | 'timeout' | 'recovery';
}

export class CodexFeishuService {
  private readonly queue = new TaskQueue();
  private readonly activeRuns = new Map<string, ActiveRunHandle>();

  public constructor(
    private readonly config: BridgeConfig,
    private readonly feishuClient: FeishuClient,
    private readonly sessionStore: SessionStore,
    private readonly auditLog: AuditLog,
    private readonly logger: Logger,
    private readonly metrics?: MetricsRegistry,
    private readonly idempotencyStore: IdempotencyStore = new IdempotencyStore(config.storage.dir),
    private readonly runStateStore: RunStateStore = new RunStateStore(config.storage.dir),
  ) {}

  public async recoverRuntimeState(): Promise<RunState[]> {
    const recovered = await this.runStateStore.recoverOrphanedRuns();
    for (const run of recovered) {
      await this.auditLog.append({
        type: 'codex.run.recovered',
        run_id: run.run_id,
        project_alias: run.project_alias,
        conversation_key: run.conversation_key,
        status: run.status,
        pid: run.pid,
      });
    }
    return recovered;
  }

  public async handleIncomingMessage(context: IncomingMessageContext): Promise<void> {
    if (!context.text.trim() && context.attachments.length === 0) {
      return;
    }

    if (context.sender_type && context.sender_type !== 'user') {
      this.logger.info({ chatId: context.chat_id, senderType: context.sender_type, messageId: context.message_id }, 'Ignoring non-user message');
      return;
    }

    if (context.message_id) {
      const key = buildMessageDedupeKey(context);
      const dedupe = await this.idempotencyStore.register(key, 'message', this.config.service.idempotency_ttl_seconds);
      if (dedupe.duplicate) {
        this.metrics?.recordDuplicateEvent('message');
        await this.auditLog.append({
          type: 'message.duplicate_ignored',
          message_id: context.message_id,
          chat_id: context.chat_id,
          actor_id: context.actor_id,
        });
        return;
      }
    }

    if (!Object.keys(this.config.projects).length) {
      await this.sendTextReply(context.chat_id, '未配置任何项目。请先执行 `codex-feishu bind <alias> <path>`。', context.message_id, context.text);
      return;
    }

    const command = parseBridgeCommand(context.text);
    this.metrics?.recordIncomingMessage(context.chat_type, command.kind);
    await this.auditLog.append({
      type: 'message.received',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      command: command.kind,
      message_id: context.message_id,
      text: context.text,
      message_type: context.message_type,
      attachment_count: context.attachments.length,
    });
    const selectionKey = await this.getSelectionConversationKey(context);

    switch (command.kind) {
      case 'help':
        await this.sendTextReply(context.chat_id, buildHelpText(), context.message_id, context.text);
        return;
      case 'projects':
        await this.sendTextReply(context.chat_id, await this.buildProjectsText(selectionKey), context.message_id, context.text);
        return;
      case 'project':
        await this.handleProjectCommand(context, selectionKey, command.alias);
        return;
      case 'status':
        await this.handleStatusCommand(context, selectionKey);
        return;
      case 'new':
        await this.handleNewCommand(context, selectionKey);
        return;
      case 'cancel':
        await this.handleCancelCommand(context, selectionKey);
        return;
      case 'kb':
        await this.handleKnowledgeCommand(context, selectionKey, command.action, command.query);
        return;
      case 'session':
        await this.handleSessionCommand(context, selectionKey, command.action, command.threadId);
        return;
      case 'prompt': {
        const prompt = normalizeIncomingText(command.prompt) || (context.attachments.length > 0 ? '请结合这条飞书消息附带的多媒体信息继续处理。' : '');
        if (!prompt) {
          return;
        }
        const projectContext = await this.resolveProjectContext(context, selectionKey);
        if (context.chat_type === 'group' && this.shouldRequireMention(projectContext.project) && context.mentions.length === 0) {
          return;
        }
        await this.sessionStore.selectProject(selectionKey, projectContext.projectAlias);

        await this.queue.run(projectContext.queueKey, async () => {
          await this.executePrompt({
            chatId: context.chat_id,
            actorId: context.actor_id,
            tenantKey: context.tenant_key,
            projectAlias: projectContext.projectAlias,
            project: projectContext.project,
            prompt,
            incomingMessage: context,
            sessionKey: projectContext.sessionKey,
            queueKey: projectContext.queueKey,
            replyToMessageId: context.message_id,
          });
        });
      }
    }
  }

  public async handleCardAction(context: IncomingCardActionContext): Promise<Record<string, unknown>> {
    const action = typeof context.action_value.action === 'string' ? context.action_value.action : 'status';
    const dedupeKey = buildCardDedupeKey(context, action);
    if (dedupeKey) {
      const dedupe = await this.idempotencyStore.register(dedupeKey, 'card', this.config.service.idempotency_ttl_seconds);
      if (dedupe.duplicate) {
        this.metrics?.recordDuplicateEvent('card');
        return buildStatusCard({
          title: '重复操作已忽略',
          summary: '这次卡片动作已经处理过，不会再次提交。',
          projectAlias: typeof context.action_value.project_alias === 'string' ? context.action_value.project_alias : 'unknown',
          includeActions: false,
        });
      }
    }

    this.metrics?.recordCardAction(action);
    await this.auditLog.append({
      type: 'card.action',
      action,
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      open_message_id: context.open_message_id,
    });
    const projectAlias = typeof context.action_value.project_alias === 'string' ? context.action_value.project_alias : undefined;
    const sessionKey = typeof context.action_value.conversation_key === 'string' ? context.action_value.conversation_key : undefined;
    const chatId = typeof context.action_value.chat_id === 'string' ? context.action_value.chat_id : context.chat_id;

    if (!projectAlias || !sessionKey || !chatId) {
      return buildStatusCard({
        title: '无法处理卡片操作',
        summary: '卡片中缺少会话元数据。请直接在飞书里发送文本继续。',
        projectAlias: projectAlias ?? 'unknown',
        includeActions: false,
      });
    }

    const project = this.requireProject(projectAlias);
    const queueKey = buildQueueKey(sessionKey, projectAlias);
    const conversation = await this.sessionStore.getConversation(sessionKey);
    if (!conversation) {
      return buildStatusCard({
        title: '会话不存在',
        summary: '对应的会话状态已经丢失。请发送 `/new` 后重新开始。',
        projectAlias,
        includeActions: false,
      });
    }

    if (action === 'new') {
      await this.sessionStore.clearActiveProjectSession(sessionKey, projectAlias);
      return buildStatusCard({
        title: '会话已重置',
        summary: '下一条文本消息会启动一个新的 Codex 会话。',
        projectAlias,
        includeActions: false,
      });
    }

    if (action === 'cancel') {
      const cancelled = await this.cancelActiveRun(queueKey, 'user');
      return buildStatusCard({
        title: cancelled ? '已提交取消' : '没有可取消的运行',
        summary: cancelled ? '当前项目的运行正在停止。' : '当前项目没有活动中的运行。',
        projectAlias,
        includeActions: false,
      });
    }

    if (action === 'rerun') {
      const previousPrompt = conversation.projects[projectAlias]?.last_prompt;
      if (!previousPrompt) {
        return buildStatusCard({
          title: '无法重试',
          summary: '没有找到上一轮提示词，请直接发新消息。',
          projectAlias,
          includeActions: false,
        });
      }
      void this.queue.run(queueKey, async () => {
        await this.executePrompt({
          chatId,
          actorId: context.actor_id,
          tenantKey: context.tenant_key,
          projectAlias,
          project,
          incomingMessage: {
            tenant_key: context.tenant_key,
            chat_id: chatId,
            chat_type: 'unknown',
            actor_id: context.actor_id,
            message_id: context.open_message_id ?? `card-rerun-${Date.now()}`,
            message_type: 'card-action',
            text: previousPrompt,
            attachments: [],
            mentions: [],
            raw: context.raw,
          },
          prompt: previousPrompt,
          sessionKey,
          queueKey,
        });
      });
      return buildStatusCard({
        title: '已提交重试',
        summary: '桥接器正在重新执行上一轮，结果会通过消息回传。',
        projectAlias,
        sessionId: conversation.projects[projectAlias]?.thread_id,
        includeActions: false,
      });
    }

    return this.buildStatusCardFromConversation(projectAlias, sessionKey, conversation, await this.runStateStore.getActiveRun(queueKey));
  }

  public async listRuns(): Promise<RunState[]> {
    return this.runStateStore.listRuns();
  }

  private async executePrompt(input: {
    chatId: string;
    actorId?: string;
    tenantKey?: string;
    projectAlias: string;
    project: ProjectConfig;
    incomingMessage: IncomingMessageContext;
    prompt: string;
    sessionKey: string;
    queueKey: string;
    replyToMessageId?: string;
  }): Promise<void> {
    const conversation =
      (await this.sessionStore.getConversation(input.sessionKey)) ??
      (await this.sessionStore.ensureConversation(input.sessionKey, {
        chat_id: input.chatId,
        actor_id: input.actorId,
        tenant_key: input.tenantKey,
        scope: input.project.session_scope,
      }));
    const currentSession = conversation.projects[input.projectAlias];
    const bridgePrompt = await this.buildBridgePrompt(input.projectAlias, input.project, input.incomingMessage, input.prompt);
    const startedAt = Date.now();
    const runId = randomUUID();
    let lastProgressUpdate = 0;
    const activeRun: ActiveRunHandle = {
      runId,
      controller: new AbortController(),
    };
    this.activeRuns.set(input.queueKey, activeRun);

    await this.runStateStore.upsertRun(runId, {
      queue_key: input.queueKey,
      conversation_key: input.sessionKey,
      project_alias: input.projectAlias,
      chat_id: input.chatId,
      actor_id: input.actorId,
      session_id: currentSession?.thread_id,
      prompt_excerpt: truncateExcerpt(input.prompt),
      status: 'running',
    });
    await this.auditLog.append({
      type: 'codex.run.started',
      run_id: runId,
      chat_id: input.chatId,
      actor_id: input.actorId,
      project_alias: input.projectAlias,
      conversation_key: input.sessionKey,
      session_id: currentSession?.thread_id,
      prompt: input.prompt,
    });

    this.metrics?.recordCodexTurnStarted(input.projectAlias, runId);

    try {
      const result = await runCodexTurn({
        bin: this.config.codex.bin,
        shell: this.config.codex.shell,
        preExec: this.config.codex.pre_exec,
        workdir: input.project.root,
        prompt: bridgePrompt,
        sessionId: currentSession?.thread_id,
        profile: input.project.profile ?? this.config.codex.default_profile,
        sandbox: input.project.sandbox ?? this.config.codex.default_sandbox,
        skipGitRepoCheck: this.config.codex.skip_git_repo_check,
        timeoutMs: this.config.codex.run_timeout_ms,
        signal: activeRun.controller.signal,
        logger: this.logger,
        onSpawn: async (pid) => {
          activeRun.pid = pid;
          await this.runStateStore.upsertRun(runId, {
            queue_key: input.queueKey,
            conversation_key: input.sessionKey,
            project_alias: input.projectAlias,
            chat_id: input.chatId,
            actor_id: input.actorId,
            session_id: currentSession?.thread_id,
            prompt_excerpt: truncateExcerpt(input.prompt),
            status: 'running',
            pid,
          });
        },
        onEvent: async (event) => {
          if (!this.config.service.emit_progress_updates) {
            return;
          }
          const message = summarizeCodexEvent(event);
          if (!message) {
            return;
          }
          const now = Date.now();
          if (now - lastProgressUpdate < this.config.service.progress_update_interval_ms) {
            return;
          }
          lastProgressUpdate = now;
          await this.sendTextReply(input.chatId, message, input.replyToMessageId, input.prompt);
        },
      });

      const excerpt = result.finalMessage.slice(0, this.config.codex.output_token_limit);
      const cardSummary = truncateForFeishuCard(excerpt || 'Codex 已完成，但没有返回可显示文本。');
      await this.auditLog.append({
        type: 'codex.run.completed',
        run_id: runId,
        chat_id: input.chatId,
        actor_id: input.actorId,
        project_alias: input.projectAlias,
        conversation_key: input.sessionKey,
        session_id: result.sessionId,
        exit_code: result.exitCode,
        duration_ms: Date.now() - startedAt,
      });
      await this.sessionStore.upsertProjectSession(input.sessionKey, input.projectAlias, {
        thread_id: result.sessionId,
        last_prompt: input.prompt,
        last_response_excerpt: excerpt,
      });
      await this.enforceSessionHistoryLimit(input.sessionKey, input.projectAlias);
      await this.runStateStore.upsertRun(runId, {
        queue_key: input.queueKey,
        conversation_key: input.sessionKey,
        project_alias: input.projectAlias,
        chat_id: input.chatId,
        actor_id: input.actorId,
        session_id: result.sessionId,
        pid: activeRun.pid,
        prompt_excerpt: truncateExcerpt(input.prompt),
        status: 'success',
      });
      this.metrics?.recordCodexTurn('success', input.projectAlias, (Date.now() - startedAt) / 1000, runId);

      if (this.config.service.reply_mode === 'card' && this.config.feishu.transport === 'webhook') {
        await this.sendCardReply(
          input.chatId,
          buildStatusCard({
            title: 'Codex 已完成',
            summary: cardSummary,
            projectAlias: input.projectAlias,
            sessionId: result.sessionId,
            runId,
            runStatus: 'success',
            sessionCount: (await this.sessionStore.listProjectSessions(input.sessionKey, input.projectAlias)).length,
            includeActions: true,
            rerunPayload: {
              action: 'rerun',
              conversation_key: input.sessionKey,
              project_alias: input.projectAlias,
              chat_id: input.chatId,
            },
            newSessionPayload: {
              action: 'new',
              conversation_key: input.sessionKey,
              project_alias: input.projectAlias,
              chat_id: input.chatId,
            },
            statusPayload: {
              action: 'status',
              conversation_key: input.sessionKey,
              project_alias: input.projectAlias,
              chat_id: input.chatId,
            },
          }),
          input.replyToMessageId,
        );
      } else {
        const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        await this.sendTextReply(
          input.chatId,
          [`项目: ${input.projectAlias}`, `运行: ${runId}`, `耗时: ${durationSeconds}s`, '', excerpt || 'Codex 已完成，但没有返回可显示文本。'].join('\n'),
          input.replyToMessageId,
          input.prompt,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = error instanceof Error && error.name === 'AbortError' && activeRun.cancelReason === 'user';
      const status = cancelled ? 'cancelled' : 'failure';
      if (!cancelled && error instanceof Error && error.name === 'AbortError') {
        activeRun.cancelReason = 'timeout';
      }
      if (!cancelled && activeRun.cancelReason === 'timeout') {
        this.metrics?.recordCodexTurn('failure', input.projectAlias, (Date.now() - startedAt) / 1000, runId);
      } else {
        this.metrics?.recordCodexTurn(cancelled ? 'cancelled' : 'failure', input.projectAlias, (Date.now() - startedAt) / 1000, runId);
      }
      await this.runStateStore.upsertRun(runId, {
        queue_key: input.queueKey,
        conversation_key: input.sessionKey,
        project_alias: input.projectAlias,
        chat_id: input.chatId,
        actor_id: input.actorId,
        session_id: currentSession?.thread_id,
        pid: activeRun.pid,
        prompt_excerpt: truncateExcerpt(input.prompt),
        status,
        error: message,
      });
      await this.auditLog.append({
        type: cancelled ? 'codex.run.cancelled' : 'codex.run.failed',
        run_id: runId,
        chat_id: input.chatId,
        actor_id: input.actorId,
        project_alias: input.projectAlias,
        conversation_key: input.sessionKey,
        error: message,
      });
      this.logger.error({ error, project: input.projectAlias, runId }, 'Codex run failed');
      await this.sendTextReply(
        input.chatId,
        cancelled
          ? [`项目: ${input.projectAlias}`, `运行: ${runId}`, '当前运行已取消。'].join('\n')
          : [`项目: ${input.projectAlias}`, `运行: ${runId}`, '执行失败。', '', message].join('\n'),
        input.replyToMessageId,
        input.prompt,
      );
    } finally {
      this.activeRuns.delete(input.queueKey);
    }
  }

  private async handleProjectCommand(context: IncomingMessageContext, selectionKey: string, alias?: string): Promise<void> {
    if (!alias) {
      const currentAlias = await this.resolveProjectAlias(selectionKey);
      const project = this.requireProject(currentAlias);
      await this.sendTextReply(context.chat_id, `当前项目: ${currentAlias}${project.description ? `\n说明: ${project.description}` : ''}`, context.message_id, context.text);
      return;
    }

    const project = this.requireProject(alias);
    await this.sessionStore.ensureConversation(selectionKey, {
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      tenant_key: context.tenant_key,
      scope: this.getSelectionScope(context),
    });
    await this.sessionStore.selectProject(selectionKey, alias);
    await this.auditLog.append({
      type: 'project.selected',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: alias,
    });
    await this.sendTextReply(context.chat_id, `已切换到项目: ${alias}${project.description ? `\n说明: ${project.description}` : ''}`, context.message_id, context.text);
  }

  private async handleStatusCommand(context: IncomingMessageContext, selectionKey: string): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const conversation = await this.sessionStore.getConversation(projectContext.sessionKey);
    if (!conversation) {
      await this.sendTextReply(context.chat_id, `项目 ${projectContext.projectAlias} 还没有会话。发送任意文本即可开始。`, context.message_id, context.text);
      return;
    }

    const activeRun = await this.runStateStore.getActiveRun(projectContext.queueKey);
    if (this.config.service.reply_mode === 'card' && this.config.feishu.transport === 'webhook') {
      await this.sendCardReply(
        context.chat_id,
        this.buildStatusCardFromConversation(projectContext.projectAlias, projectContext.sessionKey, conversation, activeRun),
        context.message_id,
      );
      return;
    }

    await this.sendTextReply(context.chat_id, await this.buildStatusText(projectContext.projectAlias, conversation, activeRun), context.message_id, context.text);
  }

  private async handleNewCommand(context: IncomingMessageContext, selectionKey: string): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    await this.sessionStore.clearActiveProjectSession(projectContext.sessionKey, projectContext.projectAlias);
    await this.auditLog.append({
      type: 'session.reset',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      conversation_key: projectContext.sessionKey,
    });
    await this.sendTextReply(context.chat_id, `已为项目 ${projectContext.projectAlias} 切换到新会话模式。下一条消息会新开一轮。`, context.message_id, context.text);
  }

  private async handleCancelCommand(context: IncomingMessageContext, selectionKey: string): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const cancelled = await this.cancelActiveRun(projectContext.queueKey, 'user');
    await this.sendTextReply(
      context.chat_id,
      cancelled ? `已提交取消请求: ${projectContext.projectAlias}` : `当前项目 ${projectContext.projectAlias} 没有活动中的运行。`,
      context.message_id,
      context.text,
    );
  }

  private async handleSessionCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action: 'list' | 'use' | 'new' | 'drop',
    threadId?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const sessions = await this.sessionStore.listProjectSessions(projectContext.sessionKey, projectContext.projectAlias);
    const activeSessionId = (await this.sessionStore.getConversation(projectContext.sessionKey))?.projects[projectContext.projectAlias]?.thread_id;

    switch (action) {
      case 'list': {
        if (sessions.length === 0) {
          await this.sendTextReply(context.chat_id, `项目 ${projectContext.projectAlias} 还没有保存的会话。`, context.message_id, context.text);
          return;
        }
        const lines = sessions.map((session, index) => {
          const prefix = session.thread_id === activeSessionId ? '*' : `${index + 1}.`;
          return `${prefix} ${session.thread_id} (${session.updated_at})${session.last_response_excerpt ? `\n   ${truncateExcerpt(session.last_response_excerpt, 80)}` : ''}`;
        });
        await this.sendTextReply(
          context.chat_id,
          [`项目: ${projectContext.projectAlias}`, `当前会话: ${activeSessionId ?? '未选择'}`, '', ...lines].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }
      case 'use': {
        if (!threadId) {
          await this.sendTextReply(context.chat_id, '用法: /session use <thread_id>', context.message_id, context.text);
          return;
        }
        await this.sessionStore.setActiveProjectSession(projectContext.sessionKey, projectContext.projectAlias, threadId);
        await this.sendTextReply(context.chat_id, `已切换到会话: ${threadId}`, context.message_id, context.text);
        return;
      }
      case 'new': {
        await this.sessionStore.clearActiveProjectSession(projectContext.sessionKey, projectContext.projectAlias);
        await this.sendTextReply(context.chat_id, '已切换为新会话模式。下一条消息会新开会话。', context.message_id, context.text);
        return;
      }
      case 'drop': {
        const targetThreadId = threadId ?? activeSessionId;
        if (!targetThreadId) {
          await this.sendTextReply(context.chat_id, '没有可删除的会话。', context.message_id, context.text);
          return;
        }
        await this.sessionStore.dropProjectSession(projectContext.sessionKey, projectContext.projectAlias, targetThreadId);
        await this.sendTextReply(context.chat_id, `已删除会话: ${targetThreadId}`, context.message_id, context.text);
      }
    }
  }

  private async handleKnowledgeCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action: 'search' | 'status',
    query?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const roots = await resolveKnowledgeRoots(projectContext.project);

    if (action === 'status') {
      const message = roots.length
        ? [`项目: ${projectContext.projectAlias}`, '知识库目录:', ...roots.map((root) => `- ${root}`)].join('\n')
        : [`项目: ${projectContext.projectAlias}`, '当前没有可用知识库目录。', '可在项目配置中设置 knowledge_paths，或在项目根下提供 docs/README。'].join('\n');
      await this.sendTextReply(context.chat_id, message, context.message_id, context.text);
      return;
    }

    if (!query) {
      await this.sendTextReply(context.chat_id, '用法: /kb search <query>', context.message_id, context.text);
      return;
    }

    const result = await searchKnowledgeBase(projectContext.project, query, 5);
    await this.auditLog.append({
      type: 'knowledge.search',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      query,
      result_count: result.matches.length,
    });

    if (result.roots.length === 0) {
      await this.sendTextReply(
        context.chat_id,
        [`项目: ${projectContext.projectAlias}`, '当前没有可搜索的知识库目录。', '可在项目配置中设置 knowledge_paths，或在项目根下提供 docs/README。'].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (result.matches.length === 0) {
      await this.sendTextReply(
        context.chat_id,
        [`项目: ${projectContext.projectAlias}`, `知识库搜索: ${query}`, '未找到匹配项。', '', '搜索目录:', ...result.roots.map((root) => `- ${root}`)].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    const lines = result.matches.map((match, index) => {
      const relativePath = match.file.startsWith(projectContext.project.root)
        ? match.file.slice(projectContext.project.root.length + 1)
        : match.file;
      return `${index + 1}. ${relativePath}:${match.line}\n   ${truncateExcerpt(match.text, 140)}`;
    });
    await this.sendTextReply(
      context.chat_id,
      [`项目: ${projectContext.projectAlias}`, `知识库搜索: ${query}`, '', ...lines].join('\n'),
      context.message_id,
      context.text,
    );
  }

  private async buildProjectsText(selectionKey: string): Promise<string> {
    const selected = await this.resolveProjectAlias(selectionKey);
    const lines = Object.entries(this.config.projects).map(([alias, project]) => {
      const marker = alias === selected ? '*' : '-';
      const description = project.description ? ` | ${project.description}` : '';
      return `${marker} ${alias}: ${project.root}${description}`;
    });
    return ['可用项目:', ...lines].join('\n');
  }

  private async buildStatusText(projectAlias: string, conversation: ConversationState, activeRun?: RunState | null): Promise<string> {
    const session = conversation.projects[projectAlias];
    const sessions = await this.sessionStore.listProjectSessions(buildConversationKeyForConversation(conversation), projectAlias);
    return [
      `项目: ${projectAlias}`,
      `当前会话: ${session?.thread_id ?? '未开始'}`,
      `已保存会话数: ${sessions.length}`,
      `最近更新时间: ${session?.updated_at ?? conversation.updated_at}`,
      `当前运行: ${activeRun ? `${activeRun.run_id} (${activeRun.status})` : '无'}`,
      '',
      session?.last_response_excerpt ?? '暂无回复摘要。',
    ].join('\n');
  }

  private buildStatusCardFromConversation(projectAlias: string, sessionKey: string, conversation: ConversationState, activeRun?: RunState | null): Record<string, unknown> {
    const session = conversation.projects[projectAlias];
    const sessionCount = Object.keys(session?.sessions ?? {}).length;
    return buildStatusCard({
      title: '当前会话状态',
      summary: session?.last_response_excerpt ?? '暂无会话摘要。',
      projectAlias,
      sessionId: session?.thread_id,
      runId: activeRun?.run_id,
      runStatus: activeRun?.status,
      sessionCount,
      includeActions: true,
      rerunPayload: session?.last_prompt && !activeRun
        ? {
            action: 'rerun',
            conversation_key: sessionKey,
            project_alias: projectAlias,
            chat_id: conversation.chat_id,
          }
        : undefined,
      newSessionPayload: {
        action: 'new',
        conversation_key: sessionKey,
        project_alias: projectAlias,
        chat_id: conversation.chat_id,
      },
      cancelPayload: activeRun
        ? {
            action: 'cancel',
            conversation_key: sessionKey,
            project_alias: projectAlias,
            chat_id: conversation.chat_id,
          }
        : undefined,
      statusPayload: {
        action: 'status',
        conversation_key: sessionKey,
        project_alias: projectAlias,
        chat_id: conversation.chat_id,
      },
    });
  }

  private async buildBridgePrompt(
    projectAlias: string,
    project: ProjectConfig,
    incomingMessage: IncomingMessageContext,
    userPrompt: string,
  ): Promise<string> {
    const prefixParts = [
      'You are replying through a Feishu bridge connected to Codex CLI.',
      'Keep the final response concise and action-oriented.',
      'When files change, summarize key paths and verification.',
      this.config.codex.bridge_instructions,
    ].filter(Boolean);

    if (project.instructions_prefix) {
      try {
        const projectInstructions = (await fs.readFile(project.instructions_prefix, 'utf8')).trim();
        if (projectInstructions) {
          prefixParts.push(projectInstructions);
        }
      } catch (error) {
        this.logger.warn({ error, projectAlias }, 'Failed to read project instructions prefix');
      }
    }

    return [
      ...prefixParts,
      '',
      `Current project alias: ${projectAlias}`,
      `Current project root: ${project.root}`,
      `Feishu message type: ${incomingMessage.message_type}`,
      '',
      'User message from Feishu:',
      userPrompt || '[no text body]',
      ...(incomingMessage.attachments.length > 0
        ? [
            '',
            'Message attachments:',
            ...incomingMessage.attachments.map((attachment, index) => `${index + 1}. ${attachment.summary}`),
          ]
        : []),
    ].join('\n');
  }

  private requireProject(alias: string): ProjectConfig {
    const project = this.config.projects[alias];
    if (!project) {
      throw new Error(`Unknown project alias: ${alias}`);
    }
    return project;
  }

  private async resolveProjectAlias(selectionKey: string): Promise<string> {
    const selection = await this.sessionStore.getConversation(selectionKey);
    if (selection?.selected_project_alias) {
      return selection.selected_project_alias;
    }
    const firstAlias = Object.keys(this.config.projects)[0];
    const selected = this.config.service.default_project ?? firstAlias;
    if (!selected) {
      throw new Error('No project configured.');
    }
    return selected;
  }

  private async resolveProjectContext(context: IncomingMessageContext, selectionKey: string): Promise<{
    projectAlias: string;
    project: ProjectConfig;
    sessionKey: string;
    queueKey: string;
  }> {
    const projectAlias = await this.resolveProjectAlias(selectionKey);
    const project = this.requireProject(projectAlias);
    const sessionKey = buildConversationKey({
      tenantKey: context.tenant_key,
      chatId: context.chat_id,
      actorId: context.actor_id,
      scope: project.session_scope,
    });
    await this.sessionStore.ensureConversation(sessionKey, {
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      tenant_key: context.tenant_key,
      scope: project.session_scope,
    });

    return {
      projectAlias,
      project,
      sessionKey,
      queueKey: buildQueueKey(sessionKey, projectAlias),
    };
  }

  private async getSelectionConversationKey(context: IncomingMessageContext): Promise<string> {
    const scope = this.getSelectionScope(context);
    const key = buildConversationKey({
      tenantKey: context.tenant_key,
      chatId: context.chat_id,
      actorId: context.actor_id,
      scope,
    });

    await this.sessionStore.ensureConversation(key, {
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      tenant_key: context.tenant_key,
      scope,
    });
    return key;
  }

  private getSelectionScope(context: Pick<IncomingMessageContext, 'actor_id'>): SessionScope {
    return context.actor_id ? 'chat-user' : 'chat';
  }

  private shouldRequireMention(project: ProjectConfig): boolean {
    return project.mention_required || this.config.security.require_group_mentions;
  }

  private async cancelActiveRun(queueKey: string, reason: 'user' | 'recovery'): Promise<boolean> {
    const live = this.activeRuns.get(queueKey);
    if (live) {
      live.cancelReason = reason;
      live.controller.abort(reason === 'user' ? 'Cancelled by user' : 'Recovered stale run');
      if (live.pid) {
        terminateProcess(live.pid, 'SIGTERM');
      }
      return true;
    }

    const persisted = await this.runStateStore.getActiveRun(queueKey);
    if (!persisted?.pid || !isProcessAlive(persisted.pid)) {
      return false;
    }
    await this.runStateStore.upsertRun(persisted.run_id, {
      queue_key: persisted.queue_key,
      conversation_key: persisted.conversation_key,
      project_alias: persisted.project_alias,
      chat_id: persisted.chat_id,
      actor_id: persisted.actor_id,
      session_id: persisted.session_id,
      pid: persisted.pid,
      prompt_excerpt: persisted.prompt_excerpt,
      status: 'cancelled',
      error: 'Cancelled from runtime management command',
    });
    return terminateProcess(persisted.pid, 'SIGTERM');
  }

  private async enforceSessionHistoryLimit(conversationKey: string, projectAlias: string): Promise<void> {
    const sessions = await this.sessionStore.listProjectSessions(conversationKey, projectAlias);
    const overflow = sessions.slice(this.config.service.session_history_limit);
    for (const session of overflow) {
      await this.sessionStore.dropProjectSession(conversationKey, projectAlias, session.thread_id);
    }
  }

  private async sendTextReply(chatId: string, body: string, replyToMessageId?: string, originalText?: string): Promise<void> {
    if (this.config.service.reply_quote_user_message && replyToMessageId) {
      await this.feishuClient.sendText(chatId, body, { replyToMessageId });
      return;
    }
    await this.feishuClient.sendText(chatId, this.formatQuotedReply(body, originalText));
  }

  private async sendCardReply(chatId: string, card: Record<string, unknown>, replyToMessageId?: string): Promise<void> {
    if (this.config.service.reply_quote_user_message && replyToMessageId) {
      await this.feishuClient.sendCard(chatId, card, { replyToMessageId });
      return;
    }
    await this.feishuClient.sendCard(chatId, card);
  }

  private formatQuotedReply(body: string, originalText?: string): string {
    if (!this.config.service.reply_quote_user_message || !originalText?.trim()) {
      return body;
    }

    const normalized = originalText.replace(/\s+/g, ' ').trim();
    const quoted = truncateExcerpt(normalized, this.config.service.reply_quote_max_chars);
    return [`引用: ${quoted}`, '', body].join('\n');
  }
}

export function buildQueueKey(conversationKey: string, projectAlias: string): string {
  return `${conversationKey}::project::${projectAlias}`;
}

function buildMessageDedupeKey(context: IncomingMessageContext): string {
  return ['message', context.tenant_key ?? 'tenant', context.chat_id, context.message_id].join('::');
}

function buildCardDedupeKey(context: IncomingCardActionContext, action: string): string | null {
  if (!context.open_message_id) {
    return null;
  }
  return ['card', context.tenant_key ?? 'tenant', context.chat_id ?? 'chat', context.actor_id ?? 'actor', context.open_message_id, action].join('::');
}

function truncateExcerpt(text: string, limit: number = 160): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function buildConversationKeyForConversation(conversation: ConversationState): string {
  return buildConversationKey({
    tenantKey: conversation.tenant_key,
    chatId: conversation.chat_id,
    actorId: conversation.actor_id,
    scope: conversation.scope,
  });
}
