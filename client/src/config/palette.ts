// All scene colors, one place to retune the mood. Values are 0x hex; the #hex in
// comments is the same color for designer tools. Named by ROLE, not hue.
//
// MOOD (LOCKED): cozy outdoor MORNING. Flat blue sky + clouds, decoupled from the grass haze.
// COLOR gotcha: the sky dome and the grass haze output RAW sRGB via srgb() (below), blended LAST.
// Do NOT route them through tonemapping/colorspace; that shifts the color (cost a long detour).

export const COLORS = {
  // --- Lighting (world/lights.js) ---
  SUN:           0xffd6a5, // #ffd6a5  warm gold. DirectionalLight + grass sun.
  SKY:           0xa9c4de, // #a9c4de  morning blue. HemisphereLight (top) + grass ambient.
  GROUND_BOUNCE: 0xb0937a, // #b0937a  warm bounce. HemisphereLight (bottom).
  HERO:          0xffe6c4, // #ffe6c4  warm accent. camera light on the character.

  // --- World ---
  GROUND:        0x1a2117, // #1a2117  near-black cool soil. planet surface under the grass.
  PATH:          0xd2c581, // #d2c581  warm cream sand. reserved for future paths.
  BACKGROUND:    0x8cc1e8, // #8cc1e8  morning blue. sky zenith.
  SKY_HORIZON:   0x8cc1e8, // #8cc1e8  = zenith. equal to BACKGROUND on purpose: a two-color gradient banded, so the sky is one flat blue + clouds.
  FOG:           0xe9ddc8, // #e9ddc8  warm pale haze. scene.fog / grass haze only (sky decoupled on the planet).
  // --- Grass (world/grass.js shader) ---
  // Green grass vs blue fog = warm/cool contrast; near reads green, far melts to fog.
  GRASS_BASE:    0x20331f, // #20331f  dark forest green (root).
  GRASS_TIP:     0x7ba85f, // #7ba85f  yellow-green (tip). leans yellow to read green.

  // --- Props (parked: future MegaKit foliage) ---
  LEAF:          0x5e8a72, // #5e8a72  cool teal-green tint.

  // --- Spell (systems/spellFx.ts, systems/targeting.ts) ---
  // The duel green, and it is green all the way through. There is deliberately NO white centre: a white
  // core reads as a laser pointer or a strip light, and washes the colour out of the middle of the beam
  // exactly where the eye looks hardest. Keeping every layer green, and letting the layers differ in
  // lightness instead of in hue, is what makes it read as enchanted rather than industrial.
  //
  // These go on unlit materials with tone mapping off, so the hex lands on screen as written, the same
  // deal as the sky. Additive blending stacks them, so where the layers overlap the middle still comes
  // out brighter without any white being in the palette.
  //
  // The field is already green, so these are far more saturated and far brighter than the grass ever
  // gets, which is what keeps the beam from sinking into it.
  SPELL_CORE:    0x8bffb0, // #8bffb0  pale mint, the bright inner line of the beam.
  SPELL_GLOW:    0x12e357, // #12e357  deep emerald, the soft aura around it.
  SPELL_BURST:   0x5cffa0, // #5cffa0  spring green flash where it lands.
};

// Raw sRGB components [0..1] of a hex, for shader uniforms that must stay in DISPLAY space (not
// linearized like THREE.Color). Used by the sky dome and the grass haze so their colors land
// on screen exactly as the hex, regardless of tone-mapping.
//
// The return type says "exactly three numbers", not just "some numbers". A shader vec3 uniform wants
// three, so if we ever return the wrong count we hear about it here instead of seeing a broken color.
export function srgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
