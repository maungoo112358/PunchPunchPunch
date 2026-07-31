import * as THREE from "three";
import { createReticle } from "./reticle.js";
import { LOCAL_ID } from "./world.js";
import type { World } from "./world.js";

// Who the wand is pointed at.
//
// The MOUSE CURSOR is the aim, the way it is in a shooter. The operating system's arrow is switched off
// over the game and a crosshair is drawn in its place; a ray goes from the camera out through wherever
// that crosshair sits, and whoever the ray passes close to is the target. The crosshair turns green when
// it is over somebody. There is no marker in the world at all: the aim lives on the screen, where your
// eye already is.
//
// Pure presentation. Nothing here is sent anywhere or agreed with the server; it only decides what the
// spell is drawn towards.

// How far away something can be and still be targetable, in world units. The planet's radius is 36, so
// this is a comfortable chunk of the visible surface without letting you snipe someone over the horizon.
const RANGE = 18;

// How close the aim ray has to pass to count as pointing at someone, in world units. This is the aim
// forgiveness: it is a fat cylinder around the ray rather than an exact hit on the model, so you do not
// have to land the crosshair on a thin arm. Roughly the width of a character. Shrink it for a stricter aim.
const PICK_RADIUS = 1.3;

// How high up the body the aim point sits, in world units, against a character about 4.4 tall. Chest
// height, so pointing at the middle of someone works rather than only at their feet.
const CHEST = 2;

// pointer hands back where the cursor is, twice: in normalized device coordinates for the raycast, and in
// screen pixels for the crosshair. Passed in as a tiny shape rather than the whole input object so this
// file cannot start reading the keyboard.
type Pointer = {
  getPointer(): { x: number; y: number };
  getPointerPx(): { x: number; y: number };
};

export function createTargeting(world: World, camera: THREE.Camera, pointer: Pointer) {
  const reticle = createReticle();
  let targetId: string | null = null;

  // Scratch, reused every frame.
  const raycaster = new THREE.Raycaster();
  const camPos = new THREE.Vector3();
  const aimPoint = new THREE.Vector3();
  const up = new THREE.Vector3();

  return {
    // Who the wand is currently pointed at, or null. The view reads this when a cast goes off.
    get targetId() {
      return targetId;
    },

    update() {
      // The ray out of the camera through the crosshair. Everything on screen under that pixel lies
      // somewhere along this line, which is what makes the cursor an aim rather than a decoration.
      raycaster.setFromCamera(pointer.getPointer() as THREE.Vector2, camera);
      camera.getWorldPosition(camPos);

      // Whoever the ray passes closest to. Measured against a point at chest height rather than the
      // model's feet, and with a fat tolerance, so aiming is forgiving: the crosshair has to be roughly
      // on someone, not exactly on a sleeve. Ties go to whoever is nearer the camera, because when two
      // overlap on screen the one you meant is almost always the one in front.
      let best: string | null = null;
      let bestDist = Infinity;
      for (const [id, player] of world.players) {
        if (id === LOCAL_ID) continue; // never lock onto yourself
        up.copy(player.state.position).normalize();
        aimPoint.copy(player.state.position).addScaledVector(up, CHEST);
        const dist = aimPoint.distanceTo(camPos);
        if (dist > RANGE) continue;
        // How far the aim line passes from them. distanceToPoint measures straight across to the line,
        // and the ray only runs forwards, so someone behind the camera can never be picked by accident.
        if (raycaster.ray.distanceToPoint(aimPoint) > PICK_RADIUS) continue;
        if (dist < bestDist) {
          bestDist = dist;
          best = id;
        }
      }
      targetId = best;

      const px = pointer.getPointerPx();
      reticle.update(px.x, px.y, targetId !== null);
    },
  };
}

export type Targeting = ReturnType<typeof createTargeting>;
