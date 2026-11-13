package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"

	"pakpos/internal/service"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := application.New(application.Options{
		Name:        "Pakpos",
		Description: "Desktop REST API client",
		Services: []application.Service{
			application.NewService(service.NewAppService()),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

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
