import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PROP_CATALOG } from "../config/propCatalog.js";

// Loads and places the nature props from propPlacements.yaml, and keeps the live list so the editor can
// move/rotate/scale them and save. Each prop is placed once from its entry, then it is just a mesh.
//
// A placement entry (from the YAML) is:
//   { model, at?, dir?, yaw?, scale?, clear? }
// "at" (a triangle like T25) is the rough drop; "dir" ([x,y,z]) is the exact spot the editor writes on
// save and wins over "at". yaw is degrees, scale a multiplier, clear the grass-clearing radius.

const loader = new GLTFLoader();
const UP = new THREE.Vector3(0, 1, 0); // a fresh model's up before we tilt it onto the sphere
const PROP_BASE_SCALE = 1.0; // global size dial for all props (tune once we see them on the planet)
const DEFAULT_CLEAR = 1.5; // default grass-clearing radius around a prop, world units

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export function createProps(scene, grid) {
  const cache = new Map(); // model name -> Promise<Object3D source>
  const records = []; // { entry, object }

  // Where does this entry sit? Its saved "dir", else the center of its "at" triangle. Returns a fresh
  // unit vector (the surface normal / up at that spot).
  function resolveDir(entry) {
    if (Array.isArray(entry.dir)) return new THREE.Vector3(entry.dir[0], entry.dir[1], entry.dir[2]).normalize();
    const spot = grid.gridPoint(entry.at || "");
    return spot ? spot.up.clone() : new THREE.Vector3(0, 1, 0);
  }

  // Stand a prop on the surface: up = the surface normal (dir), spun by yaw around that up, sized by scale.
  function applyTransform(object, entry) {
    const dir = resolveDir(entry);
    object.position.copy(dir).multiplyScalar(grid.radius);
    _q1.setFromUnitVectors(UP, dir); // tilt local +Y onto the surface normal
    _q2.setFromAxisAngle(dir, THREE.MathUtils.degToRad(entry.yaw || 0)); // spin around up
    object.quaternion.copy(_q2).multiply(_q1);
    object.scale.setScalar((entry.scale ?? 1) * PROP_BASE_SCALE);
  }

  // Load a model once and reuse it (cloned per placement).
  function loadSource(name) {
    if (cache.has(name)) return cache.get(name);
    const file = PROP_CATALOG[name];
    if (!file) {
      console.warn(`props: unknown model "${name}" (not in propCatalog.js)`);
      return Promise.resolve(null);
    }
    const pr = new Promise((res) => {
      loader.load(
        `/models/${file}`,
        (gltf) => res(gltf.scene),
        undefined,
        (err) => {
          console.error(`props: failed to load ${file}`, err);
          res(null);
        },
      );
    });
    cache.set(name, pr);
    return pr;
  }

  // Place one entry. Returns the record (or null if the model was missing).
  async function add(entry) {
    const src = await loadSource(entry.model);
    if (!src) return null;
    const object = src.clone(true); // deep clone so many trees can share the loaded geometry
    object.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    applyTransform(object, entry);
    scene.add(object);
    const rec = { entry, object };
    records.push(rec);
    return rec;
  }

  // Place every entry from the YAML (in parallel).
  function loadAll(entries) {
    return Promise.all(entries.map((e) => add(e)));
  }

  // Re-stand a record after the editor changed its entry (dir/yaw/scale).
  function apply(rec) {
    applyTransform(rec.object, rec.entry);
  }

  // Grass-clearing circles for every prop, in world space. addGrass reads this to skip blades under props.
  function footprints() {
    return records.map((r) => ({
      center: resolveDir(r.entry).multiplyScalar(grid.radius),
      radius: r.entry.clear ?? DEFAULT_CLEAR,
    }));
  }

  // The current placement list, ready to write back to YAML. dir is rounded to keep the file tidy.
  function serialize() {
    return records.map((r) => {
      const e = r.entry;
      const dir = resolveDir(e);
      const out = { model: e.model };
      if (e.at) out.at = e.at; // keep the human-friendly anchor as a note
      out.dir = [round(dir.x), round(dir.y), round(dir.z)];
      out.yaw = round(e.yaw || 0);
      out.scale = round(e.scale ?? 1);
      if (e.clear != null) out.clear = e.clear;
      return out;
    });
  }

  function setVisible(v) {
    for (const r of records) r.object.visible = v;
  }

  return { add, loadAll, apply, footprints, serialize, setVisible, records };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

// Build the grass footprints straight from raw YAML entries, BEFORE the meshes have loaded. The grass is
// built once at startup and needs the prop spots then, which we can get from the entries alone (no mesh
// required). Same math as resolveDir above.
export function footprintsFromEntries(entries, grid, defaultClear = DEFAULT_CLEAR) {
  return entries
    .map((e) => {
      const dir = Array.isArray(e.dir)
        ? new THREE.Vector3(e.dir[0], e.dir[1], e.dir[2]).normalize()
        : grid.gridPoint(e.at || "")?.up;
      if (!dir) return null;
      return { center: dir.clone().multiplyScalar(grid.radius), radius: e.clear ?? defaultClear };
    })
    .filter(Boolean);
}
