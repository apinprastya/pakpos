package fsstore

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRetryTransient(t *testing.T) {
	busy := errors.New("busy")
	fatal := errors.New("fatal")
	isBusy := func(err error) bool { return errors.Is(err, busy) }
	tests := []struct {
		name      string
		errs      []error // returned in turn; the last one repeats
		limit     time.Duration
		wantErr   error
		wantCalls int
	}{
		{"succeeds at once", []error{nil}, time.Second, nil, 1},
		{"succeeds after transient failures", []error{busy, busy, nil}, time.Second, nil, 3},
		{"other errors are not retried", []error{fatal}, time.Second, fatal, 1},
		{"gives up after the limit", []error{busy}, 0, busy, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			err := retryTransient(func() error {
				e := tt.errs[min(calls, len(tt.errs)-1)]
				calls++
				return e
			}, isBusy, tt.limit)
			if !errors.Is(err, tt.wantErr) || calls != tt.wantCalls {
				t.Fatalf("err = %v, calls = %d; want %v, %d", err, calls, tt.wantErr, tt.wantCalls)
			}
		})
	}
}

func TestRenameAndRemoveDir(t *testing.T) {
	root := t.TempDir()
	a, b := filepath.Join(root, "a"), filepath.Join(root, "b")
	if err := os.MkdirAll(filepath.Join(a, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := renameDir(a, b); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(b, "sub")); err != nil {
		t.Fatalf("renamed dir: %v", err)
	}
	if err := removeDirAll(b); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(b); !os.IsNotExist(err) {
		t.Fatalf("removed dir still there: %v", err)
	}
	if err := renameDir(a, b); err == nil {
		t.Fatal("renaming a missing dir succeeded")
	}
}
