import { spawnSync } from 'node:child_process';

export interface CodexCliCapabilities {
  version: string;
  exec: {
    supportsCd: boolean;
    supportsSandbox: boolean;
    supportsProfile: boolean;
    supportsJson: boolean;
    supportsOutputLastMessage: boolean;
  };
  resume: {
    supportsCd: boolean;
    supportsSandbox: boolean;
    supportsProfile: boolean;
    supportsJson: boolean;
    supportsOutputLastMessage: boolean;
  };
}

const capabilityCache = new Map<string, CodexCliCapabilities>();

export function detectCodexCliCapabilities(bin: string): CodexCliCapabilities {
  const cached = capabilityCache.get(bin);
  if (cached) {
    return cached;
  }

  const versionOutput = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (versionOutput.status !== 0) {
    throw new Error(`Codex binary not runnable: ${bin}`);
  }

  const execHelp = readHelp(bin, ['exec', '--help']);
  const resumeHelp = readHelp(bin, ['exec', 'resume', '--help']);

  const detected: CodexCliCapabilities = {
    version: versionOutput.stdout.trim(),
    exec: parseCapabilities(execHelp),
    resume: parseCapabilities(resumeHelp),
  };
  capabilityCache.set(bin, detected);
  return detected;
}

export function clearCodexCapabilityCache(): void {
  capabilityCache.clear();
}

export function parseCapabilities(helpText: string): CodexCliCapabilities['exec'] {
  return {
    supportsCd: /--cd\b|-C, --cd\b/.test(helpText),
    supportsSandbox: /--sandbox\b|-s, --sandbox\b/.test(helpText),
    supportsProfile: /--profile\b|-p, --profile\b/.test(helpText),
    supportsJson: /--json\b/.test(helpText),
    supportsOutputLastMessage: /--output-last-message\b/.test(helpText),
  };
}

function readHelp(bin: string, args: string[]): string {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Failed to inspect Codex help: ${bin} ${args.join(' ')}`);
  }
  return result.stdout;
}
