package sqlite

import (
	"testing"
	"time"

	"pakpos/internal/core/cookies"
)

func TestCookieStore(t *testing.T) {
	s := openTest(t)
	now := time.UnixMilli(1_800_000_000_000)
	w1, w2 := s.Cookies("W1"), s.Cookies("W2")
	live := cookies.Cookie{Name: "sid", Value: "abc", Domain: "example.com", Path: "/", HostOnly: true, Secure: true,
		HTTPOnly: true, SameSite: "lax", ExpiresAt: now.Add(time.Hour).UnixMilli(), CreatedAt: 7}
	expired := cookies.Cookie{Name: "old", Value: "x", Domain: "example.com", Path: "/", ExpiresAt: now.UnixMilli()}
	other := cookies.Cookie{Name: "o", Value: "y", Domain: "other.example", Path: "/a", ExpiresAt: now.Add(time.Hour).UnixMilli()}
	for _, c := range []cookies.Cookie{live, expired, other} {
		if err := w1.SaveCookie(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := w2.SaveCookie(live); err != nil {
		t.Fatal(err)
	}
	// Upsert.
	live.Value = "def"
	if err := w1.SaveCookie(live); err != nil {
		t.Fatal(err)
	}

	got, err := w1.LoadCookies(now)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != live || got[1] != other {
		t.Fatalf("loaded %+v", got)
	}
	if err := w1.DeleteCookie(other.Ref()); err != nil {
		t.Fatal(err)
	}
	if got, _ := w1.LoadCookies(now); len(got) != 1 {
		t.Fatalf("after delete %+v", got)
	}
	if err := w1.ClearCookies("example.com"); err != nil {
		t.Fatal(err)
	}
	if got, _ := w1.LoadCookies(now); len(got) != 0 {
		t.Fatalf("after clear domain %+v", got)
	}
	if got, _ := w2.LoadCookies(now); len(got) != 1 {
		t.Fatal("another workspace's cookies were touched")
	}
	if err := w2.ClearCookies(""); err != nil {
		t.Fatal(err)
	}
	if got, _ := w2.LoadCookies(now); len(got) != 0 {
		t.Fatal("clear all")
	}

	// Through a jar: survives a "restart".
	jar, err := cookies.New(cookies.Options{Store: s.Cookies("W3")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jar.Add(cookies.Cookie{Name: "keep", Value: "1", Domain: "x.example", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	again, _ := cookies.New(cookies.Options{Store: s.Cookies("W3")})
	if len(again.All()) != 1 {
		t.Fatal("cookie lost across jars")
	}

	_ = s.Close()
	if _, err := w1.LoadCookies(now); err == nil {
		t.Fatal("load on a closed db")
	}
	if err := w1.SaveCookie(live); err == nil {
		t.Fatal("save on a closed db")
	}
	if err := w1.DeleteCookie(live.Ref()); err == nil {
		t.Fatal("delete on a closed db")
	}
	if err := w1.ClearCookies(""); err == nil {
		t.Fatal("clear on a closed db")
	}
}
