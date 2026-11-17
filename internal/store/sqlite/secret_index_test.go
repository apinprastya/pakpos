package sqlite

import (
	"testing"
	"time"
)

func TestSecretIndex(t *testing.T) {
	s := openTest(t)
	now := time.Unix(1700000000, 0)
	s.now = func() time.Time { return now }

	if keys, err := s.SecretKeys("W1"); err != nil || len(keys) != 0 || keys == nil {
		t.Fatalf("empty = %v %v", keys, err)
	}
	for _, k := range [][3]string{{"W1", "E1", "token"}, {"W1", "C1", "a/b"}, {"W2", "E9", "token"}} {
		if err := s.RecordSecretKey(k[0], k[1], k[2]); err != nil {
			t.Fatal(err)
		}
	}
	// Adopting a known key keeps its time; a new one is dated at the epoch.
	if err := s.AdoptSecretKey("W1", "E1", "token"); err != nil {
		t.Fatal(err)
	}
	if err := s.AdoptSecretKey("W1", "G", "old"); err != nil {
		t.Fatal(err)
	}
	// Recording again refreshes the time.
	now = now.Add(time.Hour)
	if err := s.RecordSecretKey("W1", "C1", "a/b"); err != nil {
		t.Fatal(err)
	}
	keys, err := s.SecretKeys("W1")
	if err != nil {
		t.Fatal(err)
	}
	want := []SecretKeyRef{
		{"W1", "C1", "a/b", now},
		{"W1", "E1", "token", now.Add(-time.Hour)},
		{"W1", "G", "old", time.Unix(0, 0)},
	}
	if len(keys) != len(want) {
		t.Fatalf("keys = %+v", keys)
	}
	for i := range want {
		if keys[i].WorkspaceID != want[i].WorkspaceID || keys[i].ScopeID != want[i].ScopeID ||
			keys[i].Key != want[i].Key || !keys[i].WrittenAt.Equal(want[i].WrittenAt) {
			t.Fatalf("key %d = %+v, want %+v", i, keys[i], want[i])
		}
	}

	if err := s.ForgetSecretKey("W1", "E1", "token"); err != nil {
		t.Fatal(err)
	}
	if err := s.ForgetSecretKey("W1", "E1", "missing"); err != nil {
		t.Fatal(err)
	}
	if keys, _ := s.SecretKeys("W1"); len(keys) != 2 {
		t.Fatalf("after forget = %+v", keys)
	}
	if keys, _ := s.SecretKeys("W2"); len(keys) != 1 || keys[0].ScopeID != "E9" {
		t.Fatalf("other workspace = %+v", keys)
	}

	for _, bad := range [][3]string{{"", "E", "k"}, {"W", "", "k"}, {"W", "E", ""}} {
		if err := s.RecordSecretKey(bad[0], bad[1], bad[2]); err == nil {
			t.Fatalf("record %v: expected error", bad)
		}
		if err := s.AdoptSecretKey(bad[0], bad[1], bad[2]); err == nil {
			t.Fatalf("adopt %v: expected error", bad)
		}
	}
}

func TestSecretIndexClosedDB(t *testing.T) {
	s := openTest(t)
	_ = s.Close()
	if err := s.RecordSecretKey("W", "E", "k"); err == nil {
		t.Fatal("expected record error")
	}
	if err := s.AdoptSecretKey("W", "E", "k"); err == nil {
		t.Fatal("expected adopt error")
	}
	if err := s.ForgetSecretKey("W", "E", "k"); err == nil {
		t.Fatal("expected forget error")
	}
	if _, err := s.SecretKeys("W"); err == nil {
		t.Fatal("expected list error")
	}
}
