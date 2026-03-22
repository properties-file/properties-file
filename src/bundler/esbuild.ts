import type { Plugin } from 'esbuild'
import { readFileSync } from 'node:fs'
import { getProperties } from '..'

/**
 * esbuild plugin for `.properties` files.
 *
 * @returns An esbuild plugin that transforms `.properties` imports into JavaScript modules.
 */
const esbuildPlugin = (): Plugin => ({
  name: 'properties-file',
  setup: (build): void => {
    build.onLoad({ filter: /\.properties$/ }, ({ path: filePath }) => ({
      contents: `export const properties = ${JSON.stringify(getProperties(readFileSync(filePath, 'utf8')))};`,
      loader: 'js',
    }))
  },
})

export default esbuildPlugin
