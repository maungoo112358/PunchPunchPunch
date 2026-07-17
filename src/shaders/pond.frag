// Pond water, fragment stage: the color of one pixel of water. See world/pond.ts for how the disc is
// built, where these uniforms are set, and docs/POND_IMPLEMENTATION.md for the whole plan.
//
// NOTE: the pond is PARKED. SHOW_POND is false in main.ts, so none of this currently runs. It was also
// carried through the TypeScript migration untested for the same reason.
//
// The big idea: the whole look hangs off water THICKNESS. Once a frame, main.ts draws the world with the
// water hidden into an off-screen buffer that keeps how far each pixel is from the camera. tDepth is that
// buffer. Here we read the distance to the BED behind us, compare it to the distance to our own surface,
// and the gap is how much water is stacked up at this pixel: about zero at the shore, deepest in the
// middle. Depth color, shallows and foam all fall out of that one number.
//
// The three #include lines are not GLSL. They are Three's own copy-paste system: it swaps each one for a
// chunk of its shader library before compiling. <packing> is what gives us perspectiveDepthToViewZ, which
// is how the squished depth-buffer value is turned back into a real distance.

#include <packing>
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float cameraNear;
uniform float cameraFar;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uDepthFade;
uniform vec3 uSky;
uniform float uFresnelPower;
uniform float uReflectStrength;
uniform float uTime;
uniform float uRippleStrength;
uniform float uRippleSpeed;
uniform float uRippleScale;
uniform vec3 uSunDir;
uniform vec3 uGlintColor;
uniform float uGlintStrength;
uniform float uGlintSharpness;
uniform float uPondSize;
uniform vec3 uFoam;
uniform float uFoamDepth;
uniform float uFoamScale;
uniform float uFoamCut;
uniform float uFoamSoft;
uniform bool uDebug;
uniform float uDebugScale;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;

// Turn a depth-buffer value (squished, lots of detail up close) into a real distance in front of
// the camera, in world units. near/far undo the squish. Returns a positive number.
float distToCamera(float depthSample) {
  float viewZ = perspectiveDepthToViewZ(depthSample, cameraNear, cameraFar);
  return -viewZ;
}

// A blotchy 0..1 pattern used to break the foam into patches. hash() turns a grid corner into a
// pseudo-random number; valueNoise() picks the four corners around a spot and blends them smoothly,
// giving soft random blobs instead of a regular grid.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f); // smooth the blend so there are no hard seams
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Tilt the flat surface normal to fake ripples. We picture a bumpy water height made of several
// scrolling waves of different sizes and directions, find how steep that height is at this spot (the
// sum of every wave's steepness), and lean the normal against it. p is where we are on the water; N
// is the flat normal; T and B are the two flat directions along the surface to lean toward.
vec3 rippleNormal(vec2 p, vec3 N, vec3 T, vec3 B) {
  p *= uRippleScale;
  float t = uTime * uRippleSpeed;

  // First nudge the sample spot around with a slow wide wave. This bends and wanders the ripples so
  // they stop marching in dead-straight rows, which is what made them look uniform and fake.
  p += 0.9 * vec2(sin(p.y * 0.5 + t * 0.7), sin(p.x * 0.45 - t * 0.6));

  // Stack waves of different sizes aimed in odd directions, moving at different speeds. The sizes are
  // not simple multiples of each other and the directions do not line up, so they never settle into
  // a repeating pattern. The big slow waves set the overall shape; each smaller one is weaker and
  // just adds finer detail on top. cos() is the steepness of a sin() wave.
  vec2 slope = vec2(0.0);
  slope += 0.90 * cos(dot(p, vec2( 0.98,  0.19)) * 1.0 + t * 1.00) * vec2( 0.98,  0.19);
  slope += 0.55 * cos(dot(p, vec2(-0.29,  0.96)) * 1.8 + t * 1.30) * vec2(-0.29,  0.96);
  slope += 0.35 * cos(dot(p, vec2( 0.60, -0.80)) * 3.1 + t * 0.85) * vec2( 0.60, -0.80);
  slope += 0.22 * cos(dot(p, vec2(-0.85, -0.53)) * 5.0 + t * 1.60) * vec2(-0.85, -0.53);
  slope += 0.14 * cos(dot(p, vec2( 0.44,  0.90)) * 7.7 + t * 1.15) * vec2( 0.44,  0.90);

  // Lean the flat normal along the total steepness, then bring it back to unit length.
  return normalize(N - uRippleStrength * (slope.x * T + slope.y * B));
}

void main() {
  // Where am I on the screen? gl_FragCoord is this pixel's spot in screen pixels; divide by the
  // canvas size to get a 0..1 coordinate to look up the depth buffer with.
  vec2 screenUV = gl_FragCoord.xy / uResolution;

  // Distance to the bed behind me, and distance to my own water surface. The difference is how much
  // water is stacked up here: ~0 at the shore, biggest over the deep middle.
  float bedDist = distToCamera(texture2D(tDepth, screenUV).x);
  float surfaceDist = distToCamera(gl_FragCoord.z);
  float thickness = max(bedDist - surfaceDist, 0.0);

  if (uDebug) {
    // Dev view: show the thickness straight as gray.
    float gray = clamp(thickness / uDebugScale, 0.0, 1.0);
    gl_FragColor = vec4(vec3(gray), 1.0);
  } else {
    // Depth color: blend from the bright shallow tint to the deep tint as the water gets thicker.
    // smoothstep gives a soft falloff (no hard line) that eases in at the shore and out at depth.
    float t = smoothstep(0.0, uDepthFade, thickness);
    vec3 waterColor = mix(uShallow, uDeep, t);

    // Build the surface's own two in-plane directions (T and B) from the flat normal, so the ripples
    // have something to lean along: pick any axis not parallel to the normal, cross to get T, cross
    // again for B.
    vec3 baseN = normalize(vWorldNormal);
    vec3 axis = abs(baseN.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(axis, baseN));
    vec3 B = cross(baseN, T);
    // Where this spot sits on the pond, in world units, taken from the mesh's own 0..1 uv (0.5 is the
    // center) so it actually differs from spot to spot. This is what the ripple waves read.
    vec2 surfaceUV = (vUv - 0.5) * uPondSize;
    vec3 normal = rippleNormal(surfaceUV, baseN, T, B);

    // Fresnel sky reflection: the more your eye grazes the surface, the more it acts like a mirror.
    // viewDir points from this spot to the camera; when it is nearly parallel to the surface (the
    // far edge of the pond) the dot with the normal is small, so fresnel is near 1 and we blend in
    // the sky tint. Looking straight down, fresnel is near 0 and the depth color shows through.
    // Using the rippled normal makes that reflection shimmer and wander instead of sitting still.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), uFresnelPower);
    vec3 color = mix(waterColor, uSky, fresnel * uReflectStrength);

    // Sun glint: a sharp specular sparkle. The half vector sits halfway between the eye and the sun;
    // when the (rippled) normal points along it, the sun's reflection aims right back at your eye and
    // you get a bright hotspot. The high power keeps it a tight sparkle, not a broad sheen. Because it
    // reads the rippled normal, the hotspot breaks into little dancing points across the waves.
    vec3 halfVec = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(normal, halfVec), 0.0), uGlintSharpness);
    color += uGlintColor * spec * uGlintStrength;

    // Shoreline foam. shore is 1 right at the water's edge and fades to 0 by uFoamDepth of thickness,
    // so foam can only live in the thin band near the shore. We multiply it by slow scrolling noise
    // and cut the result, so foam only appears where a noise blob happens to be high: broken, drifting
    // patches instead of a solid ring. Then blend the near-white foam color on top.
    float shore = 1.0 - smoothstep(0.0, uFoamDepth, thickness);
    float n = valueNoise(surfaceUV * uFoamScale + uTime * vec2(0.06, 0.045));
    float foam = smoothstep(uFoamCut, uFoamCut + uFoamSoft, shore * n);
    color = mix(color, uFoam, foam);

    gl_FragColor = vec4(color, 1.0);
  }

  // Match the normal output pipeline (tone mapping + sRGB) so colors read the same as before.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
