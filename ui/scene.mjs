// The floor: an isometric studio of working agents, rebuilt from the view
// model every frame. Motion is the information channel, not decoration -
// posture is the derived pose, screen brightness is the event rate, the paper
// stack is the diff, an emerald ring is a verified step, a courier crossing the
// floor is a ping, and a signature move (ui/moves.mjs) is that agent doing the
// one thing it is for. Nothing here holds UI truth of its own.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/+esm';
import { ROOM, PROPS, seatOf, HEAD_HEIGHT, clamp } from './layout.mjs';
import { loadModels, instance } from './models.mjs';
import { createWorkstation } from './workstation.mjs';
import { createMoves } from './moves.mjs';

const VIEW_HEIGHT = 6.2;  // world units visible top to bottom at a wide aspect
const VIEW_WIDTH = 11.0;  // world units the desk row needs end to end
// Close to front-on, so every face reads. Enough offset to keep it isometric.
const CAMERA_DIR = new THREE.Vector3(3.2, 6.4, 9.6).normalize();
const POOL = 8;

// Desk anchors, in floor coordinates. main.mjs hands these straight back as
// pulse and ping endpoints, so both sides read the same plan.
export function deskSpot(agent) {
  const seat = seatOf(agent);
  return { x: seat.x, y: seat.z };
}

export function createScene({ canvas, palette, onSelect }) {
  const colours = readPalette(palette);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.32;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(colours.void);
  scene.fog = new THREE.Fog(colours.void, 14, 26);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const target = new THREE.Vector3(0.15, 0.5, 0.15);
  camera.position.copy(CAMERA_DIR).multiplyScalar(18).add(target);
  camera.lookAt(target);

  addLights(scene, colours);

  const signals = createSignals(scene, colours);
  const moves = createMoves(scene, colours);
  const stations = new Map();
  const room = new THREE.Group();
  scene.add(room);

  let models = null;
  let failure = null;
  let view = { agents: [], pulses: [], pings: [], moves: [] };

  // What a signature move is allowed to ask about the room. One reused map, so
  // a busy floor still costs nothing per frame.
  const byId = new Map();
  const stage = {
    // Floor coordinates, in the room's own axes - deskSpot() flattens z to y
    // for main.mjs, and a move is placed in the actual 3D room.
    spotOf: (id) => {
      const agent = byId.get(id);
      return agent ? seatOf(agent) : null;
    },
    agentOf: (id) => byId.get(id) ?? null,
    colourOf: (id) => stations.get(id)?.parts.badge ?? null,
  };

  loadModels()
    .then((loaded) => {
      models = loaded;
      buildRoom(room, models, colours);
    })
    .catch((error) => {
      failure = error;
      console.error('[floor] models failed to load', error);
    });

  // ------------------------------------------------------------------ size

  const resize = () => {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    const aspect = width / height;
    // Fit the whole crew however narrow the canvas gets: when the panel takes
    // half the screen the camera pulls back rather than cropping Vision and
    // Wanda off the right-hand edge.
    const viewHeight = Math.max(VIEW_HEIGHT, VIEW_WIDTH / aspect);
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.left = (-viewHeight * aspect) / 2;
    camera.right = (viewHeight * aspect) / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  // ----------------------------------------------------------------- input

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const targets = [...stations.values()].map((station) => station.parts.pick);
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (hit) onSelect(hit.object.userData.agentId);
  });

  // ------------------------------------------------------------------ loop

  const clock = new THREE.Clock();
  const frame = () => {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = reduced ? 0 : clock.elapsedTime;
    if (models) syncStations(t, dt);
    signals.update(view, t, reduced);
    byId.clear();
    for (const agent of view.agents) byId.set(agent.id, agent);
    moves.update(view.moves, stage, t, reduced);
    renderer.render(scene, camera);
  };
  requestAnimationFrame(frame);

  function syncStations(t, dt) {
    const live = new Set();
    for (const agent of view.agents) {
      live.add(agent.id);
      let station = stations.get(agent.id);
      if (!station) {
        station = createWorkstation({ models, agent, palette: colours });
        station.plate = createPlate(colours);
        station.group.add(station.plate.sprite);
        scene.add(station.group);
        stations.set(agent.id, station);
      }
      const seat = seatOf(agent);
      station.group.position.set(seat.x, 0, seat.z);
      station.update(agent, t, dt, reduced);
      station.plate.set(agent);
      station.plate.sprite.position.set(0, HEAD_HEIGHT + 0.66, 0.15);
    }
    for (const [id, station] of stations) {
      if (live.has(id)) continue;
      scene.remove(station.group);
      stations.delete(id);
    }
  }

  // -------------------------------------------------------------- contract

  return {
    render(next) {
      view = next;
    },
    // Where to hang floating HTML for an agent: the point just above their
    // head, projected into CSS pixels on the canvas.
    screenPos(agentId) {
      const station = stations.get(agentId);
      if (!station) return null;
      const point = station.parts.head.getWorldPosition(new THREE.Vector3());
      point.y += 0.45;
      point.project(camera);
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((point.x + 1) / 2) * rect.width,
        y: ((1 - point.y) / 2) * rect.height,
      };
    },
    get error() {
      return failure;
    },
  };
}

// ------------------------------------------------------------------ lights

function addLights(scene, colours) {
  // Cool dark ambient over the whole room; everything warm is a real lamp.
  scene.add(new THREE.HemisphereLight(colours.sky, colours.ground, 0.95));

  const key = new THREE.DirectionalLight(colours.key, 1.25);
  key.position.set(-5, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.02;
  const box = key.shadow.camera;
  box.left = -7;
  box.right = 7;
  box.top = 7;
  box.bottom = -7;
  box.near = 0.5;
  box.far = 26;
  box.updateProjectionMatrix();
  scene.add(key);

  const fill = new THREE.DirectionalLight(colours.fill, 0.45);
  fill.position.set(6, 4, -6);
  scene.add(fill);
}

// -------------------------------------------------------------------- room

function buildRoom(room, models, colours) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshStandardMaterial({ color: colours.floor, roughness: 0.92, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  room.add(floor);

  // Only the two walls the camera can see are built - the classic cutaway, so
  // nothing stands between you and the floor.
  for (let x = ROOM.minX; x < ROOM.maxX; x += 1) {
    const windowed = x > -1.6 && x < 1.6;
    const panel = instance(models, windowed ? 'wallWindow' : 'wall');
    panel.position.set(x + 0.5, 0, ROOM.minZ);
    room.add(panel);
  }
  for (let z = ROOM.minZ; z < ROOM.maxZ; z += 1) {
    const panel = instance(models, 'wall');
    panel.position.set(ROOM.minX, 0, z + 0.5);
    panel.rotation.y = Math.PI / 2;
    room.add(panel);
  }

  for (const prop of PROPS) {
    const object = instance(models, prop.model);
    object.position.set(prop.x, prop.y ?? 0, prop.z);
    object.rotation.y = prop.yaw ?? 0;
    if (prop.scale) object.scale.setScalar(prop.scale);
    room.add(object);
    if (prop.light === 'warm') {
      const lamp = new THREE.PointLight(colours.lamp, 1.4, 4, 2);
      lamp.position.set(prop.x, 0.85, prop.z);
      room.add(lamp);
    }
  }
}

// ----------------------------------------------------------------- signals

// A verified step opens an emerald ring at the desk that earned it. A ping is
// a courier that actually crosses the floor, so you can see who talks to whom.
function createSignals(scene, colours) {
  const rings = [];
  const couriers = [];

  for (let i = 0; i < POOL; i += 1) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.38, 48),
      new THREE.MeshBasicMaterial({
        color: colours.accent,
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    scene.add(ring);
    rings.push(ring);

    const courier = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.14, 0.14),
      new THREE.MeshBasicMaterial({ color: colours.accent, toneMapped: false }),
    );
    const halo = new THREE.PointLight(colours.accent, 1.2, 1.6, 2);
    courier.add(body, halo);
    courier.visible = false;
    scene.add(courier);
    couriers.push({ group: courier, body });
  }

  return {
    update(live, t, reducedMotion) {
      rings.forEach((ring, i) => {
        const pulse = live.pulses[i];
        ring.visible = Boolean(pulse);
        if (!pulse) return;
        const life = clamp(pulse.life, 0, 1);
        ring.position.set(pulse.x, 0.02, pulse.y + 0.2);
        ring.scale.setScalar(reducedMotion ? 2 : 1 + (1 - life) * 3.2);
        ring.material.opacity = life * 0.85;
      });

      couriers.forEach((courier, i) => {
        const ping = live.pings[i];
        courier.group.visible = Boolean(ping);
        if (!ping) return;
        const p = clamp(1 - ping.life, 0, 1);
        courier.group.position.set(
          ping.from.x + (ping.to.x - ping.from.x) * p,
          0.28 + Math.sin(p * Math.PI) * 0.5,
          ping.from.y + (ping.to.y - ping.from.y) * p,
        );
        courier.body.rotation.set(t * 2.4, t * 3.1, 0);
      });
    },
  };
}

// -------------------------------------------------------------- nameplates

// Crisp type in a 3D room: draw it once into a canvas and hang it as a sprite.
// The plate shows the agent's label - persona plus the seat it is sitting in -
// so nobody has to remember which persona is the tester.
const PLATE = Object.freeze({
  width: 640,
  height: 160,
  worldWidth: 1.5, // desks are 1.62 apart, so a full plate still clears its neighbour
  margin: 20,
  nameSize: 46,
  minNameSize: 26,
  loopSize: 34,
});

function createPlate(colours) {
  const canvas = document.createElement('canvas');
  canvas.width = PLATE.width;
  canvas.height = PLATE.height;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false }),
  );
  const aspect = PLATE.height / PLATE.width;
  sprite.scale.set(PLATE.worldWidth, PLATE.worldWidth * aspect, 1);
  sprite.renderOrder = 10;

  let signature = '';
  const set = (agent) => {
    const text = agent.label ?? agent.name;
    const next = `${text}|${agent.selected}|${agent.loopCount}`;
    if (next === signature) return;
    signature = next;
    ctx.clearRect(0, 0, PLATE.width, PLATE.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = agent.selected ? colours.accentHex : colours.mutedHex;
    ctx.font = fit(ctx, text, PLATE.nameSize);
    ctx.fillText(text, PLATE.width / 2, 56);
    if (agent.loopCount > 0) {
      ctx.font = plateFont(PLATE.loopSize);
      ctx.fillStyle = colours.dangerHex;
      ctx.fillText(`LOOP x${agent.loopCount}`, PLATE.width / 2, 118);
    }
    texture.needsUpdate = true;
  };

  return { sprite, set };
}

const plateFont = (size) => `600 ${size}px Menlo, "SF Mono", ui-monospace, monospace`;

// A long label shrinks to fit rather than running into the desk next door.
function fit(ctx, text, size) {
  const room = PLATE.width - PLATE.margin * 2;
  let chosen = size;
  while (chosen > PLATE.minNameSize) {
    ctx.font = plateFont(chosen);
    if (ctx.measureText(text).width <= room) break;
    chosen -= 2;
  }
  return plateFont(chosen);
}

// ------------------------------------------------------------------ colour

function readPalette(palette) {
  const accentHex = palette?.accent ?? '#34d399';
  const dangerHex = palette?.danger ?? '#f87171';
  const mutedHex = palette?.muted ?? '#8a8a8a';
  return {
    accent: new THREE.Color(accentHex),
    danger: new THREE.Color(dangerHex),
    accentHex,
    dangerHex,
    mutedHex,
    // Monitor light is cold and colourless; emerald is reserved for the one
    // agent you have selected and for a verified step.
    screen: new THREE.Color('#b6d3e2'),
    lamp: new THREE.Color('#ffb265'),
    paper: new THREE.Color('#e6e4dc'),
    floor: new THREE.Color('#232928'),
    void: new THREE.Color('#090c0b'),
    sky: new THREE.Color('#3e5b66'),
    ground: new THREE.Color('#100f0d'),
    key: new THREE.Color('#cfe2f2'),
    fill: new THREE.Color('#5d7f8c'),
  };
}
