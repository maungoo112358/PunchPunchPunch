package main

// The training dummy: a still target to practise the wand on without needing a second player.
//
// It is not a connection and it never moves, but it rides the wire as an ordinary player. It appears in
// every Welcome roster and in every snapshot, so the client draws it, the lock-on targets it and a spell
// will hit it with no special case anywhere on either side. That is the whole trick, and it is why this
// file is so short: everything that handles players already handles the dummy.
//
// A plug-in like auth.go and telegram.go. Delete this file and the two calls to it in tick.go and the
// dummy is gone, with nothing else to unpick.

import (
	pb "punchpunchpunch/server/gen/gamepb"
	"punchpunchpunch/server/sim"
)

// What it is called on the wire. Real players are "p1", "p2" and so on, counted up by the hub, so this
// can never collide with one.
const dummyID = "dummy"

// dummyCharacter is a key into the client's model catalog, the same as a player's. dummyName is what
// floats over it, since the client puts a nameplate on everything in the player map.
const dummyCharacter = "dummy"
const dummyName = "Training Dummy"

// How far off the spawn point it stands, in world units. Far enough not to be inside a joiner, close
// enough that they see it the moment they arrive and can walk to it in a couple of seconds.
const dummyOffset = 7.0

// Where it stands and which way it looks. Worked out once at startup rather than every tick, because a
// still target's position is the definition of something that does not change.
var dummyPos, dummyFwd = placeDummy(sim.NewPlanet(), sim.Vec3{X: 0, Y: sim.PlanetRadius, Z: 0})

// placeDummy puts the dummy a few paces from spawn along the surface and turns it to face back at the
// spawn point, so a joiner arrives looking it in the eye.
//
// Stepping sideways off the pole and snapping back to the sphere is the same move the walk makes every
// tick: go along the flat tangent, then push the result back onto the surface.
func placeDummy(planet sim.Planet, spawn sim.Vec3) (pos, fwd sim.Vec3) {
	pos = planet.PlaceOnSurface(spawn.AddScaled(sim.Vec3{X: 1, Y: 0, Z: 0}, dummyOffset))

	// Facing has to be flat against the ground, so take the direction back to spawn and remove the part
	// of it that points straight up. Same flattening stepPlayer does to keep a heading tangent.
	up := planet.UpAt(pos)
	toSpawn := spawn.Sub(pos)
	fwd = toSpawn.AddScaled(up, -toSpawn.Dot(up)).Normalize()
	return pos, fwd
}

// dummyInfo is the identity the dummy joins with, the same shape a player's is. It goes into the roster
// every client receives on arrival.
func dummyInfo() *pb.PlayerInfo {
	return &pb.PlayerInfo{Id: dummyID, PlanetId: 0, Character: dummyCharacter, Name: dummyName}
}

// dummySnapshot is the dummy's row in a snapshot. Idle because it is the one animation every model is
// expected to have, and the dummy's model has none at all, which the client handles by simply not
// playing anything.
func dummySnapshot() *pb.PlayerSnapshot {
	return &pb.PlayerSnapshot{
		Id:       dummyID,
		PlanetId: 0,
		Position: vecToPB(dummyPos),
		Forward:  vecToPB(dummyFwd),
		Anim:     "Idle",
	}
}
