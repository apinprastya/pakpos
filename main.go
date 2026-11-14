package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"

	"pakpos/internal/secrets"
	"pakpos/internal/service"
	"pakpos/internal/update"
)

//go:embed all:frontend/dist
var assets embed.FS

func init() {
	// Registering events lets the binding generator emit typed TS for them.
	application.RegisterEvent[service.WorkspaceChangedEvent](service.EventWorkspaceChanged)
	application.RegisterEvent[service.UpdateProgress](service.EventUpdateProgress)
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
	control := &wailsApp{}
	// Secret values go to the OS keychain when it works (probed once), else to
	// the encrypted file <data>/secrets.enc unlocked with a master password.
	store := secrets.Select(secrets.NewKeyring(), secrets.NewFileStore(dataDir))
	core, err := service.NewCore(service.Config{DataDir: dataDir, Dialogs: dialogs, Events: events, Secrets: store})
	if err != nil {
		log.Fatalf("start pakpos: %v", err)
	}

	// In-app updates come from GitHub Releases, verified with the compiled-in
	// update.PublicKey. Remove what a previous update left behind first.
	install := update.Current()
	install.Cleanup()
	updates := service.NewUpdateService(service.UpdateConfig{
		Updater: &update.Updater{PublicKey: update.PublicKey, Install: install},
		Events:  events,
		App:     control,
	})

	app := application.New(application.Options{
		Name:        "Pakpos",
		Description: "Desktop REST API client",
		Services: []application.Service{
			application.NewService(service.NewAppService()),
			application.NewService(service.NewWorkspaceService(core)),
			application.NewService(service.NewRequestService(core)),
			application.NewService(service.NewHistoryService(core)),
			application.NewService(service.NewSettingsService(core)),
			application.NewService(service.NewEnvService(core)),
			application.NewService(service.NewExampleService(core)),
			application.NewService(updates),
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
	dialogs.app, events.app, control.app = app, app, app

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
