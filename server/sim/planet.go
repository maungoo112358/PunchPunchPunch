package sim

// The tiny spherical world, mirroring client/src/world/planet.ts. The server only needs the two
// questions the walk asks: which way is up here, and put this point back on the surface. It has no
// mesh, because nothing on the server draws anything.
//
// Center is the origin on the client, so it is left out here rather than carried around as zero.

// PlanetRadius mirrors PLANET_RADIUS in planet.ts. Change one, change the other, and the golden test
// will tell you if you forget.
const PlanetRadius = 36.0

type Planet struct {
	Radius float64
}

func NewPlanet() Planet { return Planet{Radius: PlanetRadius} }

// UpAt is the outward surface normal at a world position.
func (p Planet) UpAt(pos Vec3) Vec3 { return pos.Normalize() }

// PlaceOnSurface snaps a point to exactly Radius from the centre. The walk steps along the flat
// tangent and then calls this, so one tick of drifting off the sphere is wiped out immediately.
func (p Planet) PlaceOnSurface(pos Vec3) Vec3 { return pos.SetLength(p.Radius) }
