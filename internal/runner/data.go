package runner

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Data file limits.
const (
	// MaxDataBytes is the largest data file read.
	MaxDataBytes = 32 << 20
	// MaxDataRows is the most rows a data file may have (one iteration each).
	MaxDataRows = MaxIterations
)

// Data is a parsed data file: one row per iteration. Values are strings
// (JSON non-strings are stringified). The values are not secrets: they
// are shown and stored unmasked.
type Data struct {
	// Name is the file's base name (reports keep the name, never the path
	// or the contents).
	Name string `json:"name"`
	// Columns lists the column names in file order (for JSON, in the order
	// they first appear).
	Columns []string            `json:"columns"`
	Rows    []map[string]string `json:"rows"`
}

// DataError is a data file problem, written for the user.
type DataError struct {
	Message string
	Err     error
}

func (e *DataError) Error() string { return e.Message }
func (e *DataError) Unwrap() error { return e.Err }

func dataErr(err error, format string, args ...any) *DataError {
	return &DataError{Message: fmt.Sprintf(format, args...), Err: err}
}

// LoadData reads a CSV (with a header row) or JSON (an array of objects)
// data file. The format comes from the extension (.csv, .json); any other
// file is JSON when it starts with "[", CSV otherwise.
func LoadData(path string) (*Data, error) {
	f, err := os.Open(path) //nolint:gosec // the user picked this file to read
	if err != nil {
		return nil, dataErr(err, "Couldn't read the data file %q: %v", filepath.Base(path), unwrapPathError(err))
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, MaxDataBytes+1))
	if err != nil {
		return nil, dataErr(err, "Couldn't read the data file %q: %v", filepath.Base(path), unwrapPathError(err))
	}
	if len(raw) > MaxDataBytes {
		return nil, dataErr(nil, "The data file %q is larger than %d MiB.", filepath.Base(path), MaxDataBytes>>20)
	}
	var d *Data
	switch ext := strings.ToLower(filepath.Ext(path)); {
	case ext == ".json", ext != ".csv" && bytes.HasPrefix(bytes.TrimSpace(trimBOM(raw)), []byte("[")):
		d, err = ParseJSON(bytes.NewReader(raw))
	default:
		d, err = ParseCSV(bytes.NewReader(raw))
	}
	if err != nil {
		return nil, dataErr(err, "The data file %q can't be used: %v", filepath.Base(path), err)
	}
	d.Name = filepath.Base(path)
	return d, nil
}

func unwrapPathError(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

func trimBOM(b []byte) []byte { return bytes.TrimPrefix(b, []byte("\xEF\xBB\xBF")) }

// ParseCSV reads CSV with a header row. Every row must have as many fields
// as the header; header names must be unique and not blank.
func ParseCSV(r io.Reader) (*Data, error) {
	br := bufio.NewReader(r)
	if b, err := br.Peek(3); err == nil && bytes.Equal(b, []byte("\xEF\xBB\xBF")) {
		_, _ = br.Discard(3)
	}
	cr := csv.NewReader(br)
	header, err := cr.Read()
	if errors.Is(err, io.EOF) {
		return nil, errors.New("the file is empty; it needs a header row")
	}
	if err != nil {
		return nil, csvError(err)
	}
	seen := map[string]bool{}
	for i, h := range header {
		h = strings.TrimSpace(h)
		if h == "" {
			return nil, fmt.Errorf("column %d of the header row has no name", i+1)
		}
		if seen[h] {
			return nil, fmt.Errorf("the header row names %q twice", h)
		}
		seen[h] = true
		header[i] = h
	}
	d := &Data{Columns: header, Rows: []map[string]string{}}
	for {
		rec, err := cr.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, csvError(err)
		}
		if len(d.Rows) == MaxDataRows {
			return nil, fmt.Errorf("it has more than %d rows", MaxDataRows)
		}
		row := make(map[string]string, len(header))
		for i, h := range header {
			row[h] = rec[i]
		}
		d.Rows = append(d.Rows, row)
	}
	return d, nil
}

func csvError(err error) error {
	var pe *csv.ParseError
	if errors.As(err, &pe) {
		if errors.Is(pe.Err, csv.ErrFieldCount) {
			return fmt.Errorf("line %d has a different number of fields than the header row", pe.Line)
		}
		return fmt.Errorf("line %d: %v", pe.Line, pe.Err)
	}
	return err
}

// ParseJSON reads a JSON array of objects. Strings are kept as they are,
// null becomes "", and other values are written as JSON (numbers as
// written, true/false, objects and arrays compacted).
func ParseJSON(r io.Reader) (*Data, error) {
	dec := json.NewDecoder(r)
	dec.UseNumber()
	notArray := errors.New("it must be a JSON array of objects, like [{\"user\": \"ana\"}]")
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return nil, notArray
	}
	d := &Data{Columns: []string{}, Rows: []map[string]string{}}
	seen := map[string]bool{}
	for dec.More() {
		if len(d.Rows) == MaxDataRows {
			return nil, fmt.Errorf("it has more than %d rows", MaxDataRows)
		}
		if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
			return nil, fmt.Errorf("item %d isn't an object; the file must be a JSON array of objects", len(d.Rows)+1)
		}
		row := map[string]string{}
		for dec.More() {
			tok, err := dec.Token()
			if err != nil {
				return nil, fmt.Errorf("item %d: %v", len(d.Rows)+1, err)
			}
			key := tok.(string) // object keys are always strings
			var raw json.RawMessage
			if err := dec.Decode(&raw); err != nil {
				return nil, fmt.Errorf("item %d: %v", len(d.Rows)+1, err)
			}
			row[key] = jsonString(raw)
			if !seen[key] {
				seen[key] = true
				d.Columns = append(d.Columns, key)
			}
		}
		if _, err := dec.Token(); err != nil {
			return nil, fmt.Errorf("item %d: %v", len(d.Rows)+1, err)
		}
		d.Rows = append(d.Rows, row)
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim(']') {
		return nil, fmt.Errorf("the array isn't closed: %v", err)
	}
	return d, nil
}

func jsonString(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	switch {
	case len(raw) > 0 && raw[0] == '"':
		var s string
		_ = json.Unmarshal(raw, &s) // the decoder already validated it
		return s
	case string(raw) == "null":
		return ""
	case len(raw) > 0 && (raw[0] == '{' || raw[0] == '['):
		var buf bytes.Buffer
		_ = json.Compact(&buf, raw)
		return buf.String()
	default:
		return string(raw)
	}
}

// DataPreview is what the runner tab shows for a chosen data file.
type DataPreview struct {
	Name    string     `json:"name"`
	Rows    int        `json:"rows"`
	Columns []string   `json:"columns"`
	Sample  [][]string `json:"sample"`
}

// PreviewRows is how many rows a DataPreview samples.
const PreviewRows = 5

// Preview summarizes d: its row count, columns and the first rows.
func (d *Data) Preview() DataPreview {
	p := DataPreview{Name: d.Name, Rows: len(d.Rows), Columns: d.Columns, Sample: [][]string{}}
	for _, row := range d.Rows[:min(len(d.Rows), PreviewRows)] {
		vals := make([]string, len(d.Columns))
		for i, c := range d.Columns {
			vals[i] = row[c]
		}
		p.Sample = append(p.Sample, vals)
	}
	return p
}
