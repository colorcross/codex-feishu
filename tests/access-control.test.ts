import { describe, expect, it } from 'vitest';
import type { BridgeConfig, ProjectConfig } from '../src/config/schema.js';
import { canAccessProject, filterAccessibleProjects, resolveProjectAccessRole } from '../src/security/access.js';

describe('access control', () => {
  it('resolves global and project-scoped viewer/operator/admin roles with least surprise defaults', () => {
    const config = buildConfig({
      security: {
        allowed_project_roots: [],
        viewer_chat_ids: ['chat-global-viewer'],
        operator_chat_ids: ['chat-global-operator'],
        admin_chat_ids: ['chat-global-admin'],
        require_group_mentions: true,
      },
      projects: {
        default: buildProjectConfig({
          root: '/tmp/default',
          mention_required: true,
          viewer_chat_ids: ['chat-project-viewer'],
          operator_chat_ids: ['chat-project-operator'],
          admin_chat_ids: ['chat-project-admin'],
        }),
        open: buildProjectConfig({
          root: '/tmp/open',
          mention_required: true,
        }),
      },
    });

    expect(resolveProjectAccessRole(config, 'default', 'chat-project-viewer')).toBe('viewer');
    expect(resolveProjectAccessRole(config, 'default', 'chat-global-operator')).toBe('operator');
    expect(resolveProjectAccessRole(config, 'default', 'chat-project-admin')).toBe('admin');

    expect(canAccessProject(config, 'default', 'chat-project-viewer', 'viewer')).toBe(true);
    expect(canAccessProject(config, 'default', 'chat-project-viewer', 'operator')).toBe(false);
    expect(canAccessProject(config, 'default', 'chat-global-operator', 'operator')).toBe(true);
    expect(canAccessProject(config, 'default', 'chat-global-admin', 'admin')).toBe(true);

    expect(canAccessProject(config, 'open', 'unknown-chat', 'viewer')).toBe(false);
    expect(filterAccessibleProjects(config, 'chat-global-operator', 'operator')).toEqual(['default', 'open']);
  });

  it('keeps projects open when no role guard is configured', () => {
    const config = buildConfig();
    expect(canAccessProject(config, 'default', 'any-chat', 'viewer')).toBe(true);
    expect(canAccessProject(config, 'default', 'any-chat', 'operator')).toBe(true);
    expect(filterAccessibleProjects(config, 'any-chat')).toEqual(['default']);
  });
});

function buildConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    service: {
      name: 'test-bridge',
      default_project: 'default',
      project_switch_auto_adopt_latest: false,
      reply_mode: 'text',
      natural_language_command_confirmation: true,
      natural_language_confirmation_ttl_seconds: 90,
      emit_progress_updates: false,
      progress_update_interval_ms: 4000,
      metrics_host: '127.0.0.1',
      idempotency_ttl_seconds: 86400,
      session_history_limit: 20,
      log_tail_lines: 100,
      log_rotate_max_bytes: 10 * 1024 * 1024,
      log_rotate_keep_files: 5,
      reply_quote_user_message: true,
      reply_quote_max_chars: 120,
      download_message_resources: false,
      transcribe_audio_messages: false,
      describe_image_messages: false,
      openai_image_model: 'gpt-4.1-mini',
      memory_enabled: true,
      memory_search_limit: 3,
      memory_recent_limit: 5,
      memory_prompt_max_chars: 1600,
      thread_summary_max_chars: 1200,
      memory_group_enabled: false,
      memory_cleanup_interval_seconds: 1800,
      memory_max_pinned_per_scope: 5,
      memory_pin_overflow_strategy: 'age-out',
      memory_pin_age_basis: 'updated_at',
      ...(overrides.service ?? {}),
    },
    codex: {
      bin: 'codex',
      default_sandbox: 'workspace-write',
      skip_git_repo_check: true,
      output_token_limit: 4000,
      bridge_instructions: '',
      run_timeout_ms: 600000,
      ...(overrides.codex ?? {}),
    },
    storage: {
      dir: '/tmp/codex-feishu-access-test',
      ...(overrides.storage ?? {}),
    },
    security: {
      allowed_project_roots: [],
      admin_chat_ids: [],
      require_group_mentions: true,
      ...(overrides.security ?? {}),
    },
    feishu: {
      app_id: 'app-id',
      app_secret: 'app-secret',
      dry_run: false,
      transport: 'long-connection',
      host: '127.0.0.1',
      port: 3333,
      event_path: '/webhook/event',
      card_path: '/webhook/card',
      allowed_chat_ids: [],
      allowed_group_ids: [],
      ...(overrides.feishu ?? {}),
    },
    projects: {
      default: {
        root: '/tmp/default',
        session_scope: 'chat',
        mention_required: true,
        knowledge_paths: [],
        wiki_space_ids: [],
        admin_chat_ids: [],
        chat_rate_limit_window_seconds: 60,
        chat_rate_limit_max_runs: 20,
      },
      ...(overrides.projects ?? {}),
    },
  };
}

function buildProjectConfig(overrides: Partial<ProjectConfig>): ProjectConfig {
  return {
    root: '/tmp/default',
    session_scope: 'chat',
    mention_required: false,
    knowledge_paths: [],
    wiki_space_ids: [],
    admin_chat_ids: [],
    chat_rate_limit_window_seconds: 60,
    chat_rate_limit_max_runs: 20,
    ...overrides,
  };
}
