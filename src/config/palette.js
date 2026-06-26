// All scene colors live here — one place to retune the whole mood.
// Values are 0x hex (what Three.js wants); the #hex in comments is the same color
// for designer tools. Named by ROLE, not by hue.
//
// MOOD: Tiny Glade deep twilight (ref Screenshot_1) — rich navy night, cool silvery
// moonlight, foliage lit blue-green from above. One warm accent (hero light) stands in
// for the warm window glow that makes the cool blue sing. Thick fog melts the horizon.

export const COLORS = {
  // --- Lighting (world/lights.js) ---
  SUN:           0x93a4e0, // #93a4e0  cool silvery moonlight   — DirectionalLight + grass sun
  SKY:           0x2e4486, // #2e4486  deep night-blue fill     — HemisphereLight (top) + grass ambient
  GROUND_BOUNCE: 0x262443, // #262443  deep blue-violet bounce  — HemisphereLight (bottom)
  HERO:          0xffe6c4, // #ffe6c4  warm window-glow accent  — camera light on the character

  // --- World ---
  GROUND:        0x1a2117, // #1a2117  near-black cool soil     — world/ground.js plane (hides gaps)
  PATH:          0xd2c581, // #d2c581  warm cream sand          — reserved for future paths
  BACKGROUND:    0x222c63, // #222c63  deep twilight navy       — scene background + fog

  // --- Grass (world/grass.js shader) ---
  GRASS_BASE:    0x1f343f, // #1f343f  dark cool teal (root)    — deep blue-green shadow
  GRASS_TIP:     0x5a93a0, // #5a93a0  moonlit teal-blue (tip)  — cool light catching the tops

  // --- Props (world/props.js) ---
  LEAF:          0x5e8a72, // #5e8a72  cool teal-green tint     — cools the bright daytime tree leaves into the twilight
};
