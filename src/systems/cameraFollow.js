import * as THREE from "three";

// Third-person follow: the camera sits BEHIND the character's back and smoothly
// swings around to stay behind him as he turns. It exposes its yaw so movement can
// be made camera-relative ("forward" = into the screen).
const DIST = 9; // how far behind the character
const HEIGHT = 6; // how high above
const LOOK_HEIGHT = 1.5; // aim at the upper body, not the feet
const POS_DAMP = 10; // camera position follow speed
const YAW_DAMP = 5; // how fast the camera swings behind a turn (lower = lazier)

export function createCameraFollow(camera, target) {
  let yaw = 0; // smoothed camera heading (radians)
  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();

  return {
    getYaw() {
      return yaw;
    },
    update(dt) {
      if (!target.model) return;
      const p = target.model.position;

      // Smoothly turn the camera yaw toward the character's heading (shortest path).
      const targetYaw = target.model.rotation.y;
      let dYaw = targetYaw - yaw;
      dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
      yaw += dYaw * Math.min(1, YAW_DAMP * dt);

      // Behind the back = opposite the character's forward (sin yaw, 0, cos yaw).
      desired.set(
        p.x - Math.sin(yaw) * DIST,
        p.y + HEIGHT,
        p.z - Math.cos(yaw) * DIST
      );
      const t = 1 - Math.exp(-POS_DAMP * dt); // frame-rate-independent smoothing
      camera.position.lerp(desired, t);

      lookAt.set(p.x, p.y + LOOK_HEIGHT, p.z);
      camera.lookAt(lookAt);
    },
  };
}
