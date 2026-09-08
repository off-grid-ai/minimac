import { acceptanceState, missionIsComplete } from './acceptance.mjs';
import { isDone, itemsOf } from './board.mjs';

export function projectMissionProgress(board, acceptance) {
  const workUnits = board?.workUnits ?? [];
  const activeItems = itemsOf(board).filter((item) => !['cancelled', 'superseded'].includes(item.disposition));
  const doneUnits = workUnits.filter((unit) => {
    const stages = activeItems.filter((item) => item.workUnitId === unit.id);
    return stages.length > 0 && stages.every(isDone);
  }).length;
  return {
    work: {
      done: doneUnits,
      total: workUnits.length,
      percent: workUnits.length ? Math.round((doneUnits / workUnits.length) * 100) : 0,
    },
    quality: acceptanceState(acceptance, board),
    complete: missionIsComplete(acceptance, board),
  };
}

export function repositoryQualitySummary(board) {
  const summaries = new Map();
  for (const item of itemsOf(board)) {
    const repository = String(item.scope || 'mission').split('/')[0];
    const rows = summaries.get(repository) ?? [];
    for (const evidence of item.evidence ?? []) {
      rows.push({
        checkpointId: item.id,
        gate: evidence.gate,
        result: evidence.state,
        command: evidence.receipt,
        time: evidence.at,
        by: evidence.by,
      });
    }
    summaries.set(repository, rows);
  }
  return [...summaries].map(([repository, evidence]) => ({ repository, evidence }));
}

export function missionContradictions(board, workers, acceptance) {
  const alerts = [];
  for (const item of itemsOf(board)) {
    if (isDone(item) && item.lease?.state === 'running') {
      alerts.push({ kind: 'lease', checkpointId: item.id, message: 'Done checkpoint has a running lease.' });
    }
    const worker = workers.find((candidate) => candidate.id === item.lease?.workerId);
    if (item.lease?.state === 'running' && ['stale', 'failed', 'stopped'].includes(worker?.state)) {
      alerts.push({ kind: 'worker', checkpointId: item.id, message: 'Running checkpoint has no live worker.' });
    }
  }
  const quality = acceptanceState(acceptance, board);
  const published = itemsOf(board).find((item) => item.id === 'release.push' && isDone(item));
  if (published && Object.values(quality).includes('failed')) {
    alerts.push({ kind: 'quality', message: 'Complete mission has a failed required gate.' });
  }
  return alerts;
}
