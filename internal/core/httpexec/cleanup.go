package httpexec

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SpillPrefix is the file name prefix of full response bodies written by spill.
const SpillPrefix = "pakpos-response-"

// CleanupSpills removes spilled response files in dir that were last modified
// more than olderThan ago. Files that history has taken ownership of have
// already been moved out of dir, so anything left is an orphan. It returns the
// number of files removed. A missing dir is not an error.
func CleanupSpills(dir string, olderThan time.Duration, now time.Time) (int, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), SpillPrefix) {
			continue
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) < olderThan {
			continue
		}
		if os.Remove(filepath.Join(dir, e.Name())) == nil {
			removed++
		}
	}
	return removed, nil
}
