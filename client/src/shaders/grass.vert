// Grass, vertex stage. This is where a blade is actually built and bent. It runs once per vertex, and
// there are 7 vertices per blade and up to 400,000 blades, so everything here is paid a few million
// times a frame. See world/grass.ts for how the field is scattered and what the uniforms mean.
//
// Three things in here are not declared in this file, which is worth knowing before you go looking:
//
// 1. The aBase / aRotation / aHeight / aPhase attributes ARE declared below, and they are per-blade:
//    world/grass.ts fills one value per blade into an InstancedBufferAttribute, and every vertex of
//    that blade sees the same value.
// 2. position, modelViewMatrix and projectionMatrix are NOT declared anywhere. Three writes a block of
//    declarations onto the front of this file before compiling it. position is the little 7-vertex
//    blade template from grass.ts, the same one for every blade.
// 3. #include <fog_pars_vertex> is not GLSL. It is Three's own copy-paste system: before compiling, it
//    swaps that line for a chunk of its shader library. This one declares vFogDepth, and <fog_vertex>
//    at the bottom fills it in. That is how the fragment stage knows how far away this blade is.

attribute vec3 aBase;     // world position of this blade's base (on the sphere surface)
attribute float aRotation;
attribute float aHeight;
attribute float aPhase;

varying float vHeight;
varying vec3 vNormal;

uniform float uTime;
uniform vec3 uWindDir;        // world-space wind; projected into each blade's tangent plane
uniform float uWindFrequency;
uniform float uWindAmplitude;
uniform float uWindScale;
uniform float uGustFrequency;
uniform float uGustScale;

uniform vec3 uPlayerPos;      // character world position
uniform float uPlayerRadius;  // how far the parting reaches
uniform float uPlayerStrength;// how far blades bend away

#include <fog_pars_vertex>

void main() {
  vHeight = position.y; // base geom height is 1.0, so y is the height fraction

  // Per-blade surface frame (T, B, N) derived from the base.
  vec3 N = normalize(aBase); // this blade's up = surface normal
  vec3 ref = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0); // flips near the poles
  vec3 T = normalize(cross(ref, N));
  vec3 B = cross(N, T);

  // Spin the blade in its tangent plane: widthAxis widens it, faceAxis is the card's facing.
  float s = sin(aRotation);
  float c = cos(aRotation);
  vec3 widthAxis = T * c + B * s;
  vec3 faceAxis = -T * s + B * c;

  // Build the blade: width along widthAxis, height along the surface normal.
  vec3 worldPos = aBase + widthAxis * position.x + N * (position.y * aHeight);

  // Lighting normal: card normal biased toward up for a soft up-lit look.
  vNormal = normalize(faceAxis * 0.8 + N * 0.6);

  // Wind: project world wind into the tangent plane, bend the tip along it.
  // Two sine octaves + a slow gust, scaled by vHeight so the root stays planted.
  vec3 windT = uWindDir - N * dot(uWindDir, N);
  windT = normalize(windT + 1e-4 * T); // guard if wind ~parallel to N
  float spatial = aBase.x + aBase.y + aBase.z; // varies smoothly over the sphere, no tiling
  float t = uTime * uWindFrequency;
  float wave1 = sin(t + spatial * uWindScale + aPhase);
  float wave2 = sin(t * 1.7 + dot(aBase, vec3(0.7, -1.3, 0.5)) * uWindScale * 2.0 + aPhase * 1.3);
  float wave = wave1 * 0.7 + wave2 * 0.3;
  float gust = 0.6 + 0.4 * sin(uTime * uGustFrequency + spatial * uGustScale);
  float bend = wave * gust * uWindAmplitude * vHeight;
  worldPos += windT * bend;

  // Player parting: blades within radius bend away along the tangent, plus a slight press-down.
  vec3 toBlade = aBase - uPlayerPos;
  float pdist = length(toBlade);
  float influence = 1.0 - smoothstep(0.0, uPlayerRadius, pdist); // 1 near the player, 0 at the radius
  vec3 pushDir = toBlade - N * dot(toBlade, N); // flatten into the tangent plane
  float pl = length(pushDir);
  pushDir = pl > 0.001 ? pushDir / pl : vec3(0.0);
  float push = influence * uPlayerStrength * vHeight;
  worldPos += pushDir * push;
  worldPos -= N * (push * 0.35); // trample/flatten near his feet

  vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
