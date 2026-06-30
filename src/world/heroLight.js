import * as THREE from "three";
import { COLORS } from "../config/palette.js";

// Warm hero fill light parented to the camera, so the character's visible side is
// always lit and pops warm. Follows the view automatically. Lights standard materials
// (character, ground), not the custom grass shader, so the grass stays cool.
// The camera must be in the scene graph for this child light to count.
export function addHeroLight(camera) {
  const light = new THREE.DirectionalLight(COLORS.HERO, 1.3); // dialed down, morning is already bright
  light.position.set(0, 1.5, 3.5); // camera-local: mostly behind the camera, a bit up
  camera.add(light);
  camera.add(light.target); // target at camera origin so light rakes toward the view
  return light;
}
