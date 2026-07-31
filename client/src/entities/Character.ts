import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneRig } from "three/addons/utils/SkeletonUtils.js";
import { profileForModel, PROP_DONOR, HAND_BONE, type ModelProfile } from "../config/characters.js";
import { ATTACK_TICKS, TICK_DT } from "../systems/sim.js";

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
const _up = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _lean = new THREE.Quaternion();

// The knock a hit gives. PUSH is how far the model slides at full strength in world units, TILT is how
// far it leans in radians, and DECAY is the fraction of the knock left after one second, so a small
// number springs back fast. Eye-tune all three: too much and the dummy skates across the grass.
const RECOIL_PUSH = 0.5;
const RECOIL_TILT = 0.32;
const RECOIL_DECAY = 0.0005;

// How many flat light bands the toon shading uses. 2 = just lit/shadow, higher = more steps of
// form. This is the main dial for the cel look, try bumping it and watch the robe.
const TOON_STEPS = 3;

// How dark the shadow band is allowed to get. 0 = pure black, 1 = no shadow at all. We lift it off
// zero so the shadow side keeps its color and the character pops instead of turning into a
// silhouette. Raise it to lighten the shadows more.
const TOON_SHADOW_FLOOR = 0.4;

// The ink line. Every model shares this color, but not the thickness: that is a push in the model's own
// units, so a model built at a different size needs a different number and it lives in the model's
// profile. Tune it by eye until the line reads.
const OUTLINE_COLOR = 0x141414; // near-black, a hair softer than pure black

// Clips that play through once and hold on their last frame, instead of looping forever like the walk.
// Named in the SIM's vocabulary, so the lookup goes through _clip the same as everything else.
const ONE_SHOT = new Set(["Attack"]);

// How long the sim roots a caster for each cast animation, in seconds, one per variant. Every clip is
// stretched or squeezed to last exactly its own entry, so the arm finishes on the frame the root lets go
// however the clip was authored, AND a variant given a longer entry genuinely plays slower rather than
// being cut off. Read from the sim rather than typed in, so the two cannot drift apart.
const CAST_SECONDS = ATTACK_TICKS.map((ticks) => ticks * TICK_DT);

// How long a crossfade takes. Locomotion wants the slow one, because Idle into Run is a change of mood
// and it should read as a change of mood. A cast wants the fast one: the whole clip is under a second, so
// a fifth of it spent blending in makes the swing feel like it starts late.
const FADE = 0.2;
const SNAP_FADE = 0.06;

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
function makeOutlineMaterial(thickness: number) {
  const mat = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = { value: thickness };
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

// How much larger a mesh ends up in the world than the numbers stored in its geometry.
//
// This exists because of where the ink line is applied. The shell is pushed out in the geometry's own
// units, inside the vertex shader, so every scale sitting between that geometry and the world multiplies
// the push. Profiles give the outline as a width in world units, which is the only way to compare one
// model against another by eye, and dividing by this turns it back into the units the shader wants.
//
// The catch that made this necessary: a file can carry scales of its own. The training dummy's mesh hangs
// under a node scaled by a hundred, so an outline that read as a sensible number in the profile came out
// a hundred times too thick and covered the screen in black. Reading the finished world matrix catches
// that wherever it hides, rather than trusting the profile's scale to be the whole story.
function geometryToWorldScale(root: THREE.Object3D) {
  const scale = new THREE.Vector3();
  let found = 0;
  root.traverse((obj) => {
    if (found) return; // every mesh in these models shares one scale, so the first answer is the answer
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      scale.setFromMatrixScale(mesh.matrixWorld);
      found = scale.x;
    }
  });
  return found || 1; // no meshes at all, so nothing will be drawn and the number does not matter
}

// Give this rig the thing its profile says it holds, borrowing it from another model when its own file
// does not contain one. Four of the five characters ship no wand at all, so theirs is cloned off the mage.
//
// This only works because the whole pack is one rig. handslot.r exists under the same name and with the
// same local transform in every file, and the wand is an ordinary mesh parented to that bone rather than
// a skinned one, so re-parenting the clone puts it in the hand with no fitting-up of its own.
//
// Called before the toon pass on purpose, so the grafted wand goes through the same material swap and
// gets the same ink outline as the body. Attach it afterwards and it would be the one object in the
// scene still wearing its realistic material.
function graftHeld(rig: THREE.Object3D, donor: THREE.Object3D, name: string) {
  if (!name || findNode(rig, name)) return; // holds nothing, or already has its own
  const source = findNode(donor, name);
  const hand = findNode(rig, HAND_BONE);
  if (!source || !hand) {
    console.warn(`[character] cannot graft "${name}": ${!source ? "donor has none" : "no " + HAND_BONE}`);
    return;
  }
  hand.add(source.clone());
}

// Find a node by the name the glTF FILE uses, which is not always the name three ends up with.
//
// GLTFLoader runs every node name through PropertyBinding.sanitizeNodeName, which deletes the characters
// the animation system reserves for its own paths: dot, colon, slash and square brackets. The hand bone
// is called "handslot.r" in the file and therefore "handslotr" in the scene, so asking for it by the name
// you can read in the model bounces off and the wand silently never gets attached. Comparing both names
// with those characters stripped means it does not matter which spelling the caller happens to have.
const RESERVED = /[.:/[\]]/g;

function findNode(root: THREE.Object3D, name: string) {
  const wanted = name.replace(RESERVED, "");
  let found: THREE.Object3D | undefined;
  root.traverse((obj) => {
    if (!found && obj.name.replace(RESERVED, "") === wanted) found = obj;
  });
  return found;
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
  profile: ModelProfile; // the loaded model's clip names, ink thickness and sizing
  held: THREE.Object3D | null; // the wand, so a spell can be launched from its tip
  heldTip: THREE.Vector3; // the far end of the wand in the wand's OWN space, measured once at load
  attackClip: string; // which cast variant this cast rolled, held so _clip stays consistent all the way through
  _hitDir: THREE.Vector3; // which way the last hit pushed, world space
  _hitAmount: number; // how much of that knock is left, 1 at the moment of impact, decaying to 0

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
    this.profile = profileForModel(""); // replaced the moment a real model is set
    this.held = null;
    this.heldTip = new THREE.Vector3();
    this.attackClip = "Attack"; // replaced by a real variant the first time a cast starts
    this._hitDir = new THREE.Vector3();
    this._hitAmount = 0;

    if (modelUrl) this.setModel(modelUrl);
  }

  // The cast animations this model rotates through. Falls back to whatever single clip the profile maps
  // "Attack" to, so a model that lists no rotation still casts.
  attackClips() {
    return this.profile.attacks.length ? this.profile.attacks : [this.profile.clips.Attack ?? "Attack"];
  }

  // Say which cast animation this cast is using, as the index the SIM rolled. It is not chosen here any
  // more: the variants have different lengths now, so the sim has to decide which one to know how long
  // to root the player, and taking its answer is also what makes everyone watching draw the same spell.
  //
  // Guarded with a modulo because the index arrives over the network, from a server that could be
  // running a build with a longer list than this client has clips for.
  setAttackClip(index: number) {
    const clips = this.attackClips();
    this.attackClip = clips[index % clips.length];
  }

  // What this model calls the clip the sim asked for. Most models are asked for a name they already use,
  // so the lookup usually falls straight through. "Attack" is the exception: it resolves to whichever
  // variant the sim rolled for this cast, which is why it is remembered rather than worked out again.
  _clip(name: string) {
    if (name === "Attack") return this.attackClip;
    return this.profile.clips[name] ?? name;
  }

  // Load a model, or swap to a different one, keeping this same Character instance so everything holding
  // it stays valid. A no-op if already wearing this model. The load is shared and cached across
  // characters, so a preloaded model swaps in with no fetch.
  setModel(url: string) {
    if (url === this.modelUrl) return;
    this._clearModel();
    this.modelUrl = url;
    this.profile = profileForModel(url);
    // The donor comes along for the ride because four of the five characters have no wand of their own
    // and borrow the mage's. Both are in the shared cache after preload, so this resolves immediately.
    Promise.all([loadModel(url), loadModel(PROP_DONOR)])
      .then(([gltf, donor]) => {
        if (this.modelUrl === url) this._onLoad(gltf, donor); // ignore a load that finished after a swap
      })
      .catch((err) => console.error(`Failed to load ${url}:`, err));
  }

  _onLoad(gltf: GLTF, donor: GLTF) {
    // Clone the master copy, because several characters can share one glTF. It has to be the rig-aware
    // clone: a plain .clone() copies the meshes but leaves them pointing at the original's skeleton, so
    // every copy would collapse onto whatever the first one is doing. cloneRig rebuilds the bones and
    // rebinds each mesh to its own, while still sharing the geometry, so the copies are cheap.
    const rig = cloneRig(gltf.scene);

    // Put the wand in its hand before anything else looks at the meshes, so it is toon-shaded and outlined
    // along with the body instead of being the one shiny object left over.
    graftHeld(rig, donor.scene, this.profile.hold);

    // Size and lift before anything else, because the ink line's thickness is worked back from the scale
    // the meshes actually end up at.
    rig.scale.setScalar(this.profile.scale);
    rig.position.y = this.profile.lift;
    rig.updateWorldMatrix(true, true);

    // One shared ramp and one shared outline material for every mesh, so they all match.
    const gradient = makeToonGradient(TOON_STEPS);
    const outlineMat = makeOutlineMaterial(this.profile.outline / geometryToWorldScale(rig));
    // Traverse to the meshes: flag them as shadow casters, and swap their realistic material for a
    // toon one. We keep the model's painted texture and base color, but change how light reads on
    // it: flat cel bands instead of a smooth gradient. Collect the meshes as we go so we can add
    // outline shells right after, not during, the walk (adding children mid walk would make traverse
    // visit them too).
    const meshes: THREE.Mesh[] = [];
    rig.traverse((obj) => {
      // traverse walks every node in the model and hands each one back as a plain Object3D, which has no
      // material and no isMesh. isMesh is three's own "I am a mesh" marker, so we take the Object3D as a
      // Mesh just long enough to ask, and keep that view for the rest of the block. Same object either
      // way, we are only telling TypeScript what it already is.
      // Anything hanging off a hand slot is a prop the model can hold, and everything the profile did not
      // pick gets switched off here, before it is given a material or an outline shell. Asking the parent
      // rather than matching names means this covers every character without a list per model: the body
      // parts hang off Rig, head and chest, only the weapons hang off a handslot.
      if ((obj.parent?.name ?? "").startsWith("handslot") && obj.name !== this.profile.hold) {
        obj.visible = false;
        return;
      }
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
    // The rig goes inside a wrapper, and the wrapper is what the draw pass positions and turns. Sizing and
    // the foot lift were already applied to the rig above, so they survive the position written every
    // frame and they follow the model's own rotation rather than fighting it as the surface curves.
    const model = new THREE.Group();
    model.add(rig);
    if (this.spawn) model.position.copy(this.spawn); // place on surface (origin would bury it in the planet)
    this.scene.add(model);
    this.model = model;

    // Build an action per clip up front so we can crossfade between them. Keyed by the name the FILE uses,
    // which _clip translates the sim's name into.
    this.mixer = new THREE.AnimationMixer(rig);
    for (const clip of gltf.animations) {
      this.actions[clip.name] = this.mixer.clipAction(clip);
    }

    // A cast is one swing, not a loop, so it runs to the end and stops there. clampWhenFinished is what
    // makes it hold the last pose rather than snapping back to the first: without it the model twitches
    // back to the start of the wind-up for the moment before the sim lets go of the root.
    //
    // Every variant in the rotation gets the same treatment, each at its OWN speed: a clip authored at
    // 0.67s and one authored at 1.37s both have to finish in the sim's 0.53s, so they play at different
    // rates and end together. Working it out from clip.duration is what lets a name be added to the
    // profile's list without also hand-measuring it.
    //
    // Set once here rather than on every cast, because reset() rewinds a clip but leaves its speed
    // alone, so this survives being played again and again.
    const casts = this.attackClips();
    if (casts.length !== CAST_SECONDS.length) {
      // The clip names live in config/characters.ts and their lengths live in the sim, paired by
      // position, because the sim is mirrored into Go and cannot import a list of animation names. Two
      // lists paired by position WILL drift eventually, so say so loudly the moment they do rather than
      // letting a cast quietly run at the wrong speed.
      console.warn(
        `[character] ${casts.length} cast clips but ${CAST_SECONDS.length} cast lengths; ` +
          `config/characters.ts and systems/sim.ts have drifted apart`,
      );
    }
    casts.forEach((name, i) => {
      const action = this.actions[name];
      if (!action) {
        console.warn(`[character] ${this.modelUrl} has no cast clip "${name}"`);
        return;
      }
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.setEffectiveTimeScale(action.getClip().duration / (CAST_SECONDS[i] ?? CAST_SECONDS[0]));
    });

    // Find the wand and work out where its far end is, so a spell can be launched from the tip rather
    // than from somewhere inside the character. Measured once here, in the wand's own space, because the
    // wand's own space does not move: it is the bone under it that swings, and the tip rides along.
    // The longest axis of the wand's box IS its length, and the positive end of that axis is the pointy
    // end, so nothing needs to be hand-measured per model.
    this.held = findNode(rig, this.profile.hold) ?? null;
    const wand = this.held as THREE.Mesh | null;
    if (wand?.geometry) {
      wand.geometry.computeBoundingBox();
      const box = wand.geometry.boundingBox!;
      const size = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(this.heldTip);
      const longest = Math.max(size.x, size.y, size.z);
      if (longest === size.x) this.heldTip.x = box.max.x;
      else if (longest === size.y) this.heldTip.y = box.max.y;
      else this.heldTip.z = box.max.z;
    }

    // Start in Idle. current holds the sim's name for it, so comparisons stay in the sim's vocabulary.
    this.current = "Idle";
    this.actions[this._clip("Idle")]?.play();

    // Height is logged because scale and lift are eye-tuned dials, and a measured number beats a guess.
    const box = new THREE.Box3().setFromObject(model);
    // A model carrying no clips at all is a still prop like the training dummy, not a character that
    // lost its walk, so only something that animates gets checked for the three the sim asks for.
    const missing = gltf.animations.length
      ? ["Idle", "Walk", "Run"].filter((n) => !this.actions[this._clip(n)])
      : [];
    console.log(
      `Character loaded ${this.modelUrl}: ${gltf.animations.length} clips, ` +
        `height ${(box.max.y - box.min.y).toFixed(2)}, feet at y ${box.min.y.toFixed(2)}` +
        (missing.length ? `  MISSING: ${missing.join(", ")}` : "")
    );
  }

  // Crossfade to a named clip (~ Unity Animator transition). No-op if already on it, unless restart is
  // set, which replays it from frame one even though it is already the current clip. That is there for a
  // cast thrown again before the last one finished: the sim's clip name never leaves "Attack" across a
  // chained cast, so without a way to say "again" the second spell would fire with the arm still frozen
  // at the end of the first.
  setAction(name: string, fade?: number, restart = false) {
    if (this.current === name && !restart) return;

    // Resolve what is playing NOW, before rolling a new cast variant, because rolling changes what
    // _clip("Attack") answers. Get this the wrong way round and a chained cast fades out the very clip
    // it is about to fade in, and the second spell gets thrown by an invisible arm.
    //
    // current starts out null, and you cannot look something up by null. In practice we never get here
    // with a null: the caller bails out until the clips have loaded, and by then current is "Idle".
    const outgoing = this.current ? this.actions[this._clip(this.current)] : undefined;

    const next = this.actions[this._clip(name)];
    if (!next) return;

    // A one-shot blends in fast so its first frame lands on the click; everything else takes its time.
    const blend = fade ?? (ONE_SHOT.has(name) ? SNAP_FADE : FADE);
    // Only fade the old one out if it is a genuinely different action. Chaining onto the same variant
    // just rewinds it, and fading one action out and in at once would do nothing but dim it.
    if (outgoing && outgoing !== next) outgoing.fadeOut(blend);
    next.reset().fadeIn(blend).play();
    this.current = name;
  }

  // Where the wand's tip is in the world, right now, mid-swing. Written into target, which is handed
  // back, so a caller can ask every frame without allocating.
  //
  // The tip has to be read out of the animated skeleton rather than guessed from the character's
  // position, because during the cast the arm is thrown forward and the tip travels a long way. Reading
  // it here means the bolt leaves the end of the wand wherever the animation has put it.
  wandTip(target: THREE.Vector3) {
    if (!this.held) return target.copy(this.model?.position ?? target);
    this.held.updateWorldMatrix(true, false); // the mixer moved the bones, so this matrix is a frame stale
    return target.copy(this.heldTip).applyMatrix4(this.held.matrixWorld);
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

  // Take a hit from `dir`, a world-space direction pointing the way the blow travels. The knock decays
  // on its own from here, so a caller hits once and forgets about it.
  //
  // This exists because the training dummy has no animations at all. Everyone else could play a Hit clip;
  // the dummy is a plain prop, so its reaction has to be moved by code or it stands there ignoring a
  // spell to the chest.
  recoil(dir: THREE.Vector3, amount = 1) {
    this._hitDir.copy(dir).normalize();
    this._hitAmount = amount;
  }

  // Called every frame (~ Update()). dt = seconds since last frame.
  update(dt: number) {
    if (this.mixer) this.mixer.update(dt);
    this._applyRecoil(dt);
  }

  // Lean the model away from the last hit and slide it back a little, easing back upright.
  //
  // This runs in update, AFTER the draw pass has written position and rotation from the sim, and that
  // order is the whole trick: orient() overwrites the rotation outright every frame, so a lean applied
  // before it would be wiped. Applied after, it rides on top of whatever the sim said and never fights
  // it, and the moment the knock decays to nothing the model is exactly where the sim put it.
  _applyRecoil(dt: number) {
    if (this._hitAmount <= 0.001 || !this.model) return;
    // Ease out fast. Raising a fraction to the power of dt is the frame-rate-independent way to say
    // "lose most of it per second", so the spring feels the same at 30fps and at 144.
    this._hitAmount *= Math.pow(RECOIL_DECAY, dt);

    const push = this._hitAmount * RECOIL_PUSH;
    this.model.position.addScaledVector(this._hitDir, push);

    // Tilt about the axis lying across the blow, which is up crossed with the hit direction. On a sphere
    // up is just the direction out from the centre, since the planet sits at the origin.
    _up.copy(this.model.position).normalize();
    _axis.crossVectors(_up, this._hitDir);
    if (_axis.lengthSq() < 1e-8) return; // hit straight down the up axis, no sideways lean to make
    _axis.normalize();
    _lean.setFromAxisAngle(_axis, this._hitAmount * RECOIL_TILT);
    this.model.quaternion.premultiply(_lean);
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
    this.held = null;
  }

  // Take this character off the screen for good, for when a player leaves. After this the instance wears
  // nothing and is done.
  dispose() {
    this._clearModel();
    this.modelUrl = null;
  }
}
