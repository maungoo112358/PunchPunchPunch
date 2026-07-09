import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// One shared loader instance is fine for all characters.
const loader = new GLTFLoader();

// Reused scratch for orient() so we don't allocate every frame.
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _targetQuat = new THREE.Quaternion();

// How many flat light bands the toon shading uses. 2 = just lit/shadow, higher = more steps of
// form. This is the main dial for the cel look, try bumping it and watch the robe.
const TOON_STEPS = 3;

// How dark the shadow band is allowed to get. 0 = pure black, 1 = no shadow at all. We lift it off
// zero so the shadow side keeps its color and the character pops instead of turning into a
// silhouette. Raise it to lighten the shadows more.
const TOON_SHADOW_FLOOR = 0.4;

// The ink line. Color is the outline, thickness is how far the shell is pushed out in the model's
// own units, so a bigger model needs a bigger number. Tune thickness by eye until the line reads.
const OUTLINE_COLOR = 0x141414; // near-black, a hair softer than pure black
const OUTLINE_THICKNESS = 0.03;

// Build a tiny ramp texture (TOON_STEPS wide, 1 tall) going dark to light. The darkest step starts
// at TOON_SHADOW_FLOOR instead of 0, then it climbs to full bright. The toon material reads how lit
// a spot is (a 0..1 number) and looks it up in this ramp, so a smooth fade becomes a few hard
// bands, the cel-shaded anime look. NearestFilter snaps to the nearest step with no blending, which
// is what keeps the band edges crisp.
function makeToonGradient(steps) {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = steps > 1 ? i / (steps - 1) : 1; // 0 at the darkest band, 1 at the brightest
    data[i] = Math.round((TOON_SHADOW_FLOOR + (1 - TOON_SHADOW_FLOOR) * t) * 255);
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// The outline is the classic "inverted hull": draw the model a second time, flat black, showing
// only its BACK faces, with every vertex pushed outward along a normal. The pushed-out back shell
// pokes past the real model's edges, so all you see is a thin black rim hugging the silhouette.
// Sharing this one material across all the meshes keeps it cheap.
// Two things worth knowing: we push the vertex BEFORE the skinning step so the shell bends with the
// animation, not a frozen T-pose. And we push along aSmoothNormal (a welded normal we compute in
// addSmoothNormals), not the raw normal, so the shell does not tear open at the model's hard edges.
function makeOutlineMaterial() {
  const mat = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = { value: OUTLINE_THICKNESS };
    shader.vertexShader = "uniform float uOutline;\nattribute vec3 aSmoothNormal;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n\ttransformed += normalize(aSmoothNormal) * uOutline;"
    );
  };
  return mat;
}

// Weld the outline's push directions so the ink line stops cracking. A low-poly model splits its
// vertices at every hard edge and gives each copy a different normal, so pushing the shell along
// those split normals tears it apart at the seam. Here we group every vertex by its position, add
// up all the normals sharing a spot, and store that averaged, re-normalized direction in a new
// aSmoothNormal attribute. The outline pushes along that, so corners that used to fly apart now
// move together and the line stays solid. The real mesh keeps its own crisp normals, untouched.
function addSmoothNormals(geometry) {
  if (geometry.attributes.aSmoothNormal) return; // meshes can share geometry, only do it once
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  if (!pos || !nor) return;
  const buckets = new Map(); // rounded-position key -> summed normal [x, y, z]
  const keyAt = (i) =>
    `${Math.round(pos.getX(i) * 1e4)}_${Math.round(pos.getY(i) * 1e4)}_${Math.round(pos.getZ(i) * 1e4)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = keyAt(i);
    let sum = buckets.get(k);
    if (!sum) buckets.set(k, (sum = [0, 0, 0]));
    sum[0] += nor.getX(i);
    sum[1] += nor.getY(i);
    sum[2] += nor.getZ(i);
  }
  const smooth = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const sum = buckets.get(keyAt(i));
    v.set(sum[0], sum[1], sum[2]);
    if (v.lengthSq() > 1e-12) v.normalize();
    else v.set(nor.getX(i), nor.getY(i), nor.getZ(i)); // opposite normals cancelled out, fall back to raw
    smooth[i * 3] = v.x;
    smooth[i * 3 + 1] = v.y;
    smooth[i * 3 + 2] = v.z;
  }
  geometry.setAttribute("aSmoothNormal", new THREE.BufferAttribute(smooth, 3));
}

// An animated character (~ a Unity GameObject with an Animator).
// Loading is async, so model/mixer start null and methods no-op until ready.
// Arrow callbacks keep `this` bound to the instance.
export class Character {
  constructor(scene, modelUrl, spawn = null) {
    this.scene = scene;
    this.spawn = spawn; // optional world spawn position, applied once the model loads
    this.model = null; // glTF root once loaded
    this.mixer = null; // AnimationMixer (~ Unity Animator)
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
    // One shared ramp and one shared outline material for every mesh, so they all match.
    const gradient = makeToonGradient(TOON_STEPS);
    const outlineMat = makeOutlineMaterial();
    // Traverse to the meshes: flag them as shadow casters, and swap their realistic material for a
    // toon one. We keep the model's painted texture and base color, but change how light reads on
    // it: flat cel bands instead of a smooth gradient. Collect the meshes as we go so we can add
    // outline shells right after, not during, the walk (adding children mid walk would make traverse
    // visit them too).
    const meshes = [];
    model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true; // he still drops a shadow on the grass, so he stays grounded
        // But he does NOT receive shadows on himself. Otherwise the hat brim casts a hard dark bar
        // across his eyes. The cel ramp is meant to be the only thing shading him, clean like anime.
        obj.receiveShadow = false;
        const toonify = (mat) =>
          new THREE.MeshToonMaterial({
            map: mat.map || null, // reuse the glTF's painted texture as the base color
            color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
            gradientMap: gradient,
          });
        // A mesh can carry one material or an array of them, so handle both.
        obj.material = Array.isArray(obj.material) ? obj.material.map(toonify) : toonify(obj.material);
        meshes.push(obj);
      }
    });

    // Give each mesh its black outline shell. For a rigged (skinned) mesh the shell has to share the
    // same skeleton and bind matrices, or it would hang in a frozen T-pose while the body animates.
    // We parent the shell to its mesh so it inherits the same place in the world.
    for (const obj of meshes) {
      addSmoothNormals(obj.geometry); // welded push directions so the shell does not crack at hard edges
      const shell = obj.isSkinnedMesh
        ? new THREE.SkinnedMesh(obj.geometry, outlineMat)
        : new THREE.Mesh(obj.geometry, outlineMat);
      if (obj.isSkinnedMesh) {
        shell.skeleton = obj.skeleton;
        shell.bindMode = obj.bindMode;
        shell.bindMatrix.copy(obj.bindMatrix);
        shell.bindMatrixInverse.copy(obj.bindMatrixInverse);
      }
      shell.castShadow = false; // the shell is just a rim, it should not throw its own shadow
      shell.receiveShadow = false;
      shell.frustumCulled = false; // share the body's fate on screen, never cull it on its own
      obj.add(shell);
    }
    if (this.spawn) model.position.copy(this.spawn); // place on surface (origin would bury it in the planet)
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

  // Crossfade to a named clip (~ Unity Animator transition). No-op if already on it.
  setAction(name, fade = 0.2) {
    if (this.current === name) return;
    const next = this.actions[name];
    if (!next) return;
    const prev = this.actions[this.current];
    if (prev) prev.fadeOut(fade);
    next.reset().fadeIn(fade).play();
    this.current = name;
  }

  // Orient the model on the surface: stand local +Y along the surface normal (`up`) and face
  // local +Z along `forward`. Both are world-space; `forward` need not be perpendicular to `up`
  // (flattened into the tangent plane here). Slerps toward the target so turning and tilting stay
  // smooth. Facing on a sphere is a full orientation, not one angle, so this replaces rotation.y.
  orient(up, forward, dt) {
    if (!this.model) return;
    // Flatten forward into the tangent plane (remove the component along up), then normalize.
    _fwd.copy(forward).addScaledVector(up, -forward.dot(up));
    if (_fwd.lengthSq() < 1e-8) return; // forward ~parallel to up, no valid heading, skip
    _fwd.normalize();
    _right.crossVectors(up, _fwd).normalize(); // local +X = up cross forward
    _basis.makeBasis(_right, up, _fwd); // columns: +X, +Y, +Z
    _targetQuat.setFromRotationMatrix(_basis);
    this.model.quaternion.slerp(_targetQuat, Math.min(1, this.turnSpeed * dt));
  }

  // Called every frame (~ Update()). dt = seconds since last frame.
  update(dt) {
    if (this.mixer) this.mixer.update(dt);
  }
}
