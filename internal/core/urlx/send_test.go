package urlx

import (
	"testing"

	"pakpos/internal/core/model"
)

func TestSendURL(t *testing.T) {
	tests := []struct {
		name string
		req  model.Request
		want string
	}{
		{"plain", model.Request{URL: "https://a.com/x"}, "https://a.com/x"},
		{"scheme added, url query ignored, fragment dropped",
			model.Request{URL: " a.com/x?old=1#frag ", Query: []model.KeyValue{kv("q", "a b"), off("off", "1")}},
			"http://a.com/x?q=a%20b"},
		{"path params", model.Request{URL: "https://a.com/users/:id/posts", PathParams: []model.KeyValue{kv("id", "a/b")}},
			"https://a.com/users/a%2Fb/posts"},
		{"references kept readable",
			model.Request{URL: "{{baseUrl}}/users/:id", PathParams: []model.KeyValue{kv("id", "{{userId}}")},
				Query: []model.KeyValue{kv("token", "{{$guid}}"), kv("x", "{{ spaced }}"), kv("t", "{{ns:key}}")}},
			"{{baseUrl}}/users/{{userId}}?token={{$guid}}&x=%7B%7B%20spaced%20%7D%7D&t={{ns:key}}"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SendURL(tt.req); got != tt.want {
				t.Errorf("SendURL = %q, want %q", got, tt.want)
			}
		})
	}
	if got := KeepReferences("%7b%7bbad%ZZ%7d%7d"); got != "%7b%7bbad%ZZ%7d%7d" {
		t.Errorf("invalid escape changed: %q", got)
	}
}
