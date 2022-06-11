export { Properties, KeyLineNumbers } from './properties';
export { Property } from './property';
export { PropertyLine } from './property-line';

export { getProperties } from './file';
export { propertiesToJson } from './file';

/**
 * A simple "key/value" object.
 */
export type KeyValueObject = {
  [key: string]: string;
};
