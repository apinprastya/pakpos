package service

import (
	"errors"
	"time"

	"pakpos/internal/pipeline"
	"pakpos/internal/store/fsstore"
)

// Messages for the user (the frontend shows them as they are).
const (
	msgExampleTooLarge   = "Response bodies over 1 MB can't be saved as examples."
	msgExampleNoResponse = "This send has no response to save as an example."
	// The body isn't text, so a secret in it can't be replaced with {{name}}.
	msgExampleBinarySecret = "The response body isn't text, so the secret in it can't be replaced with a {{variable}}. The example wasn't saved."
)

// userError is an error whose text is written for the user; it unwraps to
// the underlying error.
type userError struct {
	msg string
	err error
}

func (e *userError) Error() string { return e.msg }
func (e *userError) Unwrap() error { return e.err }

var errExampleTooLarge = &userError{msg: msgExampleTooLarge, err: fsstore.ErrExampleTooLarge}

// ExampleService manages a request's saved response examples (the
// <request>.examples.yaml sidecar).
type ExampleService struct {
	c   *Core
	now func() time.Time
}

// NewExampleService creates the service.
func NewExampleService(c *Core) *ExampleService { return &ExampleService{c: c, now: time.Now} }

// List returns a request's examples in saved order. Never nil.
func (s *ExampleService) List(requestID string) ([]fsstore.ExampleSummary, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return nil, err
	}
	return ws.ListExamples(requestID)
}

// ListAll returns the examples of every request in the open workspace (for
// search). Never nil.
func (s *ExampleService) ListAll() ([]fsstore.ExampleSummary, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return nil, err
	}
	return ws.AllExamples(), nil
}

// Get returns one example with its request and response.
func (s *ExampleService) Get(requestID, id string) (fsstore.Example, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Example{}, err
	}
	return ws.GetExample(requestID, id)
}

// SaveExampleResult is what Save did. Example is nil when nothing was
// saved: SecretsFound then names the secrets whose values are in the
// example (never the values), or SecretsLocked says the check couldn't run.
type SaveExampleResult struct {
	Example *fsstore.ExampleSummary `json:"example"`
	// SecretsFound is never nil.
	SecretsFound  []string `json:"secretsFound"`
	SecretsLocked bool     `json:"secretsLocked"`
}

// Save saves the response of a history entry as a new example of a saved
// request. The example keeps the request as it was written for that send
// (history never holds resolved values) and the response as received, minus
// its final URL, cookies and timings. A body over 1 MB (or one that was
// truncated at 10 MB) is refused.
//
// A response can still echo a secret (e.g. a server returning the
// Authorization header), so before writing, the example is checked for the
// value of every secret visible to the request (globals, its collection,
// the selected environment). If one is found nothing is saved and the
// result lists the names; with replaceSecrets each value is replaced by
// {{name}} and the example is saved. A locked secret store can't be
// checked: nothing is saved and SecretsLocked is set (unlock, then retry).
func (s *ExampleService) Save(requestID, name string, historyID int64, replaceSecrets bool) (SaveExampleResult, error) {
	res := SaveExampleResult{SecretsFound: []string{}}
	ws, sess, err := s.c.openSession()
	if err != nil {
		return res, err
	}
	e, err := s.c.db.GetHistory(historyID)
	if err != nil {
		return res, err
	}
	if e.Response == nil {
		return res, &userError{msg: msgExampleNoResponse}
	}
	if e.Response.Truncated || e.Response.Size > fsstore.MaxExampleBody {
		return res, errExampleTooLarge
	}
	ex := fsstore.Example{
		Name:     name,
		SavedAt:  s.now(),
		Request:  e.Request,
		Response: fsstore.ExampleResponseFrom(*e.Response),
	}
	values, locked := sess.ExampleSecrets(requestID, s.c.selectedEnvironment(ws.Manifest().ID), e.Request)
	if locked {
		res.SecretsLocked = true
		return res, nil
	}
	if found := pipeline.ScanExample(ex, values); len(found) > 0 {
		if !replaceSecrets {
			res.SecretsFound = found
			return res, nil
		}
		if ex, err = pipeline.MaskExample(ex, values); err != nil {
			return res, &userError{msg: msgExampleBinarySecret, err: err}
		}
	}
	sum, err := ws.AddExample(requestID, ex)
	if errors.Is(err, fsstore.ErrExampleTooLarge) {
		return res, errExampleTooLarge
	}
	if err != nil {
		return res, err
	}
	res.Example = &sum
	return res, nil
}

// Rename changes an example's name.
func (s *ExampleService) Rename(requestID, id, name string) (fsstore.ExampleSummary, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.ExampleSummary{}, err
	}
	return ws.RenameExample(requestID, id, name)
}

// Delete removes an example.
func (s *ExampleService) Delete(requestID, id string) error {
	ws, err := s.c.workspace()
	if err != nil {
		return err
	}
	return ws.DeleteExample(requestID, id)
}
