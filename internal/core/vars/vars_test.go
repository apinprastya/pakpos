package vars

import (
	"bytes"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/model"
)

func v(key, value string) model.Variable {
	return model.Variable{Key: key, Value: value, Enabled: true}
}

func scope(kind ScopeKind, vs ...model.Variable) Scope {
	return Scope{Kind: kind, ID: string(kind) + "-id", Name: string(kind) + " name", Variables: vs}
}

var fixedTime = time.Date(2026, 11, 14, 9, 30, 15, 123_000_000, time.FixedZone("WIB", 7*3600))

func fixedClock() time.Time { return fixedTime }

func TestResolve(t *testing.T) {
	scopes := []Scope{
		scope(ScopeGlobal, v("host", "global.example"), v("onlyGlobal", "g"), v("shadow", "global")),
		scope(ScopeCollection, v("shadow", "collection"), v("path", "/users")),
		scope(ScopeEnvironment, v("shadow", "env"), v("url", "https://{{host}}{{path}}"),
			model.Variable{Key: "disabled", Value: "nope"}),
		scope(ScopeLocal, v("host", "local.example")),
	}
	tests := []struct {
		name       string
		in         string
		want       string
		unresolved []string
	}{
		{"no refs", "plain text", "plain text", []string{}},
		{"simple", "{{onlyGlobal}}", "g", []string{}},
		{"local beats global", "{{host}}", "local.example", []string{}},
		{"env beats collection and global", "{{shadow}}", "env", []string{}},
		{"whitespace inside braces", "{{  shadow\t}}", "env", []string{}},
		{"nested", "{{url}}/1", "https://local.example/users/1", []string{}},
		{"unresolved stays literal", "a {{ missing }} b {{missing}}", "a {{ missing }} b {{missing}}", []string{"missing"}},
		{"disabled row is unresolved", "{{disabled}}", "{{disabled}}", []string{"disabled"}},
		{"case sensitive", "{{HOST}}", "{{HOST}}", []string{"HOST"}},
		{"sorted dedup", "{{b}}{{a}}{{b}}", "{{b}}{{a}}{{b}}", []string{"a", "b"}},
		{"empty braces literal", "{{}} {{  }}", "{{}} {{  }}", []string{}},
		{"unterminated", "x {{host", "x {{host", []string{}},
		{"extra open braces", "{{{{host}}", "{{local.example", []string{}},
		{"triple braces", "{{{host}}}", "{{{host}}}", []string{}},
		{"multiline is not a name", "{{a\nb}}", "{{a\nb}}", []string{}},
		{"adjacent", "{{host}}{{path}}", "local.example/users", []string{}},
		{"unknown dynamic", "{{$nope}}", "{{$nope}}", []string{"$nope"}},
	}
	r := New(scopes)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, unresolved, err := r.Resolve(tt.in)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Errorf("Resolve(%q) = %q, want %q", tt.in, got, tt.want)
			}
			if !reflect.DeepEqual(unresolved, tt.unresolved) {
				t.Errorf("unresolved = %v, want %v", unresolved, tt.unresolved)
			}
		})
	}
}

func TestNestedUnresolvedIsReported(t *testing.T) {
	got, unresolved, err := Resolve("{{a}}", []Scope{scope(ScopeEnvironment, v("a", "x{{b}}"))})
	if err != nil {
		t.Fatal(err)
	}
	if got != "x{{b}}" || !reflect.DeepEqual(unresolved, []string{"b"}) {
		t.Fatalf("got %q %v", got, unresolved)
	}
}

func chain(n int) []model.Variable {
	var vs []model.Variable
	for i := 1; i <= n; i++ {
		val := "end"
		if i < n {
			val = "{{v" + itoa(i+1) + "}}"
		}
		vs = append(vs, v("v"+itoa(i), val))
	}
	return vs
}

func itoa(i int) string { return fmt.Sprintf("%02d", i) }

func TestDepthAndCycles(t *testing.T) {
	tests := []struct {
		name    string
		vars    []model.Variable
		in      string
		want    string
		wantErr error
		errText string
	}{
		{"depth 10 ok", chain(MaxDepth), "{{v01}}", "end", nil, ""},
		{"depth 11 fails", chain(MaxDepth + 1), "{{v01}}", "", ErrTooDeep, "v01 -> v02"},
		{"self cycle", []model.Variable{v("a", "{{a}}")}, "{{a}}", "", ErrCycle, "a -> a"},
		{"two cycle", []model.Variable{v("a", "{{b}}"), v("b", "x{{a}}")}, "pre {{a}}", "", ErrCycle, "a -> b -> a"},
		{"inner cycle", []model.Variable{v("a", "{{b}}"), v("b", "{{c}}"), v("c", "{{b}}")}, "{{a}}", "", ErrCycle, "b -> c -> b"},
		{"same var twice is not a cycle", []model.Variable{v("a", "{{b}}{{b}}"), v("b", "x")}, "{{a}}", "xx", nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _, err := Resolve(tt.in, []Scope{scope(ScopeEnvironment, tt.vars...)})
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.errText) {
					t.Fatalf("err %q does not mention %q", err, tt.errText)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("got %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

// seqReader returns bytes 0,1,2,... so every read gives different data.
type seqReader struct{ n byte }

func (s *seqReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = s.n
		s.n++
	}
	return len(p), nil
}

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestDynamicVariables(t *testing.T) {
	r := New(nil, WithClock(fixedClock), WithRand(&seqReader{}))
	tests := []struct {
		in    string
		check func(string) bool
	}{
		{"{{$timestamp}}", func(s string) bool { return s == "1794623415" }},
		{"{{ $isoTimestamp }}", func(s string) bool { return s == "2026-11-14T02:30:15.123Z" }},
		{"{{$guid}}", uuidRE.MatchString},
		{"{{$randomUUID}}", uuidRE.MatchString},
		{"{{$randomInt}}", func(s string) bool { return len(s) >= 1 && len(s) <= 4 }},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, unresolved, err := r.Resolve(tt.in)
			if err != nil || len(unresolved) != 0 || !tt.check(got) {
				t.Fatalf("Resolve(%q) = %q, %v, %v", tt.in, got, unresolved, err)
			}
		})
	}
}

func TestDynamicFreshPerOccurrence(t *testing.T) {
	r := New(nil, WithRand(&seqReader{}))
	got, _, err := r.Resolve("{{$guid}} {{$guid}}")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(got, " ")
	if len(parts) != 2 || parts[0] == parts[1] {
		t.Fatalf("expected two different guids, got %q", got)
	}
	// A dynamic value referenced through a variable is fresh too.
	r = New([]Scope{scope(ScopeGlobal, v("id", "{{$randomUUID}}"))}, WithRand(&seqReader{}))
	got, _, _ = r.Resolve("{{id}}|{{id}}")
	parts = strings.Split(got, "|")
	if parts[0] == parts[1] {
		t.Fatalf("expected fresh values, got %q", got)
	}
}

func TestDynamicDoesNotResolveFurther(t *testing.T) {
	// A user variable cannot shadow a dynamic one.
	r := New([]Scope{scope(ScopeGlobal, v("$timestamp", "user"))}, WithClock(fixedClock))
	got, _, _ := r.Resolve("{{$timestamp}}")
	if got != "1794623415" {
		t.Fatalf("got %q", got)
	}
	// An unknown $name falls back to the scopes.
	r = New([]Scope{scope(ScopeGlobal, v("$custom", "mine"))})
	if got, _, _ = r.Resolve("{{$custom}}"); got != "mine" {
		t.Fatalf("got %q", got)
	}
}

func TestRandomIntRange(t *testing.T) {
	r := New(nil) // real crypto/rand
	for range 500 {
		got, _, err := r.Resolve("{{$randomInt}}")
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, c := range got {
			n = n*10 + int(c-'0')
		}
		if n < 0 || n > 1000 {
			t.Fatalf("out of range: %s", got)
		}
	}
	// Rejection sampling: 0xFFFFFFFF is above the limit, then 1001 maps to 0.
	src := bytes.NewReader([]byte{0xff, 0xff, 0xff, 0xff, 0, 0, 0x03, 0xe9})
	r = New(nil, WithRand(src))
	if got, _, _ := r.Resolve("{{$randomInt}}"); got != "0" {
		t.Fatalf("got %q", got)
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("boom") }

type constReader struct{ b byte }

func (c constReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = c.b
	}
	return len(p), nil
}

func TestDynamicRandomErrors(t *testing.T) {
	for _, in := range []string{"{{$guid}}", "{{$randomInt}}"} {
		if _, _, err := Resolve(in, nil, WithRand(errReader{})); err == nil || !strings.Contains(err.Error(), "boom") {
			t.Fatalf("%s: err = %v", in, err)
		}
	}
	if _, _, err := Resolve("{{$randomInt}}", nil, WithRand(constReader{0xff})); err == nil {
		t.Fatal("expected error for a source that never yields an accepted value")
	}
}

func TestLookup(t *testing.T) {
	r := New([]Scope{
		scope(ScopeGlobal, v("a", "1")),
		scope(ScopeEnvironment, model.Variable{Key: "a", Value: "2", Enabled: true, Secret: true}, model.Variable{Key: "", Value: "x", Enabled: true}),
	})
	m, ok := r.Lookup("a")
	want := Match{Name: "a", Value: "2", Secret: true, Scope: ScopeEnvironment, ScopeID: "environment-id", ScopeName: "environment name"}
	if !ok || m != want {
		t.Fatalf("Lookup = %+v %v", m, ok)
	}
	if _, ok := r.Lookup(""); ok {
		t.Fatal("empty key must not be defined")
	}
}

func TestDynamicNames(t *testing.T) {
	for _, n := range DynamicNames() {
		if !IsDynamic(n) {
			t.Fatalf("%s not dynamic", n)
		}
	}
	if IsDynamic("guid") {
		t.Fatal("names need the $ prefix")
	}
}

func TestUnsetSecretShadowsLowerScopes(t *testing.T) {
	scopes := []Scope{
		{Kind: ScopeGlobal, ID: "G", Variables: []model.Variable{{Key: "token", Value: "global", Enabled: true}, {Key: "ref", Value: "{{token}}", Enabled: true}}},
		{Kind: ScopeEnvironment, ID: "E", Name: "Dev", Unset: []string{"token", ""}},
	}
	r := New(scopes)
	for _, in := range []string{"{{token}}", "{{ref}}"} {
		out, unresolved, err := r.Resolve(in)
		if err != nil || out != in && out != "{{token}}" || len(unresolved) != 1 || unresolved[0] != "token" {
			t.Fatalf("%s -> %q %v %v", in, out, unresolved, err)
		}
	}
	m, ok := r.Lookup("token")
	if !ok || !m.Unset || !m.Secret || m.ScopeID != "E" || m.Value != "" {
		t.Fatalf("lookup = %+v %v", m, ok)
	}
	// A higher scope with a value wins over an unset secret below it.
	r = New(append(scopes, Scope{Kind: ScopeLocal, Variables: []model.Variable{{Key: "token", Value: "local", Enabled: true}}}))
	if out, _, _ := r.Resolve("{{token}}"); out != "local" {
		t.Fatalf("local = %q", out)
	}
}
