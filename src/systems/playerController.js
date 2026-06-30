import * as THREE from "three";

// Drives the character across the planet surface: camera-relative movement along the tangent
// plane plus locomotion animation (Idle/Walk/Run by move magnitude).
// Movement: step along the flat tangent, then snap back onto the sphere (planet.placeOnSurface).
// One frame's off-surface drift is negligible and the snap erases it (great-circle walk).
const SPEED = 4.5; // max run speed (units/s), scaled by move magnitude for walk
const WALK_MAX = 0.6; // magnitude at or below this = Walk, above = Run

export function createPlayerController(character, input, cameraFollow, planet) {
  const up = new THREE.Vector3(); // surface normal at the character, reused per frame
  const moveDir = new THREE.Vector3(); // world tangent move direction, reused

  return {
    update(dt) {
      if (!character.model) return;
      const p = character.model.position;

      const intent = input.getDirection(); // x = strafe, z = forward; magnitude = speed (0..1)
      const speed = intent.length();

      planet.upAt(p, up); // up = outward normal

      if (speed > 0) {
        // Build the world move direction from the camera's tangent basis (camera-relative).
        const fwd = cameraFollow.getForward();
        const right = cameraFollow.getRight();
        moveDir
          .copy(fwd)
          .multiplyScalar(intent.z)
          .addScaledVector(right, intent.x); // keeps magnitude, so walk/analog move slower

        // Step along the tangent, then re-project onto the surface.
        p.addScaledVector(moveDir, SPEED * dt);
        planet.placeOnSurface(p);

        planet.upAt(p, up); // up changed after moving, recompute before orienting
        character.orient(up, moveDir, dt); // face travel direction, stand up along new normal
      }

      // Locomotion state by speed.
      const state = speed > WALK_MAX ? "Run" : speed > 0 ? "Walk" : "Idle";
      character.setAction(state);
    },
  };
}
