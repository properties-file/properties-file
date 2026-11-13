import { getProperties } from '..'

import { serializeProperties } from './serialize'

/**
 * Webpack file loader for `.properties` files. Also compatible with Rspack.
 *
 * @param content - The content of a `.properties` file.
 *
 * @returns A CommonJS module string exporting the parsed key-value pairs.
 */
const webpackLoader = (content: string): string =>
  `exports.properties = ${serializeProperties(getProperties(content))};`

export default webpackLoader
