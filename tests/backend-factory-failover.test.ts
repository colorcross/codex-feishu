import { beforeEach, describe, expect, it } from 'vitest';
import { resolveProjectBackendWithFailover, resolveFallbackChain } from '../src/backend/factory.js';
import { clearProbeCache } from '../src/backend/probe.js';
import { listBackendNames } from '../src/backend/registry.js';
import type { BridgeConfig } from '../src/config/schema.js';

/**
 * Minimal BridgeConfig factory for failover unit tests. We only populate
 * the fields the failover resolver touches (backend / codex / claude /
 * qwen / projects) and cast through unknown to satisfy the full schema type.
 */
function makeConfig(overrides: {
  defaultBackend?: string;
  failover?: boolean;
  fallback?: string[];
  codexBin: string;
  claudeBin: string;
  qwenBin: string;
  projects?: Record<string, { backend?: string; failover?: boolean; fallback?: string[] }>;
}): BridgeConfig {
  const backendSection: Record<string, unknown> = {
    default: overrides.defaultBackend ?? 'codex',
    failover: overrides.failover ?? true,
  };
  if (overrides.fallback) backendSection.fallback = overrides.fallback;

  return {
    backend: backendSection,
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
    qwen: {
      bin: overrides.qwenBin,
      pre_exec: undefined,
      shell: undefined,
      default_approval_mode: 'default',
      output_token_limit: 4000,
    },
    projects: Object.fromEntries(
      Object.entries(overrides.projects ?? {}).map(([alias, p]) => [
        alias,
        {
          root: '/tmp/nope',
          backend: p.backend,
          failover: p.failover,
          fallback: p.fallback,
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

describe('resolveProjectBackendWithFailover — 2-backend scenarios', () => {
  beforeEach(() => {
    clearProbeCache();
  });

  it('returns the primary when its probe succeeds', async () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      codexBin: '/usr/bin/true',
      claudeBin: '/usr/bin/false',
      qwenBin: '/usr/bin/false',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    expect(result.name).toBe('codex');
    expect(result.failover).toBeUndefined();
  });

  it('falls over to the first chain candidate that probes ok', async () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      codexBin: '/definitely/missing/xyz',
      claudeBin: '/usr/bin/true',
      qwenBin: '/usr/bin/false',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    expect(result.name).toBe('claude');
    expect(result.failover).toBeDefined();
    expect(result.failover?.from).toBe('codex');
    expect(result.failover?.to).toBe('claude');
    expect(result.failover?.reason).toContain('not found');
  });

  it('returns the primary (with no failover info) when every candidate in the chain fails', async () => {
    const config = makeConfig({
      defaultBackend: 'claude',
      codexBin: '/definitely/missing/xyz',
      claudeBin: '/definitely/missing/abc',
      qwenBin: '/definitely/missing/def',
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
      qwenBin: '/usr/bin/true',
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
      qwenBin: '/usr/bin/true',
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
      qwenBin: '/usr/bin/false',
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
      qwenBin: '/usr/bin/false',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo', 'claude');
    // Session override selects claude as primary; it fails; codex is up; we failover to codex.
    expect(result.name).toBe('codex');
    expect(result.failover?.from).toBe('claude');
    expect(result.failover?.to).toBe('codex');
  });
});

describe('resolveProjectBackendWithFailover — 3-backend fallback chain', () => {
  beforeEach(() => {
    clearProbeCache();
  });

  it('walks the chain past a broken first candidate to find the second', async () => {
    // codex.defaultFallback = ['claude', 'qwen']. With primary codex broken
    // and claude also broken, the resolver should continue to qwen.
    const config = makeConfig({
      defaultBackend: 'codex',
      codexBin: '/definitely/missing/aaa',
      claudeBin: '/definitely/missing/bbb',
      qwenBin: '/usr/bin/true',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    expect(result.name).toBe('qwen');
    expect(result.failover?.from).toBe('codex');
    expect(result.failover?.to).toBe('qwen');
  });

  it('respects an explicit global fallback chain (skips defaults)', async () => {
    // Default chain for codex would be ['claude', 'qwen'], but we ask the
    // resolver to try qwen first. claude is alive but should be ignored
    // because the explicit fallback narrows the chain to ['qwen'].
    const config = makeConfig({
      defaultBackend: 'codex',
      fallback: ['qwen'],
      codexBin: '/definitely/missing/aaa',
      claudeBin: '/usr/bin/true',
      qwenBin: '/usr/bin/true',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    expect(result.name).toBe('qwen');
  });

  it('respects an explicit per-project fallback chain over the global one', async () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      fallback: ['qwen'],
      codexBin: '/definitely/missing/aaa',
      claudeBin: '/usr/bin/true',
      qwenBin: '/definitely/missing/ccc',
      projects: { demo: { fallback: ['claude'] } },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    // Project's ['claude'] wins over global ['qwen']; claude is alive.
    expect(result.name).toBe('claude');
  });

  it('skips unknown backends in the fallback chain', async () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      fallback: ['nonexistent', 'qwen'],
      codexBin: '/definitely/missing/aaa',
      claudeBin: '/usr/bin/true',
      qwenBin: '/usr/bin/true',
      projects: { demo: {} },
    });
    const result = await resolveProjectBackendWithFailover(config, 'demo');
    // 'nonexistent' is silently skipped, qwen takes over.
    expect(result.name).toBe('qwen');
  });

  it('never includes the primary in the fallback chain', () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      fallback: ['codex', 'claude', 'qwen'],
      codexBin: '/usr/bin/true',
      claudeBin: '/usr/bin/true',
      qwenBin: '/usr/bin/true',
      projects: { demo: {} },
    });
    const chain = resolveFallbackChain(config, 'demo', 'codex');
    expect(chain).toEqual(['claude', 'qwen']);
  });

  it('de-duplicates the fallback chain', () => {
    const config = makeConfig({
      defaultBackend: 'codex',
      fallback: ['claude', 'qwen', 'claude', 'qwen'],
      codexBin: '/usr/bin/true',
      claudeBin: '/usr/bin/true',
      qwenBin: '/usr/bin/true',
      projects: { demo: {} },
    });
    const chain = resolveFallbackChain(config, 'demo', 'codex');
    expect(chain).toEqual(['claude', 'qwen']);
  });
});

describe('registry integration', () => {
  it('has codex, claude, and qwen registered', () => {
    const names = listBackendNames();
    expect(names).toContain('codex');
    expect(names).toContain('claude');
    expect(names).toContain('qwen');
  });
});
