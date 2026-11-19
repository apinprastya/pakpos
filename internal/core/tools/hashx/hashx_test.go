package hashx

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestBytesVectors(t *testing.T) {
	key0b := strings.Repeat("0b", 20)
	tests := []struct {
		name string
		o    Options
		data string
		hex  string
	}{
		{"md5 empty", Options{Algorithm: MD5}, "", "d41d8cd98f00b204e9800998ecf8427e"},
		{"sha1 empty", Options{Algorithm: SHA1}, "", "da39a3ee5e6b4b0d3255bfef95601890afd80709"},
		{"sha256 empty", Options{Algorithm: SHA256}, "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
		{"sha384 empty", Options{Algorithm: SHA384}, "", "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b"},
		{"sha512 empty", Options{Algorithm: SHA512}, "", "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"},
		{"md5 abc", Options{Algorithm: MD5}, "abc", "900150983cd24fb0d6963f7d28e17f72"},
		{"sha1 abc", Options{Algorithm: SHA1}, "abc", "a9993e364706816aba3e25717850c26c9cd0d89d"},
		{"sha256 abc", Options{Algorithm: SHA256}, "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
		// RFC 4231 test case 1.
		{"rfc4231 1 sha256", Options{Algorithm: SHA256, HMAC: true, Key: key0b, KeyFormat: KeyHex}, "Hi There", "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"},
		{"rfc4231 1 sha384", Options{Algorithm: SHA384, HMAC: true, Key: key0b, KeyFormat: KeyHex}, "Hi There", "afd03944d84895626b0825f4ab46907f15f9dadbe4101ec682aa034c7cebc59cfaea9ea9076ede7f4af152e8b2fa9cb6"},
		{"rfc4231 1 sha512", Options{Algorithm: SHA512, HMAC: true, Key: key0b, KeyFormat: KeyHex}, "Hi There", "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854"},
		// RFC 4231 test case 2, with the key as text, base64 and spaced hex.
		{"rfc4231 2 text", Options{Algorithm: SHA256, HMAC: true, Key: "Jefe"}, "what do ya want for nothing?", "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"},
		{"rfc4231 2 base64", Options{Algorithm: SHA256, HMAC: true, Key: "SmVmZQ==", KeyFormat: KeyBase64}, "what do ya want for nothing?", "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"},
		{"rfc4231 2 hex", Options{Algorithm: SHA256, HMAC: true, Key: "4a 65\n66 65", KeyFormat: KeyHex}, "what do ya want for nothing?", "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"},
		// A key is ignored without HMAC.
		{"plain ignores key", Options{Algorithm: SHA256, Key: "zz", KeyFormat: KeyHex}, "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Bytes(tt.o, []byte(tt.data))
			if err != nil {
				t.Fatal(err)
			}
			if got.Hex != tt.hex {
				t.Fatalf("hex = %s, want %s", got.Hex, tt.hex)
			}
			raw, _ := hex.DecodeString(tt.hex)
			if b, _ := DecodeKey(got.Base64, KeyBase64); !bytes.Equal(b, raw) {
				t.Fatalf("base64 %s doesn't match hex", got.Base64)
			}
		})
	}
}

func TestUnicodeIsUTF8(t *testing.T) {
	text := "Zoë 東京 🚀"
	got, err := Bytes(Options{Algorithm: SHA256}, []byte(text))
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte(text))
	if got.Hex != hex.EncodeToString(want[:]) {
		t.Fatalf("got %s", got.Hex)
	}
}

func TestDecodeKey(t *testing.T) {
	tests := []struct {
		key    string
		format KeyFormat
		want   string
		err    string
	}{
		{"abc", "", "abc", ""},
		{"abc", KeyText, "abc", ""},
		{"DEADbeef", KeyHex, "\xde\xad\xbe\xef", ""},
		{"abc", KeyHex, "", "it isn't valid hex"},
		{"zz", KeyHex, "", "it isn't valid hex"},
		{"-_8", KeyBase64, "\xfb\xff", ""},
		{"+/8=", KeyBase64, "\xfb\xff", ""},
		{"aGk", KeyBase64, "hi", ""},
		{"a", KeyBase64, "", "it isn't valid base64"},
		{"a*b=", KeyBase64, "", "it isn't valid base64"},
		{"x", "rot13", "", `unknown key format "rot13"`},
	}
	for _, tt := range tests {
		got, err := DecodeKey(tt.key, tt.format)
		if tt.err != "" {
			if !errors.Is(err, ErrBadKey) || !strings.Contains(err.Error(), tt.err) {
				t.Errorf("DecodeKey(%q, %q) err = %v, want %q", tt.key, tt.format, err, tt.err)
			}
			continue
		}
		if err != nil || string(got) != tt.want {
			t.Errorf("DecodeKey(%q, %q) = %q, %v", tt.key, tt.format, got, err)
		}
	}
}

func TestErrors(t *testing.T) {
	if _, err := Bytes(Options{Algorithm: "crc32"}, nil); !errors.Is(err, ErrUnknownAlgorithm) || !strings.Contains(err.Error(), `"crc32"`) {
		t.Fatalf("err = %v", err)
	}
	if _, err := Bytes(Options{Algorithm: SHA256, HMAC: true, Key: "q", KeyFormat: KeyHex}, nil); !errors.Is(err, ErrBadKey) {
		t.Fatalf("err = %v", err)
	}
	if _, err := Reader(context.Background(), Options{Algorithm: "x"}, strings.NewReader("")); !errors.Is(err, ErrUnknownAlgorithm) {
		t.Fatalf("err = %v", err)
	}
	if len(Algorithms()) != 5 {
		t.Fatal("algorithms")
	}
}

func TestReaderStreamsLargeInput(t *testing.T) {
	data := bytes.Repeat([]byte("0123456789abcdef"), 3<<20/16+7)
	for _, o := range []Options{{Algorithm: SHA512}, {Algorithm: MD5, HMAC: true, Key: "k"}} {
		want, _ := Bytes(o, data)
		got, err := Reader(context.Background(), o, bytes.NewReader(data))
		if err != nil || got != want {
			t.Fatalf("Reader = %v, %v; want %v", got, err, want)
		}
	}
}

type failingReader struct{ n int }

func (f *failingReader) Read(p []byte) (int, error) {
	if f.n > 0 {
		f.n--
		return copy(p, "abc"), nil
	}
	return 0, errors.New("disk gone")
}

func TestReaderErrorsAndCancel(t *testing.T) {
	_, err := Reader(context.Background(), Options{Algorithm: SHA1}, &failingReader{n: 2})
	if err == nil || !strings.Contains(err.Error(), "read: disk gone") {
		t.Fatalf("err = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Reader(ctx, Options{Algorithm: SHA1}, io.MultiReader()); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}
