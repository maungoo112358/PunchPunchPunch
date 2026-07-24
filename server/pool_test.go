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

// A resuming guest asks for a specific character by name. They get it when it is free, keep the name
// they hand in, and fall through (ok=false) when someone else already holds that character.
func TestPoolTakeSpecific(t *testing.T) {
	p := newPool()

	// A character that is definitely in the bag, drawn back by name with a chosen label.
	want := characterPool[2]
	ch, nm, ok := p.takeSpecific(want, "Gandalf")
	if !ok || ch != want || nm != "Gandalf" {
		t.Fatalf("takeSpecific gave %q/%q ok=%v, want %q/Gandalf true", ch, nm, ok, want)
	}
	// It is now out of the bag, so asking again fails rather than handing out a duplicate.
	if _, _, ok := p.takeSpecific(want, "Gandalf"); ok {
		t.Fatal("takeSpecific handed out the same character twice")
	}
	// Giving it back makes it drawable again.
	p.give(want, "Gandalf")
	if _, _, ok := p.takeSpecific(want, "Gandalf"); !ok {
		t.Fatal("takeSpecific should succeed after the character is returned")
	}
}
