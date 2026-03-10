import { describe, expect, it } from 'vitest';
import { splitTextForFeishu, truncateForFeishuCard } from '../src/feishu/text.js';

describe('feishu text utilities', () => {
  it('splits oversized text into multiple chunks', () => {
    const input = 'a'.repeat(2000) + '\n\n' + 'b'.repeat(2000);
    const chunks = splitTextForFeishu(input, 1800);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1800)).toBe(true);
  });

  it('truncates card summaries safely', () => {
    const summary = truncateForFeishuCard('x'.repeat(1300), 1200);
    expect(summary.length).toBeLessThanOrEqual(1200);
    expect(summary.endsWith('…')).toBe(true);
  });
});
