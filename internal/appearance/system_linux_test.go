package appearance

import (
	"testing"

	"github.com/godbus/dbus/v5"
)

func TestPortalPrefersDark(t *testing.T) {
	tests := []struct {
		name string
		v    dbus.Variant
		want bool
	}{
		{"nested dark", dbus.MakeVariant(dbus.MakeVariant(uint32(1))), true},
		{"nested light", dbus.MakeVariant(dbus.MakeVariant(uint32(2))), false},
		{"no preference", dbus.MakeVariant(dbus.MakeVariant(uint32(0))), false},
		{"flat dark", dbus.MakeVariant(uint32(1)), true},
		{"wrong type", dbus.MakeVariant("dark"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := portalPrefersDark(tt.v); got != tt.want {
				t.Errorf("portalPrefersDark = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSystemDarkDoesNotPanic(t *testing.T) {
	// Without a session bus (CI) this is simply false; with one it's the desktop's choice.
	_ = SystemDark()
}
