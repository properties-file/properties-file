import { readFileSync } from 'node:fs'

import { getProperties } from '..'

/**
 * Minimal BunPlugin type to avoid importing `bun-types` which has a WebAssembly
 * type conflict with TypeScript 6.0+ (`wasm.d.ts` TS2403/TS2430).
 *
 * TODO: Replace with `import type { BunPlugin } from 'bun'` once `@types/bun` \> 1.3.11
 * is released (fix is on main but not yet published).
 */
type BunPlugin = {
  name: string
  setup: (build: {
    onLoad: (
      options: { filter: RegExp },
      callback: (loadArguments: { path: string }) => unknown
    ) => void
  }) => void
}

/**
 * Bun plugin for `.properties` files. Works with both `Bun.plugin` (runtime) and `Bun.build`
 * (build-time).
 */
const bunPlugin: BunPlugin = {
  name: 'properties-file',
  setup: (build): void => {
    build.onLoad({ filter: /\.properties$/ }, ({ path: filePath }) => ({
      exports: {
        properties: getProperties(readFileSync(filePath, 'utf8')),
      },
      loader: 'object',
    }))
  },
}

export default bunPlugin
