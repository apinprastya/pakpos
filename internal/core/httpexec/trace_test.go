package httpexec

import (
	"testing"
	"time"
)

func TestTimingsTTFB(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	at := func(ms float64) time.Time { return base.Add(time.Duration(ms * float64(time.Millisecond))) }

	tests := []struct {
		name                             string
		gotConn, wroteRequest, firstByte time.Time
		want                             float64
	}{
		{"from request write", at(1), at(2), at(5), 3},
		{"first byte before write callback falls back to connection", at(1), at(6), at(5), 4},
		{"no write callback falls back to connection", at(1), time.Time{}, at(5), 4},
		{"sub-microsecond is not truncated to zero", at(1), at(2), at(2.0005), 0.0005},
		{"no first byte", at(1), at(2), time.Time{}, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tr := &tracer{start: base, gotConn: tc.gotConn, wroteRequest: tc.wroteRequest, firstByte: tc.firstByte}
			got := tr.timings(at(10)).TTFB
			if diff := got - tc.want; diff > 1e-9 || diff < -1e-9 {
				t.Fatalf("TTFB = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMsRejectsInvertedOrZero(t *testing.T) {
	now := time.Now()
	if ms(time.Time{}, now) != 0 || ms(now, time.Time{}) != 0 || ms(now, now.Add(-time.Second)) != 0 {
		t.Fatal("ms should return 0 for zero or inverted ranges")
	}
}
