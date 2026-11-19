package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestToolServiceHashText(t *testing.T) {
	s := NewToolService(newHarness(t).core)
	tests := []struct {
		name string
		req  HashRequest
		hex  string
		err  string
	}{
		{"sha256", HashRequest{Algorithm: "sha256", Text: "abc"}, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", ""},
		{"hmac", HashRequest{Algorithm: "sha256", Text: "what do ya want for nothing?", HMAC: true, Key: "Jefe", KeyFormat: "text"}, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", ""},
		{"bad key", HashRequest{Algorithm: "sha256", HMAC: true, Key: "xyz", KeyFormat: "hex"}, "", "The HMAC key can't be read: it isn't valid hex"},
		{"bad algorithm", HashRequest{Algorithm: "crc"}, "", `Unknown hash algorithm "crc".`},
		{"too large", HashRequest{Algorithm: "md5", Text: strings.Repeat("x", MaxToolText+1)}, "", "Input is too large for this tool."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := s.Hash(context.Background(), tt.req)
			if tt.err != "" {
				if err == nil || !strings.HasPrefix(err.Error(), tt.err) {
					t.Fatalf("err = %v, want %q", err, tt.err)
				}
				if tt.req.Key != "" && strings.Contains(err.Error(), tt.req.Key) {
					t.Fatal("the key leaked into the error")
				}
				return
			}
			if err != nil || got.Hex != tt.hex || got.Base64 == "" || got.Bytes != int64(len(tt.req.Text)) {
				t.Fatalf("got %+v, %v", got, err)
			}
		})
	}
}

func TestToolServiceHashFile(t *testing.T) {
	h := newHarness(t)
	s := NewToolService(h.core)
	path := filepath.Join(t.TempDir(), "data.bin")
	data := strings.Repeat("pakpos", 200_000)
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	fromFile, err := s.Hash(context.Background(), HashRequest{Algorithm: "sha1", FilePath: path, Text: "ignored"})
	if err != nil {
		t.Fatal(err)
	}
	fromText, _ := s.Hash(context.Background(), HashRequest{Algorithm: "sha1", Text: data})
	if fromFile.Hex != fromText.Hex || fromFile.Bytes != int64(len(data)) {
		t.Fatalf("file %+v, text %+v", fromFile, fromText)
	}

	_, err = s.Hash(context.Background(), HashRequest{Algorithm: "sha1", FilePath: filepath.Join(t.TempDir(), "gone.txt")})
	if err == nil || err.Error() != "Couldn't open gone.txt. Check that it still exists and you can read it." {
		t.Fatalf("err = %v", err)
	}
	_, err = s.Hash(context.Background(), HashRequest{Algorithm: "nope", FilePath: path})
	if err == nil || !strings.HasPrefix(err.Error(), "Unknown hash algorithm") {
		t.Fatalf("err = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = s.Hash(ctx, HashRequest{Algorithm: "sha1", FilePath: path})
	if err == nil || err.Error() != "Hashing was cancelled." || !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	// A directory opens but can't be read.
	_, err = s.Hash(context.Background(), HashRequest{Algorithm: "sha1", FilePath: t.TempDir()})
	if err == nil || !strings.HasPrefix(err.Error(), "Couldn't") {
		t.Fatalf("err = %v", err)
	}
}

func TestToolServicePickFile(t *testing.T) {
	h := newHarness(t)
	h.dialogs.file = "/tmp/x.iso"
	if got, err := NewToolService(h.core).PickFile(); err != nil || got != "/tmp/x.iso" {
		t.Fatalf("got %q, %v", got, err)
	}
}
