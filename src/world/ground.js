import * as THREE from "three";
import { COLORS } from "../config/palette.js";

// The flat ground plane everything stands on. Returns the mesh for later use.
export function addGround(scene) {
  // PlaneGeometry is born in the XY plane facing +Z (standing up like a wall).
  // Rotate it -90° about X to lay it flat in XZ with its normal pointing +Y (up).
  // 1x1 segments is plenty for a flat plane; segments only matter once we displace
  // vertices (terrain/grass later).
  const geometry = new THREE.PlaneGeometry(200, 200, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: COLORS.GROUND }); // fresh grass green
  const ground = new THREE.Mesh(geometry, material);
  ground.rotation.x = -Math.PI / 2; // lay flat: normal now faces up (+Y)
  ground.receiveShadow = true; // catches the character's shadow
  scene.add(ground);
  return ground;
}
