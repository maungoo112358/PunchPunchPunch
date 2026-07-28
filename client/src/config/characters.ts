// The five characters, keyed by the same short strings the server draws from its pool. The server never
// knows a filename; it hands out a key and the client looks the model up here. A key the catalog does not
// know falls back to the mage so a typo shows a character rather than nothing.
//
// The cast is the KayKit Adventurers pack. It replaced the Quaternius five because those carried three
// locomotion clips and nothing else, while every one of these carries seventy six, including the
// spellcasting and the sideways running this game needs. The Quaternius models are still in
// public/models/ and can be listed here again in a line each if we ever want to look at them.

export const CHARACTER_MODELS: Record<string, string> = {
  barbarian: "/models/Barbarian.glb",
  knight: "/models/Knight.glb",
  mage: "/models/Mage.glb",
  rogue: "/models/Rogue.glb",
  rogue_hooded: "/models/Rogue_Hooded.glb",
};

// The handful of things that differ from one model file to the next.
//
// The sim only ever says "Idle", "Walk" or "Run". Those three names ride the wire and are mirrored in the
// Go sim, so they cannot bend to suit an asset; a model whose clips are called something else gets
// translated here instead, on the way to the mixer. A model with no entry keeps the names it already has.
export type ModelProfile = {
  clips: Record<string, string>; // what the sim calls a clip -> what this file calls it
  outline: number; // how far the ink shell is pushed out, in this model's own units
  scale: number; // sizes the model against the rest of the cast
  lift: number; // raises the feet onto the ground when the file's origin sits below them
  hold: string; // the one held prop to keep; every other one is hidden as the model loads
};

// What a model that says nothing about itself gets: its own clip names, nothing hidden, no resizing. The
// Quaternius five fit this exactly, which is why they never needed an entry.
const PLAIN: ModelProfile = { clips: {}, outline: 0.03, scale: 1, lift: 0, hold: "" };

// KayKit ships several walk and run variants and suffixes them; A is the plain one. Idle is already
// called Idle, so it is the only one of the three that needs no entry.
//
// Every KayKit character also ships its whole armoury already rigged into the hand slots, and a glTF has
// no notion of "pick one", so all of it renders at once: the knight walks around holding two swords and
// four shields. Character.ts hides everything hanging off a handslot bone except the one named here.
const KAYKIT: ModelProfile = {
  clips: { Walk: "Walking_A", Run: "Running_A" },
  outline: 0.03,
  scale: 1.3, // KayKit builds at 3.36 units against the Quaternius 3.1 to 4.3, and reads shorter still
  lift: 0,
  hold: "",
};

// The one thing each character keeps in its hands. Only the mage ships a wand, so the rest hold their own
// signature weapon for now; once casting is in, they all take a wand attached from the shared model.
const HELD: Record<string, string> = {
  "/models/Barbarian.glb": "1H_Axe",
  "/models/Knight.glb": "1H_Sword",
  "/models/Mage.glb": "1H_Wand",
  "/models/Rogue.glb": "Knife",
  "/models/Rogue_Hooded.glb": "Knife",
};

// Keyed by model url, not by character key, because the profile describes the FILE: two keys pointing at
// one model would want the same clip names and the same ink line. Every KayKit character is built the
// same way apart from what it holds.
const PROFILES: Record<string, ModelProfile> = Object.fromEntries(
  Object.values(CHARACTER_MODELS).map((url) => [url, { ...KAYKIT, hold: HELD[url] ?? "" }])
);

export function profileForModel(url: string): ModelProfile {
  return PROFILES[url] ?? PLAIN;
}

// Every model path, for preloading them all at boot so a joiner never appears as nothing for a moment.
export const ALL_MODELS = Object.values(CHARACTER_MODELS);

const FALLBACK = CHARACTER_MODELS.mage;

export function modelForCharacter(key: string): string {
  const url = CHARACTER_MODELS[key];
  if (!url) {
    console.warn(`[characters] unknown character key "${key}", using the mage`);
    return FALLBACK;
  }
  return url;
}
