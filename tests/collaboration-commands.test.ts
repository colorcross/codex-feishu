import { describe, expect, it } from 'vitest';
import { parseBridgeCommand, isReadOnlyCommand } from '../src/bridge/commands.js';

describe('collaboration commands parsing', () => {
  describe('/team', () => {
    it('parses /team command', () => {
      expect(parseBridgeCommand('/team')).toEqual({ kind: 'team' });
    });
  });

  describe('/learn', () => {
    it('parses /learn with content', () => {
      expect(parseBridgeCommand('/learn 部署规范：周五不发布')).toEqual({
        kind: 'learn',
        value: '部署规范：周五不发布',
      });
    });

    it('falls back to prompt when /learn has no content', () => {
      expect(parseBridgeCommand('/learn')).toEqual({ kind: 'prompt', prompt: '/learn' });
    });
  });

  describe('/recall', () => {
    it('parses /recall with query', () => {
      expect(parseBridgeCommand('/recall 部署')).toEqual({
        kind: 'recall',
        query: '部署',
      });
    });

    it('parses /recall with multi-word query', () => {
      expect(parseBridgeCommand('/recall deploy production rules')).toEqual({
        kind: 'recall',
        query: 'deploy production rules',
      });
    });

    it('falls back to prompt when /recall has no query', () => {
      expect(parseBridgeCommand('/recall')).toEqual({ kind: 'prompt', prompt: '/recall' });
    });
  });

  describe('/handoff', () => {
    it('parses /handoff with summary', () => {
      expect(parseBridgeCommand('/handoff 需要帮忙完成部署')).toEqual({
        kind: 'handoff',
        summary: '需要帮忙完成部署',
      });
    });

    it('parses /handoff without summary', () => {
      expect(parseBridgeCommand('/handoff')).toEqual({
        kind: 'handoff',
        summary: undefined,
      });
    });
  });

  describe('/pickup', () => {
    it('parses /pickup with id', () => {
      expect(parseBridgeCommand('/pickup abc12345')).toEqual({
        kind: 'pickup',
        id: 'abc12345',
      });
    });

    it('parses /pickup without id', () => {
      expect(parseBridgeCommand('/pickup')).toEqual({
        kind: 'pickup',
        id: undefined,
      });
    });
  });

  describe('/review', () => {
    it('parses /review command', () => {
      expect(parseBridgeCommand('/review')).toEqual({ kind: 'review' });
    });
  });

  describe('/approve', () => {
    it('parses /approve with comment', () => {
      expect(parseBridgeCommand('/approve 很好')).toEqual({
        kind: 'approve',
        comment: '很好',
      });
    });

    it('parses /approve without comment', () => {
      expect(parseBridgeCommand('/approve')).toEqual({
        kind: 'approve',
        comment: undefined,
      });
    });
  });

  describe('/reject', () => {
    it('parses /reject with reason', () => {
      expect(parseBridgeCommand('/reject 需要更多测试')).toEqual({
        kind: 'reject',
        reason: '需要更多测试',
      });
    });

    it('parses /reject without reason', () => {
      expect(parseBridgeCommand('/reject')).toEqual({
        kind: 'reject',
        reason: undefined,
      });
    });
  });

  describe('/insights', () => {
    it('parses /insights command', () => {
      expect(parseBridgeCommand('/insights')).toEqual({ kind: 'insights' });
    });
  });

  describe('/trust', () => {
    it('parses /trust with no argument', () => {
      expect(parseBridgeCommand('/trust')).toEqual({ kind: 'trust' });
    });

    it('parses /trust set execute', () => {
      expect(parseBridgeCommand('/trust set execute')).toEqual({
        kind: 'trust',
        action: 'set',
        level: 'execute',
      });
    });

    it('parses /trust set observe', () => {
      expect(parseBridgeCommand('/trust set observe')).toEqual({
        kind: 'trust',
        action: 'set',
        level: 'observe',
      });
    });

    it('parses /trust set suggest', () => {
      expect(parseBridgeCommand('/trust set suggest')).toEqual({
        kind: 'trust',
        action: 'set',
        level: 'suggest',
      });
    });

    it('parses /trust set autonomous', () => {
      expect(parseBridgeCommand('/trust set autonomous')).toEqual({
        kind: 'trust',
        action: 'set',
        level: 'autonomous',
      });
    });

    it('ignores /trust without valid set subcommand', () => {
      expect(parseBridgeCommand('/trust something')).toEqual({ kind: 'trust' });
    });
  });

  describe('/timeline', () => {
    it('parses /timeline with no argument', () => {
      expect(parseBridgeCommand('/timeline')).toEqual({
        kind: 'timeline',
        project: undefined,
      });
    });

    it('parses /timeline with project name', () => {
      expect(parseBridgeCommand('/timeline myproject')).toEqual({
        kind: 'timeline',
        project: 'myproject',
      });
    });

    it('parses /timeline with Chinese project name', () => {
      expect(parseBridgeCommand('/timeline 长话短说')).toEqual({
        kind: 'timeline',
        project: '长话短说',
      });
    });
  });
});

describe('natural language collaboration commands', () => {
  it('parses "团队态势"', () => {
    expect(parseBridgeCommand('团队态势')).toEqual({ kind: 'team' });
  });

  it('parses "查看团队协作态势"', () => {
    expect(parseBridgeCommand('查看团队协作态势')).toEqual({ kind: 'team' });
  });

  it('parses "团队状态"', () => {
    expect(parseBridgeCommand('团队状态')).toEqual({ kind: 'team' });
  });

  it('parses "团队在做什么"', () => {
    expect(parseBridgeCommand('团队在做什么')).toEqual({ kind: 'team' });
  });

  it('parses "谁在做什么"', () => {
    expect(parseBridgeCommand('谁在做什么')).toEqual({ kind: 'team' });
  });

  it('parses "效率体检"', () => {
    expect(parseBridgeCommand('效率体检')).toEqual({ kind: 'insights' });
  });

  it('parses "团队体检"', () => {
    expect(parseBridgeCommand('团队体检')).toEqual({ kind: 'insights' });
  });

  it('parses "查看瓶颈分析"', () => {
    expect(parseBridgeCommand('查看瓶颈分析')).toEqual({ kind: 'insights' });
  });

  it('parses "协作体检"', () => {
    expect(parseBridgeCommand('协作体检')).toEqual({ kind: 'insights' });
  });

  it('parses "信任等级"', () => {
    expect(parseBridgeCommand('信任等级')).toEqual({ kind: 'trust' });
  });

  it('parses "查看信任状态"', () => {
    expect(parseBridgeCommand('查看信任状态')).toEqual({ kind: 'trust' });
  });

  it('parses "项目信任"', () => {
    expect(parseBridgeCommand('项目信任')).toEqual({ kind: 'trust' });
  });

  it('parses "时间线"', () => {
    expect(parseBridgeCommand('时间线')).toEqual({ kind: 'timeline' });
  });

  it('parses "查看项目时间线"', () => {
    expect(parseBridgeCommand('查看项目时间线')).toEqual({ kind: 'timeline' });
  });

  it('parses "看一下时间线"', () => {
    expect(parseBridgeCommand('看一下时间线')).toEqual({ kind: 'timeline' });
  });
});

describe('isReadOnlyCommand for collaboration commands', () => {
  it('team is read-only', () => {
    expect(isReadOnlyCommand({ kind: 'team' })).toBe(true);
  });

  it('recall is read-only', () => {
    expect(isReadOnlyCommand({ kind: 'recall', query: 'test' })).toBe(true);
  });

  it('insights is read-only', () => {
    expect(isReadOnlyCommand({ kind: 'insights' })).toBe(true);
  });

  it('timeline is read-only', () => {
    expect(isReadOnlyCommand({ kind: 'timeline' })).toBe(true);
    expect(isReadOnlyCommand({ kind: 'timeline', project: 'proj-a' })).toBe(true);
  });

  it('trust (view) is read-only', () => {
    expect(isReadOnlyCommand({ kind: 'trust' })).toBe(true);
  });

  it('trust set is not read-only', () => {
    expect(isReadOnlyCommand({ kind: 'trust', action: 'set', level: 'execute' })).toBe(false);
  });

  it('learn is not read-only', () => {
    expect(isReadOnlyCommand({ kind: 'learn', value: 'something' })).toBe(false);
  });

  it('handoff is not read-only', () => {
    expect(isReadOnlyCommand({ kind: 'handoff', summary: 'test' })).toBe(false);
  });

  it('pickup is not read-only', () => {
    expect(isReadOnlyCommand({ kind: 'pickup' })).toBe(false);
  });

  it('review is not read-only', () => {
    expect(isReadOnlyCommand({ kind: 'review' })).toBe(false);
  });

  it('approve is not read-only', () => {
    expect(isReadOnlyCommand({ kind: 'approve' })).toBe(false);
  });

  it('reject is not read-only', () => {
    expect(isReadOnlyCommand({ kind: 'reject' })).toBe(false);
  });
});
