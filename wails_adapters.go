package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// wailsDialogs implements service.Dialogs with native Wails dialogs.
type wailsDialogs struct{ app *application.App }

func (d wailsDialogs) PickFolder(title string) (string, error) {
	return d.app.Dialog.OpenFile().
		SetTitle(title).
		CanChooseDirectories(true).
		CanChooseFiles(false).
		CanCreateDirectories(true).
		PromptForSingleSelection()
}

func (d wailsDialogs) PickFile(title string) (string, error) {
	return d.app.Dialog.OpenFile().
		SetTitle(title).
		CanChooseFiles(true).
		PromptForSingleSelection()
}

func (d wailsDialogs) SaveFile(title, defaultName string) (string, error) {
	return d.app.Dialog.SaveFile().
		SetMessage(title).
		SetFilename(defaultName).
		CanCreateDirectories(true).
		PromptForSingleSelection()
}

// wailsEvents implements service.Events with the Wails event bus.
type wailsEvents struct{ app *application.App }

func (e wailsEvents) Emit(name string, data any) { e.app.Event.Emit(name, data) }
