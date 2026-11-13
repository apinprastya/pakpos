package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"

	"pakpos/internal/service"
)

//go:embed all:frontend/dist
var assets embed.FS

func init() {
	// Registering events lets the binding generator emit typed TS for them.
	application.RegisterEvent[service.WorkspaceChangedEvent](service.EventWorkspaceChanged)
}

func main() {
	dataDir, err := service.DefaultDataDir()
	if err != nil {
		log.Fatal(err)
	}

	// The app is needed by the dialog/event adapters and the core is needed by
	// the services, so the adapters hold a pointer filled in after New.
	dialogs := &wailsDialogs{}
	events := &wailsEvents{}
	core, err := service.NewCore(service.Config{DataDir: dataDir, Dialogs: dialogs, Events: events})
	if err != nil {
		log.Fatalf("start pakpos: %v", err)
	}

	app := application.New(application.Options{
		Name:        "Pakpos",
		Description: "Desktop REST API client",
		Services: []application.Service{
			application.NewService(service.NewAppService()),
			application.NewService(service.NewWorkspaceService(core)),
			application.NewService(service.NewRequestService(core)),
			application.NewService(service.NewHistoryService(core)),
			application.NewService(service.NewSettingsService(core)),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		OnShutdown: func() {
			if err := core.Close(); err != nil {
				log.Printf("close: %v", err)
			}
		},
	})
	dialogs.app, events.app = app, app

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Pakpos",
		Width:     1280,
		Height:    800,
		MinWidth:  900,
		MinHeight: 560,
		// Matches the light theme background to avoid a flash before the UI paints.
		BackgroundColour: application.NewRGB(247, 248, 250),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
