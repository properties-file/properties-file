import { propertiesToJson } from '../content';

/**
 * Webpack file loader for `.properties` files.
 *
 * @param content - the content of a `.properties` file.
 *
 * @returns A Webpack file loader string containing the content of  a `.properties` file.
 */
export default function (content: string): string {
  return `module.exports = ${JSON.stringify(propertiesToJson(content))};`;
}
