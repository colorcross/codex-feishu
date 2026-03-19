import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyOperation,
  enforceTrustBoundary,
  recordRunOutcome,
  createInitialTrustState,
  formatTrustState,
  DEFAULT_TRUST_POLICY,
} from '../src/collaboration/trust.js';
import type { TrustLevel, TrustPolicy, TrustState } from '../src/collaboration/trust.js';
import { TrustStore } from '../src/state/trust-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('classifyOperation', () => {
  it('classifies read operations', () => {
    expect(classifyOperation('list all files in the directory')).toBe('read');
    expect(classifyOperation('show me the logs')).toBe('read');
    expect(classifyOperation('what is the current status?')).toBe('read');
  });

  it('classifies write operations', () => {
    expect(classifyOperation('create a new file called app.ts')).toBe('write');
    expect(classifyOperation('modify the config')).toBe('write');
    expect(classifyOperation('update the readme')).toBe('write');
    expect(classifyOperation('fix the broken test')).toBe('write');
    expect(classifyOperation('refactor the auth module')).toBe('write');
    expect(classifyOperation('add a new endpoint')).toBe('write');
    expect(classifyOperation('remove the deprecated function')).toBe('write');
    expect(classifyOperation('install lodash')).toBe('write');
    expect(classifyOperation('commit the changes')).toBe('write');
  });

  it('classifies dangerous operations', () => {
    expect(classifyOperation('rm -rf /tmp/data')).toBe('dangerous');
    expect(classifyOperation('drop table users')).toBe('dangerous');
    expect(classifyOperation('delete all records')).toBe('dangerous');
    expect(classifyOperation('force push to main')).toBe('dangerous');
    expect(classifyOperation('git reset --hard')).toBe('dangerous');
    expect(classifyOperation('deploy to production')).toBe('dangerous');
    expect(classifyOperation('push to prod')).toBe('dangerous');
  });

  it('classifies Chinese dangerous operations', () => {
    expect(classifyOperation('删除所有数据')).toBe('dangerous');
    expect(classifyOperation('强制推送到远程')).toBe('dangerous');
    expect(classifyOperation('部署到生产环境')).toBe('dangerous');
  });

  it('classifies Chinese write operations', () => {
    expect(classifyOperation('创建一个新文件')).toBe('write');
    expect(classifyOperation('修改配置')).toBe('write');
    expect(classifyOperation('编辑代码')).toBe('write');
    expect(classifyOperation('添加依赖')).toBe('write');
    expect(classifyOperation('安装包')).toBe('write');
  });

  it('defaults to read for ambiguous prompts', () => {
    expect(classifyOperation('how does this work?')).toBe('read');
    expect(classifyOperation('explain the architecture')).toBe('read');
  });
});

describe('enforceTrustBoundary', () => {
  describe('observe level', () => {
    it('allows read operations', () => {
      const decision = enforceTrustBoundary('observe', 'read');
      expect(decision.allowed).toBe(true);
      expect(decision.requires_approval).toBe(false);
    });

    it('blocks write operations', () => {
      const decision = enforceTrustBoundary('observe', 'write');
      expect(decision.allowed).toBe(false);
      expect(decision.requires_approval).toBe(true);
      expect(decision.reason).toContain('观察');
    });

    it('blocks dangerous operations', () => {
      const decision = enforceTrustBoundary('observe', 'dangerous');
      expect(decision.allowed).toBe(false);
      expect(decision.requires_approval).toBe(true);
    });
  });

  describe('suggest level', () => {
    it('allows read operations without approval', () => {
      const decision = enforceTrustBoundary('suggest', 'read');
      expect(decision.allowed).toBe(true);
      expect(decision.requires_approval).toBe(false);
    });

    it('allows write operations but requires approval', () => {
      const decision = enforceTrustBoundary('suggest', 'write');
      expect(decision.allowed).toBe(true);
      expect(decision.requires_approval).toBe(true);
      expect(decision.reason).toContain('建议');
    });

    it('allows dangerous operations but requires approval', () => {
      const decision = enforceTrustBoundary('suggest', 'dangerous');
      expect(decision.allowed).toBe(true);
      expect(decision.requires_approval).toBe(true);
    });
  });

  describe('execute level', () => {
    it('allows read operations freely', () => {
      const decision = enforceTrustBoundary('execute', 'read');
      expect(decision.allowed).toBe(true);
      expect(decision.requires_approval).toBe(false);
    });

    it('allows write operations freely', () => {
      const decision = enforceTrustBoundary('execute', 'write');
      expect(decision.allowed).toBe(true);
      expect(decision.requires_approval).toBe(false);
    });

    it('allows dangerous operations but requires approval', () => {
      const decision = enforceTrustBoundary('execute', 'dangerous');
      expect(decision.allowed).toBe(true);
      expect(decision.requires_approval).toBe(true);
      expect(decision.reason).toContain('高危');
    });
  });

  describe('autonomous level', () => {
    it('allows all operations freely', () => {
      expect(enforceTrustBoundary('autonomous', 'read')).toEqual({ allowed: true, requires_approval: false });
      expect(enforceTrustBoundary('autonomous', 'write')).toEqual({ allowed: true, requires_approval: false });
      expect(enforceTrustBoundary('autonomous', 'dangerous')).toEqual({ allowed: true, requires_approval: false });
    });
  });
});

describe('recordRunOutcome', () => {
  const basePolicy: TrustPolicy = {
    default_level: 'execute',
    auto_promote: true,
    promote_after_successes: 3,
    demote_after_failures: 2,
  };

  it('increments consecutive successes on success', () => {
    const state = createInitialTrustState('proj-a', 'execute');
    const updated = recordRunOutcome(state, true, basePolicy);
    expect(updated.consecutive_successes).toBe(1);
    expect(updated.consecutive_failures).toBe(0);
    expect(updated.total_runs).toBe(1);
    expect(updated.total_successes).toBe(1);
  });

  it('resets consecutive successes on failure', () => {
    let state = createInitialTrustState('proj-a', 'execute');
    state = recordRunOutcome(state, true, basePolicy);
    state = recordRunOutcome(state, true, basePolicy);
    state = recordRunOutcome(state, false, basePolicy);
    expect(state.consecutive_successes).toBe(0);
    expect(state.consecutive_failures).toBe(1);
  });

  it('resets consecutive failures on success', () => {
    let state = createInitialTrustState('proj-a', 'execute');
    state = recordRunOutcome(state, false, basePolicy);
    state = recordRunOutcome(state, true, basePolicy);
    expect(state.consecutive_failures).toBe(0);
    expect(state.consecutive_successes).toBe(1);
  });

  it('promotes trust after N consecutive successes', () => {
    let state = createInitialTrustState('proj-a', 'execute');
    for (let i = 0; i < 3; i++) {
      state = recordRunOutcome(state, true, basePolicy);
    }
    expect(state.current_level).toBe('autonomous');
    expect(state.promoted_at).toBeTruthy();
    expect(state.consecutive_successes).toBe(0); // reset after promotion
  });

  it('does not promote past autonomous', () => {
    let state = createInitialTrustState('proj-a', 'autonomous');
    for (let i = 0; i < 5; i++) {
      state = recordRunOutcome(state, true, basePolicy);
    }
    expect(state.current_level).toBe('autonomous');
  });

  it('demotes trust after N consecutive failures', () => {
    let state = createInitialTrustState('proj-a', 'execute');
    for (let i = 0; i < 2; i++) {
      state = recordRunOutcome(state, false, basePolicy);
    }
    expect(state.current_level).toBe('suggest');
    expect(state.demoted_at).toBeTruthy();
    expect(state.consecutive_failures).toBe(0); // reset after demotion
  });

  it('does not demote below observe', () => {
    let state = createInitialTrustState('proj-a', 'observe');
    for (let i = 0; i < 5; i++) {
      state = recordRunOutcome(state, false, basePolicy);
    }
    expect(state.current_level).toBe('observe');
  });

  it('does not promote when auto_promote is false', () => {
    const noPromoPolicy: TrustPolicy = { ...basePolicy, auto_promote: false };
    let state = createInitialTrustState('proj-a', 'execute');
    for (let i = 0; i < 10; i++) {
      state = recordRunOutcome(state, true, noPromoPolicy);
    }
    expect(state.current_level).toBe('execute');
  });

  it('tracks total runs, successes, and failures', () => {
    let state = createInitialTrustState('proj-a', 'autonomous');
    const policy: TrustPolicy = { ...basePolicy, auto_promote: false };
    state = recordRunOutcome(state, true, policy);
    state = recordRunOutcome(state, true, policy);
    state = recordRunOutcome(state, false, policy);
    state = recordRunOutcome(state, true, policy);

    expect(state.total_runs).toBe(4);
    expect(state.total_successes).toBe(3);
    expect(state.total_failures).toBe(1);
  });
});

describe('createInitialTrustState', () => {
  it('uses default level from policy when not specified', () => {
    const state = createInitialTrustState('proj-a');
    expect(state.current_level).toBe(DEFAULT_TRUST_POLICY.default_level);
    expect(state.project_alias).toBe('proj-a');
    expect(state.consecutive_successes).toBe(0);
    expect(state.consecutive_failures).toBe(0);
    expect(state.total_runs).toBe(0);
  });

  it('uses specified level', () => {
    const state = createInitialTrustState('proj-a', 'observe');
    expect(state.current_level).toBe('observe');
  });
});

describe('formatTrustState', () => {
  it('formats trust state with level and stats', () => {
    const state: TrustState = {
      project_alias: 'proj-a',
      current_level: 'execute',
      consecutive_successes: 5,
      consecutive_failures: 0,
      total_runs: 20,
      total_successes: 18,
      total_failures: 2,
      last_evaluated_at: new Date().toISOString(),
    };
    const text = formatTrustState(state);
    expect(text).toContain('proj-a');
    expect(text).toContain('执行');
    expect(text).toContain('20 次');
    expect(text).toContain('成功 18');
    expect(text).toContain('失败 2');
    expect(text).toContain('连续成功: 5');
  });
});

describe('TrustStore', () => {
  it('creates initial trust state via getOrCreate', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-trust-'));
    tempDirs.push(dir);
    const store = new TrustStore(dir);

    const state = await store.getOrCreate('proj-a');
    expect(state.project_alias).toBe('proj-a');
    expect(state.current_level).toBe(DEFAULT_TRUST_POLICY.default_level);
    expect(state.total_runs).toBe(0);
  });

  it('returns existing state on second getOrCreate', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-trust-'));
    tempDirs.push(dir);
    const store = new TrustStore(dir);

    const state1 = await store.getOrCreate('proj-a');
    const state2 = await store.getOrCreate('proj-a');
    expect(state2.last_evaluated_at).toBe(state1.last_evaluated_at);
  });

  it('updates trust state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-trust-'));
    tempDirs.push(dir);
    const store = new TrustStore(dir);

    const state = await store.getOrCreate('proj-a');
    const updated = recordRunOutcome(state, true, DEFAULT_TRUST_POLICY);
    await store.update('proj-a', updated);

    const fetched = await store.get('proj-a');
    expect(fetched).not.toBeNull();
    expect(fetched!.total_runs).toBe(1);
    expect(fetched!.total_successes).toBe(1);
  });

  it('returns null for unknown project via get', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-trust-'));
    tempDirs.push(dir);
    const store = new TrustStore(dir);

    const state = await store.get('nonexistent');
    expect(state).toBeNull();
  });

  it('lists all trust states', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-trust-'));
    tempDirs.push(dir);
    const store = new TrustStore(dir);

    await store.getOrCreate('proj-a');
    await store.getOrCreate('proj-b');

    const all = await store.listAll();
    expect(all).toHaveLength(2);
    const aliases = all.map((s) => s.project_alias).sort();
    expect(aliases).toEqual(['proj-a', 'proj-b']);
  });

  it('persists data across store instances', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-trust-'));
    tempDirs.push(dir);

    const store1 = new TrustStore(dir);
    const state = await store1.getOrCreate('proj-a');
    const updated = recordRunOutcome(state, true, DEFAULT_TRUST_POLICY);
    await store1.update('proj-a', updated);

    const store2 = new TrustStore(dir);
    const fetched = await store2.get('proj-a');
    expect(fetched).not.toBeNull();
    expect(fetched!.total_successes).toBe(1);
  });
});
