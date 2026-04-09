import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QwenBackend, qwenBackendDefinition } from '../src/backend/qwen.js';
import { getBackendDefinition } from '../src/backend/registry.js';
import type { BridgeConfig } from '../src/config/schema.js';

/**
 * Tests for the Qwen backend focus on the bits that are unique to qwen:
 *
 *   1. Registry self-registration (proves side-effect import works)
 *   2. Default factory options (approval-mode 'default', bin 'qwen')
 *   3. Session scanning from the JSONL chats/ directory layout
 *
 * We intentionally don't test the run() pipeline end-to-end — that
 * would require spawning the real qwen binary. ClaudeBackend's run()
 * is the same shape and is covered indirectly by bridge-service.test.ts.
 */

describe('QwenBackend — registry', () => {
  it('self-registers on module import', () => {
    expect(getBackendDefinition('qwen')).toBeDefined();
    expect(getBackendDefinition('qwen')?.name).toBe('qwen');
  });

  it('exports qwenBackendDefinition with defaultFallback ["claude", "codex"]', () => {
    expect(qwenBackendDefinition.name).toBe('qwen');
    expect(qwenBackendDefinition.defaultFallback).toEqual(['claude', 'codex']);
  });

  it('produces a bin probe spec from config.qwen (with fallback to config.codex.shell)', () => {
    const config = {
      codex: { bin: 'codex', shell: '/bin/zsh', pre_exec: 'proxy_on' },
      qwen: { bin: '/opt/homebrew/bin/qwen' },
    } as unknown as BridgeConfig;
    const spec = qwenBackendDefinition.probeSpec(config);
    expect(spec.bin).toBe('/opt/homebrew/bin/qwen');
    expect(spec.shell).toBe('/bin/zsh');
    expect(spec.preExec).toBe('proxy_on');
  });

  it('falls back to bin="qwen" when config.qwen is unset', () => {
    const config = {
      codex: { bin: 'codex' },
    } as unknown as BridgeConfig;
    const spec = qwenBackendDefinition.probeSpec(config);
    expect(spec.bin).toBe('qwen');
  });
});

describe('QwenBackend — session scanning', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-backend-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  /** Write a JSONL chat file matching the qwen 0.14.x layout. */
  async function writeChat(slug: string, sessionUuid: string, cwd: string, timestamp: string): Promise<void> {
    const dir = path.join(tmpHome, 'projects', slug, 'chats');
    await fs.mkdir(dir, { recursive: true });
    const header = {
      uuid: `header-${sessionUuid}`,
      parentUuid: null,
      sessionId: sessionUuid,
      timestamp,
      type: 'system',
      cwd,
      version: '0.14.1',
    };
    const filePath = path.join(dir, `${sessionUuid}.jsonl`);
    await fs.writeFile(filePath, JSON.stringify(header) + '\n', 'utf8');
  }

  it('finds the latest session for an exact-root match', async () => {
    await writeChat('-tmp-repo-a', 'sess-aaa', '/tmp/repo-a', '2026-04-01T00:00:00Z');
    await writeChat('-tmp-repo-b', 'sess-bbb', '/tmp/repo-b', '2026-04-02T00:00:00Z');

    const backend = new QwenBackend(
      { bin: 'qwen', defaultApprovalMode: 'default', runTimeoutMs: 1000 },
      tmpHome,
    );

    const latest = await backend.findLatestSession('/tmp/repo-a');
    expect(latest).not.toBeNull();
    expect(latest?.sessionId).toBe('sess-aaa');
    expect(latest?.cwd).toBe('/tmp/repo-a');
    expect(latest?.matchKind).toBe('exact-root');
  });

  it('returns null when no session matches the project root', async () => {
    await writeChat('-tmp-repo-a', 'sess-aaa', '/tmp/repo-a', '2026-04-01T00:00:00Z');

    const backend = new QwenBackend(
      { bin: 'qwen', defaultApprovalMode: 'default', runTimeoutMs: 1000 },
      tmpHome,
    );

    const latest = await backend.findLatestSession('/tmp/unrelated');
    expect(latest).toBeNull();
  });

  it('findSessionById returns the specific session when cwd matches', async () => {
    await writeChat('-tmp-repo-a', 'sess-aaa', '/tmp/repo-a', '2026-04-01T00:00:00Z');
    await writeChat('-tmp-repo-a', 'sess-ccc', '/tmp/repo-a', '2026-04-03T00:00:00Z');

    const backend = new QwenBackend(
      { bin: 'qwen', defaultApprovalMode: 'default', runTimeoutMs: 1000 },
      tmpHome,
    );

    const found = await backend.findSessionById('/tmp/repo-a', 'sess-ccc');
    expect(found?.sessionId).toBe('sess-ccc');
  });

  it('returns null when the home dir does not exist yet', async () => {
    const backend = new QwenBackend(
      { bin: 'qwen', defaultApprovalMode: 'default', runTimeoutMs: 1000 },
      path.join(tmpHome, 'does-not-exist'),
    );

    const latest = await backend.findLatestSession('/tmp/repo-a');
    expect(latest).toBeNull();
  });

  it('skips chat files with missing sessionId or cwd in the header', async () => {
    const dir = path.join(tmpHome, 'projects', '-tmp-broken', 'chats');
    await fs.mkdir(dir, { recursive: true });
    // Header without sessionId — should be ignored.
    await fs.writeFile(
      path.join(dir, 'broken.jsonl'),
      JSON.stringify({ type: 'system', cwd: '/tmp/broken' }) + '\n',
      'utf8',
    );

    const backend = new QwenBackend(
      { bin: 'qwen', defaultApprovalMode: 'default', runTimeoutMs: 1000 },
      tmpHome,
    );

    const sessions = await backend.listProjectSessions('/tmp/broken');
    expect(sessions).toEqual([]);
  });
});
