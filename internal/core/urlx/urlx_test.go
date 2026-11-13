package urlx

import (
	"reflect"
	"testing"

	"pakpos/internal/core/model"
)

func kv(k, v string) model.KeyValue  { return model.KeyValue{Key: k, Value: v, Enabled: true} }
func off(k, v string) model.KeyValue { return model.KeyValue{Key: k, Value: v} }

func TestSplit(t *testing.T) {
	tests := []struct {
		raw, base, query, frag string
		hasQuery               bool
	}{
		{"https://a.com/x?y=1#top", "https://a.com/x", "y=1", "top", true},
		{"a.com/x?", "a.com/x", "", "", true},
		{"a.com#f?notquery", "a.com", "", "f?notquery", false},
		{"", "", "", "", false},
		{"?a=1", "", "a=1", "", true},
	}
	for _, tt := range tests {
		b, q, f, h := Split(tt.raw)
		if b != tt.base || q != tt.query || f != tt.frag || h != tt.hasQuery {
			t.Errorf("Split(%q) = %q,%q,%q,%v", tt.raw, b, q, f, h)
		}
	}
}

func TestParseQuery(t *testing.T) {
	tests := []struct {
		name  string
		query string
		want  []model.KeyValue
	}{
		{"empty", "", []model.KeyValue{}},
		{"order and duplicates", "b=2&a=1&b=3", []model.KeyValue{kv("b", "2"), kv("a", "1"), kv("b", "3")}},
		{"key only and empty parts", "flag&&x=", []model.KeyValue{kv("flag", ""), kv("x", "")}},
		{"decodes", "q=hello%20world&p=a+b&e=%E2%9C%93", []model.KeyValue{kv("q", "hello world"), kv("p", "a b"), kv("e", "✓")}},
		{"invalid escape kept", "bad=%zz&ok=1", []model.KeyValue{kv("bad", "%zz"), kv("ok", "1")}},
		{"value with equals", "t=a=b", []model.KeyValue{kv("t", "a=b")}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ParseQuery(tt.query); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("ParseQuery(%q) = %+v, want %+v", tt.query, got, tt.want)
			}
		})
	}
}

func TestBuildQuery(t *testing.T) {
	rows := []model.KeyValue{
		kv("q", "hello world"),
		off("hidden", "1"),
		kv("", ""),
		kv("flag", ""),
		kv("v", "{{token}}"),
		kv("amp", "a&b=c+d#e%"),
		kv("path", "/x:y@z"),
	}
	want := "q=hello%20world&flag&v={{token}}&amp=a%26b%3Dc%2Bd%23e%25&path=/x:y@z"
	if got := BuildQuery(rows); got != want {
		t.Errorf("BuildQuery() = %q, want %q", got, want)
	}
}

func TestQueryRoundTrip(t *testing.T) {
	rows := []model.KeyValue{kv("a b", "c&d"), kv("plus", "1+1"), kv("pct", "100%"), kv("uni", "✓")}
	if got := ParseQuery(BuildQuery(rows)); !reflect.DeepEqual(got, rows) {
		t.Errorf("round trip = %+v, want %+v", got, rows)
	}
}

func TestWithQuery(t *testing.T) {
	tests := []struct {
		raw  string
		rows []model.KeyValue
		want string
	}{
		{"https://a.com/x?old=1#frag", []model.KeyValue{kv("n", "2")}, "https://a.com/x?n=2#frag"},
		{"https://a.com/x?old=1", []model.KeyValue{off("n", "2")}, "https://a.com/x"},
		{"a.com", []model.KeyValue{kv("a", "1"), kv("b", "2")}, "a.com?a=1&b=2"},
		{"", nil, ""},
	}
	for _, tt := range tests {
		if got := WithQuery(tt.raw, tt.rows); got != tt.want {
			t.Errorf("WithQuery(%q) = %q, want %q", tt.raw, got, tt.want)
		}
	}
}

func TestMergeQueryKeepsDisabledRows(t *testing.T) {
	prev := []model.KeyValue{kv("a", "1"), off("debug", "true")}
	got := MergeQuery("https://x.dev/?a=2&b=3", prev)
	want := []model.KeyValue{kv("a", "2"), kv("b", "3"), off("debug", "true")}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("MergeQuery = %+v, want %+v", got, want)
	}
}

func TestEncodeWireQuery(t *testing.T) {
	rows := []model.KeyValue{kv("q", "a b"), kv("v", "{x}"), off("n", "1"), kv("", ""), kv("e", "")}
	if got, want := EncodeWireQuery(rows), "q=a%20b&v=%7Bx%7D&e="; got != want {
		t.Errorf("EncodeWireQuery = %q, want %q", got, want)
	}
}

func TestEnsureScheme(t *testing.T) {
	tests := map[string]string{
		"example.com":            "http://example.com",
		"  localhost:8080/a ":    "http://localhost:8080/a",
		"https://example.com":    "https://example.com",
		"ws+unix://sock":         "ws+unix://sock",
		"{{baseUrl}}/users":      "{{baseUrl}}/users",
		"":                       "",
		"1example.com://notreal": "http://1example.com://notreal",
	}
	for in, want := range tests {
		if got := EnsureScheme(in); got != want {
			t.Errorf("EnsureScheme(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPathParamNames(t *testing.T) {
	tests := []struct {
		raw  string
		want []string
	}{
		{"https://a.com:8443/users/:id/posts/:postId", []string{"id", "postId"}},
		{"localhost:8080/:a", []string{"a"}},
		{"localhost:8080", []string{}},
		{"https://a.com/x/:id/y/:id", []string{"id"}},
		{"https://a.com/:/:1bad/:ok_1-x?q=:notparam#:nofrag", []string{"ok_1-x"}},
		{"/:partial", []string{"partial"}},
		{"", []string{}},
	}
	for _, tt := range tests {
		if got := PathParamNames(tt.raw); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("PathParamNames(%q) = %v, want %v", tt.raw, got, tt.want)
		}
	}
}

func TestSyncPathParams(t *testing.T) {
	prev := []model.KeyValue{kv("id", "42"), kv("gone", "x")}
	got := SyncPathParams("a.com/users/:id/:slug", prev)
	want := []model.KeyValue{kv("id", "42"), kv("slug", "")}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("SyncPathParams = %+v, want %+v", got, want)
	}
}

func TestApplyPathParams(t *testing.T) {
	params := []model.KeyValue{kv("id", "a b/c"), kv("empty", ""), off("off", "x"), kv("port", "9")}
	tests := []struct{ raw, want string }{
		{"https://a.com:8080/u/:id/:empty/:off?x=:id#f", "https://a.com:8080/u/a%20b%2Fc/:empty/:off?x=:id#f"},
		{"https://a.com/u/:id?", "https://a.com/u/a%20b%2Fc?"},
		{"host:8080", "host:8080"},
	}
	for _, tt := range tests {
		if got := ApplyPathParams(tt.raw, params); got != tt.want {
			t.Errorf("ApplyPathParams(%q) = %q, want %q", tt.raw, got, tt.want)
		}
	}
	if got := ApplyPathParams("a.com/:id", nil); got != "a.com/:id" {
		t.Errorf("no params should be identity, got %q", got)
	}
}
