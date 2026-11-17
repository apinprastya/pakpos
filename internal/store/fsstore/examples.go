package fsstore

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"pakpos/internal/core/model"
)

// MaxExampleBody is the largest response body (decoded) an example can hold.
const MaxExampleBody = 1 << 20 // 1 MB

// ErrExampleTooLarge is returned when a response body is over MaxExampleBody.
var ErrExampleTooLarge = errors.New("response bodies over 1 MB can't be saved as examples")

// ExampleResponse is the saved part of a response: what a mock server or a
// reader of the file needs. The final URL, cookies and timings are left out
// (the URL is resolved and may hold a secret from the query string).
type ExampleResponse struct {
	StatusCode  int                `json:"statusCode" yaml:"statusCode"`
	StatusText  string             `json:"statusText" yaml:"statusText"`
	Headers     []model.KeyValue   `json:"headers" yaml:"headers"`
	ContentType string             `json:"contentType" yaml:"contentType"`
	Kind        model.BodyKind     `json:"kind" yaml:"kind"`
	Body        string             `json:"body" yaml:"body"`
	Encoding    model.BodyEncoding `json:"encoding" yaml:"encoding"`
	Size        int64              `json:"size" yaml:"size"`
}

// ExampleResponseFrom copies the saved fields of a response. A base64 body
// stays base64.
func ExampleResponseFrom(r model.Response) ExampleResponse {
	return ExampleResponse{
		StatusCode:  r.StatusCode,
		StatusText:  r.StatusText,
		Headers:     append([]model.KeyValue{}, r.Headers...),
		ContentType: r.ContentType,
		Kind:        r.Kind,
		Body:        r.Body,
		Encoding:    r.Encoding,
		Size:        r.Size,
	}
}

// Example is a saved response of a request. Request is the request as
// written when it was sent ({{variables}} unresolved, like history), so no
// secret value is ever stored.
type Example struct {
	ID       string          `json:"id" yaml:"id"`
	Name     string          `json:"name" yaml:"name"`
	SavedAt  time.Time       `json:"savedAt" yaml:"savedAt"`
	Request  model.Request   `json:"request" yaml:"request"`
	Response ExampleResponse `json:"response" yaml:"response"`
}

// ExampleSummary is what lists of examples show.
type ExampleSummary struct {
	ID         string    `json:"id"`
	RequestID  string    `json:"requestId"`
	Name       string    `json:"name"`
	SavedAt    time.Time `json:"savedAt"`
	StatusCode int       `json:"statusCode"`
	StatusText string    `json:"statusText"`
}

// examplesFile is the content of a request's sidecar, <request-file
// stem>.examples.yaml, next to the request file.
type examplesFile struct {
	RequestID string    `yaml:"requestId"`
	Examples  []Example `yaml:"examples"`
}

func summarizeExamples(requestID string, list []Example) []ExampleSummary {
	out := make([]ExampleSummary, 0, len(list))
	for _, e := range list {
		out = append(out, ExampleSummary{
			ID: e.ID, RequestID: requestID, Name: e.Name, SavedAt: e.SavedAt,
			StatusCode: e.Response.StatusCode, StatusText: e.Response.StatusText,
		})
	}
	return out
}

// isExamplesFile reports whether name is a request's examples sidecar.
func isExamplesFile(name string) bool {
	return strings.HasSuffix(strings.ToLower(name), ExamplesSuffix)
}

// examplesName returns the sidecar file name for a request file name.
func examplesName(requestFile string) string {
	return strings.TrimSuffix(requestFile, filepath.Ext(requestFile)) + ExamplesSuffix
}

// examplesPath returns the sidecar path next to a request file path.
func examplesPath(requestPath string) string {
	return filepath.Join(filepath.Dir(requestPath), examplesName(filepath.Base(requestPath)))
}

// uniqueRequestFile returns a request file name for stem in dir that is not
// taken, and whose examples sidecar name isn't taken either (a leftover
// sidecar must not attach itself to a new request).
func uniqueRequestFile(dir, stem string) string {
	taken := map[string]bool{}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			taken[strings.ToLower(e.Name())] = true
		}
	}
	name := stem
	for i := 2; taken[name+".yaml"] || taken[name+ExamplesSuffix]; i++ {
		name = fmt.Sprintf("%s-%d", stem, i)
	}
	return name + ".yaml"
}

// loadExamples checks the sidecars found in one directory during Reload.
// byFile maps the lower-cased sidecar name each request in the directory
// would have to the request id. A sidecar that can't be read, has no request
// file next to it, or names another request is reported, not loaded.
func loadExamples(sc *scan, dirPath string, sidecars []string, byFile map[string]string) {
	for _, name := range sidecars {
		p := filepath.Join(dirPath, name)
		reqID, ok := byFile[strings.ToLower(name)]
		if !ok {
			sc.addProblem(p, "no request file next to it; its examples are not loaded")
			continue
		}
		f, err := readExamplesFile(p)
		if err != nil {
			sc.addProblem(p, err.Error())
			continue
		}
		if f.RequestID != "" && f.RequestID != reqID {
			sc.addProblem(p, fmt.Sprintf("belongs to request %s, not %s; its examples are not loaded", f.RequestID, reqID))
			continue
		}
		if len(f.Examples) > 0 {
			sc.examples[reqID] = summarizeExamples(reqID, f.Examples)
		}
	}
}

func readExamplesFile(path string) (examplesFile, error) {
	var f examplesFile
	if err := readYAML(path, &f); err != nil {
		return examplesFile{}, err
	}
	for i := range f.Examples {
		if f.Examples[i].Response.Headers == nil {
			f.Examples[i].Response.Headers = []model.KeyValue{}
		}
	}
	return f, nil
}

// examplesLocked reads a request's sidecar for a change. A missing file
// means no examples; a broken one, or one naming another request, is an
// error, so a write never replaces examples the app couldn't read.
func (w *Workspace) examplesLocked(requestID string) (string, examplesFile, error) {
	reqPath, _, err := w.requestPath(requestID)
	if err != nil {
		return "", examplesFile{}, err
	}
	path := examplesPath(reqPath)
	f, err := readExamplesFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return path, examplesFile{RequestID: requestID}, nil
	}
	if err != nil {
		return "", examplesFile{}, fmt.Errorf("%s can't be read; fix or remove it first: %w", w.rel(path), err)
	}
	if f.RequestID != "" && f.RequestID != requestID {
		return "", examplesFile{}, fmt.Errorf("%s belongs to request %s; fix or remove it first", w.rel(path), f.RequestID)
	}
	f.RequestID = requestID
	return path, f, nil
}

// writeExamplesLocked writes the sidecar (removing it when no examples are
// left) and updates the index. Examples are v2 data, so this upgrades a v1
// manifest first.
func (w *Workspace) writeExamplesLocked(path string, f examplesFile) error {
	if len(f.Examples) == 0 {
		w.markWrite(path)
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove examples file: %w", err)
		}
		delete(w.examples, f.RequestID)
		return nil
	}
	if err := w.upgradeManifestLocked(VersionV2); err != nil {
		return err
	}
	if err := w.writeYAML(path, f); err != nil {
		return fmt.Errorf("save examples: %w", err)
	}
	w.examples[f.RequestID] = summarizeExamples(f.RequestID, f.Examples)
	return nil
}

// moveExamples renames the sidecar of the request file at from so it
// follows the request to to. Nothing happens when there is none.
func (w *Workspace) moveExamples(from, to string) error {
	src, dst := examplesPath(from), examplesPath(to)
	if src == dst {
		return nil
	}
	if _, err := os.Stat(src); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	w.markWrite(src)
	w.markWrite(dst)
	if err := os.Rename(src, dst); err != nil {
		return fmt.Errorf("move examples file: %w", err)
	}
	return nil
}

// exampleBodySize is the decoded size of an example's body.
func exampleBodySize(r ExampleResponse) int64 {
	n := int64(len(r.Body))
	if r.Encoding == model.EncodingBase64 {
		n = int64(base64.StdEncoding.DecodedLen(len(r.Body)))
	}
	return max(n, r.Size)
}

// ListExamples returns a request's examples in saved order.
func (w *Workspace) ListExamples(requestID string) ([]ExampleSummary, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.requests[requestID]; !ok {
		return nil, fmt.Errorf("request %s: %w", requestID, ErrNotFound)
	}
	return append([]ExampleSummary{}, w.examples[requestID]...), nil
}

// AllExamples returns the examples of every request (e.g. for search),
// grouped by request id.
func (w *Workspace) AllExamples() []ExampleSummary {
	w.mu.Lock()
	defer w.mu.Unlock()
	ids := make([]string, 0, len(w.examples))
	for id := range w.examples {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	out := []ExampleSummary{}
	for _, id := range ids {
		out = append(out, w.examples[id]...)
	}
	return out
}

// GetExample reads one example, with its request and response.
func (w *Workspace) GetExample(requestID, id string) (Example, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, f, err := w.examplesLocked(requestID)
	if err != nil {
		return Example{}, err
	}
	for _, e := range f.Examples {
		if e.ID == id {
			return e, nil
		}
	}
	return Example{}, fmt.Errorf("example %s: %w", id, ErrNotFound)
}

// AddExample saves ex as a new example of a request, at the end of its
// list. It gets a new id; an empty name becomes "Example" and a zero SavedAt
// the current time. A body over MaxExampleBody returns ErrExampleTooLarge.
func (w *Workspace) AddExample(requestID string, ex Example) (ExampleSummary, error) {
	if exampleBodySize(ex.Response) > MaxExampleBody {
		return ExampleSummary{}, ErrExampleTooLarge
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	path, f, err := w.examplesLocked(requestID)
	if err != nil {
		return ExampleSummary{}, err
	}
	ex.ID = model.NewID()
	ex.Name = cleanName(ex.Name, "Example")
	if ex.SavedAt.IsZero() {
		ex.SavedAt = time.Now()
	}
	ex.SavedAt = ex.SavedAt.UTC().Truncate(time.Second)
	if ex.Response.Headers == nil {
		ex.Response.Headers = []model.KeyValue{}
	}
	f.Examples = append(f.Examples, ex)
	if err := w.writeExamplesLocked(path, f); err != nil {
		return ExampleSummary{}, err
	}
	return summarizeExamples(requestID, []Example{ex})[0], nil
}

// RenameExample changes an example's name.
func (w *Workspace) RenameExample(requestID, id, name string) (ExampleSummary, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	path, f, err := w.examplesLocked(requestID)
	if err != nil {
		return ExampleSummary{}, err
	}
	i := slices.IndexFunc(f.Examples, func(e Example) bool { return e.ID == id })
	if i < 0 {
		return ExampleSummary{}, fmt.Errorf("example %s: %w", id, ErrNotFound)
	}
	f.Examples[i].Name = cleanName(name, "Example")
	if err := w.writeExamplesLocked(path, f); err != nil {
		return ExampleSummary{}, err
	}
	return summarizeExamples(requestID, f.Examples[i:i+1])[0], nil
}

// DeleteExample removes an example; the sidecar goes with the last one.
func (w *Workspace) DeleteExample(requestID, id string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	path, f, err := w.examplesLocked(requestID)
	if err != nil {
		return err
	}
	n := len(f.Examples)
	f.Examples = slices.DeleteFunc(f.Examples, func(e Example) bool { return e.ID == id })
	if len(f.Examples) == n {
		return fmt.Errorf("example %s: %w", id, ErrNotFound)
	}
	return w.writeExamplesLocked(path, f)
}

// copyExamplesLocked gives the request `to` copies of the examples of
// `from`, with new ids (used by DuplicateRequest). A source sidecar that
// can't be read is skipped; it is already listed in Problems.
func (w *Workspace) copyExamplesLocked(from, to string) error {
	_, src, err := w.examplesLocked(from)
	if err != nil || len(src.Examples) == 0 {
		return nil
	}
	path, dst, err := w.examplesLocked(to)
	if err != nil {
		return err
	}
	for _, e := range src.Examples {
		e.ID = model.NewID()
		dst.Examples = append(dst.Examples, e)
	}
	return w.writeExamplesLocked(path, dst)
}
