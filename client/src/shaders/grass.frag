// Grass, fragment stage: the color of one pixel of grass. This is the locked cozy-morning look.
// See world/grass.ts for where these uniforms are set.
//
// THE RULE THIS FILE EXISTS TO PROTECT: the haze is blended LAST, after tone mapping and after the
// colorspace conversion, toward a RAW sRGB color. That is deliberate and it cost a long detour to work
// out. uHazeColor is the literal on-screen color we want distant grass to end at, and it is the same
// color the sky uses, so grass melts into the sky at the horizon instead of stopping at a visible line.
// Blend it any earlier and tone mapping shifts it, the two stop matching, and the seam comes back.
//
// The three #include lines are not GLSL. They are Three's own copy-paste system: it swaps each one for a
// chunk of its shader library before compiling. <fog_pars_fragment> is what declares fogNear, fogFar and
// vFogDepth, which is why you will not find them written down anywhere here.

uniform vec3 uBaseColor;
uniform vec3 uTipColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform float uAmbientStrength;
uniform float uSunStrength;
uniform float uTipGlow;
uniform vec3 uHazeColor; // raw sRGB haze (display space), shared with the sky horizon

varying float vHeight;
varying vec3 vNormal;

#include <fog_pars_fragment>

void main() {
  vec3 albedo = mix(uBaseColor, uTipColor, vHeight);

  vec3 N = normalize(vNormal);
  float ndl = abs(dot(N, uSunDir)); // two-sided
  float sun = ndl * 0.5 + 0.5; // half-Lambert wrap

  vec3 ambient = uSkyColor * uAmbientStrength;
  vec3 color = albedo * (ambient + uSunColor * sun * uSunStrength);
  color += albedo * pow(vHeight, 4.0) * uTipGlow; // fake tip translucency

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Haze blended last, in display space, toward a raw sRGB color, so far grass ends at the
  // same on-screen color as the sky horizon (uHazeColor == sky uHorizon). No tone-map shift.
  float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeColor, fogFactor);
}
