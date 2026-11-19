package fsstore

import (
	"errors"
	"syscall"
)

// errSharingViolation is ERROR_SHARING_VIOLATION ("being used by another
// process"), which the syscall package doesn't name.
const errSharingViolation = syscall.Errno(32)

// isTransientFSError reports the errors Windows returns while another handle
// holds a file or directory open.
func isTransientFSError(err error) bool {
	return errors.Is(err, syscall.ERROR_ACCESS_DENIED) || errors.Is(err, errSharingViolation)
}
