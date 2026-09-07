// The port. One verb set for every engine; the resolver picks the adapter.
// Nothing above this line knows Codex from Claude.

/**
 * Driver:
 *   start(agent, cwd, prompt)  -> Promise<sessionId>
 *   setGoal(sessionId, objective, tokenBudget, status) -> Promise<void>
 *   steer(sessionId, text)     -> Promise<void>
 *   interrupt(sessionId)       -> Promise<void>
 *   onEvent(handler)           -> void   // handler receives normalized Events only
 *
 * Optional:
 *   reconcile(agent, cwd, sessionId) -> Promise<{ live, state, resumable }>
 *     Check a saved session at server startup without starting new work.
 *   resume(agent, cwd, sessionId, prompt) -> Promise<sessionId>
 *     Continue an existing conversation rather than opening a new one. Falls
 *     back to start() when the engine cannot reach that session any more.
 *   approve(sessionId, approvalId, decision) -> Promise<void>
 *     Answer an approval the engine is parked on. Engines that have no protocol
 *     for it fall back to steering, so callers must check before using it.
 */

const REQUIRED = ['start', 'setGoal', 'steer', 'interrupt', 'onEvent'];

export function assertDriver(driver, name) {
  for (const method of REQUIRED) {
    if (typeof driver?.[method] !== 'function') {
      throw new Error(`${name} driver is missing ${method}()`);
    }
  }
  return driver;
}

// Open for extension: a new engine is one more entry here, and nothing above
// the port changes.
export function createDriverRegistry(driversByEngine) {
  const drivers = Object.fromEntries(
    Object.entries(driversByEngine).map(([engine, driver]) => [engine, assertDriver(driver, engine)]),
  );
  return function getDriver(engine) {
    const driver = drivers[engine];
    if (!driver) throw new Error(`no driver for engine: ${engine}`);
    return driver;
  };
}
