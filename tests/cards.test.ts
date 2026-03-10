import { describe, expect, it } from 'vitest';
import { buildStatusCard } from '../src/feishu/cards.js';

describe('status card', () => {
  it('includes actions only when requested', () => {
    const card = buildStatusCard({
      title: 'Done',
      summary: 'Summary',
      projectAlias: 'repo-a',
      sessionId: 'thread-1',
      includeActions: true,
      rerunPayload: { action: 'rerun' },
      newSessionPayload: { action: 'new' },
      statusPayload: { action: 'status' },
    });

    expect(card.header).toBeTruthy();
    expect(Array.isArray(card.elements)).toBe(true);
    expect(JSON.stringify(card)).toContain('重试上一轮');
  });
});
