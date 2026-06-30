// All scene colors live here — one place to retune the whole mood.
// Values are 0x hex (what Three.js wants); the #hex in comments is the same color
// for designer tools. Named by ROLE, not by hue.
//
// MOOD (LOCKED): cozy forest MORNING — warm gold sun, soft sky fill, warm pale haze glowing at the
// horizon and climbing to soft blue overhead. Sky (BACKGROUND) + fog (FOG) are decoupled.
// COLOR PIPELINE — IMPORTANT: the haze is shared by the grass fog + the gradient sky (world/sky.js)
// as a RAW sRGB color (see srgb() below), blended LAST in both shaders so they match EXACTLY. Do NOT
// route the haze through tonemapping/colorspace — that shifted it (khaki / white blowout) and broke
// the grass↔sky match. Tune FOG/BACKGROUND freely; the result is now predictable (= the hex you set).

export const COLORS = {
  // --- Lighting (world/lights.js) ---
  SUN:           0xffd6a5, // #ffd6a5  pale warm gold (less orange) — DirectionalLight + grass sun
  SKY:           0xa9c4de, // #a9c4de  soft morning blue        — HemisphereLight (top) + grass ambient
  GROUND_BOUNCE: 0xb0937a, // #b0937a  softer warm bounce (less orange) — HemisphereLight (bottom)
  HERO:          0xffe6c4, // #ffe6c4  warm window-glow accent  — camera light on the character

  // --- World ---
  GROUND:        0x1a2117, // #1a2117  near-black cool soil     — world/ground.js plane (hides gaps)
  PATH:          0xd2c581, // #d2c581  warm cream sand          — reserved for future paths
  BACKGROUND:    0x8cc1e8, // #8cc1e8  clearer morning blue sky — sky zenith (bluer than the old pale #bcd6ec so it reads as "clear blue")
  SKY_HORIZON:   0x8cc1e8, // #8cc1e8  = zenith (FLAT sky)      — set equal to BACKGROUND on purpose: any two-color gradient produced a visible Mach band, so the sky is one flat blue + clouds for depth
  FOG:           0xe9ddc8, // #e9ddc8  warm pale haze           — scene.fog / GRASS haze only (no longer shared with the sky; sky decoupled on the planet)

  // --- Grass (world/grass.js shader) ---
  // Green grass against the blue fog = warm/cool contrast; near reads green, far melts to fog.
  GRASS_BASE:    0x20331f, // #20331f  dark forest green (root) — deep, slightly cool shadow
  GRASS_TIP:     0x7ba85f, // #7ba85f  moonlit yellow-green (tip) — leans yellow to read green vs navy

  // --- Props (parked — future MegaKit foliage) ---
  LEAF:          0x5e8a72, // #5e8a72  cool teal-green tint     — cools bright daytime leaves into twilight
};

// Raw sRGB components [0..1] of a hex — for shader uniforms that must stay in DISPLAY space (NOT
// linearized the way THREE.Color does). Used for the haze color the grass fog and the sky share, so
// both resolve to the EXACT same on-screen color regardless of tone-mapping / color management.
export function srgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
