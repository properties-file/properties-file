import type { BunPlugin } from 'bun'
import { readFileSync } from 'node:fs'
import { getProperties } from '..'

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
