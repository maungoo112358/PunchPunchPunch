// Grass, vertex stage. This is where a blade is built and bent.
// It runs once per vertex, 7 vertices per blade and up to 400,000 blades, so everything here is paid a few
// million times a frame. world/grass.ts scatters the field and sets the uniforms.
//
// Three things used here are not declared in this file:
// aBase / aRotation / aHeight / aPhase are declared below and hold one value per blade, so every vertex of
// a blade sees the same value. grass.ts writes them as InstancedBufferAttributes.
// position, modelViewMatrix and projectionMatrix are Three's, pasted onto the front of this file as a
// block of declarations before it compiles. position is the flat 7-vertex blade template from grass.ts.
// vFogDepth comes from Three's fog chunk. The fog_pars_vertex line below declares it and the fog_vertex
// line at the bottom fills it in, which is how the fragment stage knows how far away this blade is.
// Those two lines are not GLSL, they are Three's own copy-paste system swapping in its shader library.

attribute vec3 aBase;     // world position of this blade's base, sitting on the sphere surface
attribute float aRotation;
attribute float aHeight;
attribute float aPhase;

varying float vHeight;
varying vec3 vNormal;

uniform float uTime;
uniform vec3 uWindDir;        // world-space wind, flattened into each blade's ground plane below
uniform float uWindFrequency; // time scale, how fast the waves cycle
uniform float uWindAmplitude; // sideways travel of the tip, in world units
uniform float uWindScale;     // ripple size, how many wave crests fit across the sphere
uniform float uGustFrequency; // how often the slow gust swells and fades
uniform float uGustScale;     // gust size, far bigger than the ripples so one front covers the planet

uniform vec3 uPlayerPos;      // character world position
uniform float uPlayerRadius;  // how far the parting reaches
uniform float uPlayerStrength;// how far blades bend away

#include <fog_pars_vertex>

void main() {
  vHeight = position.y; // the template's height is baked to 1.0, so y is already the height fraction

  // This blade's own frame.
  // N is its up, straight out of the sphere, so normalizing the base position gives it directly.
  // T and B lie flat on the ground there, built with cross products the same way grass.ts builds t1/t2.
  // The ref flip is the same guard: near the poles N is almost (0, ±1, 0), a cross with (0,1,0) collapses
  // toward zero, and normalizing that gives garbage.
  // Rebuilt here rather than stored per blade, because these are a few free GPU ops while three extra
  // vectors per blade would cost real memory and bandwidth.
  vec3 N = normalize(aBase);
  vec3 ref = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(ref, N));
  vec3 B = cross(N, T);

  // Spin the blade around its own up, so they do not all face the same way.
  // This is a 2D rotation by aRotation, done inside the flat T/B plane instead of with a matrix.
  // widthAxis is the direction the blade widens along, faceAxis is the direction the flat card faces.
  float s = sin(aRotation);
  float c = cos(aRotation);
  vec3 widthAxis = T * c + B * s;
  vec3 faceAxis = -T * s + B * c;

  // Build the blade: width along widthAxis, height along the surface normal, so it stands up correctly
  // wherever it is on the ball. aHeight turns the baked 1.0 into this blade's real height.
  vec3 worldPos = aBase + widthAxis * position.x + N * (position.y * aHeight);

  // Lighting normal.
  // A flat card's true normal is faceAxis, which points sideways, so with blades spun at random angles the
  // field would flicker between lit and dark as they turn.
  // Mixing in N tilts every blade's normal about 37 degrees up toward the sky, so the whole field reads as
  // one soft surface lit from above instead of thousands of separate cards.
  vNormal = normalize(faceAxis * 0.8 + N * 0.6);

  // Wind. The world wind is one fixed direction, but a blade cannot bend east if east points into the
  // ground where it stands, so flatten the wind into that blade's ground plane first.
  // dot(uWindDir, N) is how much of the wind points along the blade's up, and subtracting that much N
  // leaves only the part lying flat.
  vec3 windT = uWindDir - N * dot(uWindDir, N);
  windT = normalize(windT + 1e-4 * T); // a blade standing straight into the wind leaves zero here, so nudge it

  // spatial changes smoothly across the sphere, so neighbouring blades get nearly the same wave offset.
  // Summing the three coordinates never repeats over a sphere, so no tiling pattern shows up.
  float spatial = aBase.x + aBase.y + aBase.z;
  float t = uTime * uWindFrequency;
  // Two waves at different speeds and different directions, so it never reads as one repeating pulse.
  // aPhase shifts each blade on its own, so neighbours move almost together but never in lockstep.
  // Almost-together-but-not-quite is what reads as a breeze crossing a field instead of the whole planet
  // twitching at once.
  // The 1.7 is deliberate: two periods that do not divide evenly drift in and out of alignment instead of
  // re-syncing into a visible pulse.
  // wave2 also reads the sphere along a different direction, dot with (0.7, -1.3, 0.5) rather than the
  // plain sum, so its bands cross the planet at another angle, and × 2.0 makes them twice as tight.
  // aPhase * 1.3 shifts each blade by a different amount in wave2 than in wave1, so for any one blade the
  // two waves never lock together either.
  float wave1 = sin(t + spatial * uWindScale + aPhase);
  float wave2 = sin(t * 1.7 + dot(aBase, vec3(0.7, -1.3, 0.5)) * uWindScale * 2.0 + aPhase * 1.3);
  float wave = wave1 * 0.7 + wave2 * 0.3; // the first wave leads, the second just breaks up its rhythm
  float gust = 0.6 + 0.4 * sin(uTime * uGustFrequency + spatial * uGustScale); // slow swell, 0.2 to 1.0
  float bend = wave * gust * uWindAmplitude * vHeight; // times vHeight, so the root stays planted
  worldPos += windT * bend;

  // Player parting.
  // smoothstep counts up from 0 to 1 as the blade gets further away, so 1.0 - flips it into influence:
  // 1 right at him, easing to 0 at uPlayerRadius. Easing rather than a hard circle is what stops the
  // parting showing a visible rim.
  vec3 toBlade = aBase - uPlayerPos;
  float pdist = length(toBlade);
  float influence = 1.0 - smoothstep(0.0, uPlayerRadius, pdist);
  // Flatten the away-direction into the ground plane, the same trick as the wind, so blades bend away
  // along the ground instead of lifting off the surface.
  vec3 pushDir = toBlade - N * dot(toBlade, N);
  float pl = length(pushDir);
  pushDir = pl > 0.001 ? pushDir / pl : vec3(0.0); // a blade exactly under him has no direction to push
  float push = influence * uPlayerStrength * vHeight;
  worldPos += pushDir * push;
  worldPos -= N * (push * 0.35); // press down as well as away, so it reads as trampled underfoot

  vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
