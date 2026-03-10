import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCodexCapabilityCache, detectCodexCliCapabilities, parseCapabilities } from '../src/codex/capabilities.js';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn((bin: string, args: string[]) => {
    if (args.join(' ') === '--version') {
      return { status: 0, stdout: 'codex-cli 0.98.0\n' };
    }
    if (args.join(' ') === 'exec --help') {
      return { status: 0, stdout: 'Usage: codex exec\n  -C, --cd <DIR>\n  -s, --sandbox <MODE>\n  -p, --profile <PROFILE>\n  --json\n  -o, --output-last-message <FILE>\n' };
    }
    if (args.join(' ') === 'exec resume --help') {
      return { status: 0, stdout: 'Usage: codex exec resume\n  --json\n' };
    }
    return { status: 1, stdout: '' };
  }),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

afterEach(() => {
  clearCodexCapabilityCache();
  spawnSyncMock.mockClear();
});

describe('codex capabilities', () => {
  it('parses help text flags', () => {
    expect(parseCapabilities('--json\n-o, --output-last-message <FILE>\n-C, --cd <DIR>\n')).toEqual({
      supportsCd: true,
      supportsSandbox: false,
      supportsProfile: false,
      supportsJson: true,
      supportsOutputLastMessage: true,
    });
  });

  it('detects and caches codex capabilities from help text', () => {
    const capabilities = detectCodexCliCapabilities('codex');
    expect(capabilities.version).toBe('codex-cli 0.98.0');
    expect(capabilities.exec.supportsCd).toBe(true);
    expect(capabilities.resume.supportsCd).toBe(false);

    const cached = detectCodexCliCapabilities('codex');
    expect(cached).toEqual(capabilities);
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });
});
