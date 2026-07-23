package main

import "sync"

// The bags a joiner draws from: one of the five characters and one name, taken when a socket opens and
// put back when it closes. Drawing without replacement is the whole point. Five random picks out of five
// collide most of the time, and two players wearing the same character is exactly the confusion this
// prevents. A sixth player finds the character bag empty and is turned away, which is fine for a demo.
//
// The name comes through here too, but this is the seam login will replace at step 15: then your name is
// your account name and only the character is still drawn from a bag.

// The five characters, as keys into the client's model catalog. The client maps each to a glTF.
var characterPool = []string{"wizard", "witch", "goblin", "elf", "knight"}

// A pool of Lovecraft names, one per character, so the two bags drain together. Swap freely; nothing
// keys off the exact strings.
var namePool = []string{"Azathoth", "Cthulhu", "Dagon", "Nyarlathotep", "Shoggoth"}

type pool struct {
	mu         sync.Mutex
	characters []string
	names      []string
}

func newPool() *pool {
	// Copy the package lists so the bags can be drained and refilled without touching the originals.
	return &pool{
		characters: append([]string(nil), characterPool...),
		names:      append([]string(nil), namePool...),
	}
}

// take draws a character and a name. ok is false when the character bag is empty, which is the signal to
// turn the connection away. A name is always available in practice because the name bag starts larger
// than the character bag; if it somehow runs dry the character key stands in as the name.
func (p *pool) take() (character, name string, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.characters) == 0 {
		return "", "", false
	}
	character = p.characters[len(p.characters)-1]
	p.characters = p.characters[:len(p.characters)-1]

	if len(p.names) > 0 {
		name = p.names[len(p.names)-1]
		p.names = p.names[:len(p.names)-1]
	} else {
		name = character
	}
	return character, name, true
}

// give returns a character and a name to their bags when a player leaves, so the next joiner can draw
// them again. Empty strings are ignored, which covers a connection that was turned away before it drew.
func (p *pool) give(character, name string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if character != "" {
		p.characters = append(p.characters, character)
	}
	if name != "" {
		p.names = append(p.names, name)
	}
}
