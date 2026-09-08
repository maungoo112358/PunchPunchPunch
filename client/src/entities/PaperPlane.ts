import * as THREE from "three";

// Rough placeholder shape for flight-testing the glide physics (docs/Phase1.md). Not meant to look good
// yet, it only needs a visible nose so banking and pitching read clearly on screen. Swap for a real
// folded-paper look once the flight feel is locked in; that is a visual pass, not a physics one, and it
// is the owner's call, not this file's.

export function createPaperPlane(color: number) {
  const group = new THREE.Group();

  // A flattened 4-sided cone: the apex is the nose, the square base is the tail. Cheap way to get a
  // dart-like silhouette without hand-authoring vertices.
  const bodyGeo = new THREE.ConeGeometry(1.4, 3.2, 4);
  bodyGeo.rotateX(Math.PI / 2); // the cone points +Y by default; this turns it to point +Z (nose forward)
  bodyGeo.scale(1, 0.25, 1); // flatten it into a wedge. Not thinner than this: banked hard and viewed
  // from behind (the chase camera's default view), a thinner wedge presents almost edge-on and can
  // nearly vanish, which reads as the plane nose-diving even though altitude has not actually changed.

  const material = new THREE.MeshStandardMaterial({ color, flatShading: true });
  const body = new THREE.Mesh(bodyGeo, material);
  body.castShadow = true;
  group.add(body);

  // model is the shape every follower (camera, grass, sun) already expects: { model: Object3D | null },
  // the same minimal shape Character.ts exposes. forward is extra: glideFlight writes the plane's actual
  // heading into it every frame, and cameraFollow reads it to lock the chase camera onto that heading
  // instead of its own independent one (see cameraFollow.ts, "vehicle mode").
  return { model: group as THREE.Object3D, forward: new THREE.Vector3(0, 0, 1) };
}

export type PaperPlane = ReturnType<typeof createPaperPlane>;
