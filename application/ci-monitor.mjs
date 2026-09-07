import { ciFailureWork, failureSignature, pullRequestNumbers } from '../core/ci.mjs';

export function createCiMonitor({
  checks,
  snapshot,
  loadBaseline,
  saveBaseline,
  createCheckpoint,
  notify,
  reportHealth,
  owner,
  estimateMs,
  intervalMs = 30_000,
  schedule,
  cancel,
}) {
  let signatures = new Map();
  let activeScope = null;
  const health = new Map();
  let timer = null;
  let busy = false;

  const selectScope = (current) => {
    const scope = String(current.scope ?? 'none');
    if (scope === activeScope) return;
    activeScope = scope;
    signatures = new Map(Object.entries(loadBaseline(current) ?? {}));
    health.clear();
  };
  const persist = (current) => saveBaseline(current, Object.fromEntries(signatures));

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const current = snapshot();
      selectScope(current);
      for (const number of pullRequestNumbers(current)) {
        try {
          const failures = await checks.failuresFor(number);
          const previousHealth = health.get(number);
          health.set(number, 'ok');
          if (previousHealth && previousHealth !== 'ok') {
            reportHealth({ number, state: 'ok' });
          }
          const signature = failureSignature(failures);
          const previous = signatures.get(String(number));
          signatures.set(String(number), signature);
          persist(current);
          if (!signature || signature === previous) continue;
          const work = ciFailureWork({
            number, failures, items: current.items, owner, estimateMs,
          });
          if (work.checkpoint) createCheckpoint(work.checkpoint);
          await notify(number, work);
        } catch (error) {
          const message = error?.message ?? String(error);
          if (health.get(number) !== message) {
            health.set(number, message);
            reportHealth({ number, state: 'failed', error: message });
          }
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      void poll();
      timer = schedule(() => void poll(), intervalMs);
    },
    stop() {
      if (timer) cancel(timer);
      timer = null;
    },
    poll,
  };
}
