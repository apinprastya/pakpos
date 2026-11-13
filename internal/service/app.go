// Package service holds the thin Wails-bound adapters over the core packages.
package service

import "pakpos/internal/buildinfo"

// AppService exposes application-level information to the frontend.
type AppService struct{}

// NewAppService creates an AppService.
func NewAppService() *AppService { return &AppService{} }

// BuildInfo returns version and platform details of the running app.
func (s *AppService) BuildInfo() buildinfo.Info { return buildinfo.Get() }
