import { getProperties } from '..'

/**
 * Webpack file loader for `.properties` files.
 *
 * @param content - the content of a `.properties` file.
 *
 * @returns A Webpack file loader string containing the content of  a `.properties` file.
 */
const webpackLoader = (content: string): string =>
  `module.exports = ${JSON.stringify(getProperties(content))};`

export default webpackLoader
