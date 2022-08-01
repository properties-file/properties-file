import { existsSync, readFileSync } from 'fs'

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
export function getProperties(filePath: string, encoding?: BufferEncoding): Properties {
  if (!existsSync(filePath)) {
    throw Error(`file not found at ${filePath}`)
  }

  return getPropertiesFromContent(readFileSync(filePath, encoding ? encoding : 'utf-8'))
}

/**
 * Converts the content of a `.properties` file to JSON.
 *
 * @param filePath - The file path of the `.properties` file.
 * @param encoding - The encoding of the file to parse (default is UTF-8).
 *
 * @returns A (JSON) key/value object representing the content of a `.properties` file.
 */
export function propertiesToJson(filePath: string, encoding?: BufferEncoding): KeyValueObject {
  return getProperties(filePath, encoding).toJson()
}
