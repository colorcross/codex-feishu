import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createHandoff,
  acceptHandoff,
  createReview,
  resolveReview,
  formatHandoff,
  formatReview,
  formatReviewResult,
} from '../src/collaboration/handoff.js';
import { HandoffStore } from '../src/state/handoff-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('createHandoff', () => {
  it('creates a pending handoff with UUID and timestamp', () => {
    const record = createHandoff({
      from_actor_id: 'alice',
      from_actor_name: 'Alice',
      project_alias: 'proj-a',
      conversation_key: 'ck-1',
      summary: 'Need help with deployment',
      last_prompt: 'How to deploy?',
      files_touched: ['src/deploy.ts'],
      decisions: ['Use blue-green deployment'],
    });

    expect(record.id).toBeTruthy();
    expect(record.id.length).toBe(36); // UUID format
    expect(record.from_actor_id).toBe('alice');
    expect(record.from_actor_name).toBe('Alice');
    expect(record.project_alias).toBe('proj-a');
    expect(record.conversation_key).toBe('ck-1');
    expect(record.summary).toBe('Need help with deployment');
    expect(record.status).toBe('pending');
    expect(record.created_at).toBeTruthy();
    expect(record.context_snapshot.last_prompt).toBe('How to deploy?');
    expect(record.context_snapshot.files_touched).toEqual(['src/deploy.ts']);
    expect(record.context_snapshot.decisions).toEqual(['Use blue-green deployment']);
  });

  it('creates handoff with optional target actor', () => {
    const record = createHandoff({
      from_actor_id: 'alice',
      to_actor_id: 'bob',
      project_alias: 'proj-a',
      conversation_key: 'ck-1',
      summary: 'Hand off to Bob',
    });

    expect(record.to_actor_id).toBe('bob');
  });

  it('creates handoff without optional fields', () => {
    const record = createHandoff({
      from_actor_id: 'alice',
      project_alias: 'proj-a',
      conversation_key: 'ck-1',
      summary: 'General handoff',
    });

    expect(record.to_actor_id).toBeUndefined();
    expect(record.context_snapshot.last_prompt).toBeUndefined();
    expect(record.context_snapshot.files_touched).toBeUndefined();
    expect(record.context_snapshot.decisions).toBeUndefined();
  });
});

describe('acceptHandoff', () => {
  it('marks handoff as accepted with timestamp and acceptor', () => {
    const original = createHandoff({
      from_actor_id: 'alice',
      project_alias: 'proj-a',
      conversation_key: 'ck-1',
      summary: 'Test',
    });

    const accepted = acceptHandoff(original, 'bob');
    expect(accepted.status).toBe('accepted');
    expect(accepted.accepted_by).toBe('bob');
    expect(accepted.accepted_at).toBeTruthy();
    // Original fields preserved
    expect(accepted.from_actor_id).toBe('alice');
    expect(accepted.summary).toBe('Test');
    expect(accepted.id).toBe(original.id);
  });
});

describe('createReview', () => {
  it('creates a pending review record', () => {
    const review = createReview({
      run_id: 'run-1',
      project_alias: 'proj-a',
      chat_id: 'chat-1',
      actor_id: 'alice',
      content_excerpt: 'Generated deployment script',
    });

    expect(review.id).toBeTruthy();
    expect(review.run_id).toBe('run-1');
    expect(review.project_alias).toBe('proj-a');
    expect(review.chat_id).toBe('chat-1');
    expect(review.actor_id).toBe('alice');
    expect(review.content_excerpt).toBe('Generated deployment script');
    expect(review.status).toBe('pending');
    expect(review.created_at).toBeTruthy();
    expect(review.reviewer_id).toBeUndefined();
    expect(review.review_comment).toBeUndefined();
  });
});

describe('resolveReview', () => {
  it('approves a review with comment', () => {
    const review = createReview({
      run_id: 'run-1',
      project_alias: 'proj-a',
      chat_id: 'chat-1',
      actor_id: 'alice',
      content_excerpt: 'Some output',
    });

    const resolved = resolveReview(review, 'approved', 'bob', 'Looks good');
    expect(resolved.status).toBe('approved');
    expect(resolved.reviewer_id).toBe('bob');
    expect(resolved.review_comment).toBe('Looks good');
    expect(resolved.resolved_at).toBeTruthy();
    expect(resolved.id).toBe(review.id);
  });

  it('rejects a review with reason', () => {
    const review = createReview({
      run_id: 'run-1',
      project_alias: 'proj-a',
      chat_id: 'chat-1',
      actor_id: 'alice',
      content_excerpt: 'Risky changes',
    });

    const resolved = resolveReview(review, 'rejected', 'bob', 'Needs more testing');
    expect(resolved.status).toBe('rejected');
    expect(resolved.reviewer_id).toBe('bob');
    expect(resolved.review_comment).toBe('Needs more testing');
  });

  it('resolves without comment', () => {
    const review = createReview({
      run_id: 'run-1',
      project_alias: 'proj-a',
      chat_id: 'chat-1',
      actor_id: 'alice',
      content_excerpt: 'Output',
    });

    const resolved = resolveReview(review, 'approved', 'bob');
    expect(resolved.review_comment).toBeUndefined();
  });
});

describe('formatHandoff', () => {
  it('formats a handoff with all context', () => {
    const record = createHandoff({
      from_actor_id: 'alice',
      from_actor_name: 'Alice',
      to_actor_id: 'bob',
      project_alias: 'proj-a',
      conversation_key: 'ck-1',
      summary: 'Need help with deployment',
      last_prompt: 'How to deploy?',
      files_touched: ['src/deploy.ts', 'config.yaml'],
      decisions: ['Use blue-green deployment'],
    });

    const text = formatHandoff(record);
    expect(text).toContain('会话交接');
    expect(text).toContain('proj-a');
    expect(text).toContain('Alice');
    expect(text).toContain('bob');
    expect(text).toContain('Need help with deployment');
    expect(text).toContain('How to deploy?');
    expect(text).toContain('src/deploy.ts');
    expect(text).toContain('Use blue-green deployment');
    expect(text).toContain('/pickup');
  });

  it('shows "anyone can accept" when no target', () => {
    const record = createHandoff({
      from_actor_id: 'alice',
      project_alias: 'proj-a',
      conversation_key: 'ck-1',
      summary: 'General handoff',
    });
    const text = formatHandoff(record);
    expect(text).toContain('任何人可接');
  });
});

describe('formatReview', () => {
  it('formats a review request', () => {
    const review = createReview({
      run_id: 'run-1',
      project_alias: 'proj-a',
      chat_id: 'chat-1',
      actor_id: 'alice',
      content_excerpt: 'Generated code for feature X',
    });
    const text = formatReview(review);
    expect(text).toContain('评审请求');
    expect(text).toContain('proj-a');
    expect(text).toContain('alice');
    expect(text).toContain('Generated code for feature X');
    expect(text).toContain('/approve');
    expect(text).toContain('/reject');
  });
});

describe('formatReviewResult', () => {
  it('formats approved result', () => {
    const review = createReview({
      run_id: 'run-1',
      project_alias: 'proj-a',
      chat_id: 'chat-1',
      actor_id: 'alice',
      content_excerpt: 'Output',
    });
    const resolved = resolveReview(review, 'approved', 'bob', 'Great work');
    const text = formatReviewResult(resolved);
    expect(text).toContain('已批准');
    expect(text).toContain('bob');
    expect(text).toContain('Great work');
  });

  it('formats rejected result', () => {
    const review = createReview({
      run_id: 'run-1',
      project_alias: 'proj-a',
      chat_id: 'chat-1',
      actor_id: 'alice',
      content_excerpt: 'Output',
    });
    const resolved = resolveReview(review, 'rejected', 'bob', 'Not ready');
    const text = formatReviewResult(resolved);
    expect(text).toContain('已打回');
    expect(text).toContain('bob');
    expect(text).toContain('Not ready');
  });
});

describe('HandoffStore', () => {
  it('adds and retrieves a pending handoff', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-handoff-'));
    tempDirs.push(dir);
    const store = new HandoffStore(dir);

    const record = createHandoff({
      from_actor_id: 'alice',
      project_alias: 'proj-a',
      conversation_key: 'ck-1',
      summary: 'Test handoff',
    });

    await store.addHandoff(record);
    const pending = await store.getPendingHandoff('proj-a');
    expect(pending).not.toBeNull();
    expect(pending!.id).toBe(record.id);
    expect(pending!.status).toBe('pending');
  });

  it('returns null when no pending handoff', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-handoff-'));
    tempDirs.push(dir);
    const store = new HandoffStore(dir);

    const pending = await store.getPendingHandoff('proj-a');
    expect(pending).toBeNull();
  });

  it('updates a handoff by full ID', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-handoff-'));
    tempDirs.push(dir);
    const store = new HandoffStore(dir);

    const record = createHandoff({
      from_actor_id: 'alice',
      project_alias: 'proj-a',
      conversation_key: 'ck-1',
      summary: 'Test',
    });
    await store.addHandoff(record);

    const updated = await store.updateHandoff(record.id, {
      status: 'accepted',
      accepted_by: 'bob',
      accepted_at: new Date().toISOString(),
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('accepted');
    expect(updated!.accepted_by).toBe('bob');
  });

  it('updates a handoff by ID prefix', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-handoff-'));
    tempDirs.push(dir);
    const store = new HandoffStore(dir);

    const record = createHandoff({
      from_actor_id: 'alice',
      project_alias: 'proj-a',
      conversation_key: 'ck-1',
      summary: 'Test',
    });
    await store.addHandoff(record);

    const prefix = record.id.slice(0, 8);
    const updated = await store.updateHandoff(prefix, { status: 'accepted' });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('accepted');
  });

  it('returns null when updating non-existent handoff', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-handoff-'));
    tempDirs.push(dir);
    const store = new HandoffStore(dir);

    const updated = await store.updateHandoff('nonexistent', { status: 'accepted' });
    expect(updated).toBeNull();
  });

  it('adds and retrieves a pending review', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-handoff-'));
    tempDirs.push(dir);
    const store = new HandoffStore(dir);

    const review = createReview({
      run_id: 'run-1',
      project_alias: 'proj-a',
      chat_id: 'chat-1',
      actor_id: 'alice',
      content_excerpt: 'Test content',
    });

    await store.addReview(review);
    const pending = await store.getPendingReview('chat-1');
    expect(pending).not.toBeNull();
    expect(pending!.id).toBe(review.id);
    expect(pending!.status).toBe('pending');
  });

  it('returns null when no pending review for chat', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-handoff-'));
    tempDirs.push(dir);
    const store = new HandoffStore(dir);

    const pending = await store.getPendingReview('chat-1');
    expect(pending).toBeNull();
  });

  it('updates a review', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-handoff-'));
    tempDirs.push(dir);
    const store = new HandoffStore(dir);

    const review = createReview({
      run_id: 'run-1',
      project_alias: 'proj-a',
      chat_id: 'chat-1',
      actor_id: 'alice',
      content_excerpt: 'Test',
    });
    await store.addReview(review);

    const updated = await store.updateReview(review.id, {
      status: 'approved',
      reviewer_id: 'bob',
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('approved');
    expect(updated!.reviewer_id).toBe('bob');
  });

  it('lists handoffs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-handoff-'));
    tempDirs.push(dir);
    const store = new HandoffStore(dir);

    const h1 = createHandoff({ from_actor_id: 'a', project_alias: 'p1', conversation_key: 'ck', summary: 'h1' });
    const h2 = createHandoff({ from_actor_id: 'b', project_alias: 'p2', conversation_key: 'ck', summary: 'h2' });
    await store.addHandoff(h1);
    await store.addHandoff(h2);

    const list = await store.listHandoffs();
    expect(list).toHaveLength(2);
    // Most recent first (unshift)
    expect(list[0]!.summary).toBe('h2');
    expect(list[1]!.summary).toBe('h1');
  });

  it('persists data across store instances', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-handoff-'));
    tempDirs.push(dir);

    const store1 = new HandoffStore(dir);
    const record = createHandoff({
      from_actor_id: 'alice',
      project_alias: 'proj-a',
      conversation_key: 'ck-1',
      summary: 'Persist test',
    });
    await store1.addHandoff(record);

    const store2 = new HandoffStore(dir);
    const pending = await store2.getPendingHandoff('proj-a');
    expect(pending).not.toBeNull();
    expect(pending!.summary).toBe('Persist test');
  });
});
