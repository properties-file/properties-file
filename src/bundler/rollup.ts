import type { Plugin } from 'rollup'
import { getProperties } from '..'

/** The file extension matched by this plugin. */
const PROPERTIES_EXTENSION = '.properties'

/**
 * Rollup plugin for `.properties` files. Also compatible with Vite and Rolldown.
 *
 * @returns A Rollup plugin that transforms `.properties` imports into JavaScript modules.
 */
const rollupPlugin = (): Plugin => ({
  name: 'properties-file',
  transform: (content: string, id: string): { code: string; map: null } | null => {
    if (id.indexOf(PROPERTIES_EXTENSION, id.length - PROPERTIES_EXTENSION.length) === -1) {
      return null
    }
    return {
      code: `export const properties = ${JSON.stringify(getProperties(content))};`,
      map: null,
    }
  },
})

export default rollupPlugin
