// One agent's desk: furniture, a person, a screen and the two lights that
// carry the state. Every visible property here is a function of the view model
// - nothing is remembered locally, nothing is invented.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/+esm';
import { POSE } from '../core/derive.mjs';
import { HEAD_HEIGHT, clamp, seatOf, queueSpot } from './layout.mjs';
import { instance, build, customModel, isolateMaterials, findMaterial } from './models.mjs';
import { identityOf, hashId } from './identity.mjs';

const DESK_TOP = 0.38;
// The person sits on the FAR side of the desk facing the camera, so posture
// and attention are readable and the monitor's light falls on their face.
export const SEAT = { x: 0, y: 0.23, z: -0.66 };
const PERSON_HEIGHT = 0.5; // every character, built-in or supplied, ends up this tall
const PACE_REACH = 0.95;
const PACE_LANE = 0.55; // out to the side and in front, never hidden behind
const MAX_SHEETS = 8;

// --------------------------------------------------------------- pose (pure)
// pose + clock -> where the body is, how it is held, and which clip plays.
// No three.js in here, so the reading of a state is testable on its own.

export function poseState(agent, t, reduced, waypoint = null) {
  const seed = (hashId(agent.id) % 97) / 97;
  const time = t + seed * 7;
  const rate = clamp(agent.eventsPerMin / 24, 0, 1);

  if (agent.pose === POSE.PACING) {
    // The loop detector firing. Out of the chair and walking. This is the one
    // signal that has to carry across the room.
    const swing = reduced ? 0.6 : triangle((time / 3.6) % 1) * 2 - 1;
    const heading = reduced ? Math.PI / 2 : (Math.sign(dTriangle((time / 3.6) % 1)) || 1) * (Math.PI / 2);
    return {
      clip: 'walk',
      seated: false,
      x: swing * PACE_REACH,
      y: 0,
      z: PACE_LANE,
      yaw: heading,
      lean: 0,
      marker: 'loop',
      screen: rate * 0.35,
      timeScale: 1.4,
    };
  }

  if (agent.pose === POSE.ERRAND) {
    // Same machinery as BLOCKED - out of the chair, walk to a waypoint, stand.
    // The difference is who chose it: an errand is delivery, not distress.
    return {
      clip: 'idle',
      seated: false,
      travels: true,
      x: waypoint?.x ?? 0,
      y: 0,
      z: waypoint?.z ?? 0,
      yaw: 0,
      lean: 0,
      marker: null,
      screen: 0,
      timeScale: 1,
    };
  }

  if (agent.pose === POSE.BLOCKED) {
    // Out of the chair and over to the orchestrator's desk, where they stand
    // and wait. `waypoint` is that spot in this station's own coordinates -
    // the caller does the arithmetic, so this stays pure.
    return {
      clip: 'idle',
      seated: false,
      travels: true,
      x: waypoint?.x ?? 0.78,
      y: 0,
      z: waypoint?.z ?? 0.18,
      yaw: 0,
      lean: 0,
      marker: 'blocked',
      screen: 0,
      timeScale: reduced ? 0 : 0.6,
    };
  }

  // Killed, or taken off the mission. The chair is empty and the monitor is
  // off: a stopped desk must look stopped from across the room, not merely
  // idle. The desk itself stays, so it can be clicked and switched back on.
  if (agent.status === 'stopped' || agent.offDuty) {
    return {
      clip: 'sit',
      seated: true,
      away: true,
      x: SEAT.x,
      y: SEAT.y,
      z: SEAT.z,
      yaw: 0,
      lean: 0,
      marker: null,
      screen: 0,
      timeScale: 0,
    };
  }

  const seated = { seated: true, x: SEAT.x, y: SEAT.y, z: SEAT.z, yaw: 0, marker: null };

  if (agent.pose === POSE.TYPING) {
    return {
      ...seated,
      clip: 'sit',
      lean: reduced ? 0 : Math.sin(time * 9) * 0.035,
      bob: reduced ? 0 : Math.abs(Math.sin(time * 4.5)) * 0.012,
      screen: 0.28 + rate * 0.72,
      timeScale: 0,
    };
  }

  if (agent.pose === POSE.THINKING) {
    const look = beat(time, 5.4, 1.3);
    return {
      ...seated,
      clip: 'sit',
      yaw: look === null || reduced ? 0 : Math.sin(look * Math.PI) * 0.6,
      lean: reduced ? 0 : Math.sin(time * 0.7) * 0.02,
      bob: 0,
      screen: 0.12 + rate * 0.3,
      timeScale: 0,
    };
  }

  // Idle: quiet, but never dead. A slow breath and the occasional stretch.
  const stretch = beat(time, 11, 1.6);
  return {
    ...seated,
    clip: 'sit',
    lean: reduced || stretch === null ? 0 : Math.sin(stretch * Math.PI) * 0.12,
    bob: reduced ? 0 : Math.sin(time * 1.1) * 0.006,
    screen: 0.06,
    timeScale: 0,
  };
}

// ------------------------------------------------------- identity (pure)

const HEX = /^#[0-9a-f]{6}$/i;

// The roster may override the look. It never overrides the desk character or
// the props - those belong to the role.
export function identityColour(agent, identity) {
  return HEX.test(agent.color ?? '') ? agent.color : identity.colour;
}

// Emerald means "this is the one you selected" and red means "this failed".
// A user colour that lands near either keeps its chair but gives up the lamp
// and the floor pool, so the two signals stay legible.
export function identityTreatment(colour, reserved) {
  const clash = reserved.some((other) => distance(colour, other) < 0.3);
  return { chair: true, lamp: !clash, decal: !clash };
}

function distance(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

// -------------------------------------------------------------- workstation

export function createWorkstation({ models, agent, palette }) {
  const group = new THREE.Group();
  const parts = {};
  const identity = identityOf(agent);
  const badge = new THREE.Color(identityColour(agent, identity));
  parts.identity = identity;
  parts.badge = badge;
  parts.badgeKey = '';
  parts.reserved = [palette.accent, palette.danger];

  const desk = instance(models, 'desk');
  desk.position.set(0, 0, 0);
  group.add(desk);

  // The chair carries the identity colour: it is the biggest flat surface at
  // the desk, so it reads first from across the room.
  const chair = instance(models, 'chairDesk');
  chair.position.set(0, 0, SEAT.z);
  isolateMaterials(chair);
  parts.upholstery = findMaterial(chair, 'carpet') ?? findMaterial(chair, 'carpetDarker');
  group.add(chair);
  parts.chair = chair;

  // Monitor sits on the desk turned toward the person: we see its back, they
  // see the picture, and its light lands on their face.
  const screen = instance(models, 'computerScreen');
  screen.position.set(-0.05, DESK_TOP, -0.02);
  screen.rotation.y = Math.PI;
  isolateMaterials(screen);
  group.add(screen);
  parts.screen = screen;
  parts.screenMaterial = findMaterial(screen, 'metalDark') ?? findMaterial(screen, 'metal');

  // The lit panel itself: a plane we own, so brightness is ours to drive and
  // does not depend on how the kit named its materials.
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.2),
    new THREE.MeshBasicMaterial({ color: palette.screen, toneMapped: false, transparent: true }),
  );
  panel.position.set(-0.05, DESK_TOP + 0.16, -0.09);
  panel.rotation.y = Math.PI;
  group.add(panel);
  parts.panel = panel;

  // A light bar under the monitor, facing the room: the one part of the screen
  // you can read from the front, and it carries the same brightness.
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(0.31, 0.026, 0.022),
    new THREE.MeshBasicMaterial({ color: palette.screen, toneMapped: false, transparent: true }),
  );
  bar.position.set(-0.05, DESK_TOP + 0.05, 0.055);
  group.add(bar);
  parts.bar = bar;

  const keyboard = instance(models, 'computerKeyboard');
  keyboard.position.set(-0.02, DESK_TOP, -0.2);
  keyboard.rotation.y = Math.PI;
  group.add(keyboard);

  const mouse = instance(models, 'computerMouse');
  mouse.position.set(0.22, DESK_TOP, -0.18);
  mouse.rotation.y = Math.PI;
  group.add(mouse);

  const lamp = instance(models, 'lampRoundTable');
  lamp.position.set(-0.44, DESK_TOP, 0.13);
  group.add(lamp);

  // Warm pool from the lamp on the near edge of the desk, cold light off the
  // screen onto the person. Depth in the room comes from these two.
  const warm = new THREE.PointLight(palette.lamp.clone(), 2.6, 2.8, 2);
  warm.position.set(-0.44, DESK_TOP + 0.3, 0.13);
  group.add(warm);
  parts.warm = warm;

  const cold = new THREE.PointLight(palette.screen, 0, 2.2, 2);
  cold.position.set(-0.05, DESK_TOP + 0.26, -0.28);
  group.add(cold);
  parts.cold = cold;

  // Paper: the size of the change, stacked where you would stack it.
  parts.sheets = [];
  const sheetGeometry = new THREE.BoxGeometry(0.16, 0.008, 0.12);
  const sheetMaterial = new THREE.MeshStandardMaterial({ color: palette.paper, roughness: 0.95 });
  for (let i = 0; i < MAX_SHEETS; i += 1) {
    const sheet = new THREE.Mesh(sheetGeometry, sheetMaterial);
    sheet.castShadow = true;
    sheet.receiveShadow = true;
    sheet.position.set(0.27 + (i % 2) * 0.006, DESK_TOP + 0.006 + i * 0.009, 0.06);
    sheet.rotation.y = ((i % 3) - 1) * 0.07;
    sheet.visible = false;
    group.add(sheet);
    parts.sheets.push(sheet);
  }

  // The person lives in a slot so a roster-supplied mesh can replace the
  // built-in one the moment it finishes loading, without rebuilding the desk.
  parts.slot = new THREE.Group();
  group.add(parts.slot);
  parts.models = models;
  parts.meshPath = null;
  setPerson(parts, instance(models, identity.mesh, { targetHeight: PERSON_HEIGHT }));

  // Emerald floor ring: the one thing that says "this is the agent you picked".
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 0.82, 56),
    new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.75, toneMapped: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, 0.012, -0.2);
  ring.visible = false;
  group.add(ring);
  parts.ring = ring;

  // A soft pool of the identity colour on the floor - a colour, not a ring, so
  // it never competes with the emerald selection ring.
  const decal = new THREE.Mesh(
    new THREE.CircleGeometry(0.98, 48),
    new THREE.MeshBasicMaterial({
      color: badge,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  decal.rotation.x = -Math.PI / 2;
  decal.position.set(0, 0.014, -0.2);
  group.add(decal);
  parts.decal = decal;

  // The props that make this role's desk its own.
  for (const prop of identity.props ?? []) {
    const object = instance(models, prop.model);
    object.position.set(prop.x, prop.y ?? 0, prop.z);
    object.rotation.y = prop.yaw ?? 0;
    if (prop.scale) object.scale.setScalar(prop.scale);
    group.add(object);
  }

  parts.marker = makeMarker(palette);
  group.add(parts.marker.group);

  // Picking proxy: one box that covers the whole station, so a click anywhere
  // on the desk or the person selects that agent.
  const pick = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 1.4, 2.0),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  pick.position.set(0, 0.6, -0.2);
  pick.userData.agentId = agent.id;
  group.add(pick);
  parts.pick = pick;

  parts.head = new THREE.Object3D();
  parts.head.position.set(0, HEAD_HEIGHT, SEAT.z);
  group.add(parts.head);

  return { group, parts, update: (next, t, dt, reduced) => update(parts, palette, next, t, dt, reduced) };
}

function update(parts, palette, agent, t, dt, reduced) {
  const state = poseState(agent, t, reduced, waypointFor(agent));
  applyIdentity(parts, palette, agent);
  applyMesh(parts, agent);

  // A body does not teleport. Anything more than a step away is walked to,
  // in either direction, so leaving the desk and coming back are both seen.
  const walk = travel(parts, state, dt, reduced);

  playClip(parts, walk.walking ? 'walk' : state.clip, reduced ? 0 : walk.walking ? 1.2 : state.timeScale ?? 1, reduced);
  // Reduced motion is a held pose, not an unposed body: the mixer still has to
  // evaluate the clip once, it just never advances.
  parts.mixer.update(reduced ? 0 : dt);

  parts.slot.visible = !state.away;
  parts.slot.position.set(walk.x, state.y + (state.bob ?? 0), walk.z);
  parts.slot.rotation.set(state.lean ?? 0, walk.walking ? walk.yaw : state.yaw, 0);

  // Screen: brightness and the cold light it throws are the event rate.
  const off = Boolean(state.away);
  const level = clamp(state.screen, 0, 1);
  const failing = agent.pose === POSE.BLOCKED;
  const tint = failing ? palette.danger : agent.selected ? palette.accent : palette.screen;
  parts.panel.material.color.set(tint);
  parts.panel.material.opacity = off ? 0 : 0.25 + level * 0.75;
  parts.bar.material.color.set(tint);
  parts.bar.material.opacity = off ? 0 : 0.3 + level * 0.7;
  parts.cold.color.set(tint);
  // The screen's light is what you read from the front: it lands on the face.
  parts.cold.intensity = off ? 0 : failing ? 0.9 : 0.35 + level * 3.4;
  if (parts.screenMaterial) {
    parts.screenMaterial.emissive.set(tint);
    parts.screenMaterial.emissiveIntensity = off ? 0 : failing ? 0.35 : level * 0.9;
  }
  const floorLight = parts.identity.lampFloor ?? 1.1;
  parts.warm.intensity = off
    ? floorLight * 0.18
    : agent.pose === POSE.IDLE
      ? floorLight
      : Math.max(2.6, floorLight);
  // A dark desk: the identity pool goes out with the lamp, so a killed station
  // reads as abandoned rather than merely quiet.
  parts.decal.material.opacity = off ? 0.03 : 0.14;

  const sheets = Math.round(clamp(agent.diffLines / 60, 0, MAX_SHEETS));
  parts.sheets.forEach((sheet, i) => {
    sheet.visible = i < sheets;
  });

  parts.ring.visible = Boolean(agent.selected);
  if (parts.ring.visible && !reduced) {
    parts.ring.material.opacity = 0.5 + Math.sin(t * 2.4) * 0.22;
  }

  // The marker and the anchor for floating HTML follow the BODY, not the pose
  // it is heading for: a bubble must not wait at the desk while its agent
  // walks away from it.
  updateMarker(parts.marker, { ...state, x: walk.x, z: walk.z }, t, reduced);
  parts.head.position.set(walk.x, HEAD_HEIGHT + (state.seated ? 0 : 0.16), walk.z);
}

function playClip(parts, name, timeScale, reduced) {
  const action = parts.actions.get(name);
  if (!action) return; // a roster-supplied mesh may carry no clips at all
  if (parts.currentClip !== name) {
    for (const [clipName, other] of parts.actions) {
      if (clipName === name || !other.enabled) continue;
      if (reduced) other.stop();
      else other.fadeOut(0.25);
    }
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1);
    // A crossfade needs frames to run; with motion off there are none, so the
    // new pose is taken at full weight straight away.
    if (reduced) action.play();
    else action.fadeIn(0.25).play();
    parts.currentClip = name;
  }
  // A still clip is a held pose, not a stopped animation: the body stays put.
  action.paused = timeScale === 0;
  action.timeScale = timeScale === 0 ? 1 : timeScale;
}

// The identity treatment, reapplied only when the resolved colour changes.
function applyIdentity(parts, palette, agent) {
  const hex = identityColour(agent, parts.identity);
  if (hex === parts.badgeKey) return;
  parts.badgeKey = hex;
  parts.badge.set(hex);

  const treatment = identityTreatment(parts.badge, parts.reserved);
  if (parts.upholstery && treatment.chair) parts.upholstery.color.copy(parts.badge);
  parts.warm.color
    .copy(palette.lamp)
    .lerp(parts.badge, treatment.lamp ? parts.identity.lampMix ?? 0.3 : 0);
  parts.decal.material.color.copy(parts.badge);
  parts.decal.visible = treatment.decal;
  tintPerson(parts);
}

// A roster-supplied mesh replaces the built-in one once it has loaded. If the
// file is absent or broken the built-in character simply stays: the room never
// breaks over an optional asset.
function applyMesh(parts, agent) {
  const wanted = agent.mesh ?? null;
  if (wanted === parts.meshPath) return;
  if (!wanted) {
    parts.meshPath = null;
    setPerson(parts, instance(parts.models, parts.identity.mesh, { targetHeight: PERSON_HEIGHT }));
    tintPerson(parts);
    return;
  }
  const entry = customModel(wanted);
  if (entry.status === 'pending') return; // check again next frame
  parts.meshPath = wanted;
  if (entry.status === 'ready') {
    setPerson(parts, build(entry.model, { targetHeight: PERSON_HEIGHT }));
    tintPerson(parts);
  }
}

function setPerson(parts, person) {
  if (parts.person) parts.slot.remove(parts.person);
  parts.slot.add(person);
  parts.person = person;
  // Materials are shared across clones, so tinting one agent would repaint the
  // whole room unless each instance owns its own copy first.
  isolateMaterials(person);
  person.traverse((node) => {
    if (node.isMesh && node.material?.color) node.material.userData.base = node.material.color.clone();
  });
  parts.mixer = new THREE.AnimationMixer(person);
  parts.actions = new Map();
  for (const clip of person.userData.clips) {
    const action = parts.mixer.clipAction(clip);
    action.enabled = false;
    parts.actions.set(clip.name, action);
  }
  parts.currentClip = null;
}

// Always computed from the material's own base colour, so re-tinting cannot
// creep toward the identity colour one frame at a time.
function tintPerson(parts) {
  const amount = parts.identity.tint ?? 0.3;
  parts.person.traverse((node) => {
    const base = node.isMesh ? node.material?.userData?.base : null;
    if (base) node.material.color.copy(base).lerp(parts.badge, amount);
  });
}

// Where this agent stands when it is waiting on you, in its own coordinates.
// Every waypoint is expressed in THIS station's own coordinates, because the
// body moves inside a group already parked at its desk.
function waypointFor(agent) {
  const seat = seatOf(agent);
  // Carrying an order: walk to the desk named on the errand, wherever it is.
  if (agent.errand?.at) {
    return { x: agent.errand.at.x - seat.x, z: agent.errand.at.z - seat.z };
  }
  if (agent.isOrchestrator) return null; // it is already its own desk
  const spot = queueSpot(agent.index ?? 0);
  return { x: spot.x - seat.x, z: spot.z - seat.z };
}

// Smooth the body toward wherever the pose says it should be. Close enough to
// be a fidget, and it snaps - a damped seat would eat the typing bob. Far
// enough to be a journey, and it walks, facing the way it is going.
const STEP = 0.3;

function travel(parts, state, dt, reduced) {
  const at = (parts.at ??= { x: state.x, z: state.z });
  const dx = state.x - at.x;
  const dz = state.z - at.z;
  const distance = Math.hypot(dx, dz);
  if (distance < STEP || reduced) {
    at.x = state.x;
    at.z = state.z;
    return { x: at.x, z: at.z, walking: false, yaw: state.yaw };
  }
  const k = 1 - Math.exp(-dt * 1.6);
  at.x += dx * k;
  at.z += dz * k;
  return { x: at.x, z: at.z, walking: true, yaw: Math.atan2(dx, dz) };
}

// ------------------------------------------------------------------ markers

function makeMarker(palette) {
  const group = new THREE.Group();
  const loop = new THREE.Mesh(
    new THREE.TorusGeometry(0.13, 0.035, 10, 28),
    new THREE.MeshBasicMaterial({ color: palette.danger, toneMapped: false }),
  );
  loop.rotation.x = Math.PI / 2;
  const blocked = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.13),
    new THREE.MeshBasicMaterial({ color: palette.danger, toneMapped: false }),
  );
  group.add(loop, blocked);
  group.visible = false;
  return { group, loop, blocked };
}

function updateMarker(marker, state, t, reduced) {
  const kind = state.marker;
  marker.group.visible = Boolean(kind);
  if (!kind) return;
  marker.loop.visible = kind === 'loop';
  marker.blocked.visible = kind === 'blocked';
  // Sits just clear of the head, wherever the head currently is.
  const lift = state.seated ? HEAD_HEIGHT + 0.3 : 0.68;
  marker.group.position.set(state.x, lift + (reduced ? 0 : Math.sin(t * 3) * 0.05), state.z);
  if (!reduced) {
    marker.loop.rotation.z = t * 3.2;
    marker.blocked.rotation.y = t * 1.6;
  }
}

// ------------------------------------------------------------------- utils

function triangle(phase) {
  const p = phase - Math.floor(phase);
  return p < 0.5 ? p * 2 : 2 - p * 2;
}

function dTriangle(phase) {
  const p = phase - Math.floor(phase);
  return p < 0.5 ? 1 : -1;
}

function beat(t, period, duration) {
  const p = t % period;
  return p < duration ? p / duration : null;
}
