package model

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestVariableYAML(t *testing.T) {
	tests := []struct {
		name     string
		in       Variable
		wantYAML string
		back     Variable
	}{
		{
			name:     "plain",
			in:       Variable{Key: "host", Value: "example.com", Enabled: true},
			wantYAML: "key: host\nvalue: example.com\nenabled: true\n",
			back:     Variable{Key: "host", Value: "example.com", Enabled: true},
		},
		{
			name:     "secret value omitted",
			in:       Variable{Key: "token", Value: "s3cret", Enabled: true, Secret: true},
			wantYAML: "key: token\nenabled: true\nsecret: true\n",
			back:     Variable{Key: "token", Enabled: true, Secret: true},
		},
		{
			name:     "disabled empty",
			in:       Variable{Key: "x"},
			wantYAML: "key: x\nenabled: false\n",
			back:     Variable{Key: "x"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, err := yaml.Marshal(tt.in)
			if err != nil {
				t.Fatal(err)
			}
			if string(out) != tt.wantYAML {
				t.Fatalf("yaml = %q, want %q", out, tt.wantYAML)
			}
			var got Variable
			if err := yaml.Unmarshal(out, &got); err != nil {
				t.Fatal(err)
			}
			if got != tt.back {
				t.Fatalf("round trip = %+v, want %+v", got, tt.back)
			}
		})
	}
}

func TestVariableUnmarshal(t *testing.T) {
	tests := []struct {
		name    string
		src     string
		want    Variable
		wantErr bool
	}{
		{"v1 key/value row", "key: a\nvalue: b\nenabled: true\n", Variable{Key: "a", Value: "b", Enabled: true}, false},
		{"hand-edited secret value dropped", "key: a\nvalue: leaked\nsecret: true\n", Variable{Key: "a", Secret: true}, false},
		{"invalid", "key: [\n", Variable{}, true},
		{"wrong shape", "- a\n", Variable{}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got Variable
			err := yaml.Unmarshal([]byte(tt.src), &got)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestVariableInStructNeverWritesSecret(t *testing.T) {
	type holder struct {
		Variables []Variable `yaml:"variables"`
	}
	out, err := yaml.Marshal(holder{Variables: []Variable{{Key: "k", Value: "hidden", Secret: true, Enabled: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "hidden") {
		t.Fatalf("secret leaked into YAML:\n%s", out)
	}
}
