import * as THREE from "three";

// Drives the character across the curved planet surface from the input channels: camera-relative
// movement along the tangent plane + locomotion animation (Idle / Walk / Run by move magnitude).
// Movement model: step along the flat tangent, then SNAP back onto the sphere (planet.placeOnSurface).
// The off-surface drift over one frame is negligible and the snap erases it (great-circle walk).
const SPEED = 4.5; // max (Run) tangent speed, units/s — scaled by move magnitude for Walk/analog
const WALK_MAX = 0.6; // move magnitude at/below this = Walk; above = Run

export function createPlayerController(character, input, cameraFollow, planet) {
  const up = new THREE.Vector3(); // surface normal at the character, reused per frame
  const moveDir = new THREE.Vector3(); // world tangent move direction, reused

  return {
    update(dt) {
      if (!character.model) return;
      const p = character.model.position;

      const intent = input.getDirection(); // x = strafe, z = forward; magnitude encodes speed (0..1)
      const speed = intent.length();

      planet.upAt(p, up); // current "up" = outward normal

      if (speed > 0) {
        // Build the world move direction from the camera's tangent basis (camera-relative, like
        // the flat version — but the basis is now tangent to the sphere instead of world-XZ).
        const fwd = cameraFollow.getForward();
        const right = cameraFollow.getRight();
        moveDir
          .copy(fwd)
          .multiplyScalar(intent.z)
          .addScaledVector(right, intent.x); // keeps intent magnitude → Walk/analog move slower

        // Step along the tangent, then re-project onto the surface so he never leaves the sphere.
        p.addScaledVector(moveDir, SPEED * dt);
        planet.placeOnSurface(p);

        planet.upAt(p, up); // up changed after moving → recompute before orienting
        character.orient(up, moveDir, dt); // face travel direction, stand up along the new normal
      }

      // Locomotion state by speed (no-op if already on it).
      const state = speed > WALK_MAX ? "Run" : speed > 0 ? "Walk" : "Idle";
      character.setAction(state);
    },
  };
}
