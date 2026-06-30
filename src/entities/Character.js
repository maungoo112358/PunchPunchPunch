import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// One shared loader instance is fine for all characters.
const loader = new GLTFLoader();

// Reused scratch for orient() so we don't allocate every frame.
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _targetQuat = new THREE.Quaternion();

// An animated character ≈ a Unity GameObject with an Animator.
// Loading is ASYNC, so model/mixer start null and methods no-op until ready.
// Arrow callbacks keep `this` bound to the instance.
export class Character {
  constructor(scene, modelUrl, spawn = null) {
    this.scene = scene;
    this.spawn = spawn; // optional world spawn position, applied once the model loads (async)
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
    if (this.spawn) model.position.copy(this.spawn); // place on the surface (origin would bury it inside the planet)
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

  // Orient the model on the curved surface: stand its local +Y up along the surface normal
  // (`up`) and face its local +Z along `forward`. Both are world-space; `forward` need not be
  // perpendicular to `up` — we flatten it into the tangent plane here. Slerps toward the target
  // so turning + tilting (as the ground curves underfoot) are both smooth. Replaces the old
  // flat-world rotation.y because "facing" on a sphere is a full orientation, not one angle.
  orient(up, forward, dt) {
    if (!this.model) return;
    // Flatten forward into the tangent plane (remove any component along up), then normalize.
    _fwd.copy(forward).addScaledVector(up, -forward.dot(up));
    if (_fwd.lengthSq() < 1e-8) return; // forward ~parallel to up → no valid heading, skip
    _fwd.normalize();
    _right.crossVectors(up, _fwd).normalize(); // local +X = up × forward (right-handed: X×Y=Z=forward)
    _basis.makeBasis(_right, up, _fwd); // columns: +X, +Y, +Z
    _targetQuat.setFromRotationMatrix(_basis);
    this.model.quaternion.slerp(_targetQuat, Math.min(1, this.turnSpeed * dt));
  }

  // Called every frame ≈ Update(). dt = seconds since last frame.
  update(dt) {
    if (this.mixer) this.mixer.update(dt);
  }
}
