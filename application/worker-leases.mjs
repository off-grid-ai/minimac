import { createLease, extendLease } from '../core/leases.mjs';

export function createWorkerLeaseService({ schedule, cancel, onWarning, onExpire, now = Date.now }) {
  const timers = new Map();

  function clear(workerId) {
    const held = timers.get(workerId);
    if (held?.warning) cancel(held.warning);
    if (held?.expiry) cancel(held.expiry);
    timers.delete(workerId);
  }

  function arm(lease) {
    clear(lease.workerId);
    const current = now();
    const warning = schedule(
      () => onWarning(lease),
      Math.max(0, lease.warningAt - current),
    );
    const expiry = schedule(
      () => onExpire(lease),
      Math.max(0, lease.expiresAt - current),
    );
    timers.set(lease.workerId, { warning, expiry });
    return lease;
  }

  function start(spec) {
    return arm(createLease({ ...spec, now: now() }));
  }

  function restore(lease) {
    if (!lease?.workerId || lease.state !== 'running') return lease;
    return arm(lease);
  }

  function extend(lease) {
    const result = extendLease(lease, now());
    if (result.error) return result;
    arm(result.lease);
    return result;
  }

  return Object.freeze({ start, restore, extend, clear });
}
