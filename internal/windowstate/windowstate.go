// Package windowstate remembers the main window's size, position and
// maximised/fullscreen state between runs. It has no Wails dependency:
// main.go adapts the Wails window to the Window interface.
package windowstate

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Key is the settings key the state is stored under.
const Key = "window"

// State is the saved window state. X, Y, Width and Height are the bounds of
// the window when it is neither maximised nor fullscreen, so restoring a
// maximised window and then un-maximising it lands on the size the user chose.
type State struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
	// Positioned is false until a position has been recorded; the window is
	// then centred by the OS.
	Positioned bool `json:"positioned"`
	Maximised  bool `json:"maximised"`
	Fullscreen bool `json:"fullscreen"`
}

// Rect is a screen area.
type Rect struct{ X, Y, Width, Height int }

// Window is the live window the tracker reads.
type Window interface {
	Position() (x, y int)
	Size() (width, height int)
	IsMaximised() bool
	IsMinimised() bool
	IsFullscreen() bool
}

// Store persists the state as JSON (sqlite.Store implements it).
type Store interface {
	GetSetting(key string, out any) (bool, error)
	SetSetting(key string, v any) error
}

// Limits bound a restored size.
type Limits struct {
	MinWidth, MinHeight         int
	DefaultWidth, DefaultHeight int
}

// Load reads the saved state, falling back to the default size when nothing
// usable is stored. The size is never below the minimum.
func Load(store Store, lim Limits) State {
	var s State
	ok, err := store.GetSetting(Key, &s)
	if err != nil || !ok || s.Width <= 0 || s.Height <= 0 {
		return State{Width: lim.DefaultWidth, Height: lim.DefaultHeight}
	}
	s.Width = max(s.Width, lim.MinWidth)
	s.Height = max(s.Height, lim.MinHeight)
	return s
}

// titleBar is how much of the window's top edge must be on a screen for the
// saved position to be used, so the user can always grab and move it.
const titleBarHeight, titleBarMinWidth = 32, 100

// OnScreen reports whether the saved position puts the window's top edge
// visibly on one of the screens' work areas. A position saved on a monitor
// that is gone is not used.
func (s State) OnScreen(screens []Rect) bool {
	if !s.Positioned {
		return false
	}
	for _, r := range screens {
		left, right := max(s.X, r.X), min(s.X+s.Width, r.X+r.Width)
		top, bottom := max(s.Y, r.Y), min(s.Y+titleBarHeight, r.Y+r.Height)
		if right-left >= titleBarMinWidth && bottom-top >= titleBarHeight/2 {
			return true
		}
	}
	return false
}

// FitTo shrinks the size to the largest work area, so a window saved on a
// bigger monitor still fits. Without screens the size is unchanged.
func (s State) FitTo(screens []Rect) State {
	maxW, maxH := 0, 0
	for _, r := range screens {
		maxW, maxH = max(maxW, r.Width), max(maxH, r.Height)
	}
	if maxW > 0 && s.Width > maxW {
		s.Width = maxW
	}
	if maxH > 0 && s.Height > maxH {
		s.Height = maxH
	}
	return s
}

// Tracker records the window's state as it changes and saves it after the
// changes settle. Call Changed on every move, resize or state change and
// Flush when the window closes.
type Tracker struct {
	store Store
	delay time.Duration
	log   *slog.Logger

	mu     sync.Mutex
	win    Window
	state  State
	timer  *time.Timer
	closed bool
}

// NewTracker starts from the loaded state. delay is how long changes must
// settle before they are saved (window managers send bursts of events).
func NewTracker(store Store, initial State, delay time.Duration, log *slog.Logger) *Tracker {
	if log == nil {
		log = slog.Default()
	}
	return &Tracker{store: store, state: initial, delay: delay, log: log}
}

// Attach sets the window to read. Until then Changed and Flush do nothing.
func (t *Tracker) Attach(w Window) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.win = w
}

// State returns the last recorded state.
func (t *Tracker) State() State {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state
}

// Changed schedules a save. The window is read when the save runs, not now,
// because a resize event can arrive before the window reports itself as
// maximised.
func (t *Tracker) Changed() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed || t.win == nil {
		return
	}
	if t.timer != nil {
		t.timer.Stop()
	}
	t.timer = time.AfterFunc(t.delay, func() {
		if err := t.save(false); err != nil {
			t.log.Warn("save window state", "err", err)
		}
	})
}

// Flush reads and saves the state now and stops further saves. Call it while
// the window still exists (on close), before the store is closed.
func (t *Tracker) Flush() error {
	return t.save(true)
}

func (t *Tracker) save(final bool) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	if final {
		t.closed = true
		if t.timer != nil {
			t.timer.Stop()
		}
	}
	if t.win == nil {
		return nil
	}
	if !t.captureLocked() {
		return nil
	}
	if err := t.store.SetSetting(Key, t.state); err != nil {
		return fmt.Errorf("save window state: %w", err)
	}
	return nil
}

// captureLocked reads the window into t.state. It reports false when the
// window can't be read (gone, or minimised: a minimised window's bounds are
// meaningless and the app never starts minimised, so the previous state is
// kept).
func (t *Tracker) captureLocked() bool {
	if t.win.IsMinimised() {
		return false
	}
	w, h := t.win.Size()
	if w <= 0 || h <= 0 {
		return false // destroyed
	}
	t.state.Maximised = t.win.IsMaximised()
	t.state.Fullscreen = t.win.IsFullscreen()
	if !t.state.Maximised && !t.state.Fullscreen {
		t.state.X, t.state.Y = t.win.Position()
		t.state.Width, t.state.Height = w, h
		t.state.Positioned = true
	}
	return true
}
