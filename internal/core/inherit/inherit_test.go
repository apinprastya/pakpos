package inherit

import (
	"reflect"
	"testing"

	"pakpos/internal/core/model"
)

func h(k, v string) model.KeyValue   { return model.KeyValue{Key: k, Value: v, Enabled: true} }
func off(k, v string) model.KeyValue { return model.KeyValue{Key: k, Value: v} }
func bearer(tok string) model.Auth   { return model.Auth{Type: model.AuthBearer, Token: tok} }
func inheritAuth() model.Auth        { return model.Auth{Type: model.AuthInherit} }
func col(a model.Auth, hs ...model.KeyValue) Level {
	return Level{Kind: KindCollection, ID: "C", Name: "Users", Auth: a, Headers: hs}
}
func folder(id string, a model.Auth, hs ...model.KeyValue) Level {
	return Level{Kind: KindFolder, ID: id, Name: "Folder " + id, Auth: a, Headers: hs}
}

var (
	srcC  = Source{Kind: KindCollection, ID: "C", Name: "Users"}
	srcF1 = Source{Kind: KindFolder, ID: "F1", Name: "Folder F1"}
	srcF2 = Source{Kind: KindFolder, ID: "F2", Name: "Folder F2"}
)

func TestEffectiveAuth(t *testing.T) {
	tests := []struct {
		name     string
		chain    []Level
		reqAuth  model.Auth
		want     model.Auth
		wantFrom *Source
	}{
		{"own auth wins", []Level{col(bearer("c"))}, bearer("r"), bearer("r"), nil},
		{"own none is kept", []Level{col(bearer("c"))}, model.Auth{Type: model.AuthNone}, model.Auth{Type: model.AuthNone}, nil},
		{"empty type is not inherit", []Level{col(bearer("c"))}, model.Auth{}, model.Auth{}, nil},
		{"from collection", []Level{col(bearer("c"))}, inheritAuth(), bearer("c"), &srcC},
		{"nearest folder wins", []Level{col(bearer("c")), folder("F1", bearer("f1")), folder("F2", bearer("f2"))}, inheritAuth(), bearer("f2"), &srcF2},
		{"walks past inheriting folders", []Level{col(bearer("c")), folder("F1", bearer("f1")), folder("F2", inheritAuth())}, inheritAuth(), bearer("f1"), &srcF1},
		{"empty folder type means inherit", []Level{col(bearer("c")), folder("F1", model.Auth{})}, inheritAuth(), bearer("c"), &srcC},
		{"folder none stops the walk", []Level{col(bearer("c")), folder("F1", model.Auth{Type: model.AuthNone})}, inheritAuth(), model.Auth{Type: model.AuthNone}, &srcF1},
		{"nothing to inherit", []Level{col(inheritAuth()), folder("F1", model.Auth{})}, inheritAuth(), model.Auth{Type: model.AuthNone}, nil},
		{"no chain (draft)", nil, inheritAuth(), model.Auth{Type: model.AuthNone}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := Effective(tt.chain, model.Request{Auth: tt.reqAuth})
			if res.Request.Auth != tt.want {
				t.Errorf("auth = %+v, want %+v", res.Request.Auth, tt.want)
			}
			if !reflect.DeepEqual(res.AuthSource, tt.wantFrom) {
				t.Errorf("source = %+v, want %+v", res.AuthSource, tt.wantFrom)
			}
		})
	}
}

func TestEffectiveHeaders(t *testing.T) {
	tests := []struct {
		name        string
		chain       []Level
		req         []model.KeyValue
		wantHeaders []model.KeyValue
		wantApplied []Header
	}{
		{
			name:        "nothing anywhere",
			wantHeaders: nil,
			wantApplied: []Header{},
		},
		{
			name:        "order collection, folders, request",
			chain:       []Level{col(model.Auth{}, h("A", "c")), folder("F1", model.Auth{}, h("B", "f1")), folder("F2", model.Auth{}, h("C", "f2"))},
			req:         []model.KeyValue{h("D", "r")},
			wantHeaders: []model.KeyValue{h("A", "c"), h("B", "f1"), h("C", "f2"), h("D", "r")},
			wantApplied: []Header{{"A", "c", srcC}, {"B", "f1", srcF1}, {"C", "f2", srcF2}},
		},
		{
			name:        "request replaces case-insensitively",
			chain:       []Level{col(model.Auth{}, h("Accept", "c"), h("X-Keep", "k"))},
			req:         []model.KeyValue{h("accept", "r")},
			wantHeaders: []model.KeyValue{h("X-Keep", "k"), h("accept", "r")},
			wantApplied: []Header{{"X-Keep", "k", srcC}},
		},
		{
			name:        "deeper folder replaces collection",
			chain:       []Level{col(model.Auth{}, h("X-Env", "c"), h("x-env", "c2")), folder("F1", model.Auth{}, h(" X-ENV ", "f1"))},
			wantHeaders: []model.KeyValue{h(" X-ENV ", "f1")},
			wantApplied: []Header{{" X-ENV ", "f1", srcF1}},
		},
		{
			name:        "disabled request row does not hide",
			chain:       []Level{col(model.Auth{}, h("Accept", "c"))},
			req:         []model.KeyValue{off("Accept", "r")},
			wantHeaders: []model.KeyValue{h("Accept", "c"), off("Accept", "r")},
			wantApplied: []Header{{"Accept", "c", srcC}},
		},
		{
			name:        "disabled folder row does not hide and is not applied",
			chain:       []Level{col(model.Auth{}, h("Accept", "c")), folder("F1", model.Auth{}, off("Accept", "f1"), off("Other", "x"))},
			wantHeaders: []model.KeyValue{h("Accept", "c")},
			wantApplied: []Header{{"Accept", "c", srcC}},
		},
		{
			name:        "same name repeated at one level is kept",
			chain:       []Level{col(model.Auth{}, h("Cookie", "a=1"), h("Cookie", "b=2"), h("", "blank key skipped"))},
			wantHeaders: []model.KeyValue{h("Cookie", "a=1"), h("Cookie", "b=2")},
			wantApplied: []Header{{"Cookie", "a=1", srcC}, {"Cookie", "b=2", srcC}},
		},
		{
			name:        "blank request key does not hide",
			chain:       []Level{col(model.Auth{}, h("A", "c"))},
			req:         []model.KeyValue{h(" ", "x")},
			wantHeaders: []model.KeyValue{h("A", "c"), h(" ", "x")},
			wantApplied: []Header{{"A", "c", srcC}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := model.Request{Headers: tt.req}
			res := Effective(tt.chain, req)
			if !reflect.DeepEqual(res.Request.Headers, tt.wantHeaders) {
				t.Errorf("headers = %+v\nwant %+v", res.Request.Headers, tt.wantHeaders)
			}
			if !reflect.DeepEqual(res.Headers, tt.wantApplied) {
				t.Errorf("applied = %+v\nwant %+v", res.Headers, tt.wantApplied)
			}
		})
	}
}

func TestEffectiveDoesNotMutateInput(t *testing.T) {
	req := model.Request{Auth: inheritAuth(), Headers: make([]model.KeyValue, 1, 8)}
	req.Headers[0] = h("R", "1")
	chain := []Level{col(bearer("c"), h("A", "c"))}
	res := Effective(chain, req)
	if req.Auth.Type != model.AuthInherit || len(req.Headers) != 1 || req.Headers[:2][1] != (model.KeyValue{}) {
		t.Fatalf("input mutated: %+v", req)
	}
	res.Request.Headers[0].Value = "changed"
	if chain[0].Headers[0].Value != "c" {
		t.Fatal("result shares the chain's header rows")
	}
}
