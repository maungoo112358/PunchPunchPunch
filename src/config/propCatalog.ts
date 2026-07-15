// Short, friendly names for the nature props, mapped to their glTF file under public/models/.
// You use the SHORT name (left) in propPlacements.yaml; this map points it at the real file. We keep an
// alias map instead of renaming the files because the glTFs share textures by filename, so renaming would
// break those links. Add a new line here if you want a shorter alias for something.
//
// All files live in public/models/nature/ (copied from the Stylized Nature MegaKit, CC0).

const BASE = "nature/"; // folder under public/models/

// short name -> original file (without the .gltf)
const FILES = {
  // trees
  tree_1: "CommonTree_1", tree_2: "CommonTree_2", tree_3: "CommonTree_3", tree_4: "CommonTree_4", tree_5: "CommonTree_5",
  deadtree_1: "DeadTree_1", deadtree_2: "DeadTree_2", deadtree_3: "DeadTree_3", deadtree_4: "DeadTree_4", deadtree_5: "DeadTree_5",
  twisted_1: "TwistedTree_1", twisted_2: "TwistedTree_2", twisted_3: "TwistedTree_3", twisted_4: "TwistedTree_4", twisted_5: "TwistedTree_5",
  pine_1: "Pine_1", pine_2: "Pine_2", pine_3: "Pine_3", pine_4: "Pine_4", pine_5: "Pine_5",

  // bushes / plants / ferns
  bush: "Bush_Common", bush_flowers: "Bush_Common_Flowers", fern_1: "Fern_1",
  plant_1: "Plant_1", plant_1_big: "Plant_1_Big", plant_7: "Plant_7", plant_7_big: "Plant_7_Big",

  // small ground cover
  clover_1: "Clover_1", clover_2: "Clover_2",
  tuft_1: "Grass_Common_Short", tuft_2: "Grass_Common_Tall", tuft_3: "Grass_Wispy_Short", tuft_4: "Grass_Wispy_Tall",

  // flowers / petals
  flower_3: "Flower_3_Single", flower_3_group: "Flower_3_Group", flower_4: "Flower_4_Single", flower_4_group: "Flower_4_Group",
  petal_1: "Petal_1", petal_2: "Petal_2", petal_3: "Petal_3", petal_4: "Petal_4", petal_5: "Petal_5",

  // mushrooms
  mushroom_1: "Mushroom_Common", mushroom_2: "Mushroom_Laetiporus",

  // rocks
  rock_1: "Rock_Medium_1", rock_2: "Rock_Medium_2", rock_3: "Rock_Medium_3",
  pebble_round_1: "Pebble_Round_1", pebble_round_2: "Pebble_Round_2", pebble_round_3: "Pebble_Round_3", pebble_round_4: "Pebble_Round_4", pebble_round_5: "Pebble_Round_5",
  pebble_sq_1: "Pebble_Square_1", pebble_sq_2: "Pebble_Square_2", pebble_sq_3: "Pebble_Square_3", pebble_sq_4: "Pebble_Square_4", pebble_sq_5: "Pebble_Square_5", pebble_sq_6: "Pebble_Square_6",
  rockpath_round_1: "RockPath_Round_Small_1", rockpath_round_2: "RockPath_Round_Small_2", rockpath_round_3: "RockPath_Round_Small_3", rockpath_round_thin: "RockPath_Round_Thin", rockpath_round_wide: "RockPath_Round_Wide",
  rockpath_sq_1: "RockPath_Square_Small_1", rockpath_sq_2: "RockPath_Square_Small_2", rockpath_sq_3: "RockPath_Square_Small_3", rockpath_sq_thin: "RockPath_Square_Thin", rockpath_sq_wide: "RockPath_Square_Wide",
};

// Every valid short name, worked out from the FILES map above rather than typed out again. `keyof
// typeof FILES` means "the key names of that object", so this list updates itself when you add a line.
// Use this type anywhere a prop name is expected and a typo becomes an error instead of a silent
// missing prop.
export type PropName = keyof typeof FILES;

// Build the final short name -> URL map (relative to public/models/, which is served at /models/).
//
// The `as` at the end is us overruling the typechecker, and it needs explaining. Object.fromEntries
// only promises "an object with string keys", because in plain JS it cannot know what keys it will be
// handed. That would lose every name above and let PROP_CATALOG.tpyo pass unnoticed. We can see the
// keys come straight from FILES, so we say so. This is the one spot where we know more than the
// compiler, and it is why PropName exists.
export const PROP_CATALOG = Object.fromEntries(
  Object.entries(FILES).map(([name, file]) => [name, `${BASE}${file}.gltf`]),
) as Record<PropName, string>;

// Every short name, handy for the editor's "add prop" list later. Object.keys has the same blind spot
// as fromEntries above and only promises plain strings, so we narrow it back to real prop names.
export const PROP_NAMES = Object.keys(PROP_CATALOG) as PropName[];
