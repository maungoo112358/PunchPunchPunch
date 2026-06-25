import Stats from "three/addons/libs/stats.module.js";

// FPS / frame-time panel (top-left). stats.update() ticks once per frame.
export function createStats() {
  const stats = new Stats();
  stats.dom.style.left = "0px";
  stats.dom.style.top = "0px";
  document.body.appendChild(stats.dom);
  return { update() { stats.update(); } };
}
