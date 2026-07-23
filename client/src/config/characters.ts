// The five characters, keyed by the same short strings the server draws from its pool. The server never
// knows a filename; it hands out a key and the client looks the model up here. A key the catalog does not
// know falls back to the Wizard so a typo shows a character rather than nothing.

export const CHARACTER_MODELS: Record<string, string> = {
  wizard: "/models/Wizard.gltf",
  witch: "/models/Witch.gltf",
  goblin: "/models/Goblin_Male.gltf",
  elf: "/models/Elf.gltf",
  knight: "/models/Knight_Male.gltf",
};

// Every model path, for preloading them all at boot so a joiner never appears as nothing for a moment.
export const ALL_MODELS = Object.values(CHARACTER_MODELS);

const FALLBACK = CHARACTER_MODELS.wizard;

export function modelForCharacter(key: string): string {
  const url = CHARACTER_MODELS[key];
  if (!url) {
    console.warn(`[characters] unknown character key "${key}", using the wizard`);
    return FALLBACK;
  }
  return url;
}
