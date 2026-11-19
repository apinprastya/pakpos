package service

import (
	"strings"
	"time"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/store/sqlite"
)

// recordHistory stores a send in a workspace's history ("" for none) with
// the request as written (never the resolved copy) and applies retention.
// It returns the entry's id, or 0 when recording failed (logged).
func (c *Core) recordHistory(wsID, envName string, req model.Request, resp *model.Response, sendErr *httpexec.Error, started time.Time) int64 {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = "GET"
	}
	e := sqlite.HistoryEntry{
		HistorySummary: sqlite.HistorySummary{
			CreatedAt:       started,
			RequestID:       req.ID,
			RequestName:     req.Name,
			Method:          method,
			URL:             req.URL,
			EnvironmentName: envName,
		},
		Request:  req,
		Response: resp,
	}
	e.WorkspaceID = wsID
	if resp != nil {
		e.Status, e.DurationMs, e.Size = resp.StatusCode, resp.Timings.Total, resp.Size
	}
	if sendErr != nil {
		e.ErrorKind, e.ErrorMessage = string(sendErr.Kind), sendErr.Message
	}
	id, err := c.db.AddHistory(e)
	if err != nil {
		c.log.Warn("record history", "err", err)
		return 0
	}
	if keep := c.currentSettings().HistoryRetention; keep > 0 {
		// Retention is per workspace: only this send's group is trimmed.
		if _, err := c.db.PruneWorkspaceHistory(wsID, keep); err != nil {
			c.log.Warn("prune history", "err", err)
		}
	}
	return id
}
