import * as THREE from "three";
import { COLORS } from "../config/palette.js";

// A warm "hero" fill light ATTACHED to the camera, so the character's visible side
// is always lit and pops warm against the cool twilight. Because it's parented to
// the camera, it follows the view automatically. It lights standard materials
// (character, ground) — not the custom grass shader, so the grass stays cool.
// NOTE: the camera must be added to the scene graph for this child light to count.
export function addHeroLight(camera) {
  const light = new THREE.DirectionalLight(COLORS.HERO, 2.8);
  light.position.set(0, 1.5, 3.5); // camera-local: mostly behind the camera (rakes the back), a bit up
  camera.add(light);
  camera.add(light.target); // target at camera origin → light rakes toward the view
  return light;
}
