package runner

// Summary is a run's totals.
type Summary struct {
	// Iterations is how many iterations finished or started.
	Iterations int `json:"iterations"`
	// Requests counts every result (sent, failed to send or skipped).
	Requests     int     `json:"requests"`
	Errors       int     `json:"errors"`
	Skipped      int     `json:"skipped"`
	TestsPassed  int     `json:"testsPassed"`
	TestsFailed  int     `json:"testsFailed"`
	TestsSkipped int     `json:"testsSkipped"`
	DurationMs   float64 `json:"durationMs"`
	// AvgResponseMs is the mean response time of the results with a response.
	AvgResponseMs float64        `json:"avgResponseMs"`
	PerRequest    []RequestStats `json:"perRequest"`
	// Failures lists request errors and failed tests in run order, at
	// most MaxFailures; FailuresTotal counts them all.
	Failures      []Failure `json:"failures"`
	FailuresTotal int       `json:"failuresTotal"`
	// SecretsLocked is true when a send couldn't read or write a secret
	// because the secret store was locked.
	SecretsLocked bool `json:"secretsLocked"`
}

// RequestStats aggregates one request across iterations.
type RequestStats struct {
	RequestID   string  `json:"requestId"`
	Name        string  `json:"name"`
	Method      string  `json:"method"`
	Runs        int     `json:"runs"`
	Errors      int     `json:"errors"`
	Skipped     int     `json:"skipped"`
	TestsPassed int     `json:"testsPassed"`
	TestsFailed int     `json:"testsFailed"`
	AvgMs       float64 `json:"avgMs"`
	MinMs       float64 `json:"minMs"`
	MaxMs       float64 `json:"maxMs"`
}

// Failure is a request error (Test empty) or a failed test.
type Failure struct {
	Iteration int    `json:"iteration"`
	RequestID string `json:"requestId"`
	Name      string `json:"name"`
	Test      string `json:"test"`
	Message   string `json:"message"`
}

// Summarize computes the summary of a run's results.
func Summarize(run Report) Summary {
	s := Summary{PerRequest: []RequestStats{}, Failures: []Failure{}}
	if !run.FinishedAt.IsZero() {
		s.DurationMs = float64(run.FinishedAt.Sub(run.StartedAt).Microseconds()) / 1000
	}
	stats := make([]RequestStats, len(run.Requests))
	timed := make([]int, len(run.Requests))
	for i, r := range run.Requests {
		stats[i] = RequestStats{RequestID: r.ID, Name: r.Name, Method: r.Method}
	}
	var total float64
	var responses int
	fail := func(f Failure) {
		s.FailuresTotal++
		if len(s.Failures) < MaxFailures {
			s.Failures = append(s.Failures, f)
		}
	}
	for _, res := range run.Results {
		s.Requests++
		s.Iterations = max(s.Iterations, res.Iteration+1)
		s.SecretsLocked = s.SecretsLocked || res.SecretsLocked
		passed, failed, skipped := res.TestCounts()
		s.TestsPassed += passed
		s.TestsFailed += failed
		s.TestsSkipped += skipped
		var st *RequestStats
		if res.Index >= 0 && res.Index < len(stats) {
			st = &stats[res.Index]
		} else {
			st = &RequestStats{} // a result from another order; counted in totals only
		}
		st.Runs++
		st.TestsPassed += passed
		st.TestsFailed += failed
		switch {
		case res.Skipped:
			s.Skipped++
			st.Skipped++
		case res.Error != nil:
			s.Errors++
			st.Errors++
			fail(Failure{Iteration: res.Iteration, RequestID: res.RequestID, Name: res.Name, Message: res.Error.Message})
		}
		if res.Status != 0 {
			responses++
			total += res.DurationMs
			if res.Index >= 0 && res.Index < len(stats) {
				n := timed[res.Index]
				if n == 0 || res.DurationMs < st.MinMs {
					st.MinMs = res.DurationMs
				}
				st.MaxMs = max(st.MaxMs, res.DurationMs)
				st.AvgMs = (st.AvgMs*float64(n) + res.DurationMs) / float64(n+1)
				timed[res.Index] = n + 1
			}
		}
		for _, t := range res.Tests {
			if !t.Passed && !t.Skipped {
				fail(Failure{Iteration: res.Iteration, RequestID: res.RequestID, Name: res.Name, Test: t.Name, Message: t.Error})
			}
		}
	}
	if responses > 0 {
		s.AvgResponseMs = total / float64(responses)
	}
	if run.Outcome == OutcomePassed || run.Outcome == OutcomeFailed {
		s.Iterations = max(s.Iterations, run.Iterations)
	}
	s.PerRequest = stats
	return s
}
