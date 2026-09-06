// Where everything stands, in world units. Pure data and pure arithmetic: no
// three.js, no DOM. One source of truth for the floor plan, so the room, the
// camera, the picking proxies and deskSpot() cannot drift apart.

export const SLOTS = 5; // worker desks

export const ROOM = Object.freeze({
  minX: -4.6,
  maxX: 4.6,
  minZ: -4.0,
  maxZ: 3.6,
  wallHeight: 1.29, // one Kenney wall tile
});

const DESK_SPACING = 1.62;
const WORKER_Z = -1.7;
const ARC = 0.3; // outer desks step forward, so the row reads as an arc
const ORCHESTRATOR_Z = 2.0;

// Kenney's mini characters are ~0.67 units tall; the plate floats just clear.
export const HEAD_HEIGHT = 0.62;

export function seatOf(agent) {
  if (agent.isOrchestrator) return { x: 0, z: ORCHESTRATOR_Z };
  const index = clamp(agent.index ?? 0, 0, SLOTS - 1);
  const centred = index - (SLOTS - 1) / 2;
  return { x: centred * DESK_SPACING, z: WORKER_Z + Math.abs(centred) * ARC };
}

// The set dressing. Positions are world units; `yaw` is radians about Y.
export const PROPS = Object.freeze([
  // A big floor rug under the working row, so the middle of the room is a
  // furnished space rather than bare ground.
  { model: 'rugRectangle', x: 0, z: -0.9, yaw: 0, scale: 3.4 },
  { model: 'rugRectangle', x: 0, z: 2.1, yaw: 0, scale: 1.5 },
  { model: 'rugRound', x: -3.3, z: 1.4, yaw: 0, scale: 1.3 },

  { model: 'loungeSofa', x: -3.6, z: 0.7, yaw: Math.PI * 0.12 },
  { model: 'loungeChair', x: -2.5, z: 1.9, yaw: -Math.PI * 0.75 },
  { model: 'tableCoffee', x: -3.2, z: 1.5, yaw: 0 },
  { model: 'books', x: -3.2, z: 1.45, y: 0.23, yaw: 0.4 },

  { model: 'bookcaseOpen', x: -3.9, z: -3.7, yaw: 0 },
  { model: 'bookcaseOpen', x: -3.2, z: -3.7, yaw: 0 },
  { model: 'bookcaseClosedWide', x: 3.3, z: -3.7, yaw: 0 },

  { model: 'kitchenCabinet', x: 4.0, z: -0.4, yaw: -Math.PI / 2 },
  { model: 'kitchenCoffeeMachine', x: 4.0, z: -0.4, y: 0.42, yaw: -Math.PI / 2 },
  { model: 'stoolBar', x: 3.3, z: 0.3, yaw: 0 },

  { model: 'pottedPlant', x: -4.2, z: -0.4, yaw: 0.5 },
  { model: 'pottedPlant', x: 4.2, z: 2.4, yaw: -0.4 },
  { model: 'plantSmall1', x: -1.0, z: 2.6, yaw: 0 },
  { model: 'plantSmall2', x: 1.0, z: 2.6, yaw: 0 },
  { model: 'plantSmall3', x: 4.1, z: -2.6, yaw: 0 },

  { model: 'lampSquareFloor', x: -4.2, z: 1.0, yaw: 0, light: 'warm' },
  { model: 'lampSquareFloor', x: 4.2, z: -3.4, yaw: 0, light: 'warm' },
  { model: 'trashcan', x: 2.6, z: 3.0, yaw: 0.3, scale: 0.7 },

  // A second soft corner, so the right of the room is furnished too.
  { model: 'rugRound', x: 3.6, z: 1.2, yaw: 0, scale: 1.2 },
  { model: 'loungeChair', x: 4.1, z: 0.8, yaw: -Math.PI * 0.6 },
  { model: 'loungeChair', x: 3.2, z: 1.8, yaw: Math.PI * 0.3 },
  { model: 'tableCoffee', x: 3.7, z: 1.3, yaw: 0.2 },
  { model: 'lampSquareFloor', x: 4.3, z: 2.1, yaw: 0, light: 'warm' },
  { model: 'pottedPlant', x: -4.2, z: 2.4, yaw: 0.2 },
  { model: 'plantSmall3', x: -2.0, z: 3.0, yaw: 0 },
  { model: 'cardboardBoxClosed', x: -4.2, z: -3.2, yaw: 0.2 },
]);

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
