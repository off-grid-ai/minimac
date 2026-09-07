// The Codex daemon's lifecycle. The driver in codex.mjs speaks the protocol; it
// does not own whether anything is listening. That was the gap: every codex
// agent blocked with "app-server unreachable" and the only fix lived in another
// terminal, which is exactly the kind of thing the floor is supposed to spare
// you.
//
// Rules this obeys:
//   - Never spawn for a non-loopback URL. A remote daemon is somebody else's.
//   - Never adopt-and-kill. If one is already listening it is the operator's,
//     and it is left running when we exit.
//   - Never block boot. A daemon that will not come up is reported as a normal
//     blocked reason, not a crash.
//
// Remote control is a property of the DAEMON, not of one thread: `codex
// app-server --listen ... --remote-control` puts every session it holds on
// your account's remote control, and there is no per-session switch. So it can
// only be turned on for a daemon we start ourselves. When one is already
// listening we say plainly that its sessions are on whatever footing that
// daemon was started with, rather than implying we changed it.

import { spawn } from 'node:child_process';

const READY_TIMEOUT_MS = 15_000;
const POLL_MS = 250;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// `ws://127.0.0.1:4573` -> the http origin its health endpoints live on.
export function healthOrigin(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
  const scheme = parsed.protocol === 'wss:' ? 'https' : 'http';
  return `${scheme}://${parsed.host}`;
}

export function isLocal(url) {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function ready(url, signal) {
  const origin = healthOrigin(url);
  if (!origin) return false;
  try {
    const response = await fetch(`${origin}/readyz`, { signal });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitReady(url, deadline) {
  while (Date.now() < deadline) {
    if (await ready(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}

// Start the daemon if nothing is answering, and resolve once it is. The caller
// gets a plain description of what happened so it can say so on the floor.
export async function ensureCodexServer({
  url = 'ws://127.0.0.1:4573',
  bin = 'codex',
  timeoutMs = READY_TIMEOUT_MS,
  onLog = null,
  remoteControl = false,
} = {}) {
  if (!healthOrigin(url)) return { ok: false, reason: `not a websocket url: ${url}` };

  if (await ready(url)) {
    return {
      ok: true,
      started: false,
      remoteControl: null, // not ours, so not ours to describe
      reason: remoteControl
        ? 'already listening - remote control is whatever that daemon was started with'
        : 'already listening',
    };
  }

  if (!isLocal(url)) {
    return { ok: false, started: false, reason: `nothing listening at ${url}, and it is not ours to start` };
  }

  const args = ['app-server', '--listen', url];
  if (remoteControl) args.push('--remote-control');

  let child;
  try {
    child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false, // dies with us, so we never orphan a daemon we started
    });
  } catch (error) {
    return { ok: false, started: false, reason: `could not run ${bin}: ${error.message}` };
  }

  // A pipe nobody drains fills and stalls the child - the same bug the claude
  // adapter had.
  child.stdout?.on('data', (chunk) => onLog?.(String(chunk).trimEnd()));
  child.stderr?.on('data', (chunk) => onLog?.(String(chunk).trimEnd()));

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = signal ? `killed by ${signal}` : `exited with code ${code}`;
  });
  child.on('error', (error) => {
    exited = error.message;
  });

  const live = await waitReady(url, Date.now() + timeoutMs);
  if (!live) {
    child.kill('SIGTERM');
    return {
      ok: false,
      started: false,
      reason: exited ?? `codex app-server did not answer ${healthOrigin(url)}/readyz in ${Math.round(timeoutMs / 1000)}s`,
    };
  }

  return {
    ok: true,
    started: true,
    remoteControl,
    reason: `started codex app-server on ${url}${remoteControl ? ' with remote control' : ''}`,
    stop() {
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}
