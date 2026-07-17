// Pond water, vertex stage. See world/pond.ts for how the disc is built and what the uniforms mean.
// NOTE: the pond is PARKED. SHOW_POND is false in main.ts, so none of this currently runs.
//
// position, normal, uv, modelMatrix, viewMatrix and projectionMatrix are not declared here. Three writes
// a block of declarations onto the front of this file before compiling it, and they come from there.
//
// Hand the fragment shader where this point sits in the world and which way the surface faces
// there. Fresnel needs both: the direction from the point to the eye, versus the surface normal.
// vUv is the pond's built-in "where on the pond" value: 0..1 across the water, 0.5 at the center.
// The ripples read it so each spot gets a different wave.
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
