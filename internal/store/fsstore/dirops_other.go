//go:build !windows

package fsstore

// isTransientFSError reports errors worth retrying. Only Windows refuses to
// rename or delete a directory another process has open.
func isTransientFSError(error) bool { return false }
