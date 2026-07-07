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
  // Stylized bright turquoise (Bugsnax-style pond). Deep is a bright mid teal-blue, NOT navy: the
  // cheap murky navy read as a hole. ACES + exposure 1.4 lifts these, so they land bright on screen.
  WATER_DEEP:    0x2c7796, // #2c7796  deep water looking down. bright teal-blue, still reads as depth.
  WATER_SKY:     0xa9d4e8, // #a9d4e8  sky reflection at grazing angles (light morning blue).
  WATER_SHALLOW: 0x86c6cf, // #86c6cf  bright shallow cyan near the shore (depth read + low foam contrast).
  WATER_FOAM:    0xe8f4f4, // #e8f4f4  foam near the shore. near-white, faint cyan.

  // --- Grass (world/grass.js shader) ---
  // Green grass vs blue fog = warm/cool contrast; near reads green, far melts to fog.
  GRASS_BASE:    0x20331f, // #20331f  dark forest green (root).
  GRASS_TIP:     0x7ba85f, // #7ba85f  yellow-green (tip). leans yellow to read green.

  // --- Props (parked: future MegaKit foliage) ---
  LEAF:          0x5e8a72, // #5e8a72  cool teal-green tint.
};

// Raw sRGB components [0..1] of a hex, for shader uniforms that must stay in DISPLAY space (not
// linearized like THREE.Color). Used by the sky dome and the grass haze so their colors land
// on screen exactly as the hex, regardless of tone-mapping.
export function srgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
