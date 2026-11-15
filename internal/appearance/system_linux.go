package appearance

import (
	"context"
	"time"

	"github.com/godbus/dbus/v5"
)

// SystemDark reads the desktop's colour scheme from the XDG settings portal
// (1 means "prefer dark"). Anything that fails or is slow counts as light,
// since this runs before the window opens.
func SystemDark() bool {
	conn, err := dbus.SessionBus()
	if err != nil {
		return false
	}
	obj := conn.Object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	var outer dbus.Variant
	err = obj.CallWithContext(ctx, "org.freedesktop.portal.Settings.Read", 0, "org.freedesktop.appearance", "color-scheme").Store(&outer)
	if err != nil {
		return false
	}
	return portalPrefersDark(outer)
}

// portalPrefersDark unwraps the portal's variant-in-a-variant uint32.
func portalPrefersDark(v dbus.Variant) bool {
	if inner, ok := v.Value().(dbus.Variant); ok {
		v = inner
	}
	scheme, ok := v.Value().(uint32)
	return ok && scheme == 1
}
