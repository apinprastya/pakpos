package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"pakpos/internal/core/tools/hashx"
)

// MaxToolText is the largest text a tool accepts (files are streamed instead).
const MaxToolText = 10 << 20

// ToolService backs the tools that need Go (hashing files, MD5 that Web
// Crypto lacks). It is thin: the work is in internal/core/tools.
type ToolService struct{ c *Core }

// NewToolService creates the service.
func NewToolService(c *Core) *ToolService { return &ToolService{c: c} }

// HashRequest is what to digest: Text, or the file at FilePath when it's set.
// Key is an HMAC key (used only with HMAC), already resolved by the frontend;
// it is never logged or returned.
type HashRequest struct {
	Algorithm string `json:"algorithm"`
	Text      string `json:"text"`
	FilePath  string `json:"filePath"`
	HMAC      bool   `json:"hmac"`
	Key       string `json:"key"`
	KeyFormat string `json:"keyFormat"`
}

// HashResult is the digest in hex and base64, and how many bytes were read.
type HashResult struct {
	Hex    string `json:"hex"`
	Base64 string `json:"base64"`
	Bytes  int64  `json:"bytes"`
}

// countingReader counts what passes through, for HashResult.Bytes.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// Hash digests the request's text or file. Errors are sentences for the user.
func (s *ToolService) Hash(ctx context.Context, req HashRequest) (HashResult, error) {
	opts := hashx.Options{
		Algorithm: hashx.Algorithm(req.Algorithm),
		HMAC:      req.HMAC,
		Key:       req.Key,
		KeyFormat: hashx.KeyFormat(req.KeyFormat),
	}
	if req.FilePath == "" {
		if len(req.Text) > MaxToolText {
			return HashResult{}, &userError{msg: "Input is too large for this tool. Hash it as a file instead."}
		}
		sum, err := hashx.Bytes(opts, []byte(req.Text))
		if err != nil {
			return HashResult{}, hashError(err)
		}
		return HashResult{Hex: sum.Hex, Base64: sum.Base64, Bytes: int64(len(req.Text))}, nil
	}
	// Check the options before opening a possibly large file.
	if _, err := hashx.New(opts); err != nil {
		return HashResult{}, hashError(err)
	}
	f, err := os.Open(req.FilePath) //nolint:gosec // a file the user picked to hash
	if err != nil {
		return HashResult{}, &userError{msg: fmt.Sprintf("Couldn't open %s. Check that it still exists and you can read it.", filepath.Base(req.FilePath)), err: err}
	}
	defer func() { _ = f.Close() }()
	cr := &countingReader{r: f}
	sum, err := hashx.Reader(ctx, opts, cr)
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return HashResult{}, &userError{msg: "Hashing was cancelled.", err: err}
	}
	if err != nil {
		return HashResult{}, &userError{msg: fmt.Sprintf("Couldn't read %s: %v.", filepath.Base(req.FilePath), errors.Unwrap(err)), err: err}
	}
	return HashResult{Hex: sum.Hex, Base64: sum.Base64, Bytes: cr.n}, nil
}

// hashError turns a hashx error into a capitalised sentence.
func hashError(err error) error {
	msg := err.Error()
	return &userError{msg: strings.ToUpper(msg[:1]) + msg[1:] + ".", err: err}
}

// PickFile asks for a file to hash. It returns "" when cancelled.
func (s *ToolService) PickFile() (string, error) {
	return s.c.dialogs.PickFile("Choose a file to hash")
}

// SaveBytes asks where to save data (standard base64, as decoded by a tool)
// and writes it there. It returns the path, or "" when cancelled.
func (s *ToolService) SaveBytes(suggestedName, data string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return "", &userError{msg: "The data to save isn't valid base64.", err: err}
	}
	if suggestedName == "" {
		suggestedName = "data.bin"
	}
	dest, err := s.c.dialogs.SaveFile("Save to file", filepath.Base(suggestedName))
	if err != nil || dest == "" {
		return "", err
	}
	if err := os.WriteFile(dest, raw, 0o644); err != nil { //nolint:gosec // a file the user chose to save, readable like any document
		return "", &userError{msg: fmt.Sprintf("Couldn't save %s. Check that the folder exists and you can write to it.", filepath.Base(dest)), err: err}
	}
	return dest, nil
}
