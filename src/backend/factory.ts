import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import type { Backend, BackendName } from './types.js';
import { CodexBackend } from './codex.js';
import { ClaudeBackend } from './claude.js';
import { CodexSessionIndex } from '../codex/session-index.js';
import { extractProbeSpec, probeBackend, type ProbeResult } from './probe.js';

export function createBackend(config: BridgeConfig, codexSessionIndex?: CodexSessionIndex): Backend {
  const backendName = resolveDefaultBackend(config);
  return createBackendByName(backendName, config, codexSessionIndex);
}

export function createBackendByName(name: BackendName, config: BridgeConfig, codexSessionIndex?: CodexSessionIndex): Backend {
  switch (name) {
    case 'codex':
      return new CodexBackend(
        {
          bin: config.codex.bin,
          shell: config.codex.shell,
          preExec: config.codex.pre_exec,
          defaultProfile: config.codex.default_profile,
          defaultSandbox: config.codex.default_sandbox,
          skipGitRepoCheck: config.codex.skip_git_repo_check,
          runTimeoutMs: config.codex.run_timeout_ms,
        },
        codexSessionIndex ?? new CodexSessionIndex(),
      );
    case 'claude':
      return new ClaudeBackend({
        bin: config.claude?.bin ?? 'claude',
        shell: config.claude?.shell ?? config.codex.shell,
        preExec: config.claude?.pre_exec ?? config.codex.pre_exec,
        defaultPermissionMode: config.claude?.default_permission_mode ?? 'auto',
        defaultModel: config.claude?.default_model,
        maxBudgetUsd: config.claude?.max_budget_usd,
        allowedTools: config.claude?.allowed_tools,
        systemPromptAppend: config.claude?.system_prompt_append,
        runTimeoutMs: config.claude?.run_timeout_ms ?? config.codex.run_timeout_ms,
      });
    default:
      throw new Error(`Unknown backend: ${name}`);
  }
}

export function resolveDefaultBackend(config: BridgeConfig): BackendName {
  return config.backend?.default ?? 'codex';
}

export function resolveProjectBackend(config: BridgeConfig, projectAlias: string, codexSessionIndex?: CodexSessionIndex): Backend {
  const project = config.projects[projectAlias];
  const backendName: BackendName = project?.backend ?? resolveDefaultBackend(config);
  return createBackendByName(backendName, config, codexSessionIndex);
}

export function resolveProjectBackendWithOverride(
  config: BridgeConfig,
  projectAlias: string,
  sessionOverride?: BackendName,
  codexSessionIndex?: CodexSessionIndex,
): Backend {
  if (sessionOverride) {
    return createBackendByName(sessionOverride, config, codexSessionIndex);
  }
  return resolveProjectBackend(config, projectAlias, codexSessionIndex);
}

export function resolveProjectBackendName(config: BridgeConfig, projectAlias: string, sessionOverride?: BackendName): BackendName {
  if (sessionOverride) return sessionOverride;
  const project = config.projects[projectAlias];
  return project?.backend ?? resolveDefaultBackend(config);
}

// ---------------------------------------------------------------------------
// Startup-only failover
// ---------------------------------------------------------------------------

export interface FailoverInfo {
  from: BackendName;
  to: BackendName;
  reason: string;
}

export interface FailoverResolution {
  backend: Backend;
  name: BackendName;
  failover?: FailoverInfo;
}

function otherBackend(name: BackendName): BackendName {
  return name === 'codex' ? 'claude' : 'codex';
}

function isFailoverEnabled(config: BridgeConfig, projectAlias: string): boolean {
  const project = config.projects[projectAlias];
  if (project?.failover !== undefined) return project.failover;
  return config.backend?.failover ?? true;
}

/**
 * Resolve the backend to use for a run, with startup-only failover.
 *
 * Strategy (plan B):
 *  1. Determine primary backend name (session override > project > default).
 *  2. If failover is disabled, return the primary without probing.
 *  3. Probe the primary. If it responds, return it.
 *  4. If the primary probe fails, probe the alternate. If it responds,
 *     return it with a FailoverInfo describing the switch.
 *  5. If both probes fail, return the primary anyway — the real run will
 *     surface the actual error with full context, and we avoid masking
 *     configuration mistakes with silent rewrites.
 *
 * Runtime failures during an actual run are NOT retried here. That is the
 * deliberate boundary of plan B: we save users from "binary missing" and
 * PATH issues, but we never burn tokens on speculative re-runs.
 */
export async function resolveProjectBackendWithFailover(
  config: BridgeConfig,
  projectAlias: string,
  sessionOverride?: BackendName,
  codexSessionIndex?: CodexSessionIndex,
): Promise<FailoverResolution> {
  const primaryName = resolveProjectBackendName(config, projectAlias, sessionOverride);

  if (!isFailoverEnabled(config, projectAlias)) {
    return {
      backend: createBackendByName(primaryName, config, codexSessionIndex),
      name: primaryName,
    };
  }

  const primaryProbe = await probeBackend(primaryName, extractProbeSpec(config, primaryName));
  if (primaryProbe.ok) {
    return {
      backend: createBackendByName(primaryName, config, codexSessionIndex),
      name: primaryName,
    };
  }

  const alternateName = otherBackend(primaryName);
  const alternateProbe: ProbeResult = await probeBackend(alternateName, extractProbeSpec(config, alternateName));
  if (!alternateProbe.ok) {
    // Both failed — let the primary run and report the real error.
    return {
      backend: createBackendByName(primaryName, config, codexSessionIndex),
      name: primaryName,
    };
  }

  return {
    backend: createBackendByName(alternateName, config, codexSessionIndex),
    name: alternateName,
    failover: {
      from: primaryName,
      to: alternateName,
      reason: primaryProbe.reason ?? 'unknown',
    },
  };
}
