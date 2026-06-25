import * as THREE from "three";

// Drives the character from CAMERA-RELATIVE input: the keyboard intent (forward/
// strafe) is rotated by the camera's yaw, so "forward" is always into the screen.
// Then the character moves + faces that world direction. (Unity: a PlayerController.)
const SPEED = 4.5; // units per second

export function createPlayerController(character, input, cameraFollow) {
  const worldDir = new THREE.Vector3(); // reused per frame

  return {
    update(dt) {
      if (!character.model) return;

      const intent = input.getDirection(); // (x = strafe, z = forward) in camera space
      const moving = intent.lengthSq() > 0;

      if (moving) {
        // Rotate intent by camera yaw into a world direction.
        // camForward = (sin yaw, 0, cos yaw); camRight = (cos yaw, 0, -sin yaw).
        const yaw = cameraFollow.getYaw();
        const s = Math.sin(yaw);
        const c = Math.cos(yaw);
        worldDir.set(s * intent.z + c * intent.x, 0, c * intent.z - s * intent.x);

        character.model.position.addScaledVector(worldDir, SPEED * dt);
        character.faceDirection(worldDir, dt);
      }
      character.setMoving(moving); // crossfades Idle<->Run
    },
  };
}
