const AREA_RULES = [
  { label: 'area/feishu', keywords: ['feishu', 'lark', 'webhook', 'long-connection', 'chat_id', 'mention', 'bot', 'robot'] },
  { label: 'area/codex', keywords: ['codex', 'exec', 'resume', 'sandbox', 'profile', 'runner'] },
  { label: 'area/session', keywords: ['session', 'thread_id', 'project', 'route', 'resume', 'selection key', 'queue key'] },
  { label: 'area/ops', keywords: ['doctor', 'metrics', 'prometheus', 'grafana', 'alertmanager', 'launchd', 'systemd', 'audit', 'deploy', 'runtime'] },
  { label: 'area/docs', keywords: ['readme', 'doc', 'docs', 'documentation', 'faq', 'guide'] },
  { label: 'area/install', keywords: ['install', 'bootstrap', 'setup', 'pnpm', 'npm', 'package'] },
  { label: 'area/website', keywords: ['website', 'pages', 'landing', 'social preview', 'og:image'] },
  { label: 'area/release', keywords: ['release', 'changelog', 'tag', 'version'] },
];

const MANAGED_LABELS = [...AREA_RULES.map((rule) => rule.label), 'status/needs-feedback', 'status/needs-repro'];

function classifyIssue({ title = '', body = '', existingLabels = [] }) {
  const text = `${title}\n${body}`.toLowerCase();
  const next = new Set();

  for (const rule of AREA_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      next.add(rule.label);
    }
  }

  const bodyText = body.trim();
  const hasBugContext = existingLabels.includes('bug') || /\bbug\b|\berror\b|fail|crash|traceback|exception/.test(text);
  if (next.size === 0) {
    next.add('status/needs-feedback');
  }
  if (hasBugContext && bodyText.length < 180) {
    next.add('status/needs-repro');
  }

  return Array.from(next);
}

function diffManagedLabels(existingLabels, nextLabels) {
  const existing = new Set(existingLabels);
  const next = new Set(nextLabels);
  const add = Array.from(next).filter((label) => !existing.has(label));
  const remove = existingLabels.filter((label) => MANAGED_LABELS.includes(label) && !next.has(label));
  return { add, remove };
}

module.exports = {
  AREA_RULES,
  MANAGED_LABELS,
  classifyIssue,
  diffManagedLabels,
};
