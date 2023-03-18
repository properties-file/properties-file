import { readFileSync } from 'node:fs'

import { KeyValueObject, Properties } from '../'
import { getProperties as getPropertiesFromContent } from '../content/'

export { KeyValueObject } from '../'

/**
 * Get a `Properties` object from the content of a `.properties` file.
 *
 * @param filePath - The file path of the `.properties` file.
 * @param encoding - The encoding of the file to parse (default is UTF-8).
 *
 * @returns A `Properties` object representing the content of a `.properties` file.
 */
export const getProperties = (filePath: string, encoding?: BufferEncoding): Properties => {
  // No need to check if the file exists first since this will already throw an error.
  return getPropertiesFromContent(readFileSync(filePath, encoding ?? 'utf8'))
}

/**
 * Converts the content of a `.properties` file to JSON.
 *
 * @param filePath - The file path of the `.properties` file.
 * @param encoding - The encoding of the file to parse (default is UTF-8).
 *
 * @returns A (JSON) key/value object representing the content of a `.properties` file.
 */
export const propertiesToJson = (filePath: string, encoding?: BufferEncoding): KeyValueObject =>
  getProperties(filePath, encoding).toJson()
