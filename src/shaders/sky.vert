// Sky dome, vertex stage. Its only job is to hand the fragment stage the direction you are looking in.
// See world/sky.ts for how the dome is built and what the uniforms mean.
//
// position, projectionMatrix and modelViewMatrix are not declared anywhere here. Three quietly writes a
// block of declarations onto the front of every ShaderMaterial shader before compiling it, and they come
// from there. That is also why an editor cannot check this file on its own.

varying vec3 vDir;

void main() {
  vDir = normalize(position); // object-space view direction; independent of where the dome sits
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
