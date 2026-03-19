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

  // ── Expanded team patterns ──
  it('parses "谁在用AI"', () => {
    expect(parseBridgeCommand('谁在用AI')).toEqual({ kind: 'team' });
  });
  it('parses "大家在忙什么"', () => {
    expect(parseBridgeCommand('大家在忙什么')).toEqual({ kind: 'team' });
  });
  it('parses "看看团队"', () => {
    expect(parseBridgeCommand('看看团队')).toEqual({ kind: 'team' });
  });

  // ── /learn natural language ──
  it('parses "记住：Redis连接池至少50"', () => {
    const result = parseBridgeCommand('记住：Redis连接池至少50');
    expect(result).toEqual({ kind: 'learn', value: 'Redis连接池至少50' });
  });
  it('parses "记录一下 认证模块需要先装Redis"', () => {
    const result = parseBridgeCommand('记录一下 认证模块需要先装Redis');
    expect(result).toEqual({ kind: 'learn', value: '认证模块需要先装Redis' });
  });
  it('parses "保存知识：部署前必须跑测试"', () => {
    const result = parseBridgeCommand('保存知识：部署前必须跑测试');
    expect(result).toEqual({ kind: 'learn', value: '部署前必须跑测试' });
  });

  // ── /recall natural language ──
  it('parses "有没有关于Redis的知识"', () => {
    const result = parseBridgeCommand('有没有关于Redis的知识');
    expect(result).toEqual({ kind: 'recall', query: 'Redis' });
  });
  it('parses "查一下知识 认证模块"', () => {
    const result = parseBridgeCommand('查一下知识 认证模块');
    expect(result).toEqual({ kind: 'recall', query: '认证模块' });
  });
  it('parses "搜搜看 部署流程"', () => {
    const result = parseBridgeCommand('搜搜看 部署流程');
    expect(result).toEqual({ kind: 'recall', query: '部署流程' });
  });
  it('parses "关于认证有什么经验"', () => {
    const result = parseBridgeCommand('关于认证有什么经验');
    expect(result).toEqual({ kind: 'recall', query: '认证' });
  });

  // ── /handoff natural language ──
  it('parses "交接一下"', () => {
    expect(parseBridgeCommand('交接一下')).toEqual({ kind: 'handoff' });
  });
  it('parses "交给别人"', () => {
    expect(parseBridgeCommand('交给别人')).toEqual({ kind: 'handoff' });
  });
  it('parses "交接一下，做到一半了"', () => {
    const result = parseBridgeCommand('交接一下，做到一半了');
    expect(result).toEqual({ kind: 'handoff', summary: '做到一半了' });
  });

  // ── /pickup natural language ──
  it('parses "我来接手"', () => {
    expect(parseBridgeCommand('我来接手')).toEqual({ kind: 'pickup' });
  });
  it('parses "我来吧"', () => {
    expect(parseBridgeCommand('我来吧')).toEqual({ kind: 'pickup' });
  });
  it('parses "我接了"', () => {
    expect(parseBridgeCommand('我接了')).toEqual({ kind: 'pickup' });
  });

  // ── /review natural language ──
  it('parses "评审一下"', () => {
    expect(parseBridgeCommand('评审一下')).toEqual({ kind: 'review' });
  });
  it('parses "帮看看结果"', () => {
    expect(parseBridgeCommand('帮看看结果')).toEqual({ kind: 'review' });
  });

  // ── /approve natural language ──
  it('parses "通过"', () => {
    expect(parseBridgeCommand('通过')).toEqual({ kind: 'approve' });
  });
  it('parses "没问题"', () => {
    expect(parseBridgeCommand('没问题')).toEqual({ kind: 'approve' });
  });
  it('parses "LGTM"', () => {
    expect(parseBridgeCommand('LGTM')).toEqual({ kind: 'approve' });
  });
  it('parses "可以，做得不错" (with comment)', () => {
    expect(parseBridgeCommand('可以，做得不错')).toEqual({ kind: 'approve', comment: '做得不错' });
  });

  // ── /reject natural language ──
  it('parses "不行"', () => {
    expect(parseBridgeCommand('不行')).toEqual({ kind: 'reject' });
  });
  it('parses "打回，需要改一下错误处理" (with reason)', () => {
    expect(parseBridgeCommand('打回，需要改一下错误处理')).toEqual({ kind: 'reject', reason: '需要改一下错误处理' });
  });

  // ── /insights expanded ──
  it('parses "哪里有瓶颈"', () => {
    expect(parseBridgeCommand('哪里有瓶颈')).toEqual({ kind: 'insights' });
  });
  it('parses "效率怎么样"', () => {
    expect(parseBridgeCommand('效率怎么样')).toEqual({ kind: 'insights' });
  });
  it('parses "有什么问题"', () => {
    expect(parseBridgeCommand('有什么问题')).toEqual({ kind: 'insights' });
  });

  // ── /trust set natural language ──
  it('parses "设置信任等级为执行"', () => {
    expect(parseBridgeCommand('设置信任等级为执行')).toEqual({ kind: 'trust', action: 'set', level: 'execute' });
  });
  it('parses "提升信任等级"', () => {
    expect(parseBridgeCommand('提升信任等级')).toEqual({ kind: 'trust', action: 'set', level: '_promote' });
  });
  it('parses "降低信任"', () => {
    expect(parseBridgeCommand('降低信任')).toEqual({ kind: 'trust', action: 'set', level: '_demote' });
  });
  it('parses "调整信任级别到自主"', () => {
    expect(parseBridgeCommand('调整信任级别到自主')).toEqual({ kind: 'trust', action: 'set', level: 'autonomous' });
  });

  // ── /timeline expanded ──
  it('parses "最近发生了什么"', () => {
    expect(parseBridgeCommand('最近发生了什么')).toEqual({ kind: 'timeline' });
  });
  it('parses "项目动态"', () => {
    expect(parseBridgeCommand('项目动态')).toEqual({ kind: 'timeline' });
  });
  it('parses "frontend的时间线"', () => {
    expect(parseBridgeCommand('frontend的时间线')).toEqual({ kind: 'timeline', project: 'frontend' });
  });

  // ── /digest natural language ──
  it('parses "日报"', () => {
    expect(parseBridgeCommand('日报')).toEqual({ kind: 'digest' });
  });
  it('parses "团队日报"', () => {
    expect(parseBridgeCommand('团队日报')).toEqual({ kind: 'digest' });
  });
  it('parses "今天的报告"', () => {
    expect(parseBridgeCommand('今天的报告')).toEqual({ kind: 'digest' });
  });
  it('parses "出个日报"', () => {
    expect(parseBridgeCommand('出个日报')).toEqual({ kind: 'digest' });
  });
  it('parses "生成团队总结"', () => {
    expect(parseBridgeCommand('生成团队总结')).toEqual({ kind: 'digest' });
  });

  // ── Prefix stripping works for collaboration commands ──
  it('strips prefix: "帮我看看团队态势"', () => {
    expect(parseBridgeCommand('帮我看看团队态势')).toEqual({ kind: 'team' });
  });
  it('strips prefix: "请帮我查一下知识 Redis"', () => {
    expect(parseBridgeCommand('请帮我查一下知识 Redis')).toEqual({ kind: 'recall', query: 'Redis' });
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
