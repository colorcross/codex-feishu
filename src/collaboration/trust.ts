/**
 * Direction 5: 渐进式信任边界 — Progressive Trust Boundaries
 *
 * Defines operation risk levels and trust tiers that determine
 * what AI is allowed to do autonomously vs. with approval.
 */

export type TrustLevel = 'observe' | 'suggest' | 'execute' | 'autonomous';
export type OperationClass = 'read' | 'write' | 'dangerous';

export interface TrustPolicy {
  /** Default trust level for new projects. */
  default_level: TrustLevel;
  /** Automatically promote trust after N consecutive successes. */
  auto_promote: boolean;
  promote_after_successes: number;
  /** Demote trust after N consecutive failures. */
  demote_after_failures: number;
}

export interface TrustState {
  project_alias: string;
  current_level: TrustLevel;
  consecutive_successes: number;
  consecutive_failures: number;
  total_runs: number;
  total_successes: number;
  total_failures: number;
  last_evaluated_at: string;
  promoted_at?: string;
  demoted_at?: string;
}

export interface TrustDecision {
  allowed: boolean;
  requires_approval: boolean;
  reason?: string;
}

const TRUST_ORDER: TrustLevel[] = ['observe', 'suggest', 'execute', 'autonomous'];

export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  default_level: 'execute',
  auto_promote: true,
  promote_after_successes: 10,
  demote_after_failures: 3,
};

export function createInitialTrustState(projectAlias: string, level?: TrustLevel): TrustState {
  return {
    project_alias: projectAlias,
    current_level: level ?? DEFAULT_TRUST_POLICY.default_level,
    consecutive_successes: 0,
    consecutive_failures: 0,
    total_runs: 0,
    total_successes: 0,
    total_failures: 0,
    last_evaluated_at: new Date().toISOString(),
  };
}

/**
 * Record a run outcome and potentially adjust trust level.
 */
export function recordRunOutcome(
  state: TrustState,
  success: boolean,
  policy: TrustPolicy,
): TrustState {
  const updated: TrustState = {
    ...state,
    total_runs: state.total_runs + 1,
    last_evaluated_at: new Date().toISOString(),
  };

  if (success) {
    updated.consecutive_successes = state.consecutive_successes + 1;
    updated.consecutive_failures = 0;
    updated.total_successes = state.total_successes + 1;

    // Check for promotion
    if (policy.auto_promote && updated.consecutive_successes >= policy.promote_after_successes) {
      const promoted = promoteTrust(updated.current_level);
      if (promoted !== updated.current_level) {
        updated.current_level = promoted;
        updated.consecutive_successes = 0;
        updated.promoted_at = updated.last_evaluated_at;
      }
    }
  } else {
    updated.consecutive_failures = state.consecutive_failures + 1;
    updated.consecutive_successes = 0;
    updated.total_failures = state.total_failures + 1;

    // Check for demotion
    if (updated.consecutive_failures >= policy.demote_after_failures) {
      const demoted = demoteTrust(updated.current_level);
      if (demoted !== updated.current_level) {
        updated.current_level = demoted;
        updated.consecutive_failures = 0;
        updated.demoted_at = updated.last_evaluated_at;
      }
    }
  }

  return updated;
}

/**
 * Classify an operation's risk level from the prompt text.
 */
export function classifyOperation(prompt: string): OperationClass {
  const lower = prompt.toLowerCase();

  // Dangerous patterns
  const dangerousPatterns = [
    /\brm\s+-rf\b/,
    /\bdrop\s+(table|database)\b/,
    /\bdelete\s+(all|everything)\b/,
    /\bforce\s*push\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\b(deploy|push)\s+(to\s+)?(prod|production|master|main)\b/,
    /删除所有/,
    /强制推送/,
    /部署到生产/,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(lower)) return 'dangerous';
  }

  // Write patterns
  const writePatterns = [
    /\b(create|write|modify|update|edit|change|fix|refactor|add|remove|delete|rename)\b/,
    /\b(install|uninstall|upgrade|downgrade)\b/,
    /\b(commit|merge|rebase|cherry.pick)\b/,
    /创建|修改|编辑|添加|删除|重命名|安装|提交|合并/,
  ];

  for (const pattern of writePatterns) {
    if (pattern.test(lower)) return 'write';
  }

  // Default to read
  return 'read';
}

/**
 * Check if an operation is allowed at the current trust level.
 */
export function enforceTrustBoundary(
  trustLevel: TrustLevel,
  operationClass: OperationClass,
): TrustDecision {
  switch (trustLevel) {
    case 'observe':
      return {
        allowed: operationClass === 'read',
        requires_approval: false,
        reason:
          operationClass !== 'read'
            ? '当前项目信任等级为"观察"，只允许只读操作。使用 /trust set suggest 开启审批模式。'
            : undefined,
      };

    case 'suggest':
      return {
        allowed: true,
        requires_approval: operationClass !== 'read',
        reason:
          operationClass !== 'read'
            ? '当前项目信任等级为"建议"，写操作需要审批'
            : undefined,
      };

    case 'execute':
      if (operationClass === 'dangerous') {
        return {
          allowed: true,
          requires_approval: true,
          reason: '高危操作需要审批确认',
        };
      }
      return { allowed: true, requires_approval: false };

    case 'autonomous':
      return { allowed: true, requires_approval: false };

    default:
      return { allowed: false, requires_approval: true, reason: '未知信任等级' };
  }
}

export function formatTrustState(state: TrustState): string {
  const levelLabels: Record<TrustLevel, string> = {
    observe: '🔍 观察 (只读)',
    suggest: '💡 建议 (写操作需审批)',
    execute: '⚡ 执行 (高危需审批)',
    autonomous: '🚀 自主 (完全自主)',
  };

  const lines: string[] = [];
  lines.push(`🛡️ 信任状态: ${state.project_alias}`);
  lines.push(`  等级: ${levelLabels[state.current_level]}`);
  lines.push(`  总运行: ${state.total_runs} 次 (成功 ${state.total_successes} / 失败 ${state.total_failures})`);
  lines.push(`  连续成功: ${state.consecutive_successes} 次`);

  if (state.promoted_at) {
    lines.push(`  上次提升: ${formatDate(state.promoted_at)}`);
  }
  if (state.demoted_at) {
    lines.push(`  上次降级: ${formatDate(state.demoted_at)}`);
  }

  return lines.join('\n');
}

function promoteTrust(current: TrustLevel): TrustLevel {
  const index = TRUST_ORDER.indexOf(current);
  if (index < 0 || index >= TRUST_ORDER.length - 1) return current;
  return TRUST_ORDER[index + 1] ?? current;
}

function demoteTrust(current: TrustLevel): TrustLevel {
  const index = TRUST_ORDER.indexOf(current);
  if (index <= 0) return current;
  return TRUST_ORDER[index - 1] ?? current;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
