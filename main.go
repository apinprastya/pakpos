package main

import (
	"embed"
	"log"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"pakpos/internal/appearance"
	"pakpos/internal/secrets"
	"pakpos/internal/service"
	"pakpos/internal/update"
	"pakpos/internal/windowstate"
)

//go:embed all:frontend/dist
var assets embed.FS

func init() {
	// Registering events lets the binding generator emit typed TS for them.
	application.RegisterEvent[service.WorkspaceChangedEvent](service.EventWorkspaceChanged)
	application.RegisterEvent[service.UpdateProgress](service.EventUpdateProgress)
	application.RegisterEvent[service.ScriptConsoleEvent](service.EventScriptConsole)
	application.RegisterEvent[service.RunnerProgressEvent](service.EventRunnerProgress)
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

	// The window opens with the size and state it had when it was last closed.
	windowLimits := windowstate.Limits{MinWidth: 900, MinHeight: 560, DefaultWidth: 1280, DefaultHeight: 800}
	savedWindow := windowstate.Load(core.WindowStateStore(), windowLimits)
	windowTracker := windowstate.NewTracker(core.WindowStateStore(), savedWindow, 500*time.Millisecond, nil)

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
			application.NewService(service.NewUIStateService(core)),
			application.NewService(service.NewCookieService(core)),
			application.NewService(service.NewRunnerService(core)),
			application.NewService(updates),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		OnShutdown: func() {
			// Normally saved on close already; this covers quitting without one.
			if err := windowTracker.Flush(); err != nil {
				log.Printf("save window state: %v", err)
			}
			if err := core.Close(); err != nil {
				log.Printf("close: %v", err)
			}
		},
	})
	dialogs.app, events.app, control.app = app, app, app

	// The window starts in the saved theme's background colour, so a dark UI
	// doesn't flash light before the page paints.
	bg := appearance.Background(service.NewSettingsService(core).Get().Theme, appearance.SystemDark)

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Pakpos",
		Width:            savedWindow.Width,
		Height:           savedWindow.Height,
		MinWidth:         windowLimits.MinWidth,
		MinHeight:        windowLimits.MinHeight,
		StartState:       startState(savedWindow),
		BackgroundColour: application.NewRGB(bg.R, bg.G, bg.B),
		URL:              "/",
		// No title bar on macOS: the page runs to the top edge and keeps the
		// window buttons; the frontend leaves room for them (data-platform="mac").
		Mac: application.MacWindow{TitleBar: application.MacTitleBarHidden},
	})
	trackWindow(app, window, windowTracker, savedWindow)

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// startState is the window state to open in. The app never starts minimised.
func startState(s windowstate.State) application.WindowState {
	switch {
	case s.Fullscreen:
		return application.WindowStateFullscreen
	case s.Maximised:
		return application.WindowStateMaximised
	default:
		return application.WindowStateNormal
	}
}

// trackWindow saves the window's state as it changes and on close, and moves
// it to its saved position once it is shown (if that position is still on a
// screen). Window positions are absolute, which every platform's
// SetPosition/Position agree on; WindowXY start options do not. Wayland
// ignores positions, so there only the size and state are restored.
func trackWindow(app *application.App, win *application.WebviewWindow, t *windowstate.Tracker, saved windowstate.State) {
	t.Attach(win)
	for _, e := range []events.WindowEventType{
		events.Common.WindowDidMove, events.Common.WindowDidResize,
		events.Common.WindowMaximise, events.Common.WindowUnMaximise,
		events.Common.WindowFullscreen, events.Common.WindowUnFullscreen,
		events.Common.WindowRestore,
	} {
		win.OnWindowEvent(e, func(*application.WindowEvent) { t.Changed() })
	}
	// A hook runs before the window is destroyed, so it can still be read.
	win.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) {
		if err := t.Flush(); err != nil {
			log.Printf("save window state: %v", err)
		}
	})

	var placed sync.Once
	win.OnWindowEvent(events.Common.WindowShow, func(*application.WindowEvent) {
		placed.Do(func() {
			if saved.Maximised || saved.Fullscreen {
				return
			}
			var screens []windowstate.Rect
			for _, sc := range app.Screen.GetAll() {
				screens = append(screens, windowstate.Rect{X: sc.WorkArea.X, Y: sc.WorkArea.Y,
					Width: sc.WorkArea.Width, Height: sc.WorkArea.Height})
			}
			fit := saved.FitTo(screens)
			if fit.Width != saved.Width || fit.Height != saved.Height {
				win.SetSize(fit.Width, fit.Height)
			}
			if fit.OnScreen(screens) {
				win.SetPosition(fit.X, fit.Y)
			}
		})
	})
}
