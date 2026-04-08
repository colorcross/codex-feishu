import { beforeEach, describe, expect, it } from 'vitest';
import { resolveProjectBackendWithFailover } from '../src/backend/factory.js';
import { clearProbeCache } from '../src/backend/probe.js';
import type { BridgeConfig } from '../src/config/schema.js';

/**
 * Minimal BridgeConfig factory for failover unit tests. We only populate
 * the fields the failover resolver touches (backend / codex / claude /
 * projects) and cast through unknown to satisfy the full schema type.
 */
function makeConfig(overrides: {
  defaultBackend?: 'codex' | 'claude';
  failover?: boolean;
  codexBin: string;
  claudeBin: string;
  projects?: Record<string, { backend?: 'codex' | 'claude'; failover?: boolean }>;
}): BridgeConfig {
  return {
    backend: {
      default: overrides.defaultBackend ?? 'codex',
      failover: overrides.failover ?? true,
    },
    codex: {
      bin: overrides.codexBin,
      pre_exec: undefined,
      shell: undefined,
      default_profile: undefined,
      default_sandbox: 'workspace-write',
      skip_git_repo_check: false,
      run_timeout_ms: 1000,
    },
    claude: {
      bin: overrides.claudeBin,
      pre_exec: undefined,
      shell: undefined,
      default_permission_mode: 'auto',
      output_token_limit: 4000,
    },
    projects: Object.fromEntries(
      Object.entries(overrides.projects ?? {}).map(([alias, p]) => [
        alias,
        {
          root: '/tmp/nope',
          backend: p.backend,
          failover: p.failover,
          session_scope: 'chat',
          mention_required: false,
          knowledge_paths: [],
          wiki_space_ids: [],
          admin_chat_ids: [],
          notification_chat_ids: [],
          run_priority: 100,
          chat_rate_limit_window_seconds: 60,
          chat_rate_limit_max_runs: 20,
        },
      ]),
    ),
  } as unknown as BridgeConfig;
}

describe('resolveProjectBackendWithFailover', () => {
  beforeEach(() => {
    clearProbeCache();
  });

  it('returns the primary when its probe succeeds', async () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      codexBin: '/usr/bin/true',
      claudeBin: '/usr/bin/false',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    expect(result.name).toBe('codex');
    expect(result.failover).toBeUndefined();
  });

  it('falls over to the alternate when the primary probe fails and the alternate succeeds', async () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      codexBin: '/definitely/missing/xyz',
      claudeBin: '/usr/bin/true',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    expect(result.name).toBe('claude');
    expect(result.failover).toBeDefined();
    expect(result.failover?.from).toBe('codex');
    expect(result.failover?.to).toBe('claude');
    expect(result.failover?.reason).toContain('not found');
  });

  it('returns the primary (with no failover info) when both probes fail', async () => {
    const config = makeConfig({
      defaultBackend: 'claude',
      codexBin: '/definitely/missing/xyz',
      claudeBin: '/definitely/missing/abc',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    expect(result.name).toBe('claude');
    expect(result.failover).toBeUndefined();
  });

  it('respects per-project failover=false and returns the broken primary', async () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      codexBin: '/definitely/missing/xyz',
      claudeBin: '/usr/bin/true',
      projects: { demo: { failover: false } },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    expect(result.name).toBe('codex');
    expect(result.failover).toBeUndefined();
  });

  it('respects global backend.failover=false', async () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      failover: false,
      codexBin: '/definitely/missing/xyz',
      claudeBin: '/usr/bin/true',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    expect(result.name).toBe('codex');
    expect(result.failover).toBeUndefined();
  });

  it('per-project failover=true overrides global failover=false', async () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      failover: false,
      codexBin: '/definitely/missing/xyz',
      claudeBin: '/usr/bin/true',
      projects: { demo: { failover: true } },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    expect(result.name).toBe('claude');
    expect(result.failover?.to).toBe('claude');
  });

  it('honors session override as the primary', async () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      codexBin: '/usr/bin/true',
      claudeBin: '/definitely/missing/xyz',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo', 'claude');
    // Session override selects claude as primary; it fails; codex is up; we failover to codex.
    expect(result.name).toBe('codex');
    expect(result.failover?.from).toBe('claude');
    expect(result.failover?.to).toBe('codex');
  });
});
