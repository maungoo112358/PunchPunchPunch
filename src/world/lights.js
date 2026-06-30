import * as THREE from "three";
import { COLORS } from "../config/palette.js";

// The outdoor lighting rig: a warm directional "sun" (the key light, casts shadows)
// plus a HemisphereLight fill. Returns the lights in case callers want to tweak them.
export function addLights(scene) {
  // DirectionalLight ≈ Unity directional light / sun: parallel rays, no falloff.
  const sun = new THREE.DirectionalLight(COLORS.SUN, 1.5); // warm gold key (hybrid morning)
  sun.position.set(5, 5, 4); // mid-morning angle — warm light, gentler shadows

  // Shadow casting + the light's ORTHOGRAPHIC shadow camera. Bound it tightly to the
  // area of interest (±10 around origin) so shadow-map pixels aren't wasted on empty
  // space — that's what keeps the shadow crisp instead of blocky.
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 50;
  sun.shadow.camera.left = -10;
  sun.shadow.camera.right = 10;
  sun.shadow.camera.top = 10;
  sun.shadow.camera.bottom = -10;
  sun.shadow.normalBias = 0.05; // nudge along normals to kill "shadow acne" stripes
  scene.add(sun);
  scene.add(sun.target); // in the scene graph so sunFollow can move the shadow box

  // HemisphereLight ≈ Unity's "Gradient" environment lighting: sky color from above,
  // ground-bounce color from below, blended per surface normal. Natural outdoor fill.
  const hemi = new THREE.HemisphereLight(COLORS.SKY, COLORS.GROUND_BOUNCE, 0.95); // cool blue sky fill vs warm key
  scene.add(hemi);

  return { sun, hemi };
}
