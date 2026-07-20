package sim

import "math"

// A 3D vector, mirroring the handful of THREE.Vector3 calls the client's sim uses.
//
// These are deliberately written the same way round as three.js does them, right down to which
// multiply happens first. The two languages have to agree on the walk to the last few decimal places,
// and reordering arithmetic changes the last few decimal places. Clear code that drifts is worse than
// slightly odd-looking code that matches.
//
// Float64 throughout, because a JavaScript number is a float64. Using float32 here would guarantee a
// mismatch no amount of care could fix.
type Vec3 struct {
	X, Y, Z float64
}

func (v Vec3) Add(o Vec3) Vec3 { return Vec3{v.X + o.X, v.Y + o.Y, v.Z + o.Z} }

func (v Vec3) Sub(o Vec3) Vec3 { return Vec3{v.X - o.X, v.Y - o.Y, v.Z - o.Z} }

func (v Vec3) Scale(s float64) Vec3 { return Vec3{v.X * s, v.Y * s, v.Z * s} }

// AddScaled is three's addScaledVector: this + other * scale.
func (v Vec3) AddScaled(o Vec3, s float64) Vec3 {
	return Vec3{v.X + o.X*s, v.Y + o.Y*s, v.Z + o.Z*s}
}

func (v Vec3) Dot(o Vec3) float64 { return v.X*o.X + v.Y*o.Y + v.Z*o.Z }

func (v Vec3) Cross(o Vec3) Vec3 {
	return Vec3{
		v.Y*o.Z - v.Z*o.Y,
		v.Z*o.X - v.X*o.Z,
		v.X*o.Y - v.Y*o.X,
	}
}

func (v Vec3) LengthSq() float64 { return v.X*v.X + v.Y*v.Y + v.Z*v.Z }

func (v Vec3) Length() float64 { return math.Sqrt(v.LengthSq()) }

// Normalize divides by the length, or by 1 when the vector is zero. That "or 1" is three's own guard
// against dividing by zero, and it means normalizing a zero vector hands back a zero vector.
func (v Vec3) Normalize() Vec3 {
	l := v.Length()
	if l == 0 {
		l = 1
	}
	return Vec3{v.X / l, v.Y / l, v.Z / l}
}

// SetLength is normalize followed by a multiply, in that order, same as three.
func (v Vec3) SetLength(l float64) Vec3 { return v.Normalize().Scale(l) }

// RotateAbout turns v around a unit axis by angle radians.
//
// This is the long way round on purpose. The client builds a quaternion from the axis and angle and
// then applies it, so we do the same arithmetic in the same order rather than using the shorter
// rotation formula, which is the same rotation but lands on slightly different last digits.
func (v Vec3) RotateAbout(axis Vec3, angle float64) Vec3 {
	half := angle / 2
	s := math.Sin(half)
	qx, qy, qz, qw := axis.X*s, axis.Y*s, axis.Z*s, math.Cos(half)

	// t = 2 * cross(q.xyz, v)
	tx := 2 * (qy*v.Z - qz*v.Y)
	ty := 2 * (qz*v.X - qx*v.Z)
	tz := 2 * (qx*v.Y - qy*v.X)

	// v + w * t + cross(q.xyz, t)
	return Vec3{
		v.X + qw*tx + qy*tz - qz*ty,
		v.Y + qw*ty + qz*tx - qx*tz,
		v.Z + qw*tz + qx*ty - qy*tx,
	}
}
