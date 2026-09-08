// An engine conversation belongs to the checkpoint that created it. A worker
// slot can run later checkpoints, but it must not carry one checkpoint's
// private conversation into another checkpoint.

export function hasSessionAffinity(worker, checkpointId) {
  return (worker?.checkpointId ?? null) === (checkpointId ?? null);
}

export function canResumeSession(worker, { engine, checkpointId }) {
  return Boolean(worker?.resumeSessionId)
    && Boolean(engine)
    && (!worker.engine || worker.engine === engine)
    && hasSessionAffinity(worker, checkpointId);
}

export function isCurrentSessionEvent(worker, { sessionId = null, engine = null } = {}) {
  if (!worker) return false;
  const knownSessionId = worker.sessionId ?? worker.resumeSessionId;
  if (knownSessionId && sessionId && knownSessionId !== sessionId) return false;
  if (worker.engine && engine && worker.engine !== engine) return false;
  return true;
}
