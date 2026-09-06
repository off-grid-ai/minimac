// Who is who, at a glance. One table: role -> mesh, identity colour and the
// props that make that desk unmistakable from across the room. Data, not code,
// so a role's look is one row and nothing else in the scene knows about roles.
//
// Reserved colours, never used as an identity:
//   emerald #34D399  - selection, and a verified step
//   red     #F87171  - genuine failure only
// CODER's warm orange sits well clear of the failure red on purpose.
//
// Prop coordinates are workstation-local: the desk is at the origin, the
// person sits at z = -0.66, and the camera looks in from +Z.

const ARCHETYPES = {
  // The director. Assembles and routes; does none of the work himself.
  // Dark, matte, and the sparsest desk in the room.
  orchestrator: {
    mesh: 'character-male-d',
    colour: '#59636b',
    tint: 0.22,
    lampMix: 0.15,
    props: [
      { model: 'stoolBar', x: -1.15, z: 0.15, yaw: 0.5 },
      { model: 'stoolBar', x: 1.15, z: 0.15, yaw: -0.5 },
    ],
  },

  // Decides what is worth doing. Blue and white, with a wide board behind him.
  product: {
    mesh: 'character-female-a',
    colour: '#5b8ad6',
    tint: 0.3,
    lampMix: 0.35,
    props: [
      { model: 'televisionModern', x: 0, z: -1.5, yaw: 0, scale: 1.25 },
      { model: 'books', x: 0.42, y: 0.38, z: -0.1, yaw: 0.3 },
    ],
  },

  // The builder in the workshop. Warm orange and gold, and by far the busiest
  // desk: a second screen, a spare machine, clutter on the floor.
  coder: {
    mesh: 'character-male-a',
    colour: '#cf7a2c',
    tint: 0.34,
    lampMix: 0.5,
    props: [
      { model: 'computerScreen', x: 0.42, y: 0.38, z: -0.12, yaw: Math.PI * 0.82 },
      { model: 'laptop', x: -0.42, y: 0.38, z: -0.18, yaw: Math.PI * 1.1 },
      { model: 'speakerSmall', x: 0.62, y: 0.38, z: 0.1, yaw: 0.2 },
      { model: 'cardboardBoxClosed', x: -1.0, z: 0.35, yaw: 0.4 },
      { model: 'books', x: -0.72, y: 0.38, z: 0.05, yaw: -0.4 },
    ],
  },

  // Proof by hitting the target: exit codes, not opinions. The tidiest desk in
  // the room, with a single board to read results off.
  tester: {
    mesh: 'character-female-b',
    colour: '#7d5cb8',
    tint: 0.3,
    lampMix: 0.3,
    props: [{ model: 'televisionModern', x: 0, z: -1.5, yaw: 0, scale: 0.8 }],
  },

  // Examines every branch and finds the one flaw. Teal and old gold, a tall
  // bookcase at the elbow, and a lamp that is never off.
  auditor: {
    mesh: 'character-male-c',
    colour: '#2e7d8c',
    tint: 0.32,
    lampMix: 0.4,
    lampFloor: 2.2, // the light that stays on
    props: [
      { model: 'bookcaseOpen', x: -1.05, z: -0.95, yaw: 0.35 },
      { model: 'books', x: 0.4, y: 0.38, z: -0.05, yaw: 0.6 },
    ],
  },

  // Perception itself. Warm amber, the most plants, the softest light.
  ux: {
    mesh: 'character-female-c',
    colour: '#d99a3f',
    tint: 0.36,
    lampMix: 0.6,
    props: [
      { model: 'bathroomMirror', x: 0, z: -1.45, yaw: 0 },
      { model: 'pottedPlant', x: -1.0, z: -0.55, yaw: 0.4 },
      { model: 'plantSmall1', x: 0.95, z: -0.5, yaw: -0.3 },
      { model: 'plantSmall2', x: 0.62, y: 0.38, z: 0.08, yaw: 0.2 },
    ],
  },
};

const FALLBACK_ORDER = ['coder', 'tester', 'auditor', 'ux', 'product', 'orchestrator'];

// Stable across restarts: the role decides, and an unknown role falls back to a
// hash of the id - never to load order.
export function identityOf(agent) {
  return (
    ARCHETYPES[agent.role] ??
    ARCHETYPES[FALLBACK_ORDER[hashId(agent.id) % FALLBACK_ORDER.length]]
  );
}

export function identityModels() {
  const names = new Set();
  for (const archetype of Object.values(ARCHETYPES)) {
    names.add(archetype.mesh);
    for (const prop of archetype.props) names.add(prop.model);
  }
  return [...names];
}

export function hashId(value) {
  const str = String(value);
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
