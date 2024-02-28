import { rmSync } from 'node:fs'

// Delete the build scripts directory from the build.
rmSync('lib/build-scripts', { recursive: true, force: true })
