# properties-file

[![License](https://img.shields.io/npm/l/make-coverage-badge.svg?color=brightgreen)](https://opensource.org/licenses/MIT)
[![npm download](https://img.shields.io/npm/dw/properties-file.svg?color=brightgreen)](https://www.npmjs.com/package/properties-file)
![Coverage](https://img.shields.io/badge/Coverage-100%25-brightgreen.svg)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

`.properties` file parser, editor, formatter and Webpack loader.

## Installation 💻

> ⚠ In April 2023, we released version 3 of this package, which includes breaking changes. Please refer to the [upgrade guide](./V2-TO-V3-UPGRADE-GUIDE.md) before upgrading.

Add the package as a dependency:

```
npm install properties-file
```

## What's in it for me? 🤔

- A modern library written entirely in TypeScript that exactly reproduces the [Properties Java implementation](/assets/java-implementation.md).
- Works for both Node.js applications and browsers that support at least [ES5](https://www.w3schools.com/js/js_es5.asp).
- Flexible APIs:
  - `getProperties` converts the content of `.properties` files to a key-value pair object.
  - A `Properties` class provides insights into parsing data.
  - A `PropertiesEditor` class enables the addition, edition, and removal of entries.
  - `escapeKey` and `escapeValue` allow the conversion of any content to a `.properties` compatible format.
  - The library also includes a Webpack loader to import `.properties` files directly into your application.
- Tiny ([under 4kB compressed](https://bundlephobia.com/package/properties-file)) with 0 dependencies.
- 100% test coverage based on the output from a Java implementation.
- Active maintenance (many popular `.properties` packages have been inactive for years).

## Usage 🎬

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

### `Properties` (using parsing metadata)

The `Properties` object is what makes `getProperties` work under the hood, but when using it directly, you can access granular parsing metadata. Here is an example of how the object can be used to find key collisions:

```ts
import { Properties } from 'properties-file'

const properties = new Properties(
  'hello = hello1\nworld = world1\nworld = world2\nhello = hello2\nworld = world3'
)
console.log(properties.format())

/**
 * Outputs:
 *
 * hello = hello1
 * world = world1
 * world = world2
 * hello = hello2
 * world = world3
 */

properties.collection.forEach((property) => {
  console.log(`${property.key} = ${property.value}`)
})

/**
 * Outputs:
 *
 * hello = hello2
 * world = world3
 */

const keyCollisions = properties.getKeyCollisions()

keyCollisions.forEach((keyCollision) => {
  console.warn(
    `Found a key collision for key '${
      keyCollision.key
    }' on lines ${keyCollision.startingLineNumbers.join(
      ', '
    )} (will use the value at line ${keyCollision.getApplicableLineNumber()}).`
  )
})

/**
 * Outputs:
 *
 * Found a key collision for key 'hello' on lines 1, 4 (will use the value at line 4).
 * Found a key collision for key 'world' on lines 2, 3, 5 (will use the value at line 5).
 */
```

For purposes where you require more parsing metadata, such as building a syntax highlighter, it is recommended that you access the `Property` objects included in the `Properties.collection`. These objects provide comprehensive information about each key-value pair.

### `PropertiesEditor` (editing `.properties` content)

In certain scenarios, it may be necessary to modify the content of the `.properties` key-value pair objects. This can be achieved easily using the `Properties` object, with the assistance of the `escapeKey` and `escapeValue` APIs, as demonstrated below:

```ts
import { Properties } from 'properties-file'
import { escapeKey, escapeValue } from 'properties-file/escape'

const properties = new Properties('hello = hello\n# This is a comment\nworld = world')
const newProperties: string[] = []

properties.collection.forEach((property) => {
  const key = property.key === 'world' ? 'new world' : property.key
  const value = property.value === 'world' ? 'new world' : property.value
  newProperties.push(`${escapeKey(key)} = ${escapeValue(value)}`)
})

console.log(newProperties.join('\n'))

/**
 * Outputs:
 *
 * hello = hello
 * new\ world = new world
 */
```

The limitation of this approach is that its output contains only valid keys, without any comments or whitespace. However, if you require a more advanced editor that preserves these original elements, then the `PropertiesEditor` object is exactly what you need.

```ts
import { PropertiesEditor } from 'properties-file/editor'

const properties = new PropertiesEditor('hello = hello\n# This is a comment\nworld = world')
console.log(properties.format())

/**
 * Outputs:
 *
 * hello = hello
 * # This is a comment
 * world = world
 */

properties.insertComment('This is a multiline\ncomment before `newKey3`')
properties.insert('newKey3', 'This is my third key')

properties.insert('newKey1', 'This is my first new key', {
  referenceKey: 'newKey3',
  position: 'before',
  comment: 'Below are the new keys being edited',
  commentDelimiter: '!',
})

properties.insert('newKey2', 'こんにちは', {
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
 * newKey2 = \u3053\u3093\u306b\u3061\u306f
 * # This is a multiline
 * # comment before `newKey3`
 * newKey3 = This is my third key
 */
```

For convenience, we also added an `upsert` method that allows updating a key if it exists or adding it at the end, when it doesn't. Make sure to check in your IDE for all available methods and options in our TSDoc.

### Webpack File Loader

If you would like to import `.properties` directly using `import`, this package comes with its own Webpack file loader located under `properties-file/webpack-loader`. Here is an example of how to configure it:

```js
// webpack.config.js
module.exports = {
  module: {
    rules: [
      {
        test: /\.properties$/i,
        use: [
          {
            loader: 'properties-file/webpack-loader',
          },
        ],
      },
    ],
  },
}
```

As soon as you configure Webpack, the `.properties` type should be available in your IDE when using `import`. If you ever need to add it manually, you can add a `*.properties` type declaration file at the root of your application, like this:

```ts
declare module '*.properties' {
  /** A key/value object representing the content of a `.properties` file. */
  const properties: {
    /** The value of a `.properties` file key. */
    [key: string]: string
  }
  export { properties }
}
```

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

There are probably over 20 similar packages available, but:

- Many of the most popular packages have had no activity for over 5 years.
- Most packages will not replicate the current Java implementation.
- No package offers the same capabilities as this one.

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

Basically, our goal was to offer parity with the Java implementation, which is the closest thing to a specification for `.properties` files. Here is the logic behind this package in a nutshell:

1. The content is split by lines, creating an array of strings where each line is an element.
2. All lines are parsed to create a collection of `Property` objects that:
   1. Identify key-value pair lines from the other lines (e.g., comments, blank lines, etc.).
   2. Merge back multiline key-value pairs on single lines by removing trailing backslashes.
   3. Unescape the keys and values.

Just like Java, if a Unicode-escaped character (`\u`) is malformed, an error will be thrown. However, we do not recommend using Unicode-escaped characters, but rather using UTF-8 encoding that supports more characters.

## Additional references

- Java [Test Sandbox](https://codehs.com/sandbox/id/java-main-FObePj)
- Java's `Properties` class [documentation](https://docs.oracle.com/javase/9/docs/api/java/util/Properties.html)
- Java's `PropertyResourceBundle` [documentation](https://docs.oracle.com/javase/9/docs/api/java/util/PropertyResourceBundle.html)
- Java's Internationalization [Guide](https://docs.oracle.com/en/java/javase/18/intl/internationalization-overview.html)
- Wikipedia's .properties [page](https://en.wikipedia.org/wiki/.properties)

### Special mention

Thanks to [@calibr](https://github.com/calibr), the creator of [properties-file version 1.0](https://github.com/calibr/properties-file), for letting us use the [https://www.npmjs.com/package/properties-file](https://www.npmjs.com/package/properties-file) package name. We hope that it will make it easier to find our package.
