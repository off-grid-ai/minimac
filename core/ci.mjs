import { isClosed } from './board.mjs';

export function pullRequestNumbers({ mission = '', items = [] } = {}) {
  const source = [mission, ...items.flatMap((item) => [item.title, item.outcome, item.scope])].join('\n');
  const numbers = new Set();
  for (const match of source.matchAll(/\b(?:PR|pull request)\s*#?(\d+)\b/gi)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers];
}

export function failureSignature(checks) {
  return checks.map((check) => `${check.name}:${check.state}`).sort().join('|');
}

export function ciFailureWork({ number, failures, items, owner, estimateMs }) {
  const existing = items.find((item) => !isClosed(item)
    && new RegExp(`\\b(?:PR|pull request)\\s*#?${number}\\b`, 'i')
      .test(`${item.title}\n${item.outcome}`));
  const summary = failures.map((check) => check.name).filter(Boolean).slice(0, 3).join(', ')
    || 'hosted checks';
  if (existing) return { existing, summary, checkpoint: null };
  return {
    existing: null,
    summary,
    checkpoint: {
      title: `Fix PR ${number} CI: ${summary}`,
      plan: 'Read the hosted failure; make the smallest root-cause fix; run its focused proof; push the repaired head.',
      outcome: `PR ${number} has no failing hosted checks.`,
      verify: `gh pr checks ${number}`,
      scope: `pr/${number}`,
      owner,
      needs: ['coding', 'test', 'commits', 'push'],
      blockedBy: [],
      estimateMs,
    },
  };
}
