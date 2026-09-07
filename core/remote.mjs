// Remote control: reaching a seat from somewhere that is not this desk.
//
// Both engines can put a live session on your account's remote control, so the
// Codex or Claude app on your phone opens the same conversation the floor is
// showing. MINIMAC does not implement any of that - it decides WHO gets it and
// under what name, and the two CLIs do the rest.
//
// The default is the orchestrator, always. He is the one seat you want in your
// pocket: the crew reports to him, he rules on what the floor derives, and he
// is the one you would want to reach from a queue or a car. The workers are
// opt-in, because seven paired sessions is not a fleet you are watching, it is
// seven phones.
//
// What each engine can actually do, which is not the same thing:
//   - Claude takes `--remote-control <name>` per session, so a name here is a
//     name on your phone, and only the seats named get one.
//   - Codex enables it on the app-server DAEMON (`codex app-server --listen ...
//     --remote-control`), so it is all of that daemon's sessions or none. A
//     daemon we did not start is left exactly as it is - see adapters/codexd.

export const REMOTE = Object.freeze({
  // The orchestrator, and nobody else. The default.
  BOSS: 'boss',
  // Every seat, workers included.
  ALL: 'all',
  // Nobody. Sessions stay local to this machine.
  OFF: 'off',
});

const MODES = new Set(Object.values(REMOTE));

export function isRemoteMode(value) {
  return MODES.has(value);
}

// `--remote-control` on its own means "yes, the default": the flag exists to
// be readable at a glance, so bare use must not mean "off".
export function remoteMode(flag) {
  if (flag === undefined || flag === null || flag === false) return REMOTE.BOSS;
  if (flag === true || flag === '') return REMOTE.BOSS;
  const value = String(flag).toLowerCase();
  if (value === 'orchestrator' || value === 'thor') return REMOTE.BOSS;
  if (value === 'none' || value === 'false' || value === 'no') return REMOTE.OFF;
  if (!isRemoteMode(value)) throw new Error(`unknown --remote-control mode: ${flag}`);
  return value;
}

export function wantsRemote(agent, mode) {
  if (mode === REMOTE.OFF || !agent) return false;
  if (mode === REMOTE.ALL) return true;
  return agent.role === 'orchestrator';
}

// The name you will pick this session out by on the other device, where the
// only context is a list of names. "thor" alone would be one of several; the
// seat and the team are what make it this fleet's Thor.
//
// It must be STABLE: the same seat on the same team resumes under the name it
// already had, rather than growing a second entry every restart.
export function remoteName(agent, { team = '', prefix = 'minimac' } = {}) {
  return [prefix, slug(team), slug(agent.name), slug(agent.id)]
    .filter(Boolean)
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .join('-');
}

function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
