import * as THREE from "three";

// The visible reference grid: white triangle edges + a big number at each triangle center, floating just
// above the ground. It is only a rough anchor for placing props ("add a tree at T25"); the precise
// placement is done by dragging in the editor. So there are no corners and no occupancy colors anymore,
// just clean cells with readable numbers.
//
// This is a pure visual. It starts hidden; the placement editor (systems/propEditor.js) shows it in
// editor mode. Built only under import.meta.env.DEV, so it never ships.

const LIFT = 2.2; // how far above the ground the grid floats (clears the grass in normal view)
const LINE_COLOR = 0xffffff;
const NUMBER_COLOR = "#ffffff";
const FACE_SCALE = 2.2; // world size of a triangle number (eye-tune)

export function createGridGizmo(scene, grid) {
  const R = grid.radius + LIFT;
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  // White wireframe of the same triangles, scaled up so it floats above the ground. Same geometry build
  // as planetGrid, so the cells line up with the numbers we drop at each center.
  const wireGeo = new THREE.IcosahedronGeometry(R, grid.detail);
  const lines = new THREE.LineSegments(
    new THREE.WireframeGeometry(wireGeo),
    new THREE.LineBasicMaterial({ color: LINE_COLOR, fog: false }),
  );
  wireGeo.dispose();
  group.add(lines);

  // Each number is a little canvas chip turned into a camera-facing sprite. Cache textures by their text
  // so we only draw each number once.
  const texCache = new Map();
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function labelTexture(text) {
    const hit = texCache.get(text);
    if (hit) return hit;
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const g = canvas.getContext("2d");
    g.fillStyle = "rgba(0,0,0,0.55)"; // dark chip so the number reads over bare ground or the tan path
    roundRect(g, 12, 30, 104, 68, 16);
    g.fill();
    g.font = "bold 66px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = NUMBER_COLOR;
    g.fillText(text, 64, 66);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    texCache.set(text, tex);
    return tex;
  }

  // One number per triangle, at its center.
  grid.faces.forEach((face, i) => {
    const text = String(i + 1);
    const mat = new THREE.SpriteMaterial({ map: labelTexture(text), transparent: true, fog: false });
    const spr = new THREE.Sprite(mat);
    spr.position.copy(face.center).multiplyScalar(R);
    spr.scale.set(FACE_SCALE, FACE_SCALE, 1);
    group.add(spr);
  });

  return {
    setVisible(v) {
      group.visible = v;
    },
  };
}
