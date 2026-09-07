export const LEASE_LIMIT_MS = 480_000;
export const LEASE_WARNING_MS = 360_000;
export const MAX_LEASE_EXTENSIONS = 1;

export function createLease({ agentId, workerId, checkpointId, sessionId = null, now = Date.now() }) {
  return {
    agentId,
    workerId,
    checkpointId,
    sessionId,
    startedAt: now,
    warningAt: now + LEASE_WARNING_MS,
    expiresAt: now + LEASE_LIMIT_MS,
    extensionCount: 0,
    state: 'running',
  };
}

export function canExtendLease(lease) {
  return Boolean(lease?.workerId)
    && lease.state === 'running'
    && (lease.extensionCount ?? 0) < MAX_LEASE_EXTENSIONS;
}

export function extendLease(lease, now = Date.now()) {
  if (!canExtendLease(lease)) return { error: 'this work-unit lease cannot be extended again' };
  const expiresAt = Math.max(now, lease.expiresAt ?? now) + LEASE_LIMIT_MS;
  return {
    lease: {
      ...lease,
      warningAt: expiresAt - (LEASE_LIMIT_MS - LEASE_WARNING_MS),
      expiresAt,
      extensionCount: (lease.extensionCount ?? 0) + 1,
      state: 'running',
    },
  };
}

export function finishLease(lease, state, now = Date.now()) {
  return { ...lease, state, endedAt: now };
}
