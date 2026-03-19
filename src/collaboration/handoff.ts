/**
 * Direction 3: 接力与评审 — Relay & Review Workflows
 *
 * Enables structured handoff of AI sessions between team members
 * and review workflows for AI-generated output.
 */

import { randomUUID } from 'node:crypto';

export type HandoffStatus = 'pending' | 'accepted' | 'expired';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface HandoffRecord {
  id: string;
  from_actor_id: string;
  from_actor_name?: string;
  to_actor_id?: string;
  project_alias: string;
  conversation_key: string;
  thread_id?: string;
  summary: string;
  context_snapshot: {
    last_prompt?: string;
    last_response_excerpt?: string;
    files_touched?: string[];
    decisions?: string[];
  };
  status: HandoffStatus;
  created_at: string;
  accepted_at?: string;
  accepted_by?: string;
}

export interface ReviewRecord {
  id: string;
  run_id: string;
  project_alias: string;
  chat_id: string;
  actor_id: string;
  content_excerpt: string;
  status: ReviewStatus;
  reviewer_id?: string;
  review_comment?: string;
  created_at: string;
  resolved_at?: string;
}

export function createHandoff(input: {
  from_actor_id: string;
  from_actor_name?: string;
  to_actor_id?: string;
  project_alias: string;
  conversation_key: string;
  thread_id?: string;
  summary: string;
  last_prompt?: string;
  last_response_excerpt?: string;
  files_touched?: string[];
  decisions?: string[];
}): HandoffRecord {
  return {
    id: randomUUID(),
    from_actor_id: input.from_actor_id,
    from_actor_name: input.from_actor_name,
    to_actor_id: input.to_actor_id,
    project_alias: input.project_alias,
    conversation_key: input.conversation_key,
    thread_id: input.thread_id,
    summary: input.summary,
    context_snapshot: {
      last_prompt: input.last_prompt,
      last_response_excerpt: input.last_response_excerpt,
      files_touched: input.files_touched,
      decisions: input.decisions,
    },
    status: 'pending',
    created_at: new Date().toISOString(),
  };
}

export function acceptHandoff(record: HandoffRecord, acceptedBy: string): HandoffRecord {
  return {
    ...record,
    status: 'accepted',
    accepted_at: new Date().toISOString(),
    accepted_by: acceptedBy,
  };
}

export function createReview(input: {
  run_id: string;
  project_alias: string;
  chat_id: string;
  actor_id: string;
  content_excerpt: string;
}): ReviewRecord {
  return {
    id: randomUUID(),
    run_id: input.run_id,
    project_alias: input.project_alias,
    chat_id: input.chat_id,
    actor_id: input.actor_id,
    content_excerpt: input.content_excerpt,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
}

export function resolveReview(
  record: ReviewRecord,
  decision: 'approved' | 'rejected',
  reviewerId: string,
  comment?: string,
): ReviewRecord {
  return {
    ...record,
    status: decision,
    reviewer_id: reviewerId,
    review_comment: comment,
    resolved_at: new Date().toISOString(),
  };
}

export function formatHandoff(record: HandoffRecord): string {
  const lines: string[] = [];
  const target = record.to_actor_id ? `→ ${record.to_actor_id}` : '→ 任何人可接';

  lines.push(`🤝 会话交接 [${record.project_alias}]`);
  lines.push(`  发起: ${record.from_actor_name ?? record.from_actor_id} ${target}`);
  lines.push(`  摘要: ${record.summary}`);

  if (record.context_snapshot.last_prompt) {
    lines.push(`  最近提问: "${truncate(record.context_snapshot.last_prompt, 80)}"`);
  }
  if (record.context_snapshot.files_touched?.length) {
    lines.push(`  涉及文件: ${record.context_snapshot.files_touched.join(', ')}`);
  }
  if (record.context_snapshot.decisions?.length) {
    lines.push(`  已有决策: ${record.context_snapshot.decisions.join('; ')}`);
  }

  lines.push(`\n使用 /pickup ${record.id.slice(0, 8)} 接手此任务`);
  return lines.join('\n');
}

export function formatReview(record: ReviewRecord): string {
  const lines: string[] = [];
  lines.push(`📋 评审请求 [${record.project_alias}]`);
  lines.push(`  发起人: ${record.actor_id}`);
  lines.push(`  内容: "${truncate(record.content_excerpt, 120)}"`);
  lines.push(`\n使用 /approve 或 /reject [原因] 来完成评审`);
  return lines.join('\n');
}

export function formatReviewResult(record: ReviewRecord): string {
  const icon = record.status === 'approved' ? '✅' : '❌';
  const action = record.status === 'approved' ? '已批准' : '已打回';
  const comment = record.review_comment ? `\n  评语: ${record.review_comment}` : '';
  return `${icon} 评审${action} by ${record.reviewer_id ?? '评审人'}${comment}`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}
