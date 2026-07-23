import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneRig } from "three/addons/utils/SkeletonUtils.js";

// One shared loader instance is fine for all characters.
const loader = new GLTFLoader();

// One download and one parse per model file, however many characters wear it. The map holds the
// in-flight promise, not the result, so five characters asking at the same moment all wait on the
// same fetch instead of starting five. The loaded glTF is kept as a master copy and never added to
// the scene: each character clones it.
const loads = new Map<string, Promise<GLTF>>();

function loadModel(url: string) {
  let pending = loads.get(url);
  if (!pending) {
    pending = new Promise<GLTF>((resolve, reject) => loader.load(url, resolve, undefined, reject));
    loads.set(url, pending);
  }
  return pending;
}

// Warm the shared cache so every character model is fetched and parsed at boot, not the moment someone
// joins wearing one, which would leave them as nothing on screen for a beat.
export function preloadModels(urls: string[]) {
  for (const url of urls) loadModel(url);
}

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
function makeToonGradient(steps: number) {
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
function addSmoothNormals(geometry: THREE.BufferGeometry) {
  if (geometry.attributes.aSmoothNormal) return; // meshes can share geometry, only do it once
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  if (!pos || !nor) return;
  const buckets = new Map<string, number[]>(); // rounded-position key -> summed normal [x, y, z]
  const keyAt = (i: number) =>
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
    // The ! says this is definitely there. The loop just above put a bucket in for every single vertex,
    // using these exact same keys, so a miss is not possible.
    const sum = buckets.get(keyAt(i))!;
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
  // TypeScript wants a class to say up front what it carries, the way C# does. In plain JavaScript these
  // fields spring into being the moment the constructor assigns them; here they have to be listed. The
  // constructor below is unchanged and still does the actual assigning.
  scene: THREE.Scene;
  spawn: THREE.Vector3 | null;
  model: THREE.Object3D | null;
  mixer: THREE.AnimationMixer | null;
  actions: Record<string, THREE.AnimationAction>;
  current: string | null;
  modelUrl: string | null; // the model currently loaded or loading, so setModel can no-op a repeat

  // modelUrl may be null: the instance exists (so the camera, grass and nameplate can hold it) but wears
  // nothing until setModel is called, which is what lets a player's model wait for the server to say which.
  constructor(scene: THREE.Scene, modelUrl: string | null = null, spawn: THREE.Vector3 | null = null) {
    this.scene = scene;
    this.spawn = spawn; // optional world spawn position, applied once the model loads
    this.model = null; // glTF root once loaded
    this.mixer = null; // AnimationMixer (~ Unity Animator)
    this.actions = {}; // name -> AnimationAction (pre-built for crossfading)
    this.current = null; // name of the active action
    this.modelUrl = null;

    if (modelUrl) this.setModel(modelUrl);
  }

  // Load a model, or swap to a different one, keeping this same Character instance so everything holding
  // it stays valid. A no-op if already wearing this model. The load is shared and cached across
  // characters, so a preloaded model swaps in with no fetch.
  setModel(url: string) {
    if (url === this.modelUrl) return;
    this._clearModel();
    this.modelUrl = url;
    loadModel(url)
      .then((gltf) => {
        if (this.modelUrl === url) this._onLoad(gltf); // ignore a load that finished after another swap
      })
      .catch((err) => console.error(`Failed to load ${url}:`, err));
  }

  _onLoad(gltf: GLTF) {
    // Clone the master copy, because several characters can share one glTF. It has to be the rig-aware
    // clone: a plain .clone() copies the meshes but leaves them pointing at the original's skeleton, so
    // every copy would collapse onto whatever the first one is doing. cloneRig rebuilds the bones and
    // rebinds each mesh to its own, while still sharing the geometry, so the copies are cheap.
    const model = cloneRig(gltf.scene);
    // One shared ramp and one shared outline material for every mesh, so they all match.
    const gradient = makeToonGradient(TOON_STEPS);
    const outlineMat = makeOutlineMaterial();
    // Traverse to the meshes: flag them as shadow casters, and swap their realistic material for a
    // toon one. We keep the model's painted texture and base color, but change how light reads on
    // it: flat cel bands instead of a smooth gradient. Collect the meshes as we go so we can add
    // outline shells right after, not during, the walk (adding children mid walk would make traverse
    // visit them too).
    const meshes: THREE.Mesh[] = [];
    model.traverse((obj) => {
      // traverse walks every node in the model and hands each one back as a plain Object3D, which has no
      // material and no isMesh. isMesh is three's own "I am a mesh" marker, so we take the Object3D as a
      // Mesh just long enough to ask, and keep that view for the rest of the block. Same object either
      // way, we are only telling TypeScript what it already is.
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true; // he still drops a shadow on the grass, so he stays grounded
        // But he does NOT receive shadows on himself. Otherwise the hat brim casts a hard dark bar
        // across his eyes. The cel ramp is meant to be the only thing shading him, clean like anime.
        mesh.receiveShadow = false;
        // Material is the plain base type here, which has no map or color: those live on the specific
        // materials the glTF actually uses. Reading them through MeshStandardMaterial is how we get at
        // them without knowing exactly which kind came out of the file.
        const toonify = (mat: THREE.Material) => {
          const src = mat as THREE.MeshStandardMaterial;
          return new THREE.MeshToonMaterial({
            map: src.map || null, // reuse the glTF's painted texture as the base color
            color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
            gradientMap: gradient,
          });
        };
        // A mesh can carry one material or an array of them, so handle both.
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toonify) : toonify(mesh.material);
        meshes.push(mesh);
      }
    });

    // Give each mesh its black outline shell. For a rigged (skinned) mesh the shell has to share the
    // same skeleton and bind matrices, or it would hang in a frozen T-pose while the body animates.
    // We parent the shell to its mesh so it inherits the same place in the world.
    for (const obj of meshes) {
      addSmoothNormals(obj.geometry); // welded push directions so the shell does not crack at hard edges
      // Same trick as above: isSkinnedMesh, skeleton and the bind matrices only exist on a SkinnedMesh,
      // so we look at the mesh as one to reach them. The check itself decides whether it really is.
      const rigged = obj as THREE.SkinnedMesh;
      const shell = rigged.isSkinnedMesh
        ? new THREE.SkinnedMesh(obj.geometry, outlineMat)
        : new THREE.Mesh(obj.geometry, outlineMat);
      if (rigged.isSkinnedMesh) {
        const riggedShell = shell as THREE.SkinnedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
        riggedShell.skeleton = rigged.skeleton;
        riggedShell.bindMode = rigged.bindMode;
        riggedShell.bindMatrix.copy(rigged.bindMatrix);
        riggedShell.bindMatrixInverse.copy(rigged.bindMatrixInverse);
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
  setAction(name: string, fade = 0.2) {
    if (this.current === name) return;
    const next = this.actions[name];
    if (!next) return;
    // current starts out null, and you cannot look something up by null. Before, JavaScript quietly
    // turned the null into the text "null", found no clip under that name, and handed back nothing. The
    // check does the same thing out loud. In practice we never get here with a null: the line above
    // bails out until the clips have loaded, and by then current is "Idle".
    const prev = this.current ? this.actions[this.current] : undefined;
    if (prev) prev.fadeOut(fade);
    next.reset().fadeIn(fade).play();
    this.current = name;
  }

  // Orient the model on the surface: stand local +Y along the surface normal (`up`) and face
  // local +Z along `forward`. Both are world-space; `forward` need not be perpendicular to `up`
  // (flattened into the tangent plane here). Facing on a sphere is a full orientation, not one
  // angle, so this replaces rotation.y.
  // This used to ease toward the target a bit each frame. That easing is now a tick of the movement
  // sim instead, because facing is state the server owns and shares, so it cannot be something the
  // client quietly does on its own. What arrives here is already the facing for this exact moment.
  orient(up: THREE.Vector3, forward: THREE.Vector3) {
    if (!this.model) return;
    // Flatten forward into the tangent plane (remove the component along up), then normalize.
    _fwd.copy(forward).addScaledVector(up, -forward.dot(up));
    if (_fwd.lengthSq() < 1e-8) return; // forward ~parallel to up, no valid heading, skip
    _fwd.normalize();
    _right.crossVectors(up, _fwd).normalize(); // local +X = up cross forward
    _basis.makeBasis(_right, up, _fwd); // columns: +X, +Y, +Z
    _targetQuat.setFromRotationMatrix(_basis);
    this.model.quaternion.copy(_targetQuat);
  }

  // Called every frame (~ Update()). dt = seconds since last frame.
  update(dt: number) {
    if (this.mixer) this.mixer.update(dt);
  }

  // Take the current model off the screen and free its per-instance bits, keeping the instance itself so
  // a new model can be set. Geometry and textures are shared with the master copy and the other
  // characters, so they are deliberately left alone; the materials are made per character, so those go.
  _clearModel() {
    if (this.mixer) this.mixer.stopAllAction();
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) mat.dispose();
      });
    }
    this.model = null;
    this.mixer = null;
    this.actions = {};
    this.current = null;
  }

  // Take this character off the screen for good, for when a player leaves. After this the instance wears
  // nothing and is done.
  dispose() {
    this._clearModel();
    this.modelUrl = null;
  }
}
