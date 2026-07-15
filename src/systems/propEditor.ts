import * as THREE from "three";
import type { Planet } from "../world/planet.js";
import type { PlanetGrid } from "../world/planetGrid.js";
import type { GridGizmo } from "../world/gridGizmo.js";
import type { Grass } from "../world/grass.js";
import type { Props, PropRecord } from "./props.js";

// DEV-ONLY placement editor. Press the toggle key (M) to enter: grass hides, the number grid shows, the
// view switches to a free orbit around the planet, and you can click a prop, drag it across the surface,
// rotate/scale it, and press Ctrl+S to write it all back to propPlacements.yaml. Built only under
// import.meta.env.DEV, so it never ships.
//
// Controls come from controls.yaml (so you can rebind them). Mouse is only for props (click = select,
// drag = move). WASD rotates the planet. Wheel zooms.

const CENTER = new THREE.Vector3(0, 0, 0);
const CAM_ROT_SPEED = 1.2; // radians/sec the view spins under WASD
const ROT_STEP = 5; // degrees per Q/E press
const SCALE_STEP = 1.06; // multiply per [ / ] press
const MIN_PHI = 0.15, MAX_PHI = Math.PI - 0.15; // clamp so we never flip over the poles
const NUDGE = 0.4; // world units per arrow-key fine nudge

// The editor's key bindings, straight out of controls.yaml. Every value is a KeyboardEvent.code name
// like "KeyM" or "ArrowLeft", except save, which carries a "Ctrl+" prefix.
type EditorKeys = {
  toggle: string;
  planet_up: string;
  planet_down: string;
  planet_left: string;
  planet_right: string;
  rotate_ccw: string;
  rotate_cw: string;
  scale_down: string;
  scale_up: string;
  cycle: string;
  deselect: string;
  save: string;
};

// Everything the editor needs handed to it, rather than reaching out and grabbing it.
type EditorDeps = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  planet: Planet;
  grid: PlanetGrid;
  props: Props;
  grass: Grass;
  gizmo: GridGizmo;
  controls: { editor: EditorKeys };
};

// What createPropEditor hands back. main.ts holds one of these, or null in a release build.
export type PropEditor = ReturnType<typeof createPropEditor>;

export function createPropEditor(deps: EditorDeps) {
  const { scene, camera, planet, grid, props, grass, gizmo, controls } = deps;
  const keys = controls.editor; // { toggle, planet_up, ... , save }

  let active = false;
  let selected: PropRecord | null = null; // a props record, or null
  let dragging = false;

  // Free orbit camera state (spherical around the planet center).
  const sph = new THREE.Spherical(planet.radius * 2.6, 1.0, 0.0); // radius, phi (from +Y), theta
  const held = new Set(); // codes currently down (for the WASD spin)

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const _pos = new THREE.Vector3();

  // Yellow box around the selected prop.
  let boxHelper: THREE.BoxHelper | null = null;

  // --- little on-screen readout ---
  const hud = document.createElement("div");
  hud.style.cssText =
    "position:fixed;left:12px;bottom:12px;padding:10px 12px;font:12px/1.5 monospace;color:#fff;" +
    "background:rgba(0,0,0,0.6);border-radius:8px;white-space:pre;pointer-events:none;z-index:50;display:none;";
  document.body.appendChild(hud);

  function hudText() {
    const base =
      "EDITOR (M to exit)\n" +
      "WASD rotate planet  wheel zoom\n" +
      "click select  drag move  Q/E rotate  [ ] scale\n" +
      "arrows nudge  Tab cycle  Esc deselect  Ctrl+S save\n";
    if (!selected) return base + "\n(no prop selected)";
    const e = selected.entry;
    return (
      base +
      `\nselected: ${e.model}` +
      `\nyaw:   ${Math.round(e.yaw || 0)}` +
      `\nscale: ${(e.scale ?? 1).toFixed(2)}`
    );
  }
  function updateHud() {
    hud.textContent = hudText();
  }

  // --- selection ---
  function recordFromObject(obj: THREE.Object3D): PropRecord | null {
    for (const r of props.records) {
      // Walk up the parents looking for the prop this bit of mesh belongs to. o has to be allowed to be
      // null because that is what parent gives back once we reach the top of the tree, which is the
      // thing that stops the loop.
      let o: THREE.Object3D | null = obj;
      while (o) {
        if (o === r.object) return r;
        o = o.parent;
      }
    }
    return null;
  }

  function select(rec: PropRecord | null) {
    selected = rec;
    if (rec) {
      if (!boxHelper) {
        boxHelper = new THREE.BoxHelper(rec.object, 0xffff33);
        scene.add(boxHelper);
      }
      rec.object.updateWorldMatrix(true, true); // box reads world matrices, make sure they are current
      boxHelper.setFromObject(rec.object);
      boxHelper.visible = true;
    } else if (boxHelper) {
      boxHelper.visible = false;
    }
    updateHud();
  }

  function refreshBox() {
    if (!boxHelper || !selected) return;
    selected.object.updateWorldMatrix(true, true);
    boxHelper.setFromObject(selected.object);
  }

  // --- pointer: raycast props to select, raycast the planet to drag ---
  function setNdc(e: PointerEvent) {
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  }

  function onPointerDown(e: PointerEvent) {
    if (!active || e.button !== 0) return;
    setNdc(e);
    raycaster.setFromCamera(ndc, camera);
    const objects = props.records.map((r) => r.object);
    const hit = raycaster.intersectObjects(objects, true)[0];
    if (hit) {
      select(recordFromObject(hit.object));
      dragging = true;
    } else {
      select(null);
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!active || !dragging || !selected) return;
    setNdc(e);
    raycaster.setFromCamera(ndc, camera);
    // Drop the prop where the ray meets the planet surface.
    const hit = raycaster.intersectObject(planet.mesh, false)[0];
    if (!hit) return;
    _pos.copy(hit.point).normalize();
    selected.entry.dir = [round(_pos.x), round(_pos.y), round(_pos.z)];
    props.apply(selected);
    refreshBox();
  }

  function onPointerUp() {
    dragging = false;
  }

  // --- keys ---
  function onKeyDown(e: KeyboardEvent) {
    // toggle works whether or not we are in editor mode
    if (e.code === keys.toggle) {
      toggle();
      return;
    }
    if (!active) return;

    // save: matches "Ctrl+KeyS"
    if (keys.save === `Ctrl+${e.code}` && e.ctrlKey) {
      e.preventDefault();
      save();
      return;
    }

    held.add(e.code);

    if (e.code === keys.cycle) {
      e.preventDefault();
      cycle();
    } else if (e.code === keys.deselect) {
      select(null);
    } else if (selected) {
      const e2 = selected.entry;
      if (e.code === keys.rotate_ccw) {
        e2.yaw = (e2.yaw || 0) - ROT_STEP;
        props.apply(selected);
        refreshBox();
        updateHud();
      } else if (e.code === keys.rotate_cw) {
        e2.yaw = (e2.yaw || 0) + ROT_STEP;
        props.apply(selected);
        refreshBox();
        updateHud();
      } else if (e.code === keys.scale_down) {
        e2.scale = (e2.scale ?? 1) / SCALE_STEP;
        props.apply(selected);
        refreshBox();
        updateHud();
      } else if (e.code === keys.scale_up) {
        e2.scale = (e2.scale ?? 1) * SCALE_STEP;
        props.apply(selected);
        refreshBox();
        updateHud();
      } else if (e.code.startsWith("Arrow")) {
        nudge(e.code);
      }
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    held.delete(e.code);
  }

  // Slide the selected prop a small step across the surface, in screen-ish directions (relative to the
  // camera): left/right along the camera's right, up/down along its forward-on-the-surface.
  function nudge(code: string) {
    if (!selected) return;
    // Ask props where this entry sits. We used to read entry.dir straight, but that is only filled in
    // once a prop has been dragged or saved: a prop rough-placed with just "at: T20" has no dir yet, so
    // the arrow keys threw and the prop would not budge until you had dragged it once with the mouse.
    // resolveDir handles both cases, and it is the same call that put the prop on the ground.
    const dir = props.resolveDir(selected.entry);
    const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const north = new THREE.Vector3().crossVectors(dir, camRight).normalize(); // surface "up-screen"
    const east = new THREE.Vector3().crossVectors(north, dir).normalize();
    const step = NUDGE / grid.radius; // small angle
    if (code === "ArrowLeft") dir.addScaledVector(east, -step);
    if (code === "ArrowRight") dir.addScaledVector(east, step);
    if (code === "ArrowUp") dir.addScaledVector(north, step);
    if (code === "ArrowDown") dir.addScaledVector(north, -step);
    dir.normalize();
    selected.entry.dir = [round(dir.x), round(dir.y), round(dir.z)];
    props.apply(selected);
    refreshBox();
  }

  function cycle() {
    if (!props.records.length) return;
    const i = selected ? props.records.indexOf(selected) : -1;
    select(props.records[(i + 1) % props.records.length]);
  }

  function onWheel(e: WheelEvent) {
    if (!active) return;
    e.preventDefault();
    sph.radius *= e.deltaY > 0 ? 1.1 : 0.9;
    sph.radius = Math.max(planet.radius * 1.3, Math.min(planet.radius * 6, sph.radius));
  }

  // --- save: write YAML, then rebuild the grass carve so cleared patches match the moved props ---
  async function save() {
    const data = props.serialize();
    try {
      const res = await fetch("/__save-props", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      grass.rebuild(props.footprints());
      console.log(`Saved ${data.length} props.`);
      flashHud("saved!");
    } catch (err) {
      console.error("save failed:", err);
      flashHud("SAVE FAILED (see console)");
    }
  }

  let flashTimer = 0;
  function flashHud(msg: string) {
    hud.textContent = msg;
    flashTimer = 1.2;
  }

  // --- mode toggle ---
  function toggle() {
    active = !active;
    gizmo.setVisible(active);
    grass.setVisible(!active);
    props.setVisible(true); // props stay visible in both modes; make sure editor didn't hide them
    hud.style.display = active ? "block" : "none";
    if (active) {
      updateHud();
    } else {
      select(null);
      held.clear();
      dragging = false;
    }
  }

  // --- per-frame (only meaningful while active) ---
  function update(dt: number) {
    if (!active) return;

    if (flashTimer > 0) {
      flashTimer -= dt;
      if (flashTimer <= 0) updateHud();
    }

    // WASD spins the view around the planet.
    const d = CAM_ROT_SPEED * dt;
    if (held.has(keys.planet_left)) sph.theta -= d;
    if (held.has(keys.planet_right)) sph.theta += d;
    if (held.has(keys.planet_up)) sph.phi -= d;
    if (held.has(keys.planet_down)) sph.phi += d;
    sph.phi = Math.max(MIN_PHI, Math.min(MAX_PHI, sph.phi));

    camera.position.setFromSpherical(sph).add(CENTER);
    camera.up.set(0, 1, 0);
    camera.lookAt(CENTER);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("wheel", onWheel, { passive: false });

  return { isActive: () => active, update };
}

function round(n: number) {
  return Math.round(n * 10000) / 10000;
}
