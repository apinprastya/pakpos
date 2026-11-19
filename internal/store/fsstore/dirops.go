package fsstore

import (
	"os"
	"time"
)

// dirRetryLimit bounds how long renameDir and removeDirAll retry a
// transient failure.
var dirRetryLimit = 2 * time.Second

// renameDir renames a directory, retrying briefly while another handle
// holds it. On Windows a directory can't be renamed while anything has it
// open: the watcher listing it during a resync, antivirus or the search
// indexer. Those handles are short-lived, so a retry succeeds.
func renameDir(oldPath, newPath string) error {
	return retryTransient(func() error { return os.Rename(oldPath, newPath) }, isTransientFSError, dirRetryLimit)
}

// removeDirAll is os.RemoveAll with the same retry as renameDir.
func removeDirAll(path string) error {
	return retryTransient(func() error { return os.RemoveAll(path) }, isTransientFSError, dirRetryLimit)
}

// retryTransient runs op until it succeeds, fails with an error transient
// doesn't accept, or limit has passed, backing off up to 100 ms.
func retryTransient(op func() error, transient func(error) bool, limit time.Duration) error {
	deadline := time.Now().Add(limit)
	delay := time.Millisecond
	for {
		err := op()
		if err == nil || !transient(err) || !time.Now().Before(deadline) {
			return err
		}
		time.Sleep(delay)
		delay = min(2*delay, 100*time.Millisecond)
	}
}
