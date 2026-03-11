import type { BridgeConfig } from '../config/schema.js';

export type AccessRole = 'viewer' | 'operator' | 'admin';

const ROLE_ORDER: AccessRole[] = ['viewer', 'operator', 'admin'];

export function resolveProjectAccessRole(config: BridgeConfig, projectAlias: string, chatId: string): AccessRole | null {
  return maxRole([
    resolveGlobalRole(config, chatId),
    resolveScopedRole(config.projects[projectAlias]?.viewer_chat_ids, config.projects[projectAlias]?.operator_chat_ids, config.projects[projectAlias]?.admin_chat_ids, chatId),
  ]);
}

export function canAccessProject(config: BridgeConfig, projectAlias: string, chatId: string, minimumRole: AccessRole = 'viewer'): boolean {
  if (!hasAccessGuard(config, projectAlias)) {
    return true;
  }
  const actual = resolveProjectAccessRole(config, projectAlias, chatId);
  return actual !== null && roleRank(actual) >= roleRank(minimumRole);
}

export function filterAccessibleProjects(config: BridgeConfig, chatId: string, minimumRole: AccessRole = 'viewer'): string[] {
  return Object.keys(config.projects).filter((alias) => canAccessProject(config, alias, chatId, minimumRole));
}

export function describeMinimumRole(role: AccessRole): string {
  switch (role) {
    case 'viewer':
      return 'viewer';
    case 'operator':
      return 'operator';
    case 'admin':
      return 'admin';
  }
}

export function hasAccessGuard(config: BridgeConfig, projectAlias: string): boolean {
  return (
    hasEntries(config.security.viewer_chat_ids) ||
    hasEntries(config.security.operator_chat_ids) ||
    hasEntries(config.security.admin_chat_ids) ||
    hasEntries(config.projects[projectAlias]?.viewer_chat_ids) ||
    hasEntries(config.projects[projectAlias]?.operator_chat_ids) ||
    hasEntries(config.projects[projectAlias]?.admin_chat_ids)
  );
}

function resolveGlobalRole(config: BridgeConfig, chatId: string): AccessRole | null {
  return resolveScopedRole(config.security.viewer_chat_ids, config.security.operator_chat_ids, config.security.admin_chat_ids, chatId);
}

function resolveScopedRole(
  viewerChatIds: string[] | undefined,
  operatorChatIds: string[] | undefined,
  adminChatIds: string[] | undefined,
  chatId: string,
): AccessRole | null {
  if (adminChatIds?.includes(chatId)) {
    return 'admin';
  }
  if (operatorChatIds?.includes(chatId)) {
    return 'operator';
  }
  if (viewerChatIds?.includes(chatId)) {
    return 'viewer';
  }
  return null;
}

function maxRole(roles: Array<AccessRole | null>): AccessRole | null {
  return roles.reduce<AccessRole | null>((best, current) => {
    if (!current) {
      return best;
    }
    if (!best) {
      return current;
    }
    return roleRank(current) > roleRank(best) ? current : best;
  }, null);
}

function roleRank(role: AccessRole): number {
  return ROLE_ORDER.indexOf(role);
}

function hasEntries(value: string[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}
