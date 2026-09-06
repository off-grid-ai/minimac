// The floor's voice. A quiet ambient bed so an occupied room does not sound
// like an empty one, and one short cue per event class so you can look away
// and still know what happened.
//
// Everything is synthesised with WebAudio - no files, no library. This module
// is the speaker only: WHICH cue an event earns is a rule and lives in
// core/attention.mjs.

import { CUES } from '../core/attention.mjs';

const STORE_KEY = 'minimac.sound';
// Quiet enough to sit under a conversation, loud enough that switching it on
// is unmistakably something happening. Too quiet and the switch reads broken.
const BED_GAIN = 0.11;
const CUE_GAIN = 0.3;
const BED_RAMP = 0.25; // seconds; the room comes up while your finger is still on the switch

// Every cue in one table: a shape you can read without listening to it.
// notes are [frequency, startOffset, duration]; `type` is the oscillator.
const VOICES = Object.freeze({
  // A step was proved: two notes up, clean. The only cue that rises.
  [CUES.VERIFIED]: { type: 'sine', gain: 1.0, notes: [[660, 0, 0.09], [990, 0.075, 0.16]] },
  // An agent stopped: one low note that falls. Nothing pretty about it.
  [CUES.BLOCKED]: { type: 'triangle', gain: 1.0, notes: [[196, 0, 0.13], [146.8, 0.1, 0.24]] },
  // Something was said: a single soft tick, barely there.
  [CUES.MESSAGE]: { type: 'sine', gain: 0.5, notes: [[880, 0, 0.05]] },
  // It needs you: three notes, the only cue that repeats itself.
  [CUES.DECISION]: { type: 'sine', gain: 1.1, notes: [[587, 0, 0.1], [784, 0.11, 0.1], [587, 0.22, 0.3]] },
});

// One cue of a kind per window, however many events arrive: six agents
// finishing at once must not sound like a slot machine.
const COALESCE_MS = 450;

export function createSound() {
  let enabled = load();
  let ctx = null;
  let master = null;
  let bed = null;
  let level = 1;          // scaled down by neglect, so a dark room is quiet
  let played = 0;
  const lastCueAt = new Map();

  function build() {
    if (ctx) return ctx;
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    bed = makeBed(ctx, master);
    return ctx;
  }

  // The context can only be started from a real gesture, and resume() is a
  // promise: setting the gain against a clock that has not started yet leaves
  // the bed silent, so the ramp is scheduled again once it is actually running.
  function apply() {
    if (!ctx) return;
    const ramp = () => {
      const target = enabled ? BED_GAIN * level : 0;
      bed.gain.gain.cancelScheduledValues(ctx.currentTime);
      bed.gain.gain.setTargetAtTime(target, ctx.currentTime, BED_RAMP);
    };
    if (enabled && ctx.state !== 'running') ctx.resume().then(ramp, ramp);
    else ramp();
  }

  // A remembered "on" cannot start a context: the browser only allows that
  // from a real gesture. Without this the switch comes back lit and silent,
  // and the next click - the one meant to fix it - turns it OFF instead.
  if (enabled) {
    const arm = () => {
      removeEventListener('pointerdown', arm, true);
      removeEventListener('keydown', arm, true);
      if (!enabled) return;
      build();
      apply();
    };
    addEventListener('pointerdown', arm, true);
    addEventListener('keydown', arm, true);
  }

  return {
    get enabled() {
      return enabled;
    },

    // Only ever called from a real click, which is what lets the context start.
    setEnabled(next) {
      enabled = Boolean(next);
      save(enabled);
      if (enabled) build();
      apply();
      // Switching it on IS an event, and the first thing a new switch has to
      // prove is that it did something. You hear the floor come up.
      if (enabled) this.play(CUES.VERIFIED);
      return enabled;
    },

    toggle() {
      return this.setEnabled(!enabled);
    },

    // The room's mood, 0..1 of neglect. A neglected floor goes quiet: the last
      // thing an ignored room should do is keep chirping cheerfully.
    setNeglect(neglectLevel) {
      const next = 1 - Math.min(1, Math.max(0, neglectLevel)) * 0.85;
      if (Math.abs(next - level) < 0.02) return;
      level = next;
      apply();
    },

    play(cue) {
      const voice = VOICES[cue];
      if (!enabled || !voice || !build()) return;
      const now = Date.now();
      if (now - (lastCueAt.get(cue) ?? 0) < COALESCE_MS) return;
      lastCueAt.set(cue, now);
      const fire = () => strike(ctx, master, voice, CUE_GAIN * level);
      if (ctx.state !== 'running') ctx.resume().then(fire, fire);
      else fire();
      played += 1;
    },

    // What the speaker is actually doing, for when you cannot listen to it.
    // Read-only: it reports, it never decides anything.
    probe() {
      return {
        enabled,
        contextState: ctx?.state ?? 'none',
        masterGain: master?.gain.value ?? null,
        bedGain: bed?.gain.gain.value ?? null,
        cuesPlayed: played,
      };
    },
  };
}

// The bed: a slow drone a fifth apart plus filtered noise, all far below the
// cues. It exists to be missed when it stops, never to be listened to.
function makeBed(ctx, destination) {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(destination);

  const shelf = ctx.createBiquadFilter();
  shelf.type = 'lowpass';
  shelf.frequency.value = 320;
  shelf.Q.value = 0.4;
  shelf.connect(gain);

  for (const frequency of [55, 82.4]) {
    const oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const voice = ctx.createGain();
    voice.gain.value = 0.5;
    oscillator.connect(voice).connect(shelf);
    oscillator.start();

    // A slow detune, so two held sines never sit still enough to buzz.
    const drift = ctx.createOscillator();
    drift.type = 'sine';
    drift.frequency.value = 0.05 + Math.random() * 0.04;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    drift.connect(depth).connect(oscillator.frequency);
    drift.start();
  }

  // Room noise: two seconds of pink-ish noise on a loop, heavily filtered.
  const seconds = 2;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let running = 0;
  for (let i = 0; i < data.length; i += 1) {
    running = (running + (Math.random() * 2 - 1) * 0.02) * 0.99;
    data[i] = running;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  const hiss = ctx.createBiquadFilter();
  hiss.type = 'bandpass';
  hiss.frequency.value = 480;
  hiss.Q.value = 0.6;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 1.6;
  noise.connect(hiss).connect(noiseGain).connect(gain);
  noise.start();

  return { gain };
}

// One cue. Each note is its own short oscillator with an envelope, so nothing
// clicks and nothing is left running.
function strike(ctx, destination, voice, peak) {
  const at = ctx.currentTime + 0.005;
  for (const [frequency, offset, duration] of voice.notes) {
    const oscillator = ctx.createOscillator();
    oscillator.type = voice.type;
    oscillator.frequency.value = frequency;

    const envelope = ctx.createGain();
    const start = at + offset;
    const level = peak * (voice.gain ?? 1);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(level, start + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(envelope).connect(destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.05);
  }
}

function load() {
  try {
    return localStorage.getItem(STORE_KEY) === 'on';
  } catch {
    return false;
  }
}

function save(enabled) {
  try {
    localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off');
  } catch {
    // storage disabled: the choice simply does not survive a reload
  }
}
