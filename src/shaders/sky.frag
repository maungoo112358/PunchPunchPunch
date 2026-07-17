// Sky dome, fragment stage: works out the color of one pixel of sky. Flat blue, plus drifting clouds.
// See world/sky.ts for how the dome is built and where these uniforms are set.
//
// TWO RULES THIS FILE EXISTS TO PROTECT, both learned the hard way:
//
// 1. It writes RAW sRGB. gl_FragColor at the bottom is the literal color you see, with no tone mapping
//    and no colorspace conversion after it. Route this through either and the whole sky shifts hue.
// 2. The sky is ONE flat blue, not a gradient. uHorizon and uZenith are set to the same color on
//    purpose, because any two-color sky gradient shows a Mach band (a fake bright seam your eye
//    invents where the slope changes). The gradient math is left in so it can be tried again, but if
//    you split those two colors, expect the band back.
//
// The per-pixel normalize and the dither near the bottom are both there to kill banding. Do not remove
// them without looking at the sky afterwards.

uniform vec3 uHorizon;   // pale blue (raw sRGB), the sky's own horizon color
uniform vec3 uZenith;    // clear blue overhead (raw sRGB)
uniform float uExponent; // gradient shape: lower = blue reaches further down toward the horizon
uniform vec3 uUp;        // local up (surface normal at the character), gradient/clouds align to this

uniform float uTime;
uniform vec3 uCloudColor;   // soft white (raw sRGB)
uniform float uCloudScale;  // noise frequency: bigger = smaller, more numerous puffs
uniform float uCloudSpeed;  // drift speed across the sky
uniform float uCloudLow;    // coverage threshold (raise = fewer clouds, more blue gaps)
uniform float uCloudHigh;   // softness ceiling (gap between low/high = edge softness)
uniform float uCloudStrength; // max cloud opacity (<1 lets a hint of blue through)

varying vec3 vDir;

// --- compact 3D value-noise fbm (no textures) ---
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f); // smoothstep interpolation
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}

void main() {
  // Re-normalize per-pixel: the dome has few segments, so interpolated vDir shrinks mid-triangle
  // and the gradient bands into faint horizontal seams. Normalizing makes it exact, no seams.
  vec3 dir = normalize(vDir);

  float up = dot(dir, uUp);         // 1 = straight up (local), 0 = local horizon, <0 = below
  float h = max(up, 0.0);
  vec3 sky = mix(uHorizon, uZenith, pow(h, uExponent));

  // Clouds: fbm over the view direction, drifting with time. Faded toward the horizon
  // so clouds only inhabit the upper sky.
  vec3 cp = dir * uCloudScale + vec3(uTime * uCloudSpeed, 0.0, uTime * uCloudSpeed * 0.6);
  float cover = smoothstep(uCloudLow, uCloudHigh, fbm(cp));
  float horizonFade = smoothstep(0.05, 0.4, up); // 0 at/below horizon, 1 well up the sky
  float clouds = cover * horizonFade * uCloudStrength;

  vec3 col = mix(sky, uCloudColor, clouds);

  // Dither: the gradient is gradual, so adjacent pixel rows round to the same 8-bit color and
  // band into a seam. Add sub-step (+/-0.5/255) noise so pixels round up/down and the step dissolves.
  float dither = (hash(vec3(gl_FragCoord.xy, 1.0)) - 0.5) / 255.0;
  col += dither;

  // Raw sRGB output (display space): the dome writes its literal display colors, no tone-map shift.
  gl_FragColor = vec4(col, 1.0);
}
