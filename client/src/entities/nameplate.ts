import * as THREE from "three";

// A name tag: text drawn to a canvas, shown on a sprite. A Sprite always faces the camera, so the plate
// stays readable from any angle for free. worldView positions it above the head each frame; here we only
// build it and size it to a readable world height. Returned with its own dispose, since the canvas
// texture and material belong to this one plate.

const FONT = "bold 44px system-ui, sans-serif";
const PAD_X = 24; // canvas pixels of breathing room each side of the text
const HEIGHT_PX = 72; // canvas height; width grows with the name
const WORLD_HEIGHT = 0.5; // how tall the plate stands in world units, eye-tune against the character

export function createNameplate(name: string) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  // Measure with the font set, then size the canvas to fit. Setting canvas.width resets the context, so
  // the font has to be applied again before drawing.
  ctx.font = FONT;
  const textWidth = Math.ceil(ctx.measureText(name).width);
  canvas.width = textWidth + PAD_X * 2;
  canvas.height = HEIGHT_PX;
  ctx.font = FONT;

  // A dark rounded pill so the name reads against both the pale sky and the grass.
  ctx.fillStyle = "rgba(20, 22, 30, 0.72)";
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 18);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, canvas.width / 2, canvas.height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; // treat the drawn colors as sRGB so white stays white
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(WORLD_HEIGHT * (canvas.width / canvas.height), WORLD_HEIGHT, 1);

  return {
    sprite,
    dispose() {
      texture.dispose();
      material.dispose();
    },
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
