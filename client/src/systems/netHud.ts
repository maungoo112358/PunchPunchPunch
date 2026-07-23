// The netcode HUD, and this one ships. A corner readout of the numbers that make the netcode visible,
// plus the three controls that drive the demo: a fake-latency slider, a prediction on/off toggle, and a
// live protobuf/JSON switch. Toggle the whole panel with I.
//
// Unlike the old dev readout it is interactive, so it swallows pointer events to keep a drag on the slider
// from also orbiting the camera. Netcode is invisible when it works; this is what shows the work.

const FPS_WINDOW = 0.5; // seconds to average the frame rate over, long enough to sit still

type NetHud = {
  rows: () => Record<string, string | number>;
  onLatency: (ms: number) => void;
  onTogglePrediction: () => void;
  predictionOn: () => boolean;
  onToggleEncoding: () => void;
  encoding: () => string;
};

export function createNetHud(cfg: NetHud) {
  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed", "top:8px", "left:8px", "padding:8px 10px",
    "background:rgba(0,0,0,0.62)", "color:#e8e8e8",
    "font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", "line-height:1.45",
    "border-radius:5px", "z-index:10", "min-width:200px", "display:none",
  ].join(";");
  // Keep a click or drag on the panel from starting a camera orbit on the window behind it.
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());

  const readout = document.createElement("pre");
  readout.style.cssText = "margin:0 0 8px 0;white-space:pre";
  panel.appendChild(readout);

  // Latency slider: 0 to 500ms of added round trip.
  const latRow = document.createElement("div");
  latRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px";
  const latLabel = document.createElement("span");
  latLabel.textContent = "lag";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "500";
  slider.step = "10";
  slider.value = "0";
  slider.style.cssText = "flex:1";
  const latVal = document.createElement("span");
  latVal.textContent = "0ms";
  latVal.style.cssText = "min-width:46px;text-align:right";
  slider.addEventListener("input", () => {
    const v = Number(slider.value);
    latVal.textContent = `${v}ms`;
    cfg.onLatency(v);
  });
  latRow.append(latLabel, slider, latVal);
  panel.appendChild(latRow);

  // Prediction and encoding toggles.
  function makeButton(onClick: () => void) {
    const b = document.createElement("button");
    b.style.cssText =
      "flex:1;padding:4px 6px;font:inherit;cursor:pointer;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#e8e8e8";
    b.addEventListener("click", onClick);
    return b;
  }
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px";
  const predBtn = makeButton(cfg.onTogglePrediction);
  const encBtn = makeButton(cfg.onToggleEncoding);
  btnRow.append(predBtn, encBtn);
  panel.appendChild(btnRow);

  document.body.appendChild(panel);

  let visible = false;
  let frames = 0;
  let elapsed = 0;
  let fps = 0;

  return {
    toggle() {
      visible = !visible;
      panel.style.display = visible ? "block" : "none";
    },

    update(dt: number) {
      frames++;
      elapsed += dt;
      if (elapsed >= FPS_WINDOW) {
        fps = frames / elapsed;
        frames = 0;
        elapsed = 0;
      }
      if (!visible) return;

      const data = { fps: fps.toFixed(0), ...cfg.rows() };
      const width = Math.max(...Object.keys(data).map((k) => k.length));
      readout.textContent = Object.entries(data)
        .map(([label, value]) => `${label.padEnd(width)}  ${value}`)
        .join("\n");
      predBtn.textContent = `predict: ${cfg.predictionOn() ? "on" : "off"}`;
      encBtn.textContent = `enc: ${cfg.encoding()}`;
    },
  };
}

export type NetHudHandle = ReturnType<typeof createNetHud>;
