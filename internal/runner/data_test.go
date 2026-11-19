package runner

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeFile(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadData(t *testing.T) {
	cases := []struct {
		name, file, content string
		columns             []string
		rows                []map[string]string
		err                 string
	}{
		{
			name: "csv", file: "users.csv", content: "\xEF\xBB\xBFuser, pass\nana,\"a,1\"\nbo,b2\n",
			columns: []string{"user", "pass"},
			rows:    []map[string]string{{"user": "ana", "pass": "a,1"}, {"user": "bo", "pass": "b2"}},
		},
		{name: "csv header only", file: "h.csv", content: "a,b\n", columns: []string{"a", "b"}, rows: []map[string]string{}},
		{name: "csv empty", file: "e.csv", content: "", err: "empty; it needs a header row"},
		{name: "csv blank header", file: "b.csv", content: "a,,c\n1,2,3", err: "column 2 of the header row has no name"},
		{name: "csv duplicate header", file: "d.csv", content: "a,a\n1,2", err: `names "a" twice`},
		{name: "csv field count", file: "f.csv", content: "a,b\n1,2\n3\n", err: "line 3 has a different number of fields"},
		{name: "csv quote", file: "q.csv", content: "a\n\"x\"y\n", err: "line 2:"},
		{name: "csv bad header quote", file: "q2.csv", content: "\"a\"b\n", err: "line 1:"},
		{
			name: "json", file: "rows.json",
			content: `[{"user": "ana", "n": 1.50, "ok": true, "nil": null, "obj": {"a": [1, 2]}}, {"user": "bo", "extra": "x"}]`,
			columns: []string{"user", "n", "ok", "nil", "obj", "extra"},
			rows: []map[string]string{
				{"user": "ana", "n": "1.50", "ok": "true", "nil": "", "obj": `{"a":[1,2]}`},
				{"user": "bo", "extra": "x"},
			},
		},
		{name: "json sniffed", file: "rows.txt", content: "  [{\"a\": \"1\"}]", columns: []string{"a"}, rows: []map[string]string{{"a": "1"}}},
		{name: "csv sniffed", file: "rows.txt", content: "a\n1", columns: []string{"a"}, rows: []map[string]string{{"a": "1"}}},
		{name: "json not array", file: "o.json", content: `{"a": 1}`, err: "must be a JSON array of objects"},
		{name: "json item not object", file: "i.json", content: `[{"a": 1}, 2]`, err: "item 2 isn't an object"},
		{name: "json bad value", file: "v.json", content: `[{"a": tru}]`, err: "item 1"},
		{name: "json unclosed object", file: "u.json", content: `[{"a": 1`, err: "item 1"},
		{name: "json unclosed", file: "u2.json", content: `[{"a": 1}`, err: "isn't closed"},
		{name: "json bad key", file: "k.json", content: `[{1: 2}]`, err: "item 1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, err := LoadData(writeFile(t, tc.file, tc.content))
			if tc.err != "" {
				var de *DataError
				if !errors.As(err, &de) || !strings.Contains(err.Error(), tc.err) || !strings.Contains(err.Error(), tc.file) {
					t.Fatalf("err = %v, want %q", err, tc.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if d.Name != tc.file || !reflect.DeepEqual(d.Columns, tc.columns) || !reflect.DeepEqual(d.Rows, tc.rows) {
				t.Errorf("data = %+v", d)
			}
		})
	}
}

func TestLoadDataLimits(t *testing.T) {
	if _, err := LoadData(filepath.Join(t.TempDir(), "missing.csv")); err == nil || !strings.Contains(err.Error(), `Couldn't read the data file "missing.csv"`) {
		t.Errorf("missing: %v", err)
	}
	if _, err := LoadData(t.TempDir()); err == nil {
		t.Error("directory accepted")
	}
	big := writeFile(t, "big.csv", "a\n"+strings.Repeat("x", MaxDataBytes))
	if _, err := LoadData(big); err == nil || !strings.Contains(err.Error(), "larger than 32 MiB") {
		t.Errorf("big: %v", err)
	}
	many := writeFile(t, "many.csv", "a\n"+strings.Repeat("1\n", MaxDataRows+1))
	if _, err := LoadData(many); err == nil || !strings.Contains(err.Error(), "more than 10000 rows") {
		t.Errorf("many csv: %v", err)
	}
	manyJSON := writeFile(t, "many.json", "["+strings.TrimSuffix(strings.Repeat(`{"a":1},`, MaxDataRows+1), ",")+"]")
	if _, err := LoadData(manyJSON); err == nil || !strings.Contains(err.Error(), "more than 10000 rows") {
		t.Errorf("many json: %v", err)
	}
	if errors.Unwrap(&DataError{Err: os.ErrNotExist}) != os.ErrNotExist {
		t.Error("unwrap")
	}
}

func TestPreview(t *testing.T) {
	d := &Data{Name: "d.csv", Columns: []string{"a", "b"}}
	for i := range 7 {
		d.Rows = append(d.Rows, map[string]string{"a": strings.Repeat("x", i), "b": "y"})
	}
	p := d.Preview()
	if p.Name != "d.csv" || p.Rows != 7 || len(p.Sample) != PreviewRows || !reflect.DeepEqual(p.Sample[2], []string{"xx", "y"}) {
		t.Errorf("preview = %+v", p)
	}
}
