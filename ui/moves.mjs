// Signature moves: the one thing each agent does when it actually does its
// job. A bolt for the orchestrator, a smash for a test verdict, a repulsor
// ring for a landed diff, a portal for a finding, a sweeping beam for a
// published report, a hex band for an accepted plan. An arrow and a shield are
// kept here too: they are complete rigs no role currently claims.
//
// The rules this file lives by:
//   - Nothing is invented. A move exists only while main.mjs says it does, and
//     `life` (1 -> 0) is the only clock a move gets.
//   - Colour is semantic, never decorative: emerald is a pass, red is a real
//     failure, and everything else borrows the agent's own identity colour.
//   - Rigs are pooled and built once. A firing move takes a rig, arms it, and
//     gives it back - no geometry, material or vector is allocated per frame.
//   - prefers-reduced-motion gets one still marker for the same duration, so
//     the event is still reported without the animation.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/+esm';
import { clamp } from './layout.mjs';

export const MOVE_KINDS = Object.freeze([
  'lightning', 'arrow', 'repulsor', 'portal', 'beam', 'shield', 'smash', 'hex',
]);

const DESK_TOP = 0.38;
const SEAT_Z = -0.66; // where the agent actually sits, relative to its desk spot
const POOL = Object.freeze({
  lightning: 2, arrow: 3, repulsor: 3, portal: 3, beam: 2, shield: 3, smash: 3, hex: 3,
});
const MARKERS = 8; // reduced motion: one still marker per agent that can fire at once

// ------------------------------------------------------------------ shared
// One geometry per shape for the whole room. Rigs clone materials (they each
// need their own colour and opacity) but never geometry.

const UP = new THREE.Vector3(0, 1, 0);
const SCRATCH_A = new THREE.Vector3();
const SCRATCH_B = new THREE.Vector3();
const SCRATCH_Q = new THREE.Quaternion();
const WHITE = new THREE.Color('#ffffff');

const GEO = {
  bolt: new THREE.BoxGeometry(1, 1, 1),
  ring: new THREE.RingGeometry(0.42, 0.5, 48),
  thinRing: new THREE.RingGeometry(0.46, 0.5, 48),
  core: new THREE.SphereGeometry(0.11, 16, 12),
  shaft: new THREE.BoxGeometry(0.04, 0.04, 0.4),
  head: new THREE.ConeGeometry(0.08, 0.19, 8),
  torus: new THREE.TorusGeometry(0.42, 0.045, 10, 40),
  disc: new THREE.CircleGeometry(0.4, 40),
  shard: new THREE.OctahedronGeometry(0.075),
  cone: new THREE.ConeGeometry(0.6, 3.8, 20, 1, true),
  plate: new THREE.CylinderGeometry(0.44, 0.44, 0.045, 36),
  rim: new THREE.TorusGeometry(0.44, 0.035, 8, 36),
  fist: new THREE.BoxGeometry(0.3, 0.24, 0.3),
  band: new THREE.TorusGeometry(0.6, 0.022, 8, 48),
};

const owned = [];

function glow(colour, opacity = 1) {
  const material = new THREE.MeshBasicMaterial({
    color: colour,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  owned.push(material);
  return material;
}

const ease = (p) => 1 - (1 - p) * (1 - p);
const fade = (p, inTo, outFrom) => clamp(Math.min(p / inTo, (1 - p) / (1 - outFrom)), 0, 1);

// A box stretched between two points - the only way a bolt or an arrow gets a
// direction without allocating a matrix per frame.
function span(mesh, from, to, width) {
  SCRATCH_A.subVectors(to, from);
  const length = SCRATCH_A.length() || 0.0001;
  SCRATCH_B.copy(SCRATCH_A).multiplyScalar(1 / length);
  SCRATCH_Q.setFromUnitVectors(UP, SCRATCH_B);
  mesh.quaternion.copy(SCRATCH_Q);
  mesh.position.copy(from).addScaledVector(SCRATCH_A, 0.5);
  mesh.scale.set(width, length, width);
}

// ---------------------------------------------------------------- lightning
// A bolt cracks down onto the desk. The most dramatic move in the room, so it
// is also the shortest: drawn in the first third, then it flickers out.

function makeLightning(scene, colours) {
  const SEGMENTS = 7;
  const TOP = 3.4;
  const group = new THREE.Group();
  const material = glow(WHITE);
  const bolts = [];
  for (let i = 0; i < SEGMENTS; i += 1) {
    const bolt = new THREE.Mesh(GEO.bolt, material);
    group.add(bolt);
    bolts.push(bolt);
  }
  const flareMaterial = glow(WHITE, 0.8);
  const flare = new THREE.Mesh(GEO.thinRing, flareMaterial);
  flare.rotation.x = -Math.PI / 2;
  flare.position.y = 0.03;
  group.add(flare);

  // Lights live on the scene root, not in the rig: a light that appears and
  // disappears changes the light count and forces every shader to recompile.
  const spark = new THREE.PointLight(WHITE, 0, 6, 2);
  scene.add(spark);

  const path = [];
  for (let i = 0; i <= SEGMENTS; i += 1) path.push(new THREE.Vector3());

  return {
    group,
    arm(move, spot, tone) {
      group.position.set(spot.x, 0, spot.z);
      material.color.copy(tone).lerp(WHITE, 0.62);
      flareMaterial.color.copy(tone).lerp(WHITE, 0.4);
      spark.color.copy(tone).lerp(WHITE, 0.5);
      // A fresh zigzag per strike, so no two bolts are the same shape.
      for (let i = 0; i <= SEGMENTS; i += 1) {
        const k = i / SEGMENTS;
        const jitter = i === SEGMENTS ? 0 : (Math.random() - 0.5) * 0.34 * (1 - k * 0.4);
        path[i].set(jitter, TOP * (1 - k) + DESK_TOP * k, (Math.random() - 0.5) * 0.24 * (1 - k));
      }
      spark.position.set(spot.x, 1.4, spot.z);
    },
    update(life, t) {
      const p = 1 - life;
      const drawn = clamp(p / 0.3, 0, 1) * SEGMENTS;
      bolts.forEach((bolt, i) => {
        bolt.visible = i < drawn;
        if (bolt.visible) span(bolt, path[i], path[i + 1], 0.05 + (1 - i / SEGMENTS) * 0.03);
      });
      // Two hard flicker steps rather than a smooth fade: a strike is discrete.
      const flicker = Math.sin(t * 47) > -0.35 ? 1 : 0.35;
      // Bright while it strikes, then gone - a bolt must not linger as a pale
      // column standing on the desk.
      material.opacity = Math.pow(clamp((life - 0.3) / 0.7, 0, 1), 0.6) * flicker;
      flare.scale.setScalar(0.4 + p * 2.6);
      flareMaterial.opacity = life * life * 0.85;
      spark.intensity = life * life * 16;
    },
    park() {
      spark.intensity = 0;
    },
  };
}

// -------------------------------------------------------------------- arrow
// Fired from the tester's desk at whoever was just judged. Emerald with a hit
// ring on a pass; red, and it clatters on the floor, on a fail.

function makeArrow(scene, colours) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  const material = glow(colours.accent);
  const shaft = new THREE.Mesh(GEO.shaft, material);
  const head = new THREE.Mesh(GEO.head, material);
  head.rotation.x = Math.PI / 2;
  head.position.z = 0.28;
  body.add(shaft, head);
  group.add(body);

  const ringMaterial = glow(colours.accent, 0.9);
  const ring = new THREE.Mesh(GEO.thinRing, ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const here = new THREE.Vector3();
  let failed = false;

  return {
    group,
    arm(move, spot, tone, ctx) {
      group.position.set(0, 0, 0);
      material.color.copy(tone);
      ringMaterial.color.copy(tone);
      failed = move.tone === 'fail';
      const target = move.toAgentId ? ctx.spotOf(move.toAgentId) : null;
      from.set(spot.x, DESK_TOP + 0.28, spot.z + 0.15);
      // No target named: fire forward into the room and land short, so the
      // shot still reads as a shot and never points at an innocent desk.
      if (target) to.set(target.x, DESK_TOP + 0.1, target.z + 0.2);
      else to.set(spot.x, 0.08, spot.z + 2.1);
      ring.position.copy(to).setY(to.y + 0.06);
    },
    update(life, t) {
      const p = 1 - life;
      const flight = clamp(p / 0.68, 0, 1);
      const landed = p > 0.68;
      body.visible = !landed || failed;
      if (!landed) {
        here.lerpVectors(from, to, flight);
        here.y += Math.sin(flight * Math.PI) * 0.5;
        body.position.copy(here);
        // Point along the flight, arc included, by looking one step ahead.
        SCRATCH_A.lerpVectors(from, to, Math.min(flight + 0.06, 1));
        SCRATCH_A.y += Math.sin(Math.min(flight + 0.06, 1) * Math.PI) * 0.5;
        body.lookAt(SCRATCH_A);
        material.opacity = 1;
      } else if (failed) {
        // A clatter: down on the floor at the target, bouncing itself still.
        const q = (p - 0.68) / 0.32;
        body.position.set(to.x, 0.06 + Math.abs(Math.sin(q * 9)) * 0.09 * (1 - q), to.z);
        body.rotation.set(Math.PI / 2, t * 7 * (1 - q), 0.3);
        material.opacity = life * 3;
      }
      const hit = clamp((p - 0.62) / 0.38, 0, 1);
      ring.visible = hit > 0;
      ring.scale.setScalar(0.25 + ease(hit) * (failed ? 0.9 : 1.9));
      ringMaterial.opacity = (1 - hit) * (failed ? 0.5 : 0.95);
    },
    park() {},
  };
}

// ----------------------------------------------------------------- repulsor
// A diff landed. The ring pulses out from the desk top, and the bigger the
// diff the further it travels - the size of the change, made physical.

function makeRepulsor(scene, colours) {
  const group = new THREE.Group();
  const ringMaterial = glow(colours.accent, 0.9);
  const ring = new THREE.Mesh(GEO.ring, ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  const echo = new THREE.Mesh(GEO.thinRing, ringMaterial);
  echo.rotation.x = -Math.PI / 2;
  const coreMaterial = glow(WHITE, 1);
  const core = new THREE.Mesh(GEO.core, coreMaterial);
  group.add(ring, echo, core);

  let reach = 2;

  return {
    group,
    arm(move, spot, tone, ctx) {
      group.position.set(spot.x, DESK_TOP + 0.24, spot.z - 0.1);
      ringMaterial.color.copy(tone);
      coreMaterial.color.copy(tone).lerp(WHITE, 0.45);
      const agent = ctx.agentOf(move.agentId);
      reach = 1.4 + clamp((agent?.diffLines ?? 0) / 240, 0, 1) * 3.2;
    },
    update(life, t) {
      const p = 1 - life;
      ring.scale.setScalar(0.2 + ease(p) * reach);
      echo.scale.setScalar(0.2 + ease(clamp((p - 0.18) / 0.82, 0, 1)) * reach * 0.7);
      ringMaterial.opacity = life * life * 0.95;
      core.scale.setScalar(0.3 + life * 1.6);
      coreMaterial.opacity = life * life;
    },
    park() {},
  };
}

// ------------------------------------------------------------------- portal
// A finding. A ring of light turns open beside the desk and drops one shard
// out of it - the thing the auditor found, made of the same light.

function makePortal(scene, colours) {
  const group = new THREE.Group();
  const wheel = new THREE.Group();
  const ringMaterial = glow(colours.accent, 0.95);
  const wheelRing = new THREE.Mesh(GEO.torus, ringMaterial);
  const mouthMaterial = glow(colours.accent, 0.18);
  const mouth = new THREE.Mesh(GEO.disc, mouthMaterial);
  wheel.add(wheelRing, mouth);
  const shardMaterial = glow(WHITE, 1);
  const shard = new THREE.Mesh(GEO.shard, shardMaterial);
  group.add(wheel, shard);

  return {
    group,
    arm(move, spot, tone) {
      // Beside the desk, on the open side, facing the camera.
      group.position.set(spot.x + 0.98, 0.82, spot.z + 0.25);
      ringMaterial.color.copy(tone);
      mouthMaterial.color.copy(tone);
      shardMaterial.color.copy(tone).lerp(WHITE, 0.55);
    },
    update(life, t) {
      const p = 1 - life;
      const open = ease(clamp(p / 0.22, 0, 1));
      wheel.scale.setScalar(open);
      wheel.rotation.z = t * 0.9;
      const out = fade(p, 0.22, 0.7);
      ringMaterial.opacity = out * 0.95;
      mouthMaterial.opacity = out * 0.22;
      // The shard falls out of the mouth once the ring is open.
      const drop = clamp((p - 0.3) / 0.7, 0, 1);
      shard.visible = drop > 0;
      shard.position.set(0, -ease(drop) * 0.72, 0);
      shard.rotation.set(t * 2.1, t * 2.7, 0);
      shard.scale.setScalar(0.9 - drop * 0.25);
      shardMaterial.opacity = 1 - drop * drop;
    },
    park() {},
  };
}

// --------------------------------------------------------------------- beam
// A report is published. A soft cone sweeps the room from the desk and briefly
// lights whatever it crosses, so the room itself reports the publication.

function makeBeam(scene, colours) {
  const group = new THREE.Group();
  const material = glow(colours.accent, 0.08);
  const cone = new THREE.Mesh(GEO.cone, material);
  // The cone is authored apex-up; lay it down so the apex sits at the desk and
  // the mouth opens out into the room.
  cone.rotation.x = -Math.PI / 2;
  cone.position.z = 1.75;
  group.add(cone);

  const lamp = new THREE.SpotLight(colours.accent, 0, 8, 0.38, 0.75, 1.6);
  const aim = new THREE.Object3D();
  lamp.target = aim;
  scene.add(lamp, aim);

  const origin = new THREE.Vector3();

  return {
    group,
    arm(move, spot, tone) {
      group.position.set(spot.x, DESK_TOP + 0.24, spot.z + 0.1);
      origin.copy(group.position);
      material.color.copy(tone);
      lamp.color.copy(tone).lerp(WHITE, 0.35);
      lamp.position.copy(origin);
    },
    update(life, t) {
      const p = 1 - life;
      const sweep = (p - 0.5) * 1.5; // radians, left to right across the room
      group.rotation.y = sweep;
      const envelope = fade(p, 0.15, 0.72);
      material.opacity = envelope * 0.085;
      lamp.intensity = envelope * 5;
      aim.position.set(origin.x + Math.sin(sweep) * 3, 0.35, origin.z + Math.cos(sweep) * 3);
    },
    park() {
      lamp.intensity = 0;
    },
  };
}

// ------------------------------------------------------------------- shield
// A plan is accepted. The disc spins up over the desk and slams flat onto it:
// the contract, put on the table.

function makeShield(scene, colours) {
  const group = new THREE.Group();
  const material = glow(colours.accent, 0.5);
  const plate = new THREE.Mesh(GEO.plate, material);
  const rimMaterial = glow(colours.accent, 1);
  const rim = new THREE.Mesh(GEO.rim, rimMaterial);
  rim.rotation.x = -Math.PI / 2;
  const shockMaterial = glow(WHITE, 0.9);
  const shock = new THREE.Mesh(GEO.thinRing, shockMaterial);
  shock.rotation.x = -Math.PI / 2;
  group.add(plate, rim, shock);

  const TOP = 1.5;
  const REST = DESK_TOP + 0.06;

  return {
    group,
    arm(move, spot, tone) {
      group.position.set(spot.x, 0, spot.z - 0.05);
      material.color.copy(tone);
      rimMaterial.color.copy(tone);
      shockMaterial.color.copy(tone).lerp(WHITE, 0.6);
    },
    update(life, t) {
      const p = 1 - life;
      // Spin up in the air, then one hard drop, then the impact ring.
      const dropping = clamp((p - 0.5) / 0.22, 0, 1);
      const y = TOP - (TOP - REST) * ease(dropping);
      plate.position.y = y;
      rim.position.y = y;
      const spin = p < 0.5 ? p * 34 : 17 - (dropping * dropping) * 3;
      plate.rotation.y = spin;
      rim.rotation.z = spin;
      material.opacity = (0.25 + clamp(p * 2, 0, 1) * 0.35) * clamp(life * 2.4, 0, 1);
      rimMaterial.opacity = clamp(life * 2.4, 0, 1);
      const hit = clamp((p - 0.72) / 0.28, 0, 1);
      shock.visible = hit > 0;
      shock.position.y = REST - 0.02;
      shock.scale.setScalar(0.3 + ease(hit) * 2.4);
      shockMaterial.opacity = (1 - hit) * 0.9;
    },
    park() {},
  };
}

// -------------------------------------------------------------------- smash
// A verdict landed. Two weights fall onto the desk, the impact throws a flat
// shockwave across the floor and kicks up dust, and the whole rig takes the
// recoil. Fast in, slow settle - it has to read as weight, not as a flash.
//
// A pass and a fail must be told apart at a glance, so tone is not the only
// difference: a pass throws one clean wide wave and the dust lifts, a fail
// throws a short stuttering wave and the dust is flung out low and drops.

function makeSmash(scene, colours) {
  const FISTS = 2;
  const MOTES = 7;
  const TOP = 2.0;
  const REST = DESK_TOP + 0.13;
  const IMPACT = 0.24; // when the weights touch down, as a fraction of the move

  const group = new THREE.Group();

  const fistMaterial = glow(colours.accent, 1);
  const drop = new THREE.Group();
  for (let i = 0; i < FISTS; i += 1) {
    const fist = new THREE.Mesh(GEO.fist, fistMaterial);
    fist.position.x = (i - (FISTS - 1) / 2) * 0.44;
    drop.add(fist);
  }
  group.add(drop);

  const shockMaterial = glow(WHITE, 0.95);
  // The thin ring, not the wide one: scaled out to a 3m wave, a wide band goes
  // soft and reads as fog on a lit floor.
  const shock = new THREE.Mesh(GEO.thinRing, shockMaterial);
  shock.rotation.x = -Math.PI / 2;
  shock.position.y = 0.05;
  const echoMaterial = glow(colours.accent, 0.8);
  const echo = new THREE.Mesh(GEO.thinRing, echoMaterial);
  echo.rotation.x = -Math.PI / 2;
  echo.position.y = 0.035;
  const flashMaterial = glow(WHITE, 1);
  const flash = new THREE.Mesh(GEO.disc, flashMaterial);
  flash.rotation.x = -Math.PI / 2;
  flash.position.y = REST - 0.055;
  group.add(shock, echo, flash);

  const dustMaterial = glow(WHITE, 0.75);
  const motes = [];
  const spread = [];
  for (let i = 0; i < MOTES; i += 1) {
    const mote = new THREE.Mesh(GEO.core, dustMaterial);
    group.add(mote);
    motes.push(mote);
    spread.push(new THREE.Vector2());
  }

  let failed = false;

  return {
    group,
    arm(move, spot, tone) {
      // The near edge of the desk: the weights land on clear surface, not
      // through the screen the agent is working on.
      group.position.set(spot.x, 0, spot.z + 0.04);
      failed = move.tone === 'fail';
      fistMaterial.color.copy(tone).lerp(WHITE, 0.12);
      shockMaterial.color.copy(tone).lerp(WHITE, 0.1);
      echoMaterial.color.copy(tone);
      flashMaterial.color.copy(tone).lerp(WHITE, 0.35);
      dustMaterial.color.copy(tone).lerp(WHITE, 0.25);
      // A fresh scatter per hit, so no two impacts throw the same dust.
      for (let i = 0; i < MOTES; i += 1) {
        const angle = (i / MOTES) * Math.PI * 2 + Math.random() * 0.7;
        spread[i].set(Math.cos(angle), Math.sin(angle)).multiplyScalar(0.55 + Math.random() * 0.45);
      }
    },
    update(life, t) {
      const p = 1 - life;
      // Down fast (squared, so it accelerates), then a damped settle.
      const fall = clamp(p / IMPACT, 0, 1);
      const q = clamp((p - IMPACT) / (1 - IMPACT), 0, 1);
      const settle = Math.sin(q * 22) * Math.exp(-q * 9) * (failed ? 0.11 : 0.055);
      drop.position.y = p < IMPACT ? TOP - (TOP - REST) * fall * fall : REST + settle;
      // Additive on a closed box draws both faces, so half opacity is full weight.
      fistMaterial.opacity = clamp(life * 2.6, 0, 1) * 0.62;

      // The recoil, taken by the rig rather than the camera: a short squash and
      // spread that dies out inside the first fifth of the settle.
      const jolt = Math.sin(q * 19) * Math.exp(-q * 8) * 0.07;
      group.scale.set(1 + jolt, 1 - jolt * 0.85, 1 + jolt);

      const reach = failed ? 1.9 : 3.4;
      // A fail stutters: the wave pulses instead of sweeping out clean.
      const stutter = failed ? 0.6 + 0.4 * Math.abs(Math.sin(q * 16)) : 1;
      shock.visible = q > 0;
      shock.scale.setScalar(0.25 + ease(q) * reach);
      shockMaterial.opacity = (1 - q) * (1 - q) * 1.1 * stutter;
      const trail = clamp((q - 0.16) / 0.84, 0, 1);
      echo.visible = trail > 0;
      echo.scale.setScalar(0.25 + ease(trail) * reach * 0.62);
      echoMaterial.opacity = (1 - trail) * (1 - trail) * 0.8 * stutter;

      // Short and bright: a lingering faint disc reads as a stain on the desk.
      flash.visible = q > 0 && q < 0.2;
      flash.scale.setScalar(0.45 + q * 1.4);
      flashMaterial.opacity = clamp(1 - q / 0.18, 0, 1) * 0.45;

      const push = ease(q) * (failed ? 1.6 : 1.0);
      for (let i = 0; i < MOTES; i += 1) {
        const mote = motes[i];
        mote.visible = q > 0;
        // A pass lifts its dust; a fail throws debris out low and lets it fall.
        const height = failed
          ? 0.07 + Math.sin(q * Math.PI) * 0.26
          : 0.12 + ease(q) * 0.85;
        mote.position.set(spread[i].x * push, height, spread[i].y * push);
        mote.scale.setScalar((failed ? 0.4 : 0.5) * (1 - q * 0.45));
      }
      dustMaterial.opacity = (1 - q) * (1 - q) * (failed ? 0.6 : 0.75);
    },
    park() {
      group.scale.set(1, 1, 1);
    },
  };
}

// ---------------------------------------------------------------------- hex
// A plan is accepted. Three bands turn slowly around the agent on different
// axes while motes drift in from the room, and then the whole thing folds to a
// point. The calmest move on the floor: it builds, holds, and settles - it
// never strikes anything.

function makeHex(scene, colours) {
  const MOTES = 9;
  const group = new THREE.Group();
  const halo = new THREE.Group(); // everything that collapses to the centre
  group.add(halo);

  const bandMaterial = glow(colours.accent, 0.9);
  // Each band lives in its own holder: the holder precesses about Y, the band
  // itself is fixed at a tilt, so a symmetric torus still reads as turning.
  const BANDS = [
    { tilt: -Math.PI / 2 + 0.3, size: 0.88, speed: 0.5 },
    { tilt: -0.55, size: 0.7, speed: -0.62 },
    { tilt: 1.15, size: 0.52, speed: 0.4 },
  ];
  const holders = BANDS.map((spec) => {
    const holder = new THREE.Group();
    const band = new THREE.Mesh(GEO.band, bandMaterial);
    band.rotation.x = spec.tilt;
    band.scale.setScalar(spec.size);
    holder.add(band);
    halo.add(holder);
    return holder;
  });

  const moteMaterial = glow(WHITE, 0.85);
  const motes = [];
  const phase = [];
  const level = [];
  for (let i = 0; i < MOTES; i += 1) {
    const mote = new THREE.Mesh(GEO.shard, moteMaterial);
    halo.add(mote);
    motes.push(mote);
    phase.push(0);
    level.push(0);
  }

  const coreMaterial = glow(WHITE, 0);
  const core = new THREE.Mesh(GEO.core, coreMaterial);
  group.add(core);

  return {
    group,
    arm(move, spot, tone) {
      // Centred on the seat, not the desk: the band belongs to the agent.
      group.position.set(spot.x, 0.55, spot.z + SEAT_Z);
      bandMaterial.color.copy(tone);
      moteMaterial.color.copy(tone).lerp(WHITE, 0.35);
      coreMaterial.color.copy(tone).lerp(WHITE, 0.7);
      for (let i = 0; i < MOTES; i += 1) {
        phase[i] = (i / MOTES) * Math.PI * 2 + Math.random() * 0.5;
        level[i] = (Math.random() - 0.5) * 0.9;
      }
    },
    update(life, t) {
      const p = 1 - life;
      const build = ease(clamp(p / 0.28, 0, 1));
      const collapse = ease(clamp((p - 0.78) / 0.22, 0, 1));
      halo.scale.setScalar(Math.max(build * (1 - collapse * 0.96), 0.0001));

      for (let i = 0; i < holders.length; i += 1) {
        holders[i].rotation.y = t * BANDS[i].speed;
      }
      // Two torus faces add up under additive blending: half opacity, full colour.
      bandMaterial.opacity = build * (1 - collapse * collapse) * 0.5;

      // The motes come in from the room and are gathered before the fold.
      const draw = ease(clamp((p - 0.1) / 0.62, 0, 1));
      const radius = 1.6 - draw * 1.02;
      for (let i = 0; i < MOTES; i += 1) {
        const angle = phase[i] + t * 0.45;
        motes[i].position.set(
          Math.cos(angle) * radius,
          level[i] * (1 - draw * 0.65),
          Math.sin(angle) * radius,
        );
        motes[i].rotation.set(t * 0.8, t * 1.1, 0);
        motes[i].scale.setScalar(0.34 * (1 - draw * 0.35));
      }
      moteMaterial.opacity = fade(p, 0.2, 0.72) * 0.85;

      // One quiet bloom as it settles, then nothing left behind.
      core.scale.setScalar(0.35 + collapse * 0.55);
      coreMaterial.opacity = clamp(collapse * (1 - collapse) * 3.2, 0, 1);
    },
    park() {},
  };
}

// ------------------------------------------------------------ still marker
// prefers-reduced-motion: one marker, held for exactly as long as the move
// would have run. The event is still reported; only the animation is gone.

function makeMarker(scene, colours) {
  const group = new THREE.Group();
  const material = glow(colours.accent, 0.95);
  const pip = new THREE.Mesh(GEO.shard, material);
  pip.scale.setScalar(1.6);
  const halo = new THREE.Mesh(GEO.thinRing, material);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -0.6;
  group.add(pip, halo);
  return {
    group,
    arm(move, spot, tone) {
      group.position.set(spot.x, 1.15, spot.z);
      material.color.copy(tone);
    },
    update() {
      material.opacity = 0.95;
    },
    park() {},
  };
}

const BUILDERS = Object.freeze({
  lightning: makeLightning,
  arrow: makeArrow,
  repulsor: makeRepulsor,
  portal: makePortal,
  beam: makeBeam,
  shield: makeShield,
  smash: makeSmash,
  hex: makeHex,
});

// --------------------------------------------------------------- the stage

// `ctx` is how the stage asks the room a question it must not answer itself:
//   spotOf(id)  -> { x, z } floor position of that desk, or null
//   agentOf(id) -> the view-model agent, for magnitude (diff size)
//   colourOf(id)-> that agent's identity colour, for a neutral move
export function createMoves(scene, colours) {
  const pools = new Map();
  const marker = { rigs: [], busy: new Map() };
  for (const kind of MOVE_KINDS) {
    const rigs = [];
    for (let i = 0; i < POOL[kind]; i += 1) {
      const rig = BUILDERS[kind](scene, colours);
      rig.group.visible = false;
      scene.add(rig.group);
      rigs.push(rig);
    }
    pools.set(kind, { rigs, busy: new Map() });
  }
  // Every agent can be mid-move at once, so reduced motion never runs short of
  // markers and silently drops an event.
  for (let i = 0; i < MARKERS; i += 1) {
    const rig = makeMarker(scene, colours);
    rig.group.visible = false;
    scene.add(rig.group);
    marker.rigs.push(rig);
  }

  const tint = new THREE.Color();
  const live = new Set();

  const toneOf = (move, ctx) => {
    if (move.tone === 'ok') return tint.copy(colours.accent);
    if (move.tone === 'fail') return tint.copy(colours.danger);
    return tint.copy(ctx.colourOf(move.agentId) ?? colours.accent);
  };

  const release = (pool) => {
    for (const [key, rig] of pool.busy) {
      if (live.has(key)) continue;
      rig.group.visible = false;
      rig.park();
      pool.busy.delete(key);
    }
  };

  return {
    update(moves, ctx, t, reduced) {
      live.clear();
      // Only a move whose desk still exists counts as live: an agent that
      // leaves the roster mid-move must not strand a lit rig in the room.
      for (const move of moves ?? []) {
        if (ctx.spotOf(move.agentId)) live.add(`${move.agentId}:${move.born}`);
      }
      for (const pool of pools.values()) release(pool);
      release(marker);

      for (const move of moves ?? []) {
        const spot = ctx.spotOf(move.agentId);
        if (!spot) continue;
        const pool = reduced ? marker : pools.get(move.move) ?? pools.get('repulsor');
        const key = `${move.agentId}:${move.born}`;
        let rig = pool.busy.get(key);
        if (!rig) {
          rig = pool.rigs.find((candidate) => !candidate.group.visible);
          if (!rig) continue; // more moves than rigs: the room drops the extra
          rig.group.visible = true;
          rig.arm(move, spot, toneOf(move, ctx), ctx);
          pool.busy.set(key, rig);
        }
        rig.update(clamp(move.life, 0, 1), t);
      }
    },
    dispose() {
      for (const material of owned) material.dispose();
      for (const geometry of Object.values(GEO)) geometry.dispose();
    },
  };
}
