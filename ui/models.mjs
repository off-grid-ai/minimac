// The only place that fetches geometry. Everything above it asks for a model
// by name and gets a fresh instance back, already centred, shadowed and ready
// to place. Kenney CC0 kits, loaded once and cloned per instance.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/+esm';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/loaders/GLTFLoader.js/+esm';
import { clone as cloneSkinned } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/utils/SkeletonUtils.js/+esm';
import { identityModels } from './identity.mjs';

const FURNITURE = '/assets/furniture';
const PEOPLE = '/assets/people';

export const PEOPLE_MODELS = Object.freeze([
  'character-male-a',
  'character-female-a',
  'character-male-b',
  'character-female-b',
  'character-male-c',
  'character-female-c',
  'character-male-d',
  'character-female-d',
]);

export const FURNITURE_MODELS = Object.freeze([
  'desk',
  'chairDesk',
  'computerScreen',
  'computerKeyboard',
  'computerMouse',
  'lampRoundTable',
  'wall',
  'wallWindow',
  'rugRectangle',
  'rugRound',
  'loungeSofa',
  'loungeChair',
  'tableCoffee',
  'books',
  'bookcaseOpen',
  'bookcaseClosedWide',
  'kitchenCabinet',
  'kitchenCoffeeMachine',
  'stoolBar',
  'pottedPlant',
  'plantSmall1',
  'plantSmall2',
  'plantSmall3',
  'lampSquareFloor',
  'trashcan',
  'cardboardBoxClosed',
]);

const isPerson = (name) => name.startsWith('character-');

// A loaded model: the prototype scene plus its animation clips. The identity
// table is a second source of model names, so it is unioned in here rather
// than duplicated by hand.
export async function loadModels() {
  const loader = new GLTFLoader();
  const load = (url) => loader.loadAsync(url);
  const wanted = identityModels();
  const furniture = [...new Set([...FURNITURE_MODELS, ...wanted.filter((n) => !isPerson(n))])];
  const people = [...new Set([...PEOPLE_MODELS, ...wanted.filter(isPerson)])];
  const entries = await Promise.all([
    ...furniture.map(async (name) => [name, await load(`${FURNITURE}/${name}.glb`)]),
    ...people.map(async (name) => [name, await load(`${PEOPLE}/${name}.glb`)]),
  ]);
  const models = new Map();
  for (const [name, gltf] of entries) {
    prepare(gltf.scene);
    models.set(name, { scene: gltf.scene, clips: gltf.animations ?? [] });
  }
  return models;
}

// Kenney's kit ships a bright salmon-and-pine palette. Off Grid is near-black
// with a single emerald accent, so the kit is regraded once, on load, by
// material name - one table rather than a tint scattered through the scene.
const MATERIAL_COLOURS = Object.freeze({
  carpet: '#333d3a',
  carpetDarker: '#242c2a',
  carpetWhite: '#c9d1ce',
  wood: '#6d5439',
  woodDark: '#4a3826',
  metal: '#9ba7a8',
  metalDark: '#2b3232',
  metalMedium: '#485252',
  lamp: '#ffe9a0',
  glass: '#8fa8a0',
  plant: '#4d7f66',
  _defaultMat: '#98a09e',
});

// Everything the renderer needs to be true of every mesh, applied once.
function prepare(root) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      material.side = THREE.FrontSide;
      const graded = MATERIAL_COLOURS[material.name];
      if (graded) material.color.set(graded);
      if ('roughness' in material) material.roughness = Math.min(material.roughness ?? 1, 0.88);
      if ('metalness' in material) material.metalness = 0;
    }
  });
}

// A placeable instance, wrapped in a group whose origin is on the floor at the
// model's horizontal centre. Callers position by that centre and never have to
// know the kit's authoring origin. `targetHeight` normalises a model of unknown
// scale - which is every model a user drops in themselves.
export function build(model, { targetHeight } = {}) {
  const object = cloneSkinned(model.scene);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const scale = targetHeight && size.y > 0 ? targetHeight / size.y : 1;
  object.scale.setScalar(scale);
  object.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);

  const group = new THREE.Group();
  group.add(object);
  group.userData.size = size;
  group.userData.clips = model.clips;
  return group;
}

export function instance(models, name, options) {
  const model = models.get(name);
  if (!model) throw new Error(`model not loaded: ${name}`);
  return build(model, options);
}

// Roster-supplied characters. The directory is deliberately optional and
// usually empty, so a miss is a silent fall back to the built-in look - never
// an error the user has to read.
const custom = new Map();

export function customModel(path) {
  if (!path) return null;
  const url = path.startsWith('/') ? path : `/${path}`;
  let entry = custom.get(url);
  if (entry) return entry;
  entry = { status: 'pending', model: null };
  custom.set(url, entry);
  new GLTFLoader()
    .loadAsync(encodeURI(url))
    .then((gltf) => {
      prepare(gltf.scene);
      entry.model = { scene: gltf.scene, clips: gltf.animations ?? [] };
      entry.status = 'ready';
    })
    .catch(() => {
      entry.status = 'missing';
    });
  return entry;
}

// Materials are shared across clones, so anything per-instance (an emissive
// screen, a tint) has to own its own copy first.
export function isolateMaterials(root) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    node.material = Array.isArray(node.material)
      ? node.material.map((material) => material.clone())
      : node.material.clone();
  });
}

export function findMaterial(root, name) {
  let found = null;
  root.traverse((node) => {
    if (found || !node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const hit = materials.find((material) => material?.name === name);
    if (hit) found = hit;
  });
  return found;
}
