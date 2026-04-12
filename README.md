# properties-file

[![License](https://img.shields.io/npm/l/make-coverage-badge.svg?color=brightgreen)](https://opensource.org/licenses/MIT)
[![Download Stats](https://img.shields.io/npm/dw/properties-file.svg?color=brightgreen)](https://www.npmjs.com/package/properties-file)
![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)
![Package Size](https://img.shields.io/badge/min%2Bgzip-970%20B-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

`.properties` file parser, editor, formatter and bundler integrations.

## Installation

> Doing a major version update? Check our [migration guides](./docs/migration/README.md).

Add the package as a dependency:

```
npm install properties-file
```

## What's in it for me?

- A modern library written entirely in TypeScript that exactly reproduces the [Properties Java implementation](/assets/java-implementation.md).
- Works for both Node.js applications and browsers that support at least [ES5](https://www.w3schools.com/js/js_es5.asp).
- Flexible, tree-shakable APIs — import only what you need, and your bundler will exclude the rest:
  - `getProperties` converts `.properties` content to a key-value pair object.
  - `Properties` provides lossless parsing with a full data model — every element (properties, comments, blank lines, whitespace, duplicate keys) is preserved and can be round-tripped exactly or normalized via `format()` options.
  - `PropertiesEditor` enables insertion, edition, and removal of entries while preserving formatting.
  - `escapeKey` and `escapeValue` convert any content to `.properties` compatible format.
  - Bundler integrations for Webpack, Rollup/Vite, esbuild, and Bun to import `.properties` files directly. See [BUNDLER.md](./docs/BUNDLER.md).
- **Tiny with 0 dependencies** — `getProperties` is only 970 B min+gzip.
- **Runs everywhere** — compiled to ES5, works in any browser and on Node.js all the way back to v0.4.0 (2011, the first stable release with ES5 support). [Verified via Docker](./tests/node-compat/).
- **100% test coverage** based on the output from a Java implementation.
- Active maintenance (many popular `.properties` packages have been inactive for years). See our [detailed comparison](./docs/COMPARISON.md) with other packages.

## Usage

We have put a lot of effort into incorporating [TSDoc](https://tsdoc.org/) into all our APIs. If you are unsure about how to use certain APIs provided in our examples, please check directly in your IDE.

### `getProperties` (converting `.properties` to an object)

The most common use case for `.properties` files is for Node.js applications that need to read the file's content into a simple key-value pair object. Here is how this can be done with a single API call:

```ts
import { readFileSync } from 'node:fs'
import { getProperties } from 'properties-file'

console.log(getProperties(readFileSync('hello-world.properties')))
```

Output:

```js
{ hello: 'hello', world: 'world' }
```

### `Properties` (lossless parsing with full data model)

The `Properties` class parses a `.properties` file into a lossless data model where every element — properties, comments, blank lines — is preserved in order. This is useful when you need to inspect, analyze, or transform `.properties` files while retaining their exact structure.

```ts
import { readFileSync } from 'node:fs'
import { PropertiesNodeType, Properties } from 'properties-file/parser'

const properties = new Properties(readFileSync('example.properties'))

// Access all nodes in file order (properties, comments, blank lines).
for (const node of properties.nodes) {
  switch (node.type) {
    case PropertiesNodeType.PROPERTY:
      console.log(`${node.key} = ${node.value}`)
      break
    case PropertiesNodeType.COMMENT:
      console.log(`Comment: ${node.delimiter}${node.body}`)
      break
    case PropertiesNodeType.BLANK:
      console.log('(blank line)')
      break
  }
}

// Get a simple key-value object (last-wins for duplicate keys).
console.log(properties.toObject())

// Lossless round-trip: format() reproduces the exact original content.
console.log(properties.format() === readFileSync('example.properties', 'utf8')) // true
```

#### Finding key collisions

```ts
import { Properties } from 'properties-file/parser'

const properties = new Properties(
  'hello = hello1\nworld = world1\nworld = world2\nhello = hello2\nworld = world3'
)

const collisions = properties.getKeyCollisions()
collisions.forEach((collision) => {
  const lines = collision.nodes.map((node) => node.startingLineNumber)
  console.log(`Key '${collision.key}' appears on lines ${lines.join(', ')}`)
})

/**
 * Outputs:
 *
 * Key 'hello' appears on lines 1, 4
 * Key 'world' appears on lines 2, 3, 5
 */
```

#### Normalizing output

Passing options to `format()` produces a normalized version of the file with granular control over formatting:

```ts
import { Properties } from 'properties-file/parser'

const properties = new Properties('# comment\n\n    key : value\n    key : updated')

console.log(
  properties.format({
    removeComments: true, // Strip all comments
    removeBlankLines: true, // Strip all blank lines
    removeLeadingWhitespace: true, // Strip indentation
    deduplicateKeys: true, // Keep only last occurrence
    separatorChar: '=', // Standardize separator
    separatorLeading: ' ', // Space before =
    separatorTrailing: ' ', // Space after =
  })
)

/**
 * Outputs:
 *
 * key = updated
 */
```

### `PropertiesEditor` (editing `.properties` content)

The `PropertiesEditor` extends `Properties` with methods to insert, update, delete, and upsert entries while preserving formatting.

```ts
import { PropertiesEditor } from 'properties-file/editor'

const properties = new PropertiesEditor('hello = hello\n# This is a comment\nworld = world')

properties.insertComment('This is a multiline\ncomment before `newKey3`')
properties.insert('newKey3', 'This is my third key')

properties.insert('newKey1', 'This is my first new key', {
  referenceKey: 'newKey3',
  position: 'before',
  comment: 'Below are the new keys being edited',
  commentDelimiter: '!',
})

properties.insert('newKey2', 'hello', {
  referenceKey: 'newKey1',
  position: 'after',
  escapeUnicode: true,
})

properties.delete('hello')
properties.update('world', {
  newValue: 'new world',
})
console.log(properties.format())

/**
 * Outputs:
 *
 * # This is a comment
 * world = new world
 * ! Below are the new keys being edited
 * newKey1 = This is my first new key
 * newKey2 = hello
 * # This is a multiline
 * # comment before `newKey3`
 * newKey3 = This is my third key
 */
```

The editor also provides `upsert` (update or insert) and `deleteAll` (remove all occurrences of a duplicate key). Check your IDE for all available methods and options via TSDoc.

### Bundler Integrations

If you would like to import `.properties` directly using `import`, this package provides integrations for all major bundlers: **Webpack/Rspack**, **Rollup/Vite/Rolldown**, **esbuild**, and **Bun**.

See [BUNDLER.md](./docs/BUNDLER.md) for setup instructions and examples.

By adding these configurations you should now be able to import directly `.properties` files just like this:

```ts
import { properties as helloWorld } from './hello-world.properties'

console.dir(helloWorld)
```

Output:

```json
{ "hello": "world" }
```

## Why another `.properties` file package?

There are over 20 similar packages available, but most are abandoned, incomplete, or not compliant with the Java specification. See our [detailed comparison](./docs/COMPARISON.md) for benchmarks, compliance tests, and a feature matrix against the top 5 packages. The short version:

- **100% Java spec compliance** — the only package (alongside `properties-parser`) to pass all test cases.
- **3–7x faster** than alternatives on a 10,000-entry file.
- **Lossless data model** — no other package preserves comments, blank lines, whitespace, and duplicate keys for round-trip editing.

Unfortunately, the `.properties` file specification is not well-documented. One reason for this is that it was originally used in Java to store configurations. Today, most applications handle this using JSON, YAML, or other modern formats because these formats are more flexible.

### So why `.properties` files?

While many options exist today to handle configurations, `.properties` files remain one of the best options to store localizable strings (also known as messages). On the Java side, `PropertyResourceBundle` is how most implementations handle localization today. Because of its simplicity and maturity, `.properties` files remain one of the best options today when it comes to internationalization (i18n):

| File format   | Key/value based  | Supports inline comments | Built for localization | Good linguistic tools support |
| ------------- | ---------------- | ------------------------ | ---------------------- | ----------------------------- |
| `.properties` | Yes              | Yes                      | Yes (Resource Bundles) | Yes                           |
| `JSON`        | No (can do more) | No (requires JSON5)      | No                     | Depends on the schema         |
| `YAML`        | No (can do more) | Yes                      | No                     | Depends on the schema         |

Having good JavaScript/TypeScript support for `.properties` files offers more internationalization (i18n) options.

### How does this package work?

Our goal is to offer parity with the Java implementation, which is the closest thing to a specification for `.properties` files. The package provides two parsing paths:

1. **`getProperties`** — a fast, functional parser optimized for the common case of converting `.properties` content to a key-value object. Uses `charCodeAt`-based scanning with zero-copy optimizations.

2. **`Properties`** — a lossless parser that produces an ordered array of typed nodes (`PropertyNode`, `CommentNode`, `BlankLineNode`). Every element in the file is preserved, enabling exact round-trip reconstruction via `format()` and flexible normalization by passing options to `format()`.

Both parsers are fully compliant with the Java `Properties` specification and produce identical key-value output. Just like Java, if a Unicode-escaped character (`\u`) is malformed, an error will be thrown.

## Contributing

See [CONTRIBUTING.md](./docs/CONTRIBUTING.md) for project principles, architecture, code style, and development commands.

## Additional references

- Java [Test Sandbox](https://codehs.com/sandbox/id/java-main-FObePj)
- Java's `Properties` class [documentation](https://docs.oracle.com/javase/9/docs/api/java/util/Properties.html)
- Java's `PropertyResourceBundle` [documentation](https://docs.oracle.com/javase/9/docs/api/java/util/PropertyResourceBundle.html)
- Java's Internationalization [Guide](https://docs.oracle.com/en/java/javase/18/intl/internationalization-overview.html)
- Wikipedia's .properties [page](https://en.wikipedia.org/wiki/.properties)

### Special mention

Thanks to [@calibr](https://github.com/calibr), the creator of [properties-file version 1.0](https://github.com/calibr/properties-file), for letting us use the [https://www.npmjs.com/package/properties-file](https://www.npmjs.com/package/properties-file) package name. We hope that it will make it easier to find our package.
