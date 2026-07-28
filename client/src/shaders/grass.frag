// Grass, fragment stage: the color of one pixel of grass. This is the locked cozy-morning look.
// world/grass.ts sets these uniforms.
//
// THE RULE THIS FILE EXISTS TO PROTECT: the haze is blended LAST, after tone mapping and after the
// colorspace conversion, toward a RAW sRGB color. It cost a long detour to work out.
// uHazeColor is the literal on-screen color we want distant grass to end at, and it is the same color the
// sky uses at the horizon, so grass melts into the sky instead of stopping at a visible line.
// Blend it any earlier and tone mapping shifts it, the two stop matching, and the seam comes back.
//
// The three include lines below are not GLSL. They are Three's own copy-paste system, swapping each one
// for a chunk of its shader library before compiling. The fog_pars_fragment one declares fogNear, fogFar
// and vFogDepth, which is why you will not find them written down anywhere here.

uniform vec3 uBaseColor;         // root color
uniform vec3 uTipColor;          // tip color, mixed in by height
uniform vec3 uSunDir;            // must match lights.ts and sunFollow, nothing enforces it
uniform vec3 uSunColor;
uniform vec3 uSkyColor;          // flat fill with no direction, used as ambient
uniform float uAmbientStrength;  // how much of that flat fill lands
uniform float uSunStrength;      // how much the sun term adds on top
uniform float uTipGlow;          // extra brightness on the top of a blade
uniform vec3 uHazeColor;         // raw sRGB haze in display space, shared with the sky horizon

varying float vHeight;
varying vec3 vNormal;

#include <fog_pars_fragment>

void main() {
  vec3 albedo = mix(uBaseColor, uTipColor, vHeight); // darker at the root, brighter at the tip

  vec3 N = normalize(vNormal);
  float ndl = abs(dot(N, uSunDir)); // abs makes it two-sided, since a thin blade catches light on either face
  float sun = ndl * 0.5 + 0.5; // half-Lambert: remaps 0..1 to 0.5..1, so grass facing away goes dim, not black

  // Sky fill lands on every blade whatever way it faces, which is what keeps the shaded sides readable.
  // Then the grass color is multiplied by the total light falling on it, sky fill plus sun.
  vec3 ambient = uSkyColor * uAmbientStrength;
  vec3 color = albedo * (ambient + uSunColor * sun * uSunStrength);
  color += albedo * pow(vHeight, 4.0) * uTipGlow; // pow 4 keeps the glow on the top slice only, faking light through the thin tip

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Haze blended last, in display space, toward a raw sRGB color, so far grass ends at the
  // same on-screen color as the sky horizon (uHazeColor == sky uHorizon). No tone-map shift.
  // smoothstep rather than a straight ramp, so the haze eases in and out over the distance instead of
  // starting abruptly at fogNear and clamping hard at fogFar.
  float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeColor, fogFactor);
}
