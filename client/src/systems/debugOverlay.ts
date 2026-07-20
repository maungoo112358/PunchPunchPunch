// The corner readout. It knows nothing about the game: you hand it a function that returns whatever
// labels and values you want shown, and it redraws them every frame. Dev-only for now. Step 14 grows
// this into the real netcode readout (round trip time, how far prediction was off, corrections a
// second), which is the thing that makes the netcode visible to someone watching rather than invisible
// when it works.
//
// Frame rate is one of the rows, worked out here from the time between frames, so everything is one
// list in one box that comes and goes together. Averaged over a short window, because the raw
// frame-to-frame number jumps around too much to read.

// How long to average the frame rate over. Long enough to sit still, short enough to react.
const FPS_WINDOW = 0.5; // seconds

// What to show, worked out fresh each frame: a label on the left, a value on the right.
type Rows = () => Record<string, string | number>;

export function createDebugOverlay(rows: Rows) {
  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed",
    "top:8px",
    "left:8px",
    "padding:8px 10px",
    "background:rgba(0,0,0,0.6)",
    "color:#e8e8e8",
    "font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    "line-height:1.45",
    "white-space:pre",
    "border-radius:4px",
    "z-index:10",
    "pointer-events:none", // clicks go through to the game, so dragging to orbit still works
    "display:none",
  ].join(";");
  document.body.appendChild(panel);

  let visible = false;
  let frames = 0; // frames counted since the last frame-rate update
  let elapsed = 0; // seconds those frames took
  let fps = 0;

  return {
    toggle() {
      visible = !visible;
      panel.style.display = visible ? "block" : "none";
    },

    update(dt: number) {
      // Count frames even while hidden, so the number is already right when you open the panel.
      frames++;
      elapsed += dt;
      if (elapsed >= FPS_WINDOW) {
        fps = frames / elapsed;
        frames = 0;
        elapsed = 0;
      }
      if (!visible) return;

      const data = { fps: fps.toFixed(0), ...rows() };
      // Pad the labels so the values line up in a column instead of jittering as digits come and go.
      const width = Math.max(...Object.keys(data).map((k) => k.length));
      panel.textContent = Object.entries(data)
        .map(([label, value]) => `${label.padEnd(width)}  ${value}`)
        .join("\n");
    },
  };
}

export type DebugOverlay = ReturnType<typeof createDebugOverlay>;
