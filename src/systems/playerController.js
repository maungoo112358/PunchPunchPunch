import * as THREE from "three";

// Drives the character from input each frame: move on the XZ plane, face travel
// direction, and switch Idle/Run. (Unity analog: a PlayerController MonoBehaviour.)
const SPEED = 4.5; // units per second

export function createPlayerController(character, input) {
  const move = new THREE.Vector3(); // reused per frame

  return {
    update(dt) {
      if (!character.model) return; // model still loading

      const dir = input.getDirection();
      const moving = dir.lengthSq() > 0;

      if (moving) {
        move.copy(dir).multiplyScalar(SPEED * dt);
        character.model.position.add(move);
        character.faceDirection(dir, dt);
      }
      character.setMoving(moving); // crossfades Idle<->Run (no-op if unchanged)
    },
  };
}
