// The crosshair. It replaces the mouse arrow over the game and IS the aim: wherever it sits is what the
// wand shoots at.
//
// Drawn as an HTML element on top of the canvas rather than as an object in the 3D scene, because it
// belongs to the screen, not to the world. A crosshair in the scene would be affected by perspective,
// fog, the sun and the depth of whatever is behind it, and would need constant work to stop all four
// happening. On top as a div it is simply always the same size in the same place, which is the whole
// point of a crosshair.
//
// pointer-events: none is what stops it eating the clicks meant for the game underneath.

// How big the crosshair is, in screen pixels, free and when locked onto something. It grows on lock, so
// the change is felt at the edge of your eye without having to look at it.
const SIZE_FREE = 22;
const SIZE_LOCKED = 34;

// The colours. White while it is pointing at nothing, the spell's green the moment it is over a target,
// so the crosshair and the beam are obviously the same system.
const COLOR_FREE = "rgba(255, 255, 255, 0.85)";
const COLOR_LOCKED = "#3cff6e";

export function createReticle() {
  // The four ticks around the centre, built as one element each so they can be moved apart on lock. A
  // gap in the middle rather than a solid cross, so the thing being aimed at is never hidden by the aim.
  const root = document.createElement("div");
  root.style.cssText = `
    position: fixed; left: 0; top: 0; z-index: 20;
    pointer-events: none; transform: translate(-50%, -50%);
    display: none;
  `;

  const ticks: HTMLDivElement[] = [];
  for (let i = 0; i < 4; i++) {
    const tick = document.createElement("div");
    tick.style.cssText = "position: absolute; background: #fff; transform: translate(-50%, -50%);";
    root.appendChild(tick);
    ticks.push(tick);
  }

  // A dot dead centre, which is the actual aim point. The ticks only frame it.
  const dot = document.createElement("div");
  dot.style.cssText = `
    position: absolute; width: 3px; height: 3px; border-radius: 50%;
    background: #fff; transform: translate(-50%, -50%);
  `;
  root.appendChild(dot);
  document.body.appendChild(root);

  // Hide the operating system's arrow over the game itself. Only over the canvas, so the arrow comes
  // back over the HUD and the voice panel where you actually need to click something.
  const canvas = document.querySelector("canvas");
  if (canvas) canvas.style.cursor = "none";

  let shown = false;

  return {
    // Put the crosshair at the cursor and set it to locked or free. Called once a frame by targeting,
    // which is the thing that knows whether the aim is over anybody.
    update(x: number, y: number, locked: boolean) {
      if (!shown) {
        root.style.display = "block";
        shown = true;
      }
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;

      const size = locked ? SIZE_LOCKED : SIZE_FREE;
      const color = locked ? COLOR_LOCKED : COLOR_FREE;
      const arm = locked ? 10 : 7; // how long each tick is
      const thickness = locked ? 3 : 2;
      const glow = locked ? `0 0 6px ${COLOR_LOCKED}` : "0 0 3px rgba(0,0,0,0.9)";

      for (let i = 0; i < 4; i++) {
        const tick = ticks[i];
        const vertical = i < 2; // 0,1 are above and below; 2,3 are left and right
        const away = i % 2 === 0 ? -size / 2 : size / 2;
        tick.style.width = `${vertical ? thickness : arm}px`;
        tick.style.height = `${vertical ? arm : thickness}px`;
        tick.style.left = `${vertical ? 0 : away}px`;
        tick.style.top = `${vertical ? away : 0}px`;
        tick.style.background = color;
        tick.style.boxShadow = glow;
      }
      dot.style.background = color;
      dot.style.boxShadow = glow;
    },
  };
}

export type Reticle = ReturnType<typeof createReticle>;
