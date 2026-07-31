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

// AttackTicks is how long a cast lasts, ONE ENTRY PER CAST ANIMATION, in ticks at 30Hz. Ticks rather
// than seconds so a cast can never land between two ticks and come out a different length on the two
// machines.
//
// Index-aligned with KAYKIT_ATTACKS in the client's config/characters.ts, and with the same list in
// client/src/systems/sim.ts, which this mirrors. The client stretches each clip to fill its own entry,
// so these numbers are effectively the playback speeds. Change one here and change it there.
//
// Both entries are the same right now. The list stays per variant anyway, because that shape is what
// lets one animation be retimed without dragging the others with it.
var AttackTicks = []int{16, 16}

// RecastWindow is how near the end of a cast the next one may start, in ticks left on the counter. The
// last stretch of a clip is the arm recovering, and nobody needs to watch that before throwing again.
// The gap between chained casts is that cast's own length minus this, so the short variants chain every
// 10 ticks and the long one every 18.
const RecastWindow = 6

// Animation names, matching the clips in the glTF.
const (
	AnimIdle   = "Idle"
	AnimWalk   = "Walk"
	AnimRun    = "Run"
	AnimAttack = "Attack"
)

// PlayerState is everything a player is, as far as the sim and the network care. Position and Forward
// are both world space, and Forward stays tangent to the surface.
type PlayerState struct {
	Position Vec3
	Forward  Vec3
	Anim     string
	// Attack is the ticks of cast still to run, 0 when not casting. The first thing in here that is not a
	// place or a direction, which makes it the first thing reconciliation has to rebuild rather than
	// slide: a position slightly out can ease back into line, but "am I casting" is yes or no.
	Attack int
	// Buffered is a click that arrived too early to use, held until the cast reaches its recast window.
	// This is what makes spamming the button feel right: a press during the locked part of a cast is
	// REMEMBERED rather than thrown away, so it fires the moment it legally can.
	Buffered bool
	// AttackClip is which cast animation the current cast rolled, as an index into AttackTicks. It is sim
	// state rather than a client-side flourish for two reasons: it decides how long the cast runs, and it
	// has to be the same on every machine or a player and the people watching would see different spells.
	AttackClip int
}

// Input is one tick of intent, already resolved to world space by the client. Its length is the speed,
// so it carries walk versus run in the same three numbers. Seq numbers the ticks and is what the server
// echoes back as "I have processed everything up to here".
type Input struct {
	Seq int
	Dir Vec3
	// Attack is true on the one tick the cast key went down, not for as long as it is held. Holding it
	// would re-arm the cast every tick and the animation would never get past its first frame.
	Attack bool
	// Aim is where the crosshair is pointing, in world space, and only its direction is read. A zero
	// vector means no aim, which is what walking sends, because walking already turns you by where you
	// are going.
	Aim Vec3
}

// turnToward swings fwd toward target by at most one tick's worth of turning, around the surface normal.
// Used by both the walk, which aims at where you are travelling, and the cast, which aims at the
// crosshair, so the two can never turn at different rates.
//
// Turn by an ANGLE, do not blend the two directions. Blending slides along the straight line between
// them, and for a dead reverse that line runs through the middle: you get a shorter vector pointing the
// same way, which normalizes back to exactly where you started.
func turnToward(fwd, target, up Vec3, dt float64) Vec3 {
	// Flatten the target into the ground plane first, because on a sphere a heading is only meaningful
	// once the part of it pointing at the sky is removed.
	dir := target.AddScaled(up, -target.Dot(up))
	if dir.LengthSq() < 1e-8 {
		return fwd // aiming straight up or at nothing, no heading to turn to
	}
	dir = dir.Normalize()
	// Signed angle from facing to target, measured around up.
	cross := fwd.Cross(dir)
	angle := math.Atan2(cross.Dot(up), fwd.Dot(dir))
	step := math.Min(math.Abs(angle), TurnRate*dt) // never overshoot the target
	if angle < 0 {
		step = -step
	}
	return fwd.RotateAbout(up, step).Normalize()
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

	// The cast. A counter running down is the whole state machine: there is no "am I attacking" flag to
	// get out of step, just a number of ticks left.
	//
	// Three steps, in this order. Tick the counter down first, so a press this tick is measured against
	// where the cast has actually got to. Then remember any press, whether or not it can be used. Then
	// start a cast if the counter has run far enough down, which is either at zero or inside the recast
	// window near the end.
	//
	// Splitting "remember" from "start" is what gives back-to-back casting. The buffer is a single flag,
	// not a queue, so ten frantic clicks still only buy one extra cast.
	// Which animation comes up is a straight rotation, not a random roll, and it has to be. The sim is
	// replayed on the client after every correction, and a random number would come out differently the
	// second time and desync the cast length from this one's. Stepping to the next is the same answer
	// every time, and it still guarantees no clip repeats back to back.
	attack := state.Attack
	buffered := state.Buffered
	clip := state.AttackClip
	if attack > 0 {
		attack--
	}
	if input.Attack {
		buffered = true
	}
	if buffered && attack <= RecastWindow {
		clip = (clip + 1) % len(AttackTicks)
		attack = AttackTicks[clip]
		buffered = false
	}

	// Casting roots you where you stand, but you still turn: the whole point of aiming is that the caster
	// ends up facing what the crosshair is on, and turning is the only way the body ever gets there. The
	// aim keeps arriving every tick of the cast, so dragging the mouse mid-cast tracks the target.
	if attack > 0 {
		fwd = turnToward(fwd, input.Aim, up, dt)
		return PlayerState{
			Position: p, Forward: fwd, Anim: AnimAttack,
			Attack: attack, Buffered: buffered, AttackClip: clip,
		}
	}

	if speed > 0 {
		runSpeed := GrassSpeed
		if path != nil && path.Contains(p, 0) {
			runSpeed = PathSpeed
		}
		p = p.AddScaled(input.Dir, runSpeed*dt)
		p = planet.PlaceOnSurface(p)
		up = planet.UpAt(p) // up changed after moving, recompute before turning

		// Swing facing toward where he is travelling, at a steady turn rate.
		fwd = turnToward(fwd, input.Dir, up, dt)
	}

	anim := AnimIdle
	if speed > WalkMax {
		anim = AnimRun
	} else if speed > 0 {
		anim = AnimWalk
	}

	return PlayerState{Position: p, Forward: fwd, Anim: anim, Attack: 0, Buffered: buffered, AttackClip: clip}
}
