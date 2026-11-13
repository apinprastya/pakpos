package service

import (
	"testing"

	"pakpos/internal/buildinfo"
)

func TestAppServiceBuildInfo(t *testing.T) {
	if got, want := NewAppService().BuildInfo(), buildinfo.Get(); got != want {
		t.Fatalf("BuildInfo() = %+v, want %+v", got, want)
	}
}
