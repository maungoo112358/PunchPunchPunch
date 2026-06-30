import * as THREE from "three";

// PerspectiveCamera(fov, aspect, near, far) defines the view frustum.
// Temporary elevated 3/4 view (~45 deg down) so the ground isn't edge-on.
// Becomes the fixed-angle follow rig in Task 5.
export function createCamera() {
  const camera = new THREE.PerspectiveCamera(
    60, // vertical FOV in degrees
    window.innerWidth / window.innerHeight, // aspect
    0.1, // near clip
    1000 // far clip
  );
  camera.position.set(0, 8, 8);
  camera.lookAt(0, 0, 0);
  return camera;
}
