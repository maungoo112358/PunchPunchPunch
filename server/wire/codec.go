package wire

// The codec seam, the server twin of client/src/net/codec.ts. One schema in gen/gamepb, two encodings,
// and the same rule: the receiver never reads a flag. A text frame is JSON, a binary frame is protobuf,
// so Decode is told which kind of frame arrived and Encode is told which kind to produce.
//
// The package is called wire, not net, because a Go package named net would shadow the standard library.

import (
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Encoding is how a connection wants its outbound frames serialized. Set once per connection next step,
// from the socket URL, then this connection is answered in kind for its whole life.
type Encoding int

const (
	Protobuf Encoding = iota
	JSON
)

// Encode turns a message into a wire frame. The bool is whether it must go out as a WebSocket text
// frame: true for JSON, false for a binary protobuf frame. That bool is what lets the other side pick
// the decoder without any flag in the bytes.
func Encode(message proto.Message, encoding Encoding) (data []byte, text bool, err error) {
	if encoding == JSON {
		data, err = protojson.Marshal(message)
		return data, true, err
	}
	data, err = proto.Marshal(message)
	return data, false, err
}

// Decode fills message from a wire frame. text says which kind arrived: a text frame is JSON, a binary
// frame is protobuf. message must be the right empty type for what is expected on this direction, the
// server always decoding a ClientMessage.
func Decode(message proto.Message, data []byte, text bool) error {
	if text {
		return protojson.Unmarshal(data, message)
	}
	return proto.Unmarshal(data, message)
}
