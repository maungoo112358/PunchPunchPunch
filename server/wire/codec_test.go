package wire

// Round-trip the wire types through both encodings and check every field comes back unchanged. This is
// the server half of the same test on the client, and the point is to exercise both paths: the unused
// one breaks quietly and you find out the day you flip the switch. Pure, no network.

import (
	"testing"

	pb "punchpunchpunch/server/gen/gamepb"

	"google.golang.org/protobuf/proto"
)

func TestRoundTrip(t *testing.T) {
	// One message each way. The values are picked to catch trouble: a negative and a tiny fraction in a
	// Vec3 (double must survive, not round to float), a second planet id, and both anim strings.
	up := &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{
		Seq: 42,
		Dir: &pb.Vec3{X: 0.1, Y: -2.5, Z: 3.25},
	}}}
	down := &pb.ServerMessage{Body: &pb.ServerMessage_Snapshot{Snapshot: &pb.Snapshot{
		Tick: 7,
		Ack:  41,
		Players: []*pb.PlayerSnapshot{
			{Id: "p1", PlanetId: 0, Position: &pb.Vec3{X: 1, Y: 2, Z: 3}, Forward: &pb.Vec3{X: 0, Y: 0, Z: 1}, Anim: "Run"},
			{Id: "p2", PlanetId: 1, Position: &pb.Vec3{X: -36, Y: 0.0001, Z: 12.5}, Forward: &pb.Vec3{X: 1, Y: 0, Z: 0}, Anim: "Idle"},
		},
	}}}

	cases := []proto.Message{up, down}
	encodings := []struct {
		name string
		enc  Encoding
	}{{"protobuf", Protobuf}, {"json", JSON}}

	for _, want := range cases {
		for _, e := range encodings {
			data, text, err := Encode(want, e.enc)
			if err != nil {
				t.Fatalf("%s encode: %v", e.name, err)
			}
			// text frame if and only if JSON, which is the whole basis of the receiver telling them apart.
			if wantText := e.enc == JSON; text != wantText {
				t.Fatalf("%s: text=%v, want %v", e.name, text, wantText)
			}
			got := want.ProtoReflect().New().Interface() // a fresh empty of the same type
			if err := Decode(got, data, text); err != nil {
				t.Fatalf("%s decode: %v", e.name, err)
			}
			if !proto.Equal(want, got) {
				t.Errorf("%s round-trip changed the message\n want: %v\n got:  %v", e.name, want, got)
			}
		}
	}
}
