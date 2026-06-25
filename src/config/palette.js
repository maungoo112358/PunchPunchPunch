// All scene colors live here — one place to retune the whole mood.
// Values are 0x hex (what Three.js wants); the #hex in comments is the same color
// for designer tools. Named by ROLE, not by hue.
//
// MOOD: twilight — cool blue-purple key + ambient + haze, warm "hero" light on the
// character so it pops against the cool (Tiny Glade night).

export const COLORS = {
  // --- Lighting (world/lights.js) ---
  SUN:           0x9aa6e2, // #9aa6e2  cool moonlight key       — DirectionalLight + grass sun
  SKY:           0x3a5ad8, // #3a5ad8  strong night blue        — HemisphereLight (top) + grass ambient
  GROUND_BOUNCE: 0x312f55, // #312f55  deep blue-purple bounce  — HemisphereLight (bottom)
  HERO:          0xffeeda, // #ffeeda  soft warm-white fill     — camera light on the character

  // --- World ---
  GROUND:        0x232f1d, // #232f1d  dark cool soil           — world/ground.js plane (hides gaps)
  PATH:          0xd2c581, // #d2c581  warm cream sand          — reserved for future paths
  BACKGROUND:    0x284de2, // #284de2  saturated night blue     — scene background + fog

  // --- Grass (world/grass.js shader) ---
  GRASS_BASE:    0x254038, // #254038  dark teal-green (root) — cooled so blue light reflects
  GRASS_TIP:     0x568f6a, // #568f6a  teal-green (tip)
};
