package sim

import "math"

// The dirt road, mirroring the parts of client/src/world/path.ts that the walk asks about. The client
// file also builds the visible ribbon of dirt; none of that is here, because the server never draws.
// What is here is Contains, which answers "is he standing on the road" so he can move a little quicker.
//
// How the loop is defined: pick an axis through the planet. Going around that axis is the angle phi.
// The road's centreline sits at some angle away from the axis, its latitude, called beta, and that
// latitude weaves as phi goes around. The weave is built from whole-number sine waves, so it lines back
// up after a full turn and the loop always closes.

// Placement. The spawn at the north pole sits at beta = pi/2 from this axis, so a centreline near pi/2
// runs right past where the player starts.
var pathAxis = Vec3{1, 0, 0.2}.Normalize()

const pathLat = math.Pi/2 - 0.1 // centreline latitude, a few units off the spawn

// Meander: the centreline latitude weaves by this sum of sine waves as it goes around.
const (
	meander1Amp, meander1Freq, meander1Phase = 0.12, 2.0, 0.6
	meander2Amp, meander2Freq, meander2Phase = 0.06, 3.0, 2.3
	meander3Amp, meander3Freq, meander3Phase = 0.035, 5.0, 4.1
)

// Width, non-uniform with ragged edges.
const (
	pathHalfWidth           = 2.75 // average half width in world units
	widthVar                = 0.8  // broad swell and pinch of the whole road
	width1Freq, width1Phase = 3.0, 1.0
	width2Freq, width2Phase = 7.0, 3.5
	edgeRagged              = 0.45 // how hard each edge jags in and out on its own
)

// The two directions that, with the axis, make a frame to measure phi in.
var (
	pathRef = func() Vec3 {
		if math.Abs(pathAxis.Y) < 0.99 {
			return Vec3{0, 1, 0}
		}
		return Vec3{1, 0, 0}
	}()
	axisT = pathRef.Cross(pathAxis).Normalize()
	axisB = pathAxis.Cross(axisT)
)

// The centreline latitude at a given angle around the loop.
func betaAt(phi float64) float64 {
	return pathLat +
		meander1Amp*math.Sin(meander1Freq*phi+meander1Phase) +
		meander2Amp*math.Sin(meander2Freq*phi+meander2Phase) +
		meander3Amp*math.Sin(meander3Freq*phi+meander3Phase)
}

// Gentle swell and pinch of the whole road, both edges moving together.
func swellAt(phi float64) float64 {
	return 0.5 * (math.Sin(width1Freq*phi+width1Phase) + math.Sin(width2Freq*phi+width2Phase))
}

// Jagged in-and-out wander of one edge. side shifts the phases so the two edges never match.
func raggedAt(phi float64, side float64) float64 {
	s := 0.0
	if side <= 0 {
		s = 7.3
	}
	return 0.45*math.Sin(9*phi+s+0.3) +
		0.28*math.Sin(15*phi+s+1.7) +
		0.19*math.Sin(24*phi+s+3.1) +
		0.12*math.Sin(38*phi+s+0.9)
}

// Half width on one side of the centreline. Clamped so the road never pinches shut.
func edgeAt(phi float64, side float64) float64 {
	w := pathHalfWidth + widthVar*swellAt(phi) + edgeRagged*raggedAt(phi, side)
	return math.Max(w, 0.3)
}

type Path struct {
	Radius float64
}

func NewPath(radius float64) Path { return Path{Radius: radius} }

// Contains asks whether a world position is on the dirt. Same question the client asks, so the two
// always agree about who is walking faster.
func (p Path) Contains(worldPos Vec3, margin float64) bool {
	d := worldPos.Normalize()
	beta := math.Acos(clamp(d.Dot(pathAxis), -1, 1))
	phi := math.Atan2(d.Dot(axisB), d.Dot(axisT))
	signed := beta - betaAt(phi) // + is one side of the centreline, - is the other
	side := -1.0
	if signed >= 0 {
		side = 1
	}
	w := edgeAt(phi, side) // that side's ragged width, so it matches the dirt's edge
	return math.Abs(signed)*p.Radius < w+margin
}

func clamp(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
}
