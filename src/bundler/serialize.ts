import type { KeyValuePairObject } from '..'

/**
 * Serialize parsed properties as the source of a JavaScript expression that evaluates to an
 * equal object, for the plugins that emit a module as code.
 *
 * The JSON form of the object is emitted as an object literal, with one trap: in a literal, an
 * entry named `__proto__` does not create a property, it sets the prototype of the object, and
 * a string is ignored as a prototype. A `.properties` key with that name would be silently
 * missing from the bundled module. `JSON.parse` has no such special case, so when the key is
 * present the JSON is emitted as a string for the module to parse instead. Every other file
 * keeps the plain literal.
 *
 * The call is marked `@__PURE__`: bundlers treat `JSON.parse` as a call that may have side
 * effects, and would otherwise keep it in the bundle even when the import is unused, unlike the
 * literal.
 *
 * @param properties - The parsed key-value pairs.
 *
 * @returns The source of an expression evaluating to an object equal to `properties`.
 */
export const serializeProperties = (properties: KeyValuePairObject): string => {
  const json = JSON.stringify(properties)
  return Object.prototype.hasOwnProperty.call(properties, '__proto__')
    ? `/* @__PURE__ */ JSON.parse(${JSON.stringify(json)})`
    : json
}
