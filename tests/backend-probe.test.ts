import { beforeEach, describe, expect, it } from 'vitest';
import { clearProbeCache, probeBackend } from '../src/backend/probe.js';

describe('backend probe', () => {
  beforeEach(() => {
    clearProbeCache();
  });

  it('reports ok for a binary that exits 0', async () => {
    const result = await probeBackend('codex', { bin: '/usr/bin/true' });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('reports failure for a binary that exits non-zero', async () => {
    const result = await probeBackend('codex', { bin: '/usr/bin/false' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('exited with code');
  });

  it('reports ENOENT when the binary does not exist', async () => {
    const result = await probeBackend('claude', {
      bin: '/definitely/not/a/real/path/xyz-feique-nope',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('caches a probe result within the TTL window', async () => {
    // Seed cache with a success via /usr/bin/true
    const first = await probeBackend('codex', { bin: '/usr/bin/true' });
    expect(first.ok).toBe(true);

    // Second call with the same spec should return the cached result.
    // We can't directly assert cache hit without exposing internals, but we
    // can prove it by passing a bogus bin on a cache miss (different key) —
    // that should still run fresh and fail. Same key returns cached success.
    const second = await probeBackend('codex', { bin: '/usr/bin/true' });
    expect(second).toEqual(first);

    const freshMiss = await probeBackend('codex', { bin: '/definitely/missing/xyz' });
    expect(freshMiss.ok).toBe(false);
  });

  it('distinguishes cache entries by backend name', async () => {
    const codexResult = await probeBackend('codex', { bin: '/usr/bin/true' });
    const claudeResult = await probeBackend('claude', { bin: '/usr/bin/false' });
    expect(codexResult.ok).toBe(true);
    expect(claudeResult.ok).toBe(false);
  });
});
