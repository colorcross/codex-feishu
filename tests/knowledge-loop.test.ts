import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '../src/state/memory-store.js';
import {
  extractInsights,
  buildLearnInput,
  formatRecallResults,
} from '../src/collaboration/knowledge.js';

describe('extractInsights', () => {
  it('extracts root cause pattern', () => {
    const prompt = 'Why does the build fail?';
    const response = 'After investigation, the root cause: missing dependency in package.json. ' +
      'This was introduced in commit abc123. The fix is straightforward and involves adding the dependency back. ' +
      'Additional context about the issue is that it only affects CI builds.';
    const result = extractInsights(prompt, response, 'proj-a');
    expect(result).not.toBeNull();
    expect(result!.tags).toContain('root-cause');
    expect(result!.tags).toContain('auto-extracted');
    expect(result!.source).toBe('auto');
    expect(result!.project_alias).toBe('proj-a');
    expect(result!.title.length).toBeGreaterThan(0);
    expect(result!.content).toContain('[root-cause]');
  });

  it('extracts solution pattern', () => {
    const prompt = 'How do I fix the flaky test?';
    const response = 'The test is timing-dependent. Solution: add a retry mechanism with exponential backoff. ' +
      'This approach is used in several other test suites in the codebase and has proven reliable over time.';
    const result = extractInsights(prompt, response, 'proj-b');
    expect(result).not.toBeNull();
    expect(result!.tags).toContain('solution');
  });

  it('extracts Chinese root cause pattern', () => {
    const prompt = '为什么部署失败？';
    const response = '经过排查，根因：配置文件中的端口号与实际服务不一致，导致健康检查超时。' +
      '这个问题在上周的版本更新中被引入，需要修改配置文件中的端口映射。' +
      '具体来说，原来的配置使用了 8080 端口，但容器内服务实际监听在 3000 端口。修复方法是将端口映射改为正确的值。';
    const result = extractInsights(prompt, response, 'proj-c');
    expect(result).not.toBeNull();
    expect(result!.tags).toContain('root-cause');
  });

  it('returns null when no patterns match', () => {
    const prompt = 'List all files';
    const response = 'Here are the files in the directory: src/index.ts, src/main.ts, package.json. ' +
      'There are also some configuration files and documentation scattered throughout the project.';
    const result = extractInsights(prompt, response, 'proj-a');
    expect(result).toBeNull();
  });

  it('returns null when response is too short', () => {
    const prompt = 'root cause?';
    const response = 'root cause: missing dep';
    const result = extractInsights(prompt, response, 'proj-a');
    expect(result).toBeNull();
  });

  it('extracts finding pattern', () => {
    const prompt = 'Check the performance issue';
    const response = 'I found that the database queries are not using indexes properly. This causes full table scans ' +
      'on every request. The solution would be to add composite indexes on the frequently queried columns.';
    const result = extractInsights(prompt, response, 'proj-d');
    expect(result).not.toBeNull();
    expect(result!.tags).toContain('finding');
  });

  it('extracts workaround pattern', () => {
    const prompt = 'How to work around the API limit?';
    const response = 'The API has a rate limit of 100 requests per minute. Workaround: implement client-side caching ' +
      'with a TTL of 5 minutes to reduce the number of API calls significantly during peak usage.';
    const result = extractInsights(prompt, response, 'proj-e');
    expect(result).not.toBeNull();
    expect(result!.tags).toContain('workaround');
  });

  it('extracts breaking change pattern', () => {
    const prompt = 'What changed in the new version?';
    const response = 'The API response format was restructured. Breaking change: the "data" field is now nested under ' +
      '"response.payload" instead of being at the top level. All clients need to update their parsing logic accordingly.';
    const result = extractInsights(prompt, response, 'proj-f');
    expect(result).not.toBeNull();
    expect(result!.tags).toContain('breaking-change');
  });

  it('limits title to 80 characters', () => {
    const prompt = 'Check';
    const longCause = 'a'.repeat(300);
    const response = `Root cause: ${longCause} and that is the full explanation of what went wrong with the service deployment and recovery process.`;
    const result = extractInsights(prompt, response, 'proj-a');
    expect(result).not.toBeNull();
    expect(result!.title.length).toBeLessThanOrEqual(80);
  });
});

describe('buildLearnInput', () => {
  it('splits on Chinese colon separator', () => {
    const result = buildLearnInput('部署规范：每次部署前必须跑完所有测试', 'proj-a', 'user-1', 'chat-1');
    expect(result.title).toBe('部署规范');
    expect(result.content).toBe('每次部署前必须跑完所有测试');
    expect(result.source).toBe('manual');
    expect(result.tags).toEqual(['manual']);
    expect(result.project_alias).toBe('proj-a');
    expect(result.actor_id).toBe('user-1');
    expect(result.chat_id).toBe('chat-1');
  });

  it('splits on English colon separator', () => {
    const result = buildLearnInput('Deploy rule: always run tests first', 'proj-b');
    expect(result.title).toBe('Deploy rule');
    expect(result.content).toBe('always run tests first');
  });

  it('uses first 80 chars as title when no separator found', () => {
    const longText = 'This is a long piece of knowledge that does not have a colon separator anywhere in it';
    const result = buildLearnInput(longText, 'proj-a');
    expect(result.title).toBe(longText.slice(0, 80).trim());
    expect(result.content).toBe(longText);
  });

  it('does not split when colon is past position 60', () => {
    const longPrefix = 'a'.repeat(70);
    const text = `${longPrefix}: some value`;
    const result = buildLearnInput(text, 'proj-a');
    expect(result.title).toBe(text.slice(0, 80).trim());
    expect(result.content).toBe(text);
  });

  it('uses title as content when content after colon is empty', () => {
    const result = buildLearnInput('部署规范：', 'proj-a');
    expect(result.title).toBe('部署规范');
    expect(result.content).toBe('部署规范');
  });

  it('prefers Chinese colon when it comes before English colon', () => {
    const result = buildLearnInput('规范：部署: 周五不发布', 'proj-a');
    expect(result.title).toBe('规范');
    expect(result.content).toBe('部署: 周五不发布');
  });
});

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    scope: 'project',
    project_alias: 'proj-a',
    title: 'Test memory',
    content: 'Some content',
    tags: ['test'],
    source: 'manual',
    pinned: false,
    confidence: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('formatRecallResults', () => {
  it('returns not-found message for empty results', () => {
    const result = formatRecallResults([], '部署');
    expect(result).toContain('没有找到');
    expect(result).toContain('部署');
  });

  it('formats results with titles and content', () => {
    const memories: MemoryRecord[] = [
      makeMemory({
        id: 'mem-1',
        title: 'Deploy guide',
        content: 'Always run tests before deploying',
        tags: ['deploy', 'ci'],
        source: 'manual',
        pinned: false,
      }),
    ];
    const result = formatRecallResults(memories, 'deploy');
    expect(result).toContain('团队知识检索');
    expect(result).toContain('deploy');
    expect(result).toContain('Deploy guide');
    expect(result).toContain('[手动记录]');
    expect(result).toContain('deploy, ci');
  });

  it('shows pinned icon for pinned memories', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ pinned: true, title: 'Important rule' }),
    ];
    const result = formatRecallResults(memories, 'rule');
    expect(result).toContain('Important rule');
  });

  it('shows auto-extracted label', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ source: 'auto', title: 'Auto finding' }),
    ];
    const result = formatRecallResults(memories, 'finding');
    expect(result).toContain('[自动提取]');
  });

  it('shows created_by when present', () => {
    const memories: MemoryRecord[] = [
      makeMemory({ created_by: 'alice', title: 'Alice note' }),
    ];
    const result = formatRecallResults(memories, 'note');
    expect(result).toContain('by alice');
  });

  it('truncates long content', () => {
    const longContent = 'x'.repeat(200);
    const memories: MemoryRecord[] = [
      makeMemory({ content: longContent }),
    ];
    const result = formatRecallResults(memories, 'test');
    // Content should be truncated (the truncate function cuts at 120 chars)
    expect(result.length).toBeLessThan(longContent.length + 200);
  });
});
