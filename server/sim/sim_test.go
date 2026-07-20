package sim

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

// The golden test. testdata/trajectory.json is a recording of the CLIENT walking a fixed list of
// inputs: what was pushed each tick, and where the client's sim put the player afterwards. Here we
// feed the same inputs to the Go sim and check it lands on the same points.
//
// This is the whole reason the mirrored sim is safe to have. The walk exists twice, once in TypeScript
// and once in Go, and two hand-written copies of anything drift. Without this test the drift is silent:
// the server thinks you are somewhere slightly different from where your screen says, every correction
// nudges you, and it shows up as unexplained twitching that is miserable to track down months later.
// With it, changing a speed in one language and not the other fails in one second with a clear message.
//
// Regenerate the recording with `npm run gen:trajectory` from client/ after any deliberate change.

// How far apart the two are allowed to be. The languages agree exactly on arithmetic, but their sine
// and cosine can differ in the last bit or two, and 400 ticks of walking lets that accumulate a little.
// A millionth of a unit on a planet 36 units across is thousands of times smaller than anything that
// could ever be seen, while still being tight enough to catch a real mistake.
const epsilon = 1e-6

type fixture struct {
	TickDT float64    `json:"tickDt"`
	Radius float64    `json:"radius"`
	Spawn  []float64  `json:"spawn"`
	Facing []float64  `json:"facing"`
	Steps  []stepData `json:"steps"`
}

type stepData struct {
	Dir      []float64 `json:"dir"`
	Position []float64 `json:"position"`
	Forward  []float64 `json:"forward"`
	Anim     string    `json:"anim"`
}

func vec(v []float64) Vec3 { return Vec3{v[0], v[1], v[2]} }

func loadFixture(t *testing.T) fixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/trajectory.json")
	if err != nil {
		t.Fatalf("cannot read the golden file, regenerate it with `npm run gen:trajectory` from client/: %v", err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("golden file is not valid JSON: %v", err)
	}
	return f
}

// The constants have to match before the walk can. Checking them separately means a changed tick rate
// reports itself plainly instead of showing up as a path that slowly falls behind.
func TestConstantsMatchClient(t *testing.T) {
	f := loadFixture(t)
	if f.TickDT != TickDT {
		t.Errorf("tick length differs: client %v, go %v", f.TickDT, TickDT)
	}
	if f.Radius != PlanetRadius {
		t.Errorf("planet radius differs: client %v, go %v", f.Radius, PlanetRadius)
	}
}

func TestWalkMatchesClient(t *testing.T) {
	f := loadFixture(t)
	planet := NewPlanet()
	path := NewPath(f.Radius)
	state := NewPlayerState(vec(f.Spawn), vec(f.Facing))

	worstPos, worstFwd := 0.0, 0.0

	for i, want := range f.Steps {
		state = Step(state, Input{Seq: i, Dir: vec(want.Dir)}, planet, &path, f.TickDT)

		posOff := state.Position.Sub(vec(want.Position)).Length()
		fwdOff := state.Forward.Sub(vec(want.Forward)).Length()
		worstPos = math.Max(worstPos, posOff)
		worstFwd = math.Max(worstFwd, fwdOff)

		if posOff > epsilon {
			t.Fatalf("tick %d: position is %v off\n  go     %+v\n  client %v", i, posOff, state.Position, want.Position)
		}
		if fwdOff > epsilon {
			t.Fatalf("tick %d: facing is %v off\n  go     %+v\n  client %v", i, fwdOff, state.Forward, want.Forward)
		}
		if state.Anim != want.Anim {
			t.Fatalf("tick %d: animation differs: go %q, client %q", i, state.Anim, want.Anim)
		}
	}

	t.Logf("%d ticks matched. Worst gap: position %.3e, facing %.3e (allowed %.0e)", len(f.Steps), worstPos, worstFwd, epsilon)
}

// The road decides who walks faster, so the two languages have to agree on its edges too. Sampling the
// recorded path is enough: if the meander or the ragged width had been copied wrong, the speed would
// differ somewhere along 400 ticks of walking and the test above would already have failed. This one
// makes the road's own answer explicit, so a failure points straight at it.
func TestRoadIsActuallyCrossed(t *testing.T) {
	f := loadFixture(t)
	path := NewPath(f.Radius)
	on, off := 0, 0
	for _, s := range f.Steps {
		if path.Contains(vec(s.Position), 0) {
			on++
		} else {
			off++
		}
	}
	if on == 0 || off == 0 {
		t.Fatalf("the recorded walk needs to spend time both on and off the road to be worth testing, got on=%d off=%d", on, off)
	}
	t.Logf("recorded walk: %d ticks on the dirt, %d on grass", on, off)
}
