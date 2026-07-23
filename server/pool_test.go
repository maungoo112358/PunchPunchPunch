package main

import "testing"

// The bag hands out each character once, refuses once empty, and gives a returned one back. That is the
// whole contract: no two players wear the same character, a sixth is turned away, and a leaver frees
// theirs for the next joiner.
func TestPoolDrawsWithoutCollisionThenRefills(t *testing.T) {
	p := newPool()

	seen := map[string]bool{}
	var lastChar, lastName string
	for i := 0; i < len(characterPool); i++ {
		ch, nm, ok := p.take()
		if !ok {
			t.Fatalf("take %d failed while the bag should still have characters", i)
		}
		if seen[ch] {
			t.Fatalf("character %q was handed out twice", ch)
		}
		seen[ch] = true
		lastChar, lastName = ch, nm
	}

	if _, _, ok := p.take(); ok {
		t.Fatal("a take past the pool size should fail, not hand out a duplicate")
	}

	p.give(lastChar, lastName)
	ch, _, ok := p.take()
	if !ok {
		t.Fatal("take after give should succeed")
	}
	if ch != lastChar {
		t.Fatalf("expected the returned character %q back, got %q", lastChar, ch)
	}
}
