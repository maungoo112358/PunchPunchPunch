import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { COLORS } from "../config/palette.js";

// Environment props (Stylized Nature MegaKit). SPIKE: a single tree placed off-center near
// the spawn (character spawns at origin), just to judge scale + how it reads under the
// twilight lighting. The real scatter/instancing system comes next once we agree placement.
const loader = new GLTFLoader();

export function addProps(scene) {
  loader.load(
    "/models/nature/CommonTree_1.gltf",
    (gltf) => {
      const tree = gltf.scene;
      tree.position.set(4, 0, 2); // off-center, a few units from the character at origin
      tree.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        const mat = o.material;
        // Foliage only (material "Leaves_NormalTree"): cool the bright daytime green into the
        // twilight, and double-side the leaf cards so both faces catch the moonlight (the inner
        // cards were rendering pure black). Bark is left as-is — it sits fine warm.
        if (mat && /leaves|leaf/i.test(mat.name)) {
          mat.color.setHex(COLORS.LEAF); // multiplies the green texture toward cool teal
          mat.side = THREE.DoubleSide; // light both faces → kills the black hollow core
          mat.roughness = 1; // matte, no twilight shine
          mat.metalness = 0;
          mat.needsUpdate = true;
        }
      });
      scene.add(tree);
      console.log("Tree loaded at", tree.position);
    },
    undefined,
    (err) => console.error("Failed to load tree:", err)
  );
}
