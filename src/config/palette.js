// All scene colors live here — one place to retune the whole mood.
// Values are 0x hex (what Three.js wants); the #hex in comments is the same color
// for designer tools. Named by ROLE, not by hue.

export const COLORS = {
  // --- Lighting (world/lights.js) ---
  SUN:           0xfff4e6, // #fff4e6  warm off-white sunlight — DirectionalLight key
  SKY:           0x9fc0ff, // #9fc0ff  soft blue sky tint      — HemisphereLight (top)
  GROUND_BOUNCE: 0x5f7d39, // #5f7d39  grass up-bounce          — HemisphereLight (bottom)

  // --- World ---
  GROUND:        0x7aa64a, // #7aa64a  fresh grass green        — world/ground.js plane
  BACKGROUND:    0x1a1d2e, // #1a1d2e  dim slate-blue           — main.js scene background
};
