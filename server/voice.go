package main

import (
	"context"
	"log"

	pb "punchpunchpunch/server/gen/gamepb"
)

// Voice signalling, the fourth optional plug-in. Pull this file and the game runs exactly as it does now:
// voice messages arrive, match nothing in the read loop's switch, and are ignored.
//
// No sound passes through this server. Two browsers work out a direct connection between themselves and
// the audio then flows straight from one to the other, never touching this box. The only reason the server
// is involved at all is that until that handshake finishes, the two browsers have no way to reach each
// other, so something they can both already talk to has to carry the first few messages. That is this.
//
// It reads one field, peer, to know who to hand the message to. The payload is passed through unopened.

// maxSignalPayload caps one handshake blob. A full audio description runs a few kilobytes and a single
// address is a couple of hundred bytes, so 16k is generous for anything real and small enough that a
// hostile client cannot use this to push size around the room. The socket's own frame limit sits above
// this; the cap here is about what we agree to forward, not what we agree to receive.
const maxSignalPayload = 16 * 1024

// routeVoice hands one step of the handshake to the player it is addressed to.
func (s *server) routeVoice(ctx context.Context, from *Client, sig *pb.VoiceSignal) {
	if sig == nil || sig.Peer == "" || len(sig.Payload) > maxSignalPayload {
		return
	}
	// Addressing yourself is always a bug on the sending side, and forwarding it would feed a browser
	// its own handshake.
	if sig.Peer == from.ID {
		return
	}
	to := s.hub.Get(sig.Peer)
	// They left in the gap between the sender deciding to call them and this arriving. Dropping it is
	// the right answer: a leave message is already on its way to the sender, which tears down the attempt.
	if to == nil {
		return
	}

	// peer is rewritten from "who this is for" into "who this came from", which is what the receiver
	// needs to know. The sender's id is taken from the socket the message arrived on and never from
	// anything the client put in it, so no one can pose as another player by filling in a field.
	out := &pb.ServerMessage{Body: &pb.ServerMessage_Voice{Voice: &pb.VoiceSignal{
		Peer:    from.ID,
		Kind:    sig.Kind,
		Payload: sig.Payload,
	}}}
	s.sendMsg(ctx, to, out)

	// Offers and answers are logged and addresses are not, on purpose. There are exactly two of the
	// former per pair of players, which is enough to watch a handshake travel, while addresses arrive by
	// the dozen and would bury the log.
	switch sig.Kind {
	case pb.VoiceSignal_KIND_OFFER, pb.VoiceSignal_KIND_ANSWER:
		log.Printf("voice %s -> %s %s", from.ID, to.ID, sig.Kind)
	}
}
