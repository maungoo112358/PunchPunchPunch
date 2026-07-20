package sim

import "math"

// The movement sim, mirroring client/src/systems/sim.ts line for line.
//
// This is the server half of the most important agreement in the project: the client predicts your
// movement with its copy, the server decides the truth with this one, and the two have to land on the
// same spot or every correction becomes a visible twitch. sim_test.go runs a fixed list of inputs
// through both and fails if they part company, which is the only thing keeping these two files honest.
//
// If you change anything here, change it there, regenerate the fixture, and run the test.

// TickHz is how many times a second the sim runs. Rendering on the client is separate and faster.
const (
	TickHz = 30
	TickDT = 1.0 / TickHz
)

// Run speed depends on the ground: a touch slower slogging through grass, a touch quicker on the
// packed dirt road. Walk scales down from these by the move magnitude.
const (
	GrassSpeed = 4.0  // run speed on grass, units per second
	PathSpeed  = 5.2  // run speed on the dirt road
	WalkMax    = 0.6  // magnitude at or below this is a walk, above it is a run
	TurnRate   = 10.0 // how fast facing swings round to the travel direction, radians per second
)

// Animation names, matching the clips in the glTF.
const (
	AnimIdle = "Idle"
	AnimWalk = "Walk"
	AnimRun  = "Run"
)

// PlayerState is everything a player is, as far as the sim and the network care. Position and Forward
// are both world space, and Forward stays tangent to the surface.
type PlayerState struct {
	Position Vec3
	Forward  Vec3
	Anim     string
}

// Input is one tick of intent, already resolved to world space by the client. Its length is the speed,
// so it carries walk versus run in the same three numbers. Seq numbers the ticks and is what the server
// echoes back as "I have processed everything up to here".
type Input struct {
	Seq int
	Dir Vec3
}

func NewPlayerState(spawn Vec3, facing Vec3) PlayerState {
	return PlayerState{Position: spawn, Forward: facing, Anim: AnimIdle}
}

// Step advances one player by one tick.
//
// Movement: step along the flat tangent, then snap back onto the sphere. One tick's off-surface drift
// is negligible and the snap erases it, which is what makes this a great-circle walk.
func Step(state PlayerState, input Input, planet Planet, path *Path, dt float64) PlayerState {
	p := state.Position
	speed := input.Dir.Length()

	up := planet.UpAt(p)

	// Keep facing flat against the ground as the surface curves underneath.
	fwd := state.Forward.AddScaled(up, -state.Forward.Dot(up))
	if fwd.LengthSq() < 1e-8 {
		fwd = Vec3{0, 0, 1}.AddScaled(up, -up.Z) // degenerate guard
	}
	fwd = fwd.Normalize()

	if speed > 0 {
		runSpeed := GrassSpeed
		if path != nil && path.Contains(p, 0) {
			runSpeed = PathSpeed
		}
		p = p.AddScaled(input.Dir, runSpeed*dt)
		p = planet.PlaceOnSurface(p)
		up = planet.UpAt(p) // up changed after moving, recompute before turning

		// Swing facing toward where he is travelling, at a steady turn rate.
		// Turn by an ANGLE, do not blend the two directions. Blending slides along the straight line
		// between them, and for a dead reverse that line runs through the middle: you get a shorter
		// vector pointing the same way, which normalizes back to exactly where you started.
		dir := input.Dir.AddScaled(up, -input.Dir.Dot(up)).Normalize()
		// Signed angle from facing to target, measured around up.
		cross := fwd.Cross(dir)
		angle := math.Atan2(cross.Dot(up), fwd.Dot(dir))
		step := math.Min(math.Abs(angle), TurnRate*dt) // never overshoot the target
		if angle < 0 {
			step = -step
		}
		fwd = fwd.RotateAbout(up, step).Normalize()
	}

	anim := AnimIdle
	if speed > WalkMax {
		anim = AnimRun
	} else if speed > 0 {
		anim = AnimWalk
	}

	return PlayerState{Position: p, Forward: fwd, Anim: anim}
}
