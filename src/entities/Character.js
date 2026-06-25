import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// One shared loader instance is fine for all characters.
const loader = new GLTFLoader();

// An animated character ≈ a Unity GameObject with an Animator.
// Loading is ASYNC, so model/mixer start null and methods no-op until ready.
// Arrow callbacks keep `this` bound to the instance.
export class Character {
  constructor(scene, modelUrl) {
    this.scene = scene;
    this.model = null; // glTF root once loaded
    this.mixer = null; // AnimationMixer ≈ Unity Animator
    this.actions = {}; // name -> AnimationAction (pre-built for crossfading)
    this.current = null; // name of the active action
    this.turnSpeed = 6; // how fast the model rotates to face travel direction

    loader.load(
      modelUrl,
      (gltf) => this._onLoad(gltf),
      undefined, // onProgress (skipped)
      (err) => console.error(`Failed to load ${modelUrl}:`, err)
    );
  }

  _onLoad(gltf) {
    const model = gltf.scene;
    // Traverse to the meshes and flag them as shadow casters (and self-shadowers).
    model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    this.scene.add(model);
    this.model = model;

    // Build an action per clip up front so we can crossfade between them.
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      this.actions[clip.name] = this.mixer.clipAction(clip);
    }

    // Start in Idle.
    this.current = "Idle";
    this.actions["Idle"]?.play();

    console.log("Character loaded. Clips:", Object.keys(this.actions));
  }

  // Crossfade to a named clip (≈ Unity Animator transition). No-op if already on it.
  setAction(name, fade = 0.2) {
    if (this.current === name) return;
    const next = this.actions[name];
    if (!next) return;
    const prev = this.actions[this.current];
    if (prev) prev.fadeOut(fade);
    next.reset().fadeIn(fade).play();
    this.current = name;
  }

  // Convenience: Run while moving, Idle when stopped.
  setMoving(isMoving) {
    this.setAction(isMoving ? "Run" : "Idle");
  }

  // Smoothly rotate the model to face a world-XZ direction (normalized).
  // Model forward is +Z at yaw 0, so target yaw = atan2(dir.x, dir.z).
  faceDirection(dir, dt) {
    if (!this.model) return;
    const target = Math.atan2(dir.x, dir.z);
    let delta = target - this.model.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest path, wrapped to [-pi,pi]
    this.model.rotation.y += delta * Math.min(1, this.turnSpeed * dt);
  }

  // Called every frame ≈ Update(). dt = seconds since last frame.
  update(dt) {
    if (this.mixer) this.mixer.update(dt);
  }
}
