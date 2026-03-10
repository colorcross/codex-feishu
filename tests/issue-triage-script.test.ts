import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { classifyIssue, diffManagedLabels } = require('../.github/scripts/issue-triage.cjs') as {
  classifyIssue: (input: { title?: string; body?: string; existingLabels?: string[] }) => string[];
  diffManagedLabels: (existingLabels: string[], nextLabels: string[]) => { add: string[]; remove: string[] };
};

describe('issue triage script', () => {
  it('classifies issue area labels from text keywords', () => {
    const labels = classifyIssue({
      title: 'Webhook reply fails after Codex resume',
      body: 'Feishu webhook mode fails when Codex resume is triggered from a session command.',
      existingLabels: ['bug'],
    });

    expect(labels).toContain('area/feishu');
    expect(labels).toContain('area/codex');
    expect(labels).toContain('area/session');
  });

  it('adds and removes managed status labels conservatively', () => {
    const nextLabels = classifyIssue({
      title: 'Help',
      body: 'Short bug',
      existingLabels: ['bug', 'status/needs-feedback', 'area/docs'],
    });
    const diff = diffManagedLabels(['bug', 'status/needs-feedback', 'area/docs'], nextLabels);

    expect(nextLabels).toContain('status/needs-repro');
    expect(diff.add).toContain('status/needs-repro');
    expect(diff.remove).toContain('area/docs');
  });
});
