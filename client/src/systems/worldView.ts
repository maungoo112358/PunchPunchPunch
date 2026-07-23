import * as THREE from "three";
import { Character } from "../entities/Character.js";
import { createNameplate } from "../entities/nameplate.js";
import { modelForCharacter } from "../config/characters.js";
import type { Planet } from "../world/planet.js";
import type { World } from "./world.js";

// Puts the world state on screen. Every frame it walks the player map, gives anyone new a character,
// makes each wear the model the server assigned, floats their name over their head, takes all that away
// from anyone who has gone, and places the rest.
//
// This is the whole point of the state layer: nothing here knows or cares whether a player is moved by
// your keyboard or by a snapshot off the network. The model and name come from the player's own entry,
// filled in by the join and roster messages, so local and remote go through the exact same path.

// How high above the model origin the name tag floats, in world units. Eye-tune against the character.
const NAMEPLATE_HEIGHT = 4.5;

type Nameplate = { plate: ReturnType<typeof createNameplate>; name: string };

export function createWorldView(scene: THREE.Scene, world: World, planet: Planet) {
  const characters = new Map<string, Character>();
  const nameplates = new Map<string, Nameplate>();
  const up = new THREE.Vector3();
  const drawPos = new THREE.Vector3();
  const drawFwd = new THREE.Vector3();

  // Make a character for this id if there is not one yet, wearing nothing until the player's assigned
  // model is known. Called by the draw pass, and by the wiring in main for the local player, which needs
  // the object up front to hand to the camera and the grass.
  function characterFor(id: string) {
    let character = characters.get(id);
    if (!character) {
      character = new Character(scene);
      characters.set(id, character);
    }
    return character;
  }

  // Keep a name tag matching this player's current name, rebuilding it if the name changed.
  function nameplateFor(id: string, name: string) {
    let entry = nameplates.get(id);
    if (entry && entry.name === name) return entry;
    if (entry) {
      scene.remove(entry.plate.sprite);
      entry.plate.dispose();
    }
    const plate = createNameplate(name);
    scene.add(plate.sprite);
    entry = { plate, name };
    nameplates.set(id, entry);
    return entry;
  }

  function removeNameplate(id: string) {
    const entry = nameplates.get(id);
    if (!entry) return;
    scene.remove(entry.plate.sprite);
    entry.plate.dispose();
    nameplates.delete(id);
  }

  return {
    characterFor,

    // alpha is how far we are between the previous tick and the current one, 0 to 1. At 30 ticks a
    // second and 120 frames a second this is what stops the character stepping four times per move.
    render(alpha: number) {
      // Anyone whose character outlived them, off the screen, name tag and all.
      for (const [id, character] of characters) {
        if (world.players.has(id)) continue;
        character.dispose();
        characters.delete(id);
        removeNameplate(id);
      }

      for (const [id, player] of world.players) {
        const character = characterFor(id);
        // Wear the assigned model as soon as the server has named it. setModel no-ops once it matches.
        if (player.character) character.setModel(modelForCharacter(player.character));
        if (!character.model) continue; // still loading, or no model assigned yet, nothing to place

        drawPos.lerpVectors(player.previous.position, player.state.position, alpha);
        drawFwd.lerpVectors(player.previous.forward, player.state.forward, alpha);
        if (drawFwd.lengthSq() < 1e-8) drawFwd.copy(player.state.forward); // opposite facings cancelled out

        character.model.position.copy(drawPos);
        planet.upAt(drawPos, up);
        character.orient(up, drawFwd);
        character.setAction(player.state.anim);

        // Float the name tag over the head along this player's own up, which on a sphere is not yours.
        if (player.name) {
          const entry = nameplateFor(id, player.name);
          entry.plate.sprite.position.copy(drawPos).addScaledVector(up, NAMEPLATE_HEIGHT);
        }
      }
    },

    // Animation playback is presentation, so it runs on real elapsed time rather than the fixed tick.
    update(dt: number) {
      for (const character of characters.values()) character.update(dt);
    },
  };
}

export type WorldView = ReturnType<typeof createWorldView>;
