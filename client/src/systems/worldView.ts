import * as THREE from "three";
import { Character } from "../entities/Character.js";
import type { Planet } from "../world/planet.js";
import type { World } from "./world.js";

// Puts the world state on screen. Every frame it walks the player map, gives anyone new a character,
// takes the character away from anyone who has gone, and places the rest.
//
// This is the whole point of the state layer: nothing here knows or cares whether a player is moved by
// your keyboard or by a snapshot off the network. Later, remote players will appear in the map and
// this loop will draw them without a single change.

// Which glTF a player wears. One model for now, so everyone is a Wizard. Step 12 hands out five
// different ones so you can tell each other apart.
const MODEL_URL = "/models/Wizard.gltf";

export function createWorldView(scene: THREE.Scene, world: World, planet: Planet) {
  const characters = new Map<string, Character>();
  const up = new THREE.Vector3();
  const drawPos = new THREE.Vector3();
  const drawFwd = new THREE.Vector3();

  // Make a character for this id if there is not one yet. Called by the draw pass, and by the wiring in
  // main for the local player, which needs the object up front to hand to the camera and the grass. The
  // model inside starts null and fills in when the glTF finishes loading.
  function characterFor(id: string) {
    let character = characters.get(id);
    if (!character) {
      character = new Character(scene, MODEL_URL);
      characters.set(id, character);
    }
    return character;
  }

  return {
    characterFor,

    // alpha is how far we are between the previous tick and the current one, 0 to 1. At 30 ticks a
    // second and 120 frames a second this is what stops the character stepping four times per move.
    render(alpha: number) {
      // Anyone whose character outlived them, off the screen.
      for (const [id, character] of characters) {
        if (world.players.has(id)) continue;
        character.dispose();
        characters.delete(id);
      }

      for (const [id, player] of world.players) {
        const character = characterFor(id);
        if (!character.model) continue; // still loading, nothing to place yet

        drawPos.lerpVectors(player.previous.position, player.state.position, alpha);
        drawFwd.lerpVectors(player.previous.forward, player.state.forward, alpha);
        if (drawFwd.lengthSq() < 1e-8) drawFwd.copy(player.state.forward); // opposite facings cancelled out

        character.model.position.copy(drawPos);
        planet.upAt(drawPos, up);
        character.orient(up, drawFwd);
        character.setAction(player.state.anim);
      }
    },

    // Animation playback is presentation, so it runs on real elapsed time rather than the fixed tick.
    update(dt: number) {
      for (const character of characters.values()) character.update(dt);
    },
  };
}

export type WorldView = ReturnType<typeof createWorldView>;
