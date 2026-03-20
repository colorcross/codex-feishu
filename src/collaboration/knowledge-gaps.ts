/**
 * Knowledge Gap Detection — identifies topics the team keeps asking
 * about but hasn't documented.
 *
 * Logic:
 * 1. Extract topic clusters from recent prompts (keyword extraction)
 * 2. Check if those topics have matching entries in the knowledge base
 * 3. Topics with high prompt frequency but low/no knowledge = gap
 */

import type { RunState } from '../state/run-state-store.js';
import type { MemoryRecord } from '../state/memory-store.js';

export interface KnowledgeGap {
  topic: string;
  frequency: number;
  actors: string[];
  projects: string[];
  has_knowledge: boolean;
  knowledge_count: number;
  suggestion: string;
}

/**
 * Detect knowledge gaps from recent runs and existing knowledge.
 */
export function detectKnowledgeGaps(
  recentRuns: RunState[],
  existingKnowledge: MemoryRecord[],
  minFrequency: number = 3,
  windowHours: number = 168, // 7 days
): KnowledgeGap[] {
  const cutoff = Date.now() - windowHours * 3600_000;
  const windowRuns = recentRuns.filter(
    (r) => new Date(r.started_at).getTime() > cutoff && r.prompt_excerpt,
  );

  if (windowRuns.length === 0) return [];

  // Step 1: Extract topic keywords from prompts
  const topicMap = new Map<string, { runs: RunState[]; actors: Set<string>; projects: Set<string> }>();

  for (const run of windowRuns) {
    const keywords = extractTopicKeywords(run.prompt_excerpt);
    for (const keyword of keywords) {
      const entry = topicMap.get(keyword) ?? { runs: [], actors: new Set(), projects: new Set() };
      entry.runs.push(run);
      if (run.actor_id) entry.actors.add(run.actor_id);
      entry.projects.add(run.project_alias);
      topicMap.set(keyword, entry);
    }
  }

  // Step 2: Check each topic against knowledge base
  const knowledgeIndex = buildKnowledgeIndex(existingKnowledge);
  const gaps: KnowledgeGap[] = [];

  for (const [topic, data] of topicMap) {
    if (data.runs.length < minFrequency) continue;

    // Only flag topics asked by multiple actors or repeatedly by one
    if (data.actors.size < 2 && data.runs.length < minFrequency * 2) continue;

    const matchingKnowledge = knowledgeIndex.get(topic) ?? 0;

    gaps.push({
      topic,
      frequency: data.runs.length,
      actors: [...data.actors],
      projects: [...data.projects],
      has_knowledge: matchingKnowledge > 0,
      knowledge_count: matchingKnowledge,
      suggestion: matchingKnowledge === 0
        ? `团队在"${topic}"方面被问了 ${data.runs.length} 次但没有沉淀知识。建议使用 /learn 记录经验。`
        : `"${topic}"相关知识有 ${matchingKnowledge} 条，但仍被频繁询问（${data.runs.length} 次）。建议更新或补充现有知识。`,
    });
  }

  // Sort: no knowledge first, then by frequency desc
  gaps.sort((a, b) => {
    if (a.has_knowledge !== b.has_knowledge) return a.has_knowledge ? 1 : -1;
    return b.frequency - a.frequency;
  });

  return gaps.slice(0, 10);
}

export function formatKnowledgeGaps(gaps: KnowledgeGap[]): string {
  if (gaps.length === 0) {
    return '📚 知识缺口检测：未发现明显缺口。团队知识沉淀良好。';
  }

  const lines: string[] = ['📚 知识缺口检测\n'];

  const noKnowledge = gaps.filter((g) => !g.has_knowledge);
  const needsUpdate = gaps.filter((g) => g.has_knowledge);

  if (noKnowledge.length > 0) {
    lines.push('🔴 缺失知识（被反复问到但没有记录）');
    for (const gap of noKnowledge) {
      const actorInfo = gap.actors.length > 1 ? `${gap.actors.length} 人问过` : gap.actors[0] ?? '';
      lines.push(`  • "${gap.topic}" — 被问 ${gap.frequency} 次, ${actorInfo}`);
    }
  }

  if (needsUpdate.length > 0) {
    lines.push('\n🟡 需要补充（有记录但仍被频繁询问）');
    for (const gap of needsUpdate) {
      lines.push(`  • "${gap.topic}" — 已有 ${gap.knowledge_count} 条知识, 但仍被问 ${gap.frequency} 次`);
    }
  }

  lines.push('\n💡 使用 /learn 记录团队经验，下次 AI 会自动引用。');

  return lines.join('\n');
}

// ── Internal helpers ──

/**
 * Extract meaningful topic keywords from a prompt excerpt.
 * Produces 2-3 char Chinese compound words and English technical terms.
 */
function extractTopicKeywords(text: string): string[] {
  const keywords: string[] = [];

  // English technical terms (2+ chars, lowercase)
  const englishTerms = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g);
  if (englishTerms) {
    for (const term of englishTerms) {
      // Skip common stop words
      if (!STOP_WORDS.has(term)) {
        keywords.push(term);
      }
    }
  }

  // Chinese 2-3 char compound words
  const cjkRuns = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      if (run.length >= 2 && run.length <= 4 && !CJK_STOP_WORDS.has(run)) {
        keywords.push(run);
      }
      // Also extract 2-char subwords from longer runs
      if (run.length > 2) {
        const chars = [...run];
        for (let i = 0; i < chars.length - 1; i++) {
          const bigram = chars[i]! + chars[i + 1]!;
          if (!CJK_STOP_WORDS.has(bigram)) {
            keywords.push(bigram);
          }
        }
      }
    }
  }

  return [...new Set(keywords)];
}

/**
 * Build an index of existing knowledge: topic keyword → count of matching records.
 */
function buildKnowledgeIndex(memories: MemoryRecord[]): Map<string, number> {
  const index = new Map<string, number>();

  for (const mem of memories) {
    if (mem.archived_at) continue;

    const text = `${mem.title} ${mem.content} ${mem.tags.join(' ')}`;
    const keywords = extractTopicKeywords(text);

    for (const keyword of keywords) {
      index.set(keyword, (index.get(keyword) ?? 0) + 1);
    }
  }

  return index;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'have', 'has',
  'not', 'but', 'are', 'was', 'were', 'been', 'will', 'can', 'could',
  'should', 'would', 'may', 'might', 'shall', 'does', 'did', 'its',
  'let', 'get', 'set', 'put', 'run', 'use', 'new', 'add', 'try',
  'how', 'what', 'why', 'when', 'who', 'which', 'where', 'fix',
  'help', 'make', 'just', 'also', 'need', 'want', 'like', 'please',
  'file', 'code', 'test', 'look', 'see', 'check', 'update',
]);

const CJK_STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '有', '这', '个', '们', '中',
  '来', '上', '大', '为', '和', '国', '地', '到', '以', '说',
  '时', '要', '就', '出', '会', '也', '你', '对', '生', '能',
  '而', '子', '那', '得', '于', '着', '下', '自', '之', '年',
  '过', '发', '后', '作', '里', '用', '道', '行', '所', '然',
  '家', '种', '事', '成', '方', '多', '经', '么', '去', '法',
  '当', '起', '与', '好', '看', '学', '进', '没', '如', '都',
  '同', '现', '一下', '什么', '怎么', '可以', '一个', '我们',
  '帮我', '请', '修复', '修改', '查看', '如何', '为什么',
]);
