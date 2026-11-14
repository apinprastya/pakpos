//go:build windows

package httpexec

import (
	"errors"
	"syscall"
)

// wsaeConnRefused is Winsock's WSAECONNREFUSED (10061). Windows reports a
// refused connection with it rather than the POSIX ECONNREFUSED value the
// syscall package defines, and syscall does not export a name for it.
const wsaeConnRefused = syscall.Errno(10061)

// isConnRefused reports whether err is a refused TCP connection.
func isConnRefused(err error) bool {
	return errors.Is(err, wsaeConnRefused) || errors.Is(err, syscall.ECONNREFUSED)
}
