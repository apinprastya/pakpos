// Package buildinfo exposes version metadata stamped at build time via -ldflags.
package buildinfo

import "runtime"

// Set with: -ldflags "-X pakpos/internal/buildinfo.Version=1.2.3 -X pakpos/internal/buildinfo.Commit=abc123"
var (
	Version = "dev"
	Commit  = ""
)

// Info describes the running build.
type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

// Get returns information about the current build.
func Get() Info {
	return Info{Version: Version, Commit: Commit, OS: runtime.GOOS, Arch: runtime.GOARCH}
}
