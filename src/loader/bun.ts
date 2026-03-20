import { type BunPlugin } from 'bun'

import { readFileSync } from 'node:fs'

import { getProperties } from '..'

/**
 * Bun file loader for `.properties` files
 */
const bunLoader: BunPlugin = {
  name: 'Properties loader',
  setup: (build) => {
    build.onLoad({ filter: /\.properties$/ }, (arguments_) => {
      return {
        exports: {
          properties: getProperties(readFileSync(arguments_.path)),
        },
        loader: 'object',
      }
    })
  },
}

export default bunLoader
