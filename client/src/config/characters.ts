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
  dummy: "/models/PracticeDummy.glb", // the training target, sent by the server as a player (dummy.go)
};

// The handful of things that differ from one model file to the next.
//
// The sim only ever says "Idle", "Walk" or "Run". Those three names ride the wire and are mirrored in the
// Go sim, so they cannot bend to suit an asset; a model whose clips are called something else gets
// translated here instead, on the way to the mixer. A model with no entry keeps the names it already has.
export type ModelProfile = {
  clips: Record<string, string>; // what the sim calls a clip -> what this file calls it
  attacks: string[]; // the cast animations to rotate through, so two clicks never look identical
  outline: number; // how wide the ink line draws, in WORLD units, so models compare against each other
  scale: number; // sizes the model against the rest of the cast
  lift: number; // raises the feet onto the ground when the file's origin sits below them
  hold: string; // the one held prop to keep; every other one is hidden as the model loads
};

// What a model that says nothing about itself gets: its own clip names, nothing hidden, no resizing. The
// Quaternius five fit this exactly, which is why they never needed an entry.
const PLAIN: ModelProfile = { clips: {}, attacks: [], outline: 0.04, scale: 1, lift: 0, hold: "" };

// KayKit ships several walk and run variants and suffixes them; A is the plain one. Idle is already
// called Idle, so it is the only one of the three that needs no entry. Attack is the wand cast, and all
// five carry it: the whole pack shares one 76-clip library off one rig, so nobody needs a special case.
//
// Every KayKit character also ships its whole armoury already rigged into the hand slots, and a glTF has
// no notion of "pick one", so all of it renders at once: the knight walks around holding two swords and
// four shields. Character.ts hides everything hanging off a handslot bone except the one named here.
// The cast animations, picked from at random so clicking twice does not replay the identical motion.
// One is chosen per cast and never the same one twice running.
//
// Each is sped up or slowed to fill the sim's cast length exactly, worked out from the clip's own
// authored duration in Character.ts, so adding or removing a name here is the whole edit.
//
// Two spellcasts, both authored as spellcasts, both playing near the speed they were made at: 0.67s and
// 0.93s clips in a 16-tick (0.53s) cast, so 1.25x and 1.75x.
//
// Two clips that belong beat three where one does not. The pack has only these two spellcasts short
// enough to use, so a third meant borrowing from another category, and both attempts were cut:
//   Throw                           1.37s, needed 2.56x, read as frantic, and an overarm throw is the
//                                   wrong motion for a wand however fast it goes
//   1H_Melee_Attack_Slice_Diagonal  1.00s, given its own longer cast so it could run at a true 1.00x,
//                                   and it still did not look natural. It is a sword swing, and slowing
//                                   a sword swing down does not turn it into a spell.
//
// The lesson worth keeping: the problem with both was the MOTION, not the speed, and no amount of
// retiming fixed that. If a third is ever wanted, the other one-handed candidates are 1H_Ranged_Shoot,
// 1H_Melee_Attack_Slice_Horizontal and 1H_Melee_Attack_Chop, all about 1.07s. The pack's other two
// spellcasts run 2.1s and 2.5s, which would need their own very long casts to avoid looking sped up.
const KAYKIT_ATTACKS = ["Spellcasting", "Spellcast_Shoot"];

const KAYKIT: ModelProfile = {
  clips: { Walk: "Walking_A", Run: "Running_A", Attack: "Spellcast_Shoot" },
  attacks: KAYKIT_ATTACKS,
  outline: 0.04,
  scale: 1.3, // KayKit builds at 3.36 units against the Quaternius 3.1 to 4.3, and reads shorter still
  lift: 0,
  hold: "",
};

// The one thing each character keeps in its hands. Everyone holds the wand, because everyone casts: a
// rogue swinging a knife through a spellcast animation reads as a bug, not as a character.
//
// Only Mage.glb actually ships a wand. The other four carry an axe, a sword or a knife and no wand at
// all, so Character.ts grafts the mage's onto them. That works because all five are one rig: the
// handslot.r bone has the same name and the same local transform in every file, so a wand parented to it
// lands in exactly the same place in the hand whichever character is wearing it.
const WAND = "1H_Wand";

const HELD: Record<string, string> = {
  "/models/Barbarian.glb": WAND,
  "/models/Knight.glb": WAND,
  "/models/Mage.glb": WAND,
  "/models/Rogue.glb": WAND,
  "/models/Rogue_Hooded.glb": WAND,
};

// The training dummy is not one of the cast. It has no animation at all, nothing in its hands, and it was
// authored at 1.2 units against the cast's 4.4, so it brings its own numbers. The outline matches the
// cast because outline is a world width now; Character.ts works out what that means for this file, which
// hides a scale of a hundred on the node above its mesh.
const DUMMY: ModelProfile = { clips: {}, attacks: [], outline: 0.04, scale: 3.6, lift: 0, hold: "" };

// Keyed by model url, not by character key, because the profile describes the FILE: two keys pointing at
// one model would want the same clip names and the same ink line. Every KayKit character is built the
// same way apart from what it holds, so HELD doubles as the list of who they are.
const PROFILES: Record<string, ModelProfile> = {
  ...Object.fromEntries(Object.keys(HELD).map((url) => [url, { ...KAYKIT, hold: HELD[url] }])),
  "/models/PracticeDummy.glb": DUMMY,
};

export function profileForModel(url: string): ModelProfile {
  return PROFILES[url] ?? PLAIN;
}

// Where the shared wand is borrowed from, and the bone it hangs off. Character.ts reads these when the
// model it just loaded wants to hold something its own file does not contain.
export const PROP_DONOR = "/models/Mage.glb";
export const HAND_BONE = "handslot.r";

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
