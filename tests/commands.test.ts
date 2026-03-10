import { describe, expect, it } from 'vitest';
import { buildHelpText, normalizeIncomingText, parseBridgeCommand } from '../src/bridge/commands.js';

describe('bridge commands', () => {
  it('parses project switch commands', () => {
    expect(parseBridgeCommand('/project repo-a')).toEqual({ kind: 'project', alias: 'repo-a' });
  });

  it('parses session commands', () => {
    expect(parseBridgeCommand('/session list')).toEqual({ kind: 'session', action: 'list' });
    expect(parseBridgeCommand('/session use thread-123')).toEqual({ kind: 'session', action: 'use', threadId: 'thread-123' });
    expect(parseBridgeCommand('/session new')).toEqual({ kind: 'session', action: 'new' });
    expect(parseBridgeCommand('/session drop')).toEqual({ kind: 'session', action: 'drop', threadId: undefined });
    expect(parseBridgeCommand('/cancel')).toEqual({ kind: 'cancel' });
    expect(parseBridgeCommand('/kb status')).toEqual({ kind: 'kb', action: 'status' });
    expect(parseBridgeCommand('/kb search install')).toEqual({ kind: 'kb', action: 'search', query: 'install' });
  });

  it('treats unknown slash commands as prompts', () => {
    expect(parseBridgeCommand('/fix this bug')).toEqual({ kind: 'prompt', prompt: '/fix this bug' });
  });

  it('normalizes leading mentions', () => {
    expect(normalizeIncomingText('@Codex   帮我看下这个报错')).toBe('帮我看下这个报错');
  });

  it('renders help text with key commands', () => {
    const helpText = buildHelpText();
    expect(helpText).toContain('/projects');
    expect(helpText).toContain('/new');
    expect(helpText).toContain('/session list');
    expect(helpText).toContain('/cancel');
    expect(helpText).toContain('/kb search');
  });
});
