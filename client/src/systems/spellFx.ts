import * as THREE from "three";
import { COLORS } from "../config/palette.js";
import type { Character } from "../entities/Character.js";

// The visible half of the wand attack: a crackling beam from the wand tip to whoever is locked on, held
// for a couple of seconds, with a flare at the wand and a burst where it lands.
//
// This is PURE DECORATION and it is deliberate. The cast itself lives in the sim, where the server owns
// it and both machines agree tick for tick. Nothing here touches that: the beam is drawn off the anim
// name, which every character already carries, so a remote player's spell appears for the same reason
// their walk does, with nothing new on the wire.
//
// It runs on real frame time, not the fixed tick, because it is presentation. The jitter that makes the
// beam look alive wants every frame it can get, and a fixed-step version would only make it stutter.

// How long after the cast begins the beam lights up, and how long it stays. The whole cast is 0.53s, so
// these are deliberately tiny: the beam is a FLASH, there and gone, the way a spell reads in Hogwarts
// Legacy rather than a held searchlight. Brief is not the same as invisible, which is why it snaps to
// full strength instantly and spends most of its life fading: the eye catches the bright first frame
// and the fade is what makes it legible afterwards.
//
// The delay is the wind-up, and it moved out with the cast: the clips play slower now, so the arm
// reaches the point it throws from a little later in real time.
const BEAM_DELAY = 0.15;
const BEAM_TIME = 0.26;
const FADE_TIME = 0.19; // the tail of BEAM_TIME spent fading out rather than at full strength

// How far the beam reaches when there is nothing locked on, so a cast at empty air still shows something.
const FREE_RANGE = 14;

// The beam's build. More segments means a smoother snake and more per-frame work; 32 is plenty for a
// beam this short. RADIAL is how many sides the tube has, and 6 is enough because it is a glow, not a
// surface anybody inspects.
const SEGMENTS = 32;
const RADIAL = 6;

// Thickness in world units, against a character about 4.4 tall. The inner line is much fatter than it
// was, because it used to be a white hairline hiding inside the glow and is now the beam itself.
const CORE_RADIUS = 0.13;
const GLOW_RADIUS = 0.34;

// The crackle. AMP is how far the beam wanders off the straight line between wand and target, in world
// units; SPEED is how fast that wander travels along it; WAVES is how many kinks fit along its length.
// Turn AMP to 0 and you get a laser, which is the boring version.
const JITTER_AMP = 0.22;
const JITTER_SPEED = 26; // fast, because the beam only exists for a quarter of a second
const JITTER_WAVES = 3.1;

// The flare at the wand tip and the burst at the far end, as radii in world units.
const MUZZLE_RADIUS = 0.34;
const IMPACT_RADIUS = 0.62;

// How hard the target is knocked when the beam lands on it.
const HIT_STRENGTH = 1;

// Unlit, additive, out of tone mapping. Additive is what makes it read as light rather than as a painted
// plastic tube: it ADDS its colour to whatever is behind, so it brightens the grass it crosses. Tone
// mapping is off for the same reason the sky opts out, so the palette hex is the colour on screen.
// depthWrite off stops the invisible parts of one transparent piece cutting a hole in another.
function glowMaterial(color: number, opacity: number) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

const blob = new THREE.IcosahedronGeometry(1, 2); // the flare and the burst, low-poly to suit the toon world

// Build an empty tube: the right number of vertices and the triangles joining them, with every position
// still at zero. The shape is written in later, every frame, by updateTube.
//
// Why build it once and rewrite it rather than making a fresh TubeGeometry each frame: a beam is redrawn
// sixty times a second for two seconds, and handing the GPU a brand new buffer each time would throw a
// hundred and twenty geometries at the garbage collector for one spell. The vertex COUNT never changes,
// only where the vertices are, so the buffer can be kept and overwritten.
function makeTube() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SEGMENTS * RADIAL * 3), 3));

  // Two triangles per quad, one quad between each pair of neighbouring rings.
  const index: number[] = [];
  for (let s = 0; s < SEGMENTS - 1; s++) {
    for (let r = 0; r < RADIAL; r++) {
      const next = (r + 1) % RADIAL; // wrap the last side back round to the first
      const a = s * RADIAL + r;
      const b = s * RADIAL + next;
      const c = (s + 1) * RADIAL + r;
      const d = (s + 1) * RADIAL + next;
      index.push(a, c, b, b, c, d);
    }
  }
  geometry.setIndex(index);
  return geometry;
}

// Scratch for the tube rebuild, module level so a frame of beams allocates nothing.
const _p = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _binormal = new THREE.Vector3();
const _ref = new THREE.Vector3();
const _axisA = new THREE.Vector3();
const _axisB = new THREE.Vector3();

// Rewrite a tube so it runs from `from` to `to`, wandering as it goes.
//
// The wander is two sine waves running along the beam and sliding with time, one on each of the two
// directions across it. Sines rather than random numbers on purpose: random jitter changes completely
// every frame and reads as television static, while a wave that TRAVELS reads as energy running down the
// beam, which is the thing being copied from the films.
//
// The ends are pinned: the wander is scaled by how far along you are, fading to nothing at both tips, so
// the beam always starts exactly at the wand and ends exactly on the target however much the middle
// thrashes about.
function updateTube(
  geometry: THREE.BufferGeometry,
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  time: number,
) {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const array = position.array as Float32Array;

  // One pair of directions across the beam, shared by every ring. The beam is close to straight, so a
  // single frame works the whole length and saves recomputing one per segment.
  _tangent.copy(to).sub(from);
  const length = _tangent.length();
  if (length < 1e-5) return;
  _tangent.divideScalar(length);
  // Any direction that is not along the beam will do to get started. Picking by the tangent's smallest
  // component guarantees the cross product below never collapses to zero.
  _ref.set(0, 1, 0);
  if (Math.abs(_tangent.y) > 0.9) _ref.set(1, 0, 0);
  _axisA.crossVectors(_tangent, _ref).normalize();
  _axisB.crossVectors(_tangent, _axisA).normalize();

  for (let s = 0; s < SEGMENTS; s++) {
    const t = s / (SEGMENTS - 1); // 0 at the wand, 1 at the target

    // Straight-line point, then pushed sideways by the two travelling waves. sin(pi * t) is the pin: it
    // is 0 at both ends and 1 in the middle, so the wander swells through the middle and dies at the tips.
    _p.lerpVectors(from, to, t);
    const pin = Math.sin(Math.PI * t) * JITTER_AMP;
    const phase = t * JITTER_WAVES * Math.PI * 2;
    _p.addScaledVector(_axisA, Math.sin(phase - time * JITTER_SPEED) * pin);
    _p.addScaledVector(_axisB, Math.cos(phase * 1.37 - time * JITTER_SPEED * 0.8) * pin);

    // The tube is fattest in the middle and tapers to the ends, which stops the beam looking like a
    // length of pipe and gives the impression it is being thrown rather than bolted on.
    const width = radius * (0.55 + 0.45 * Math.sin(Math.PI * t));

    for (let r = 0; r < RADIAL; r++) {
      const angle = (r / RADIAL) * Math.PI * 2;
      _normal.copy(_axisA).multiplyScalar(Math.cos(angle) * width);
      _binormal.copy(_axisB).multiplyScalar(Math.sin(angle) * width);
      const i = (s * RADIAL + r) * 3;
      array[i] = _p.x + _normal.x + _binormal.x;
      array[i + 1] = _p.y + _normal.y + _binormal.y;
      array[i + 2] = _p.z + _normal.z + _binormal.z;
    }
  }
  position.needsUpdate = true;
  // The bounding sphere is what three uses to decide the beam is off screen and can be skipped. It was
  // computed from the zeroed buffer, so without this the beam vanishes the moment the camera turns.
  geometry.computeBoundingSphere();
}

// A cast that has begun but whose beam has not lit yet. It holds the CHARACTERS rather than positions,
// because over the next few frames the arm is still swinging and the target may still be moving; where
// the beam actually runs is read fresh every frame once it is alight.
type Pending = { caster: Character; target: Character | null; wait: number };

type Beam = {
  caster: Character;
  target: Character | null;
  end: THREE.Vector3; // where it lands, held so a beam at empty air has somewhere to point
  core: THREE.Mesh;
  glow: THREE.Mesh;
  muzzle: THREE.Mesh;
  impact: THREE.Mesh;
  age: number;
  struck: boolean; // whether the target has already been knocked, so it is knocked once, not every frame
};

export function createSpellFx(scene: THREE.Scene) {
  const pending: Pending[] = [];
  const beams: Beam[] = [];
  let clock = 0; // seconds since boot, what the travelling waves are read against

  // Scratch, reused every frame.
  const tip = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const hitDir = new THREE.Vector3();

  function makeBeam(caster: Character, target: Character | null): Beam {
    // Two green layers, no white anywhere. The inner is the pale mint line you read as the beam, the
    // outer is a soft emerald aura around it. Additive blending stacks them, so the middle still comes
    // out brightest without a white core being drawn to do it.
    const core = new THREE.Mesh(makeTube(), glowMaterial(COLORS.SPELL_CORE, 0.95));
    const glow = new THREE.Mesh(makeTube(), glowMaterial(COLORS.SPELL_GLOW, 0.7));
    const muzzle = new THREE.Mesh(blob, glowMaterial(COLORS.SPELL_CORE, 0.9));
    const impact = new THREE.Mesh(blob, glowMaterial(COLORS.SPELL_BURST, 0.8));
    // frustumCulled off because the beam's bounds are rewritten every frame from the wand's position,
    // and three would otherwise be testing this frame's camera against last frame's bounds.
    for (const mesh of [core, glow, muzzle, impact]) {
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    return {
      caster, target, end: new THREE.Vector3(),
      core, glow, muzzle, impact, age: 0, struck: false,
    };
  }

  function disposeBeam(beam: Beam) {
    for (const mesh of [beam.core, beam.glow, beam.muzzle, beam.impact]) {
      scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
    }
    beam.core.geometry.dispose();
    beam.glow.geometry.dispose();
  }

  return {
    // Begin a cast. The beam does not appear yet: it waits BEAM_DELAY so it lights on the animation's
    // throw rather than during the wind-up. Called by the draw pass the moment a character starts its
    // Attack clip, which is why it works for remote players too without knowing anything about the network.
    cast(caster: Character, target: Character | null) {
      pending.push({ caster, target, wait: BEAM_DELAY });
    },

    update(dt: number) {
      clock += dt;

      // Casts whose moment has come. Walked backwards so a lit one can be spliced out mid-loop without
      // the loop skipping its neighbour.
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        p.wait -= dt;
        if (p.wait > 0) continue;
        pending.splice(i, 1);
        if (!p.caster.model) continue; // caster despawned during the wind-up
        beams.push(makeBeam(p.caster, p.target));
      }

      for (let i = beams.length - 1; i >= 0; i--) {
        const beam = beams[i];
        beam.age += dt;
        if (beam.age >= BEAM_TIME || !beam.caster.model) {
          disposeBeam(beam);
          beams.splice(i, 1);
          continue;
        }

        // Where it runs, read fresh every frame: the wand tip moves with the arm, and the target may be
        // walking.
        beam.caster.wandTip(tip);
        if (beam.target?.model) {
          // Chest height rather than the feet, so the beam crosses the body instead of skimming the grass.
          beam.end.copy(beam.target.model.position).addScaledVector(beam.target.model.position.clone().normalize(), 2);
        } else {
          forward.set(0, 0, 1).applyQuaternion(beam.caster.model.quaternion).normalize();
          beam.end.copy(tip).addScaledVector(forward, FREE_RANGE);
        }

        // Full strength, then fading over the last stretch, so it dims out instead of being switched off.
        const remaining = BEAM_TIME - beam.age;
        const fade = remaining < FADE_TIME ? remaining / FADE_TIME : 1;

        updateTube(beam.core.geometry, tip, beam.end, CORE_RADIUS, clock);
        updateTube(beam.glow.geometry, tip, beam.end, GLOW_RADIUS, clock);
        (beam.core.material as THREE.MeshBasicMaterial).opacity = 0.95 * fade;
        (beam.glow.material as THREE.MeshBasicMaterial).opacity = 0.7 * fade;

        // The flare at the wand and the burst on the target, both breathing at different rates so the
        // two ends never pulse in lockstep and look mechanical.
        beam.muzzle.position.copy(tip);
        beam.muzzle.scale.setScalar(MUZZLE_RADIUS * (0.8 + 0.2 * Math.sin(clock * 27)) * fade);
        (beam.muzzle.material as THREE.MeshBasicMaterial).opacity = 0.9 * fade;

        beam.impact.position.copy(beam.end);
        beam.impact.scale.setScalar(IMPACT_RADIUS * (0.75 + 0.25 * Math.sin(clock * 19 + 1)) * fade);
        (beam.impact.material as THREE.MeshBasicMaterial).opacity = 0.8 * fade;

        // Knock the target once, as the beam lands, rather than every frame it stays on.
        if (!beam.struck && beam.target?.model) {
          beam.struck = true;
          hitDir.copy(beam.end).sub(tip).normalize();
          beam.target.recoil(hitDir, HIT_STRENGTH);
        }
      }
    },
  };
}

export type SpellFx = ReturnType<typeof createSpellFx>;
