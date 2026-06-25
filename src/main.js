import * as THREE from "three";

console.log("PunchPunchPunch booting...");

// --- Renderer ---------------------------------------------------------------
// The WebGLRenderer owns the <canvas> and does the actual drawing each frame.
// (Unity: the render pipeline + the game window rolled into one object.)
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
// Clamp pixel ratio to 2: on high-DPI screens this keeps things crisp without
// rendering 3x+ the pixels (which murders performance for no visible gain).
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// --- Scene ------------------------------------------------------------------
// The scene graph root. Everything we draw (meshes, lights) gets added here.
const scene = new THREE.Scene();
// A dim slate-blue background so a working frame is visibly NOT pure black.
scene.background = new THREE.Color(0x1a1d2e);

// --- Camera -----------------------------------------------------------------
// PerspectiveCamera(fov, aspect, near, far) — defines the view frustum.
// This is just a plain viewpoint for now; the PoE2 fixed-angle follow rig is Task 5.
const camera = new THREE.PerspectiveCamera(
  60,                                   // vertical FOV in degrees
  window.innerWidth / window.innerHeight, // aspect ratio
  0.1,                                  // near clip
  1000                                  // far clip
);
camera.position.set(0, 0, 5);           // back off along +Z so we can see the origin
camera.lookAt(0, 0, 0);

// --- Lights -----------------------------------------------------------------
// DirectionalLight ≈ a Unity directional light / sun: parallel rays, has a
// direction (set via its position relative to the target at origin), no falloff.
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(3, 4, 5);
scene.add(sun);
// AmbientLight ≈ flat ambient/environment fill so shadowed faces aren't pure black.
const ambient = new THREE.AmbientLight(0xffffff, 0.3);
scene.add(ambient);

// --- Test cube (temporary proof-of-life) ------------------------------------
// MeshStandardMaterial is physically-based and LIT — it needs the lights above.
const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshStandardMaterial({ color: 0xffdb4d }); // yellow
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

// --- Render loop ------------------------------------------------------------
// setAnimationLoop is Three's frame driver (requestAnimationFrame under the hood).
// This callback ≈ Unity's Update(): it runs once per displayed frame.
renderer.setAnimationLoop(() => {
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.015;
  renderer.render(scene, camera);
});

// --- Resize handling --------------------------------------------------------
// Keep the camera aspect + renderer size in sync with the window so the image
// never stretches. updateProjectionMatrix() must be called after changing aspect.
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
