function tokens(value) {
  return Math.max(0, Math.ceil(JSON.stringify(value ?? '').length / 4));
}

export function estimateDispatchTokens({ mission, board, crew, attachments = [] }) {
  const base = tokens({ mission, crew, attachments });
  const checkpoints = (board?.items ?? []).filter((item) => item.disposition === 'active');
  return {
    assemble: base,
    coldWorker: checkpoints.length
      ? Math.max(...checkpoints.map((item) => base + tokens({
        id: item.id, workUnitId: item.workUnitId, stage: item.stage,
        plan: item.plan, outcome: item.outcome, verify: item.verify,
        files: item.files, blockedBy: item.blockedBy,
      })))
      : base,
    unit: 'estimated tokens',
  };
}

export function estimateResumeMode(worker, checkpointId) {
  const sameCheckpoint = Boolean(worker?.resumeSessionId && worker.checkpointId === checkpointId);
  return { mode: sameCheckpoint ? 'resume' : 'cold', sessionId: sameCheckpoint ? worker.resumeSessionId : null };
}
