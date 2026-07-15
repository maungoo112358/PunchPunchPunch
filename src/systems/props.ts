import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PROP_CATALOG, type PropName } from "../config/propCatalog.js";
import type { PlanetGrid } from "../world/planetGrid.js";

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

// One line out of propPlacements.yaml, written down as a real shape instead of only in the comment above.
// model is left as a plain string on purpose: the YAML is just a text file, so it can name a prop that
// does not exist, and loadSource below warns when it does. A PropName here would be a promise we cannot
// keep, because types are gone by the time the file is actually read.
export type PropEntry = {
  model: string;
  at?: string; // rough drop, a triangle label like "T25"
  dir?: number[]; // exact spot the editor writes on save; wins over "at"
  yaw?: number; // degrees around the surface normal
  scale?: number; // multiplier on top of PROP_BASE_SCALE
  clear?: number; // grass-clearing radius, world units
};

// A placed prop: the line it came from, and the thing standing in the scene.
export type PropRecord = { entry: PropEntry; object: THREE.Object3D };

// One line as it goes back OUT to the YAML on save. Same idea as PropEntry, but dir/yaw/scale are always
// written, so the file the editor produces is fully explicit.
type SerializedProp = {
  model: string;
  at?: string;
  dir?: number[];
  yaw?: number;
  scale?: number;
  clear?: number;
};

// What createProps hands back. The dev-only placement editor drives all of it.
export type Props = ReturnType<typeof createProps>;

export function createProps(scene: THREE.Scene, grid: PlanetGrid) {
  const cache = new Map<string, Promise<THREE.Object3D | null>>(); // model name -> Promise<Object3D source>
  const records: PropRecord[] = []; // { entry, object }

  // Where does this entry sit? Its saved "dir", else the center of its "at" triangle. Returns a fresh
  // unit vector (the surface normal / up at that spot).
  function resolveDir(entry: PropEntry) {
    if (Array.isArray(entry.dir)) return new THREE.Vector3(entry.dir[0], entry.dir[1], entry.dir[2]).normalize();
    const spot = grid.gridPoint(entry.at || "");
    return spot ? spot.up.clone() : new THREE.Vector3(0, 1, 0);
  }

  // Stand a prop on the surface: up = the surface normal (dir), spun by yaw around that up, sized by scale.
  function applyTransform(object: THREE.Object3D, entry: PropEntry) {
    const dir = resolveDir(entry);
    object.position.copy(dir).multiplyScalar(grid.radius);
    _q1.setFromUnitVectors(UP, dir); // tilt local +Y onto the surface normal
    _q2.setFromAxisAngle(dir, THREE.MathUtils.degToRad(entry.yaw || 0)); // spin around up
    object.quaternion.copy(_q2).multiply(_q1);
    object.scale.setScalar((entry.scale ?? 1) * PROP_BASE_SCALE);
  }

  // Load a model once and reuse it (cloned per placement).
  function loadSource(name: string): Promise<THREE.Object3D | null> {
    // The ! is needed because has() and get() are two separate calls, and TypeScript does not connect
    // them: it cannot tell that a key we just checked for is definitely there, so get() still looks like
    // it might come back empty. We know better, because nothing ever deletes from this cache.
    if (cache.has(name)) return cache.get(name)!;
    // The name came out of a YAML file, so it might not be a real prop. PROP_CATALOG only has keys for
    // the props that exist, so we tell TypeScript to let the lookup through and say plainly that the
    // answer may be missing. That is what the warning below is for, and it is a case TypeScript cannot
    // catch for us: the file is read while the game runs, long after the types are gone.
    const file: string | undefined = PROP_CATALOG[name as PropName];
    if (!file) {
      console.warn(`props: unknown model "${name}" (not in propCatalog.js)`);
      return Promise.resolve(null);
    }
    const pr = new Promise<THREE.Object3D | null>((res) => {
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
  async function add(entry: PropEntry) {
    const src = await loadSource(entry.model);
    if (!src) return null;
    const object = src.clone(true); // deep clone so many trees can share the loaded geometry
    object.traverse((o) => {
      // traverse hands back plain Object3D, and only a Mesh has isMesh, so we ask TypeScript to treat it
      // as one just long enough to read the flag. isMesh is three's own "am I a mesh" marker.
      if ((o as THREE.Mesh).isMesh) {
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
  function loadAll(entries: PropEntry[]) {
    return Promise.all(entries.map((e) => add(e)));
  }

  // Re-stand a record after the editor changed its entry (dir/yaw/scale).
  function apply(rec: PropRecord) {
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
      const out: SerializedProp = { model: e.model };
      if (e.at) out.at = e.at; // keep the human-friendly anchor as a note
      out.dir = [round(dir.x), round(dir.y), round(dir.z)];
      out.yaw = round(e.yaw || 0);
      out.scale = round(e.scale ?? 1);
      if (e.clear != null) out.clear = e.clear;
      return out;
    });
  }

  function setVisible(v: boolean) {
    for (const r of records) r.object.visible = v;
  }

  // resolveDir is handed out because it is the one answer to "where does this entry sit", and the editor
  // needs it too. Working it out anywhere else would mean a second copy of the same rule.
  return { add, loadAll, apply, footprints, serialize, setVisible, records, resolveDir };
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

// A circle of cleared ground under a prop. This is the same shape world/grass.ts asks for; the two are
// kept apart on purpose so the grass does not have to know props exist, and matching shapes is all
// TypeScript needs for it to fit.
export type Footprint = { center: THREE.Vector3; radius: number };

// Build the grass footprints straight from raw YAML entries, BEFORE the meshes have loaded. The grass is
// built once at startup and needs the prop spots then, which we can get from the entries alone (no mesh
// required). Same math as resolveDir above.
export function footprintsFromEntries(
  entries: PropEntry[],
  grid: PlanetGrid,
  defaultClear = DEFAULT_CLEAR,
) {
  return entries
    .map((e) => {
      const dir = Array.isArray(e.dir)
        ? new THREE.Vector3(e.dir[0], e.dir[1], e.dir[2]).normalize()
        : grid.gridPoint(e.at || "")?.up;
      if (!dir) return null;
      return { center: dir.clone().multiplyScalar(grid.radius), radius: e.clear ?? defaultClear };
    })
    // The nulls above (entries whose spot we could not work out) are dropped here. The test is still
    // plain Boolean, exactly as before. What is new is the "f is Footprint" part: TypeScript cannot see
    // on its own that filtering removes the nulls, because Boolean just answers true or false and says
    // nothing about types. So we spell the claim out, which is called a type predicate, and it is what
    // lets us hand the grass a list it can trust has no holes in it.
    .filter((f): f is Footprint => Boolean(f));
}
