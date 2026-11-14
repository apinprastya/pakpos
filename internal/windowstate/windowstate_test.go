package windowstate

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type memStore struct {
	mu      sync.Mutex
	data    map[string][]byte
	getErr  error
	setErr  error
	saves   int
	savedCh chan struct{}
}

func newMemStore() *memStore {
	return &memStore{data: map[string][]byte{}, savedCh: make(chan struct{}, 16)}
}

func (m *memStore) GetSetting(key string, out any) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.getErr != nil {
		return false, m.getErr
	}
	raw, ok := m.data[key]
	if !ok {
		return false, nil
	}
	return true, json.Unmarshal(raw, out)
}

func (m *memStore) SetSetting(key string, v any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.setErr != nil {
		return m.setErr
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	m.data[key] = raw
	m.saves++
	m.savedCh <- struct{}{}
	return nil
}

func (m *memStore) saved(t *testing.T) State {
	t.Helper()
	var s State
	if ok, err := m.GetSetting(Key, &s); !ok || err != nil {
		t.Fatalf("nothing saved: %v", err)
	}
	return s
}

type fakeWindow struct {
	mu                          sync.Mutex
	x, y, w, h                  int
	maximised, minimised, fullS bool
}

func (f *fakeWindow) Position() (int, int) { f.mu.Lock(); defer f.mu.Unlock(); return f.x, f.y }
func (f *fakeWindow) Size() (int, int)     { f.mu.Lock(); defer f.mu.Unlock(); return f.w, f.h }
func (f *fakeWindow) IsMaximised() bool    { f.mu.Lock(); defer f.mu.Unlock(); return f.maximised }
func (f *fakeWindow) IsMinimised() bool    { f.mu.Lock(); defer f.mu.Unlock(); return f.minimised }
func (f *fakeWindow) IsFullscreen() bool   { f.mu.Lock(); defer f.mu.Unlock(); return f.fullS }

var lim = Limits{MinWidth: 900, MinHeight: 560, DefaultWidth: 1280, DefaultHeight: 800}

func TestLoad(t *testing.T) {
	tests := []struct {
		name   string
		stored any
		getErr error
		want   State
	}{
		{"nothing stored", nil, nil, State{Width: 1280, Height: 800}},
		{"read error", nil, errors.New("boom"), State{Width: 1280, Height: 800}},
		{"zero size", State{Width: 0, Height: 700}, nil, State{Width: 1280, Height: 800}},
		{"undecodable", "not an object", nil, State{Width: 1280, Height: 800}},
		{"stored", State{X: 10, Y: 20, Width: 1000, Height: 700, Positioned: true, Maximised: true}, nil,
			State{X: 10, Y: 20, Width: 1000, Height: 700, Positioned: true, Maximised: true}},
		{"below minimum", State{Width: 400, Height: 300}, nil, State{Width: 900, Height: 560}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newMemStore()
			if tt.stored != nil {
				raw, _ := json.Marshal(tt.stored)
				m.data[Key] = raw
			}
			m.getErr = tt.getErr
			if got := Load(m, lim); got != tt.want {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestOnScreen(t *testing.T) {
	screens := []Rect{{0, 0, 1920, 1080}, {1920, 0, 1280, 1024}}
	tests := []struct {
		name string
		s    State
		want bool
	}{
		{"not positioned", State{X: 10, Y: 10, Width: 800, Height: 600}, false},
		{"primary", State{X: 10, Y: 10, Width: 800, Height: 600, Positioned: true}, true},
		{"second screen", State{X: 2000, Y: 100, Width: 800, Height: 600, Positioned: true}, true},
		{"gone monitor", State{X: 4000, Y: 100, Width: 800, Height: 600, Positioned: true}, false},
		{"above the top", State{X: 10, Y: -500, Width: 800, Height: 600, Positioned: true}, false},
		{"sliver on the left", State{X: -750, Y: 10, Width: 800, Height: 600, Positioned: true}, false},
		{"mostly off the right but grabbable", State{X: 3000, Y: 10, Width: 800, Height: 600, Positioned: true}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.s.OnScreen(screens); got != tt.want {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
	if (State{Positioned: true, Width: 800, Height: 600}).OnScreen(nil) {
		t.Fatal("no screens should never be on screen")
	}
}

func TestFitTo(t *testing.T) {
	s := State{Width: 3000, Height: 700}
	got := s.FitTo([]Rect{{0, 0, 1920, 1080}, {1920, 0, 2560, 1400}})
	if got.Width != 2560 || got.Height != 700 {
		t.Fatalf("got %+v", got)
	}
	if got := s.FitTo(nil); got != s {
		t.Fatalf("no screens changed it: %+v", got)
	}
	tall := State{Width: 1000, Height: 2000}.FitTo([]Rect{{0, 0, 1920, 1080}})
	if tall.Height != 1080 || tall.Width != 1000 {
		t.Fatalf("tall = %+v", tall)
	}
}

func waitSave(t *testing.T, m *memStore) {
	t.Helper()
	select {
	case <-m.savedCh:
	case <-time.After(2 * time.Second):
		t.Fatal("no save")
	}
}

func TestTrackerSavesNormalBoundsAfterChanges(t *testing.T) {
	m := newMemStore()
	tr := NewTracker(m, State{Width: 1280, Height: 800}, 5*time.Millisecond, nil)
	tr.Changed() // before Attach: ignored
	if err := tr.Flush(); err != nil {
		t.Fatal(err)
	}
	if m.saves != 0 {
		t.Fatal("saved without a window")
	}

	tr = NewTracker(m, State{Width: 1280, Height: 800}, 5*time.Millisecond, nil)
	w := &fakeWindow{x: 50, y: 60, w: 1100, h: 700}
	tr.Attach(w)
	tr.Changed()
	tr.Changed() // bursts collapse
	waitSave(t, m)
	want := State{X: 50, Y: 60, Width: 1100, Height: 700, Positioned: true}
	if got := m.saved(t); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	// Maximised: the normal bounds stay, only the flag changes.
	w.mu.Lock()
	w.maximised, w.x, w.y, w.w, w.h = true, 0, 0, 1920, 1080
	w.mu.Unlock()
	tr.Changed()
	waitSave(t, m)
	want.Maximised = true
	if got := m.saved(t); got != want {
		t.Fatalf("maximised: got %+v, want %+v", got, want)
	}
	if tr.State() != want {
		t.Fatalf("State() = %+v", tr.State())
	}

	// Minimised: nothing is recorded.
	w.mu.Lock()
	w.maximised, w.minimised = false, true
	w.mu.Unlock()
	if err := tr.Flush(); err != nil {
		t.Fatal(err)
	}
	if got := m.saved(t); got != want {
		t.Fatalf("minimised changed state: %+v", got)
	}
	// After Flush the tracker is closed.
	w.mu.Lock()
	w.minimised = false
	w.mu.Unlock()
	tr.Changed()
	if err := tr.Flush(); err != nil {
		t.Fatal(err)
	}
	if got := m.saved(t); got != want {
		t.Fatalf("saved after close: %+v", got)
	}
}

func TestTrackerFullscreenAndDestroyed(t *testing.T) {
	m := newMemStore()
	tr := NewTracker(m, State{X: 1, Y: 2, Width: 1000, Height: 700, Positioned: true}, time.Hour, nil)
	w := &fakeWindow{w: 2560, h: 1440, fullS: true}
	tr.Attach(w)
	tr.Changed() // pending timer is stopped by Flush
	if err := tr.Flush(); err != nil {
		t.Fatal(err)
	}
	want := State{X: 1, Y: 2, Width: 1000, Height: 700, Positioned: true, Fullscreen: true}
	if got := m.saved(t); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	m2 := newMemStore()
	tr2 := NewTracker(m2, State{}, time.Hour, nil)
	tr2.Attach(&fakeWindow{}) // destroyed windows report a zero size
	if err := tr2.Flush(); err != nil || m2.saves != 0 {
		t.Fatalf("saved a destroyed window: %v %d", err, m2.saves)
	}
}

func TestTrackerSaveError(t *testing.T) {
	m := newMemStore()
	m.setErr = errors.New("disk full")
	tr := NewTracker(m, State{}, 5*time.Millisecond, nil)
	tr.Attach(&fakeWindow{w: 1000, h: 700})
	tr.Changed() // logged, not fatal
	time.Sleep(30 * time.Millisecond)
	if err := tr.Flush(); err == nil {
		t.Fatal("expected save error")
	}
}
