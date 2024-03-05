import { getProperties } from '..'

/**
 * Webpack file loader for `.properties` files.
 *
 * @param content - the content of a `.properties` file.
 *
 * @returns A Webpack file loader string containing the content of  a `.properties` file.
 */
const webpackLoader = (content: string): string =>
  `exports.properties = ${JSON.stringify(getProperties(content))};`

export default webpackLoader
