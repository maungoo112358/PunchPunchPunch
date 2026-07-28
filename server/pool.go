package main

import "sync"

// The bags a joiner draws from: one of the five characters and one name, taken when a socket opens and
// put back when it closes. Drawing without replacement is the whole point. Five random picks out of five
// collide most of the time, and two players wearing the same character is exactly the confusion this
// prevents. A sixth player finds the character bag empty and is turned away, which is fine for a demo.
//
// The name comes through here too, and login (auth.go) plugs in at this seam: a logged-in player still
// draws a character from the bag but wears their account name instead of the drawn one. The drawn name is
// still what gets returned to the bag on leave, which is why the caller tracks poolName separately.

// The five characters, as keys into the client's model catalog. The client maps each to a glTF. These
// must stay in step with CHARACTER_MODELS in client/src/config/characters.ts: a key that side does not
// know draws the fallback model, so everyone would end up wearing the same thing.
var characterPool = []string{"barbarian", "knight", "mage", "rogue", "rogue_hooded"}

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

// takeSpecific tries to draw one particular character back out of the bag, for a guest resuming after a
// refresh who wants the same avatar they had a moment ago. ok is false when that character is not free
// right now, which happens if someone else drew it in the blink between the old socket closing and the
// new one opening; the caller then falls back to a normal random take. The name is only a label, so it
// is pulled from the name bag when still there and kept as given either way. Under that same rare race a
// name can end up repeated, which is cosmetic and only touches guests.
func (p *pool) takeSpecific(character, name string) (drawnCharacter, drawnName string, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	idx := indexOf(p.characters, character)
	if idx < 0 {
		return "", "", false
	}
	p.characters = append(p.characters[:idx], p.characters[idx+1:]...)
	if nidx := indexOf(p.names, name); nidx >= 0 {
		p.names = append(p.names[:nidx], p.names[nidx+1:]...)
	}
	return character, name, true
}

func indexOf(list []string, want string) int {
	for i, s := range list {
		if s == want {
			return i
		}
	}
	return -1
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
