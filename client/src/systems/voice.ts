import { VoiceKind } from "../net/session.js";
import type { VoiceSignal } from "../net/session.js";

// Voice chat, the client half and the only part that touches sound.
//
// No audio goes through our server. Each browser opens a direct connection to each other browser and the
// sound travels between them, so the server only carries the handshake that lets them find each other.
// server/voice.go is that mailbox, and net/session.ts is how the messages get there.
//
// One connection per other player. At the five the character pool allows that is four connections each,
// which is nothing. Past roughly eight this shape stops paying and the audio would want to go through a
// server instead, so the count matters if the pool ever grows.

// The two kinds of help a browser needs to reach another browser.
//
// The first is somewhere to ask "what does my address look like from the outside", which it needs because
// a home router hides the real one. Google runs these free and it is an address to talk to, not a package
// to install.
//
// The second is a relay to bounce the sound through when the two browsers cannot reach each other at all.
// Plenty of home and mobile networks will not accept a connection that was not started from inside them,
// and when both ends are like that there is no direct route to find. Measured in the wild that is around
// 30% of pairs, and a missing relay is the most common reason voice fails in production, so this is not
// the rare case it looks like.
//
// These relay credentials are the Open Relay project's public test ones. They are fine for finding out
// whether a relay is what was missing, and they are not something to leave in a real deployment: the
// traffic goes through someone else's server on a shared free allowance. If this turns out to be the fix,
// the honest options are our own relay on the Lightsail box or a paid account with its own credentials.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443"],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

// What we ask the microphone for. All three are the browser cleaning the signal up before it ever reaches
// the network: cancel the echo of other people's voices coming back through speakers, drop steady
// background noise like a fan, and even out how loud someone is. They are far better on headphones than
// on speakers, which is worth knowing when someone reports echo.
const MIC: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

// Only one side of a pair ever places the call, and it is always the one whose id sorts lower. The other
// waits and answers. This is the rule that keeps the whole thing simple: two browsers can never be
// dialling each other at the same moment, so there is no tie to break and no way for both to sit waiting
// on a call the other already threw away. The rule only has to be agreed, not fair, and comparing the two
// ids gives both sides the same answer without either having to ask.
function callerOf(a: string, b: string): string {
  return a < b ? a : b;
}

// How often the caller looks over its calls. Only a check, not a deadline: a call that is genuinely
// progressing is never touched here.
const CALL_SWEEP_MS = 2000;

// How long a call may go completely unanswered before it is placed again. Only counted while nothing at
// all has come back, which is what calling someone who has not joined voice looks like. It has to be
// comfortably longer than a real handshake between two homes, because cutting one of those off is far
// worse than waiting a few extra seconds for someone who was never going to answer.
const UNANSWERED_MS = 8000;

// How often we look at how loud a stream is. This is also how late the start of a word can be: nothing is
// sent until a reading comes in above the line, so at 20ms the most that can be clipped off the front of
// "hello" is 20ms, which nobody hears. Reading the meter is just copying a small buffer, so 50 times a
// second costs nothing.
const LEVEL_POLL_MS = 20;

// How loud counts as talking. This is the one number to tune by ear: too low and a fan holds the line
// open, too high and quiet speech gets cut. Levels run 0 to 1 and ordinary speech sits well above this.
const SPEAKING_LEVEL = 0.02;

// How long to keep sending after you drop below the line. Speech is full of short gaps, and cutting out
// the instant you pause chops the ends off words, which sounds far worse than the background noise this
// is meant to remove. It is also what stops the talking light flickering on every syllable.
const HANG_MS = 400;

// What the panel shows per person. "calling" covers everything from sending the offer to the sound
// arriving, because from the outside those are all just waiting.
export type PeerState = "calling" | "live" | "failed";

// One row's worth: how the connection is going, and whether they are talking right this moment.
export type PeerInfo = { state: PeerState; speaking: boolean };

// Measures how loud a stream is right now. The same code serves both jobs: on our own microphone it
// decides whether to transmit, and on someone else's incoming voice it decides whether to light their
// name up. The analyser is deliberately not connected onward to the speakers, so this only ever listens.
// Their sound reaches the speakers through the audio element instead, which is also what keeps the
// browser feeding this node anything at all.
type Meter = { level(): number; close(): void };

function createMeter(ctx: AudioContext, stream: MediaStream): Meter {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  return {
    // Root mean square: square every sample, average, square root. Loudness is about how far the wave
    // swings from silence in either direction, so squaring is what stops the negative half of the wave
    // cancelling out the positive half and reporting silence for a loud sound.
    level() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return Math.sqrt(sum / samples.length);
    },
    close() {
      source.disconnect();
      analyser.disconnect();
    },
  };
}

type Peer = {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  state: PeerState;
  // When this attempt started, so the sweep can tell a call that is still connecting from one that has
  // been sitting unanswered and should be placed again.
  startedAt: number;
  // Addresses that arrived before we had their description to attach them to. The caller sends its
  // description and then starts sending addresses immediately, so on a fast connection the addresses
  // overtake the description in our own handling of them. A browser refuses an address until it has the
  // description, so these wait here and go in the moment it lands. Losing them is not survivable: the two
  // browsers have nothing left to find each other through.
  pendingCandidates: RTCIceCandidateInit[];
  // Watching their incoming voice, so their name can light up while they talk.
  meter: Meter | null;
  speaking: boolean;
  lastLoud: number;
};

type VoiceDeps = {
  // Sends one handshake step to another player, through the game socket.
  sendSignal(peer: string, kind: VoiceKind, payload: string): void;
  // Called whenever anything the panel draws has changed.
  onChange(): void;
  // Called on every reading of our own microphone, many times a second. Only for the level bar, which
  // has to move smoothly, so it must not redraw the whole panel.
  onLevel?(): void;
};

export function createVoice(deps: VoiceDeps) {
  let selfId = "";
  let mic: MediaStream | null = null;
  let joined = false;
  let micEnabled = true;

  // The browser's audio engine, used only for measuring loudness. Built on the join click, because a
  // browser will not start one without a gesture behind it and it would sit suspended forever.
  let audioCtx: AudioContext | null = null;
  let micMeter: Meter | null = null;
  let selfSpeaking = false;
  let selfLastLoud = 0;
  // The last raw reading from our own microphone, kept so the panel can draw it. Seeing the real number
  // move is the difference between "voice is broken" and "the microphone is fine, the threshold is wrong".
  let selfLevel = 0;

  // Self-test: our own microphone wired straight to our own speakers, with nothing else in the way. No
  // other player, no connection, no server. If you can hear yourself then the microphone, the audio engine
  // and playback are all fine and any remaining problem is in the part that carries sound between
  // browsers. If you cannot, nothing further along was ever going to work.
  // While it is on the gate is bypassed and the microphone is held open, so a closed gate cannot be
  // mistaken for a dead microphone.
  let monitor: { source: MediaStreamAudioSourceNode; gain: GainNode } | null = null;

  // Everyone in the world, whether or not they are in voice. We offer to all of them and the ones who
  // have not joined ignore it, which is why the answer timeout above exists.
  const players = new Set<string>();
  const peers = new Map<string, Peer>();
  // One queue per player, so handshake steps from them are applied strictly in the order they were sent.
  // Kept out of the Peer so it survives a connection being torn down and rebuilt underneath it.
  const queues = new Map<string, Promise<void>>();

  function setState(id: string, state: PeerState) {
    const peer = peers.get(id);
    if (!peer || peer.state === state) return;
    peer.state = state;
    deps.onChange();
  }

  // Builds the connection to one player and wires up its four events. It does not offer: adding our
  // microphone below makes the browser raise "negotiationneeded" on its own, and that is where the offer
  // is written. Letting the browser decide when to negotiate is what keeps this correct when a track is
  // added or replaced later.
  function connect(id: string): Peer {
    // Never leave an old connection behind. Its audio element is in the page and playing, so replacing
    // one in the map without closing it first would leave two copies of the same person's voice coming
    // out of the speakers, slightly apart, which sounds exactly like an echo you cannot get rid of.
    drop(id);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const audio = new Audio();
    audio.autoplay = true;
    // Put it in the page even though there is nothing to see. Some browsers are more willing to start
    // sound for an element that is actually in the document than for one floating loose in a variable.
    audio.style.display = "none";
    document.body.appendChild(audio);

    const peer: Peer = {
      pc,
      audio,
      state: "calling",
      startedAt: performance.now(),
      pendingCandidates: [],
      meter: null,
      speaking: false,
      lastLoud: 0,
    };
    peers.set(id, peer);

    // Only the caller writes an offer. The browser raises this as soon as our microphone is added, and on
    // the answering side we let it pass, because that side's description is written in reply to the call
    // rather than ahead of it.
    pc.onnegotiationneeded = async () => {
      if (callerOf(selfId, id) !== selfId) return;
      try {
        await pc.setLocalDescription();
        deps.sendSignal(id, VoiceKind.OFFER, JSON.stringify(pc.localDescription));
      } catch (err) {
        console.warn(`voice: could not call ${id}`, err);
      }
    };

    // One address this browser might be reachable at. These arrive over a second or two, several per
    // connection, and each is forwarded on its own as it turns up rather than waiting for the whole set.
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) deps.sendSignal(id, VoiceKind.CANDIDATE, JSON.stringify(candidate));
    };

    // Their sound. Attaching the stream to an audio element is all that playing it takes, and the
    // element's own volume is what the panel will later turn down or mute.
    pc.ontrack = ({ streams }) => {
      const stream = streams[0] ?? null;
      audio.srcObject = stream;
      // Browsers can refuse to start audio without a click behind it. Joining voice is a click, so this
      // almost always succeeds, and Safari is the one that will complain if anything ever changes that.
      audio.play().catch((err) => console.warn(`voice: browser would not play ${id}`, err));
      // Watch their level too, which is what lights their name up while they speak.
      peer.meter?.close();
      peer.meter = stream && audioCtx ? createMeter(audioCtx, stream) : null;
    };

    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case "connected":
          // The self-test cannot stay on once there is somebody to talk to. It plays your microphone
          // back through the audio engine, and Chrome's echo canceller only removes sound it knows came
          // from a call, so anything played that way is invisible to it. Your own voice then leaves the
          // speaker uncancelled, your microphone picks it up, and the other person hears it back. That is
          // not a room problem you can fix with headphones, it is guaranteed by the route the sound takes.
          stopMonitoring();
          setState(id, "live");
          break;
        case "failed":
          setState(id, "failed");
          break;
        case "disconnected":
          setState(id, "calling"); // it often comes back on its own, so this is not a failure yet
          break;
      }
    };

    if (mic) for (const track of mic.getTracks()) pc.addTrack(track, mic);
    deps.onChange();
    return peer;
  }

  // Places any call that is missing or has gone stale. Only the caller of each pair does anything here;
  // the other side has nothing to do but wait, so it walks away.
  //
  // Calling someone who has not joined voice yet is the ordinary case, not a failure: they ignore it, and
  // this comes round again a few seconds later and calls once more. That is why nothing here ever gives
  // up. It is also what repairs a connection that dies long after it was working.
  function sweepCalls() {
    if (!joined) return;
    const now = performance.now();

    for (const id of players) {
      if (callerOf(selfId, id) !== selfId) continue;

      const peer = peers.get(id);
      if (!peer) {
        connect(id);
        continue;
      }
      const pc = peer.pc;

      // They answered, so this is a live negotiation. Leave it completely alone until the browser says it
      // has failed. Finding a route between two homes takes seconds and the connection sits in "new" for
      // most of it, so anything that treats "not connected yet" as "not working" tears down handshakes
      // that were about to succeed. That mistake is what made every call end in unreachable.
      if (pc.currentRemoteDescription) {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          drop(id);
          connect(id);
        }
        continue;
      }

      // No answer at all yet, which is what calling someone who has not joined voice looks like. Wait long
      // enough that a slow but real handshake is never mistaken for silence, then call again.
      if (now - peer.startedAt > UNANSWERED_MS) {
        drop(id);
        connect(id);
      }
    }
  }

  // Applies one handshake step. Only ever runs from the queue above, one at a time per player.
  async function applySignal(id: string, sig: VoiceSignal) {
    let peer = peers.get(id) ?? connect(id);

    if (sig.kind === VoiceKind.CANDIDATE) {
      const candidate = JSON.parse(sig.payload) as RTCIceCandidateInit;
      // No description of theirs yet, so the browser has nothing to attach this to. Hold it.
      if (!peer.pc.currentRemoteDescription) {
        peer.pendingCandidates.push(candidate);
        return;
      }
      await peer.pc.addIceCandidate(candidate);
      return;
    }

    const description = JSON.parse(sig.payload) as RTCSessionDescriptionInit;

    // A fresh call from the caller, arriving while we still hold a half-finished or dead attempt from
    // them. Only one side of a pair ever calls, so this is never a crossed line; it is the sweep calling
    // again. Start from nothing rather than unpick what is left of the old one.
    if (description.type === "offer") {
      const stale = peer.pc.signalingState !== "stable" || peer.pc.connectionState === "failed";
      if (stale) {
        drop(id);
        peer = connect(id);
      }
    }

    await peer.pc.setRemoteDescription(description);
    // Their description has landed, so anything that arrived ahead of it can go in now.
    const waiting = peer.pendingCandidates.splice(0);
    for (const candidate of waiting) {
      await peer.pc.addIceCandidate(candidate).catch(() => {}); // one bad address must not stop the rest
    }

    if (description.type === "offer") {
      await peer.pc.setLocalDescription();
      deps.sendSignal(id, VoiceKind.ANSWER, JSON.stringify(peer.pc.localDescription));
    }
  }

  function stopMonitoring() {
    if (!monitor) return;
    monitor.source.disconnect();
    monitor.gain.disconnect();
    monitor = null;
    deps.onChange();
  }

  function drop(id: string) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.meter?.close();
    peer.pc.onnegotiationneeded = null; // stop it asking to renegotiate on the way down
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
    peers.delete(id);
    deps.onChange();
  }

  // Turns a raw level into "is this person talking", with the hang time applied. Above the line is
  // instantly talking; below it, they stay talking until the hang runs out, so ordinary pauses between
  // words do not register as stopping.
  function talking(level: number, lastLoud: number, now: number): { talking: boolean; lastLoud: number } {
    const loud = level > SPEAKING_LEVEL;
    const at = loud ? now : lastLoud;
    return { talking: now - at < HANG_MS, lastLoud: at };
  }

  // The one timer behind both jobs. It gates our own microphone and works out who is speaking, and it
  // only tells the panel to redraw when something actually changed, because this runs fifty times a
  // second and the panel does not.
  function pollLevels() {
    const now = performance.now();
    let changed = false;

    if (micMeter && mic) {
      // A suspended audio engine reports pure silence for everything, which the gate below would read as
      // "not talking" and hold the microphone shut forever. Browsers hand one back suspended more often
      // than you would like, because asking for the microphone breaks the chain back to the click that
      // started all this. So while it is not running we do not gate at all: an open microphone is a far
      // better failure than a room where nobody can hear anyone.
      const running = audioCtx?.state === "running";
      if (!running) void audioCtx?.resume();

      selfLevel = running ? micMeter.level() : 0;
      const self = running
        ? talking(selfLevel, selfLastLoud, now)
        : { talking: true, lastLoud: now };
      selfLastLoud = self.lastLoud;
      deps.onLevel?.();
      // Muting yourself wins over everything: silence is silence no matter how loud the room is.
      // The self-test wins over the gate, so a shut gate can never look like a broken microphone.
      const sending = micEnabled && (self.talking || monitor !== null);
      for (const track of mic.getAudioTracks()) {
        // Switching the track off is what stops the sound leaving. The connection stays up and the other
        // side simply hears nothing, which is why this is instant and needs no renegotiating.
        if (track.enabled !== sending) track.enabled = sending;
      }
      if (self.talking !== selfSpeaking) {
        selfSpeaking = self.talking;
        changed = true;
      }
    }

    for (const peer of peers.values()) {
      if (!peer.meter) continue;
      const them = talking(peer.meter.level(), peer.lastLoud, now);
      peer.lastLoud = them.lastLoud;
      if (them.talking !== peer.speaking) {
        peer.speaking = them.talking;
        changed = true;
      }
    }

    if (changed) deps.onChange();
  }

  return {
    // Our own id, from the Welcome. Needed before anything else, because which side places the call is
    // decided by comparing it against the other player's.
    setSelfId(id: string) {
      selfId = id;
    },

    get joined() {
      return joined;
    },

    get micEnabled() {
      return micEnabled;
    },

    // Whether our own microphone is passing sound through right now, for the panel to light us up too.
    get selfSpeaking() {
      return selfSpeaking;
    },

    // The raw loudness of our own microphone, 0 to roughly 1, and the line it has to cross to transmit.
    // The panel draws both so the threshold can be judged against what the microphone actually hears.
    get selfLevel() {
      return selfLevel;
    },
    get speakingLevel() {
      return SPEAKING_LEVEL;
    },

    get monitoring() {
      return monitor !== null;
    },

    // Wire our own microphone to our own speakers, or unwire it. Use headphones: on speakers this is a
    // feedback loop by definition, because the microphone can hear the speakers playing the microphone.
    setMonitoring(on: boolean) {
      if (on === (monitor !== null)) return;
      if (!on) {
        stopMonitoring();
        return;
      }
      // Refused while anyone is connected, for the reason above: it would feed your own uncancellable
      // voice to everyone in the room. It is a test for when you are alone, not a feature.
      for (const peer of peers.values()) {
        if (peer.pc.connectionState === "connected") {
          console.warn("voice: not testing the mic while someone is connected, it would echo to them");
          return;
        }
      }
      if (!audioCtx || !mic) {
        console.warn("voice: cannot hear yourself, there is no audio engine or no microphone");
        return;
      }
      try {
        // Asking again here matters: this runs from a real click, which is exactly the moment a browser
        // is willing to start an engine it refused to start before.
        void audioCtx.resume();
        const source = audioCtx.createMediaStreamSource(mic);
        const gain = audioCtx.createGain();
        gain.gain.value = 1;
        source.connect(gain).connect(audioCtx.destination);
        monitor = { source, gain };
      } catch (err) {
        console.warn("voice: could not wire the microphone to the speakers", err);
      }
      deps.onChange();
    },

    // What the browser's audio engine is doing. "running" is healthy. Anything else means the gate is off
    // and the microphone is being left open, which is worth saying out loud rather than hiding.
    get audioState(): string {
      return joined ? (audioCtx ? audioCtx.state : "none") : "-";
    },

    // Everyone currently in the world, how their connection is going, and whether they are talking.
    // Every player gets a row whether or not a connection exists yet, because the side that waits to be
    // called has no connection at all until the call arrives, and showing nobody there would be a lie.
    peerStates(): Map<string, PeerInfo> {
      const out = new Map<string, PeerInfo>();
      for (const id of players) {
        const peer = peers.get(id);
        out.set(id, peer ? { state: peer.state, speaking: peer.speaking } : { state: "calling", speaking: false });
      }
      return out;
    },

    // Asks for the microphone and calls everyone. The browser will not hand over a microphone without a
    // click behind it, so this has to be reached from a button and not from startup.
    async join() {
      if (joined) return;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: MIC });
      } catch (err) {
        console.warn("voice: microphone refused", err);
        return;
      }
      joined = true;

      // Call everyone we are the caller for, and keep checking. Connecting must not depend on the
      // loudness meter below working, because a browser that will not give us an audio engine is still
      // perfectly able to carry voice, and the wrong order here once left people connected to nobody.
      sweepCalls();
      window.setInterval(sweepCalls, CALL_SWEEP_MS);

      // Then the meter on our own microphone, which is what decides when to actually transmit.
      //
      // The order here is the whole point. Nothing that can hang or throw is allowed to run before the
      // polling loop is started, because that loop is what moves the level bar, opens the gate, and keeps
      // retrying to wake the audio engine. Awaiting resume() here once stopped all three: on an engine the
      // browser will not start, that promise never settles at all, so there is no error and no clue, just
      // a dead meter and a microphone that never opens.
      try {
        audioCtx = new AudioContext();
        micMeter = createMeter(audioCtx, mic);
        for (const track of mic.getAudioTracks()) track.enabled = false;
      } catch (err) {
        // No meter means no gate, so the microphone is left open rather than left shut. Being heard with
        // background noise beats not being heard at all.
        console.warn("voice: no loudness meter, microphone stays open", err);
        audioCtx = null;
        micMeter = null;
        for (const track of mic.getAudioTracks()) track.enabled = true;
      }

      // Started outside the try, so it runs whether or not any of the above worked.
      window.setInterval(pollLevels, LEVEL_POLL_MS);
      // Asking for the microphone broke the chain back to the click that started this, so the engine can
      // come back suspended. Ask it to start, but never wait on the answer: the poll asks again every time
      // it finds it not running.
      void audioCtx?.resume();
      // A browser that refuses to start the engine on its own will nearly always start it on the next real
      // click, so the next one anywhere on the page is used to try again. Harmless once it is running.
      window.addEventListener("pointerdown", () => void audioCtx?.resume());

      deps.onChange();
    },

    // Stops sending without dropping the connections, so the other side keeps hearing silence rather than
    // seeing you disappear. Their sound keeps arriving, which is what "mute myself" should do.
    // Only the flag is set here. The poll below owns the track, so muting and the talking gate never end
    // up fighting over it, and the next poll turns it off within a frame either way.
    setMicEnabled(on: boolean) {
      micEnabled = on;
      if (!on) {
        selfSpeaking = false;
        selfLastLoud = 0;
      }
      deps.onChange();
    },

    // A player appeared. If we are already in voice, call them straight away rather than waiting for the
    // next sweep. If we are not, they are simply remembered for when we join.
    addPlayer(id: string) {
      if (id === selfId) return;
      players.add(id);
      if (joined) sweepCalls();
      deps.onChange();
    },

    removePlayer(id: string) {
      players.delete(id);
      queues.delete(id);
      drop(id);
    },

    // One step of a handshake, relayed by the server. peer here is who it came from.
    //
    // Every step is put on a queue per player rather than handled as it arrives. Each step waits on the
    // browser, and while it waits the next message would otherwise start on top of it, so a description
    // and the addresses that follow it could be applied in the wrong order. They have to go in exactly
    // the order they were sent.
    handleSignal(sig: VoiceSignal) {
      const id = sig.peer;
      if (!id || id === selfId) return;
      // Not in voice means no microphone and nothing to say, so calls go unanswered on purpose. The
      // caller's sweep simply calls again later, by which time we may have joined.
      if (!joined) return;

      players.add(id);
      const queued = (queues.get(id) ?? Promise.resolve())
        .then(() => applySignal(id, sig))
        .catch((err) => {
          console.warn(`voice: handshake with ${id} failed`, err);
          setState(id, "failed");
        });
      queues.set(id, queued);
    },
  };
}

export type Voice = ReturnType<typeof createVoice>;
