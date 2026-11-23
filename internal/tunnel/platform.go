package tunnel

import "runtime"

// The platform Install picks an asset for unless Installer overrides it.
var (
	goosDefault   = runtime.GOOS
	goarchDefault = runtime.GOARCH
)
