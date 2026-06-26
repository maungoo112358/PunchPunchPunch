import * as THREE from "three";

// Drives the character from the input channels: camera-relative movement + locomotion
// animation (Idle / Walk / Run chosen by move magnitude). Jump/attack were removed to keep
// the controls simple — this is pure ground locomotion.
const SPEED = 4.5; // max (Run) horizontal speed, units/s — scaled by move magnitude for Walk/analog
const WALK_MAX = 0.6; // move magnitude at/below this = Walk; above = Run

export function createPlayerController(character, input, cameraFollow) {
  const worldDir = new THREE.Vector3(); // reused per frame

  return {
    update(dt) {
      if (!character.model) return;

      const intent = input.getDirection(); // magnitude encodes speed (0..1)
      const speed = intent.length();

      if (speed > 0) {
        // Rotate the camera-relative intent into a world direction.
        const yaw = cameraFollow.getYaw();
        const s = Math.sin(yaw);
        const c = Math.cos(yaw);
        worldDir.set(s * intent.z - c * intent.x, 0, c * intent.z + s * intent.x);
        // worldDir keeps the intent's magnitude, so Walk/analog naturally move slower.
        character.model.position.addScaledVector(worldDir, SPEED * dt);
        character.faceDirection(worldDir, dt);
      }

      // Locomotion state by speed (no-op if already on it).
      const state = speed > WALK_MAX ? "Run" : speed > 0 ? "Walk" : "Idle";
      character.setAction(state);
    },
  };
}
