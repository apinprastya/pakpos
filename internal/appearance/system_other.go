//go:build !linux && !windows && !darwin

package appearance

// SystemDark is false where the OS preference isn't known.
func SystemDark() bool { return false }
