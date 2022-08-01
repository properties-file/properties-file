export { getProperties, propertiesToJson } from './file'
export { KeyLineNumbers, Properties } from './properties'
export { Property } from './property'
export { PropertyLine } from './property-line'

/**
 * A simple "key/value" object.
 */
export type KeyValueObject = {
  [key: string]: string
}
