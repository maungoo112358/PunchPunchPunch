import type { PeerState, PeerInfo } from "./voice.js";

// The voice panel, top left. Deliberately plain for now: a join button, a mute-myself button, and one row
// per player showing how their connection is going. Steps 5 and 6 grow this into the real thing with
// volume sliders, per-person mute and a lit-up name while someone is talking.
//
// The connection state per row is the point of this version. Voice either works or it does not, and when
// it does not the only useful question is how far the handshake got, which is exactly what a row shows.
// Testing happens on two machines on two different networks, so this has to be readable without devtools.
//
// Plain DOM on top of the canvas, the same as the login overlay and the netcode readout, and it swallows
// pointer events so clicking a button does not also swing the camera.

// What each state means to the person reading it, rather than what it means to the code.
const LABEL: Record<PeerState, string> = {
  calling: "calling...",
  live: "connected",
  failed: "unreachable",
};

const COLOR: Record<PeerState, string> = {
  calling: "#d8c56a",
  live: "#7fd07f",
  failed: "#d07f7f",
};

// Talking is shown by brightening the name rather than adding an icon. It has to be readable at a glance
// while you are looking at the game and not at the panel, and a name going bright is the least you can
// draw that still answers "who is that".
const SPEAKING_NAME = "#ffffff";
const QUIET_NAME = "#9a9a9a";

type VoicePanel = {
  // Everyone in the world, how their connection is going, and whether they are talking.
  peers: () => Map<string, PeerInfo>;
  // The name to show for a player id, so the panel shows "Cthulhu" and not "p3".
  nameFor: (id: string) => string;
  joined: () => boolean;
  micEnabled: () => boolean;
  selfSpeaking: () => boolean;
  // Raw microphone loudness and the line it has to cross to transmit, both 0 to 1.
  selfLevel: () => number;
  speakingLevel: () => number;
  // What the browser's audio engine is doing, shown only when it is not healthy.
  audioState: () => string;
  monitoring: () => boolean;
  onJoin: () => void;
  onToggleMic: () => void;
  onToggleMonitor: () => void;
};

// The bar is drawn on a square-root scale rather than straight. Speech sits low in the 0 to 1 range and a
// straight bar leaves it as a barely visible sliver, which is useless for judging anything. This spreads
// the quiet end out where all the interesting movement is.
function barWidth(level: number): number {
  return Math.min(100, Math.sqrt(Math.min(1, Math.max(0, level))) * 100);
}

export function createVoicePanel(cfg: VoicePanel) {
  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed", "top:8px", "left:8px", "padding:8px 10px",
    "background:rgba(0,0,0,0.62)", "color:#e8e8e8",
    "font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", "line-height:1.5",
    "border-radius:5px", "z-index:11", "min-width:190px",
  ].join(";");
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());

  function button(label: string, onClick: () => void) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = [
      "width:100%", "margin-bottom:6px", "padding:4px 8px", "cursor:pointer",
      "background:#2f6f3f", "color:#eaeaea", "border:0", "border-radius:4px",
      "font:inherit",
    ].join(";");
    b.addEventListener("click", onClick);
    panel.appendChild(b);
    return b;
  }

  const joinBtn = button("join voice", cfg.onJoin);
  const micBtn = button("mute me", cfg.onToggleMic);
  // The self-test. Nothing between your microphone and your own speakers, so it answers one question on
  // its own: does sound get in and back out of this browser at all.
  const monitorBtn = button("hear myself", cfg.onToggleMonitor);

  // What your own microphone is hearing, right now. This exists because everything else about voice is
  // invisible: with a moving bar you can tell a dead microphone from a working one that is simply too
  // quiet to cross the line, and those two look identical from anywhere else.
  const meter = document.createElement("div");
  meter.style.cssText = "position:relative;height:8px;background:#222;border-radius:3px;margin-bottom:6px;overflow:hidden";
  const fill = document.createElement("div");
  fill.style.cssText = "height:100%;width:0%;background:#7fd07f;transition:width 60ms linear";
  // The line the level has to cross before anything is sent, so the threshold can be judged by eye
  // against real speech instead of guessed at.
  const mark = document.createElement("div");
  mark.style.cssText = "position:absolute;top:0;bottom:0;width:1px;background:#e8e8e8;opacity:0.7";
  meter.append(fill, mark);
  panel.appendChild(meter);

  const note = document.createElement("div");
  note.style.cssText = "color:#d07f7f;margin-bottom:6px";
  panel.appendChild(note);

  const list = document.createElement("div");
  panel.appendChild(list);
  document.body.appendChild(panel);

  // Only touches the bar. Called many times a second, so it must never rebuild the rows.
  function renderLevel() {
    fill.style.width = `${barWidth(cfg.selfLevel())}%`;
    fill.style.background = cfg.selfSpeaking() ? "#9fe89f" : "#4a7a4a";
  }

  // Rebuilt whole rather than diffed. Five rows costs nothing to throw away, and this only runs when
  // something actually changed, never per frame.
  function render() {
    const joined = cfg.joined();
    joinBtn.style.display = joined ? "none" : "block";
    micBtn.style.display = joined ? "block" : "none";
    meter.style.display = joined ? "block" : "none";
    mark.style.left = `${barWidth(cfg.speakingLevel())}%`;

    monitorBtn.style.display = joined ? "block" : "none";
    monitorBtn.textContent = cfg.monitoring() ? "stop hearing myself" : "hear myself";
    monitorBtn.style.background = cfg.monitoring() ? "#6f5f2f" : "#2f5f6f";

    // Said out loud only when it is wrong. A gate that is off means the microphone is wide open, which is
    // working but not what was asked for, and silently doing the wrong thing is worse than saying so.
    const state = cfg.audioState();
    const healthy = !joined || state === "running";
    note.textContent = healthy ? "" : `audio engine ${state}, mic stays open`;
    note.style.display = healthy ? "none" : "block";
    // The button doubles as your own talking light, so you can see the gate opening and know your
    // microphone is actually working before anyone tells you it is not.
    micBtn.textContent = cfg.micEnabled() ? (cfg.selfSpeaking() ? "talking" : "mute me") : "unmute me";
    micBtn.style.background = !cfg.micEnabled() ? "#6f2f2f" : cfg.selfSpeaking() ? "#3f8f4f" : "#2f6f3f";

    list.textContent = "";
    const peers = cfg.peers();
    if (!joined) {
      list.textContent = "voice is off";
      return;
    }
    if (peers.size === 0) {
      list.textContent = "nobody else here";
      return;
    }
    for (const [id, info] of peers) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;gap:10px";
      const who = document.createElement("span");
      who.textContent = cfg.nameFor(id);
      who.style.color = info.speaking ? SPEAKING_NAME : QUIET_NAME;
      const how = document.createElement("span");
      how.textContent = LABEL[info.state];
      how.style.color = COLOR[info.state];
      row.append(who, how);
      list.appendChild(row);
    }
  }

  render();
  renderLevel();
  return { render, renderLevel };
}

export type VoicePanelHandle = ReturnType<typeof createVoicePanel>;
