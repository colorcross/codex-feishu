import { describe, expect, it } from 'vitest';
import { buildCodexArgs, buildSpawnSpec, summarizeCodexEvent } from '../src/codex/runner.js';
import type { CodexCliCapabilities } from '../src/codex/capabilities.js';

const capabilities: CodexCliCapabilities = {
  version: 'codex-cli 0.98.0',
  exec: {
    supportsCd: true,
    supportsSandbox: true,
    supportsProfile: true,
    supportsJson: true,
    supportsOutputLastMessage: true,
  },
  resume: {
    supportsCd: false,
    supportsSandbox: false,
    supportsProfile: false,
    supportsJson: true,
    supportsOutputLastMessage: false,
  },
};

describe('codex runner spawn spec', () => {
  it('builds exec args with cwd, sandbox, and profile for fresh sessions', () => {
    const args = buildCodexArgs(
      {
        bin: 'codex',
        workdir: '/tmp/repo',
        prompt: 'hello',
        sandbox: 'workspace-write',
        profile: 'default',
        skipGitRepoCheck: true,
        logger: {} as any,
      },
      '/tmp/out.txt',
      capabilities,
    );

    expect(args).toEqual([
      'exec',
      '--json',
      '--output-last-message',
      '/tmp/out.txt',
      '--skip-git-repo-check',
      '-C',
      '/tmp/repo',
      '--sandbox',
      'workspace-write',
      '--profile',
      'default',
      'hello',
    ]);
  });

  it('builds resume args without unsupported exec-only options', () => {
    const args = buildCodexArgs(
      {
        bin: 'codex',
        workdir: '/tmp/repo',
        prompt: 'follow up',
        sessionId: 'session-123',
        sandbox: 'workspace-write',
        profile: 'default',
        skipGitRepoCheck: true,
        logger: {} as any,
      },
      '/tmp/out.txt',
      capabilities,
    );

    expect(args).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', 'session-123', 'follow up']);
  });

  it('spawns codex directly when no pre_exec is configured', () => {
    const spec = buildSpawnSpec(
      {
        bin: 'codex',
      },
      ['exec', '--json', 'hello'],
    );

    expect(spec).toEqual({
      command: 'codex',
      args: ['exec', '--json', 'hello'],
    });
  });

  it('wraps codex with an interactive shell when pre_exec is configured', () => {
    const spec = buildSpawnSpec(
      {
        bin: 'codex',
        shell: '/bin/zsh',
        preExec: 'proxy_on',
      },
      ['exec', '--json', "it's me"],
    );

    expect(spec.command).toBe('/bin/zsh');
    expect(spec.args[0]).toBe('-ic');
    expect(spec.args[1]).toContain('proxy_on &&');
    expect(spec.args[1]).toContain("'codex'");
    expect(spec.args[1]).toContain("'it'\"'\"'s me'");
  });

  it('suppresses non-error progress event summaries', () => {
    expect(summarizeCodexEvent({ type: 'turn.started' })).toBeNull();
    expect(summarizeCodexEvent({ type: 'turn.completed' })).toBeNull();
    expect(summarizeCodexEvent({ item: { type: 'shell_command' } })).toBeNull();
    expect(summarizeCodexEvent({ type: 'error', message: 'boom' })).toBe('Codex 错误：boom');
  });
});
