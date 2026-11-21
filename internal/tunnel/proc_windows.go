//go:build windows

package tunnel

import (
	"os/exec"
	"syscall"
)

// createNoWindow keeps cloudflared (a console program) from opening a
// console window next to the app.
const createNoWindow = 0x08000000

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
