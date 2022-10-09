# properties-file

[![License](https://img.shields.io/npm/l/make-coverage-badge.svg)](https://opensource.org/licenses/MIT)
[![npm download](https://img.shields.io/npm/dw/properties-file.svg)](https://www.npmjs.com/package/properties-file)
![Coverage](https://img.shields.io/badge/Coverage-100%25-brightgreen.svg)
![Dependencies](https://img.shields.io/badge/dependencies-0-green)
[![Known Vulnerabilities](https://snyk.io/test/github/Avansai/properties-file/badge.svg?targetFile=package.json)](https://snyk.io/test/github/Avansai/properties-file?targetFile=package.json)

.properties file parser, JSON converter and Webpack loader.

## Installation 💻

> ⚠ in June 2022 we have released version 2 of this package which is not compatible with the previous versions. Make sure to read the documentation before upgrading.

Add the package as a dependency:

```
npm install properties-file
```

## What's in it for me? 🤔

- A modern TypeScript library that reproduces exactly the [Properties Java implementation](/assets/java-implementation.md).
- Flexible APIs:
  - `propertiesToJson` allows quick conversion from `.properties` files to JSON.
  - `getProperties` returns a `Properties` object that provides insights into parsing issues such as key collisions.
  - `propertiesToJson` & `getProperties` also have a browser-compatible version when passing directly the content of a file using the APIs under `properties-file/content`.
  - Out of the box Webpack loader to `import` `.properties` files directly in your application.
- 100% test coverage based on the output from a Java implementation.
- Active maintenance (many popular .properties packages have been inactive years).

## Usage 🎬

We put a lot of effort into adding [TSDoc](https://tsdoc.org/) to all our APIs. Please check directly in your IDE if you are unsure how to use certain APIs provided in our examples.

Both APIs (`getProperties` and `propertiesToJson`) directly under `properties-file` depend on [`fs`](https://nodejs.org/api/fs.html) which means they cannot be used by browsers. If you cannot use `fs` and already have a `.properties` file content, the same APIs are available under `properties-file/content`. Instead of taking the `filePath` as the first argument, they take `content`. The example below will use "`fs`" APIs since they are the most common use cases.

### `propertiesToJson`

This API is probably the most used. You have a `.properties` file that you want to open and access like a simple key/value JSON object. Here is how this can be done with a single API call:

```ts
import { propertiesToJson } from 'properties-file'

console.log(propertiesToJson('hello-world.properties'))
```

Output:

```js
{ hello: 'hello', world: 'world' }
```

If you cannot use `fs` and already have the content of a `.properties` file, your code would look like this instead:

```ts
import { propertiesToJson } from 'properties-file/content'

// ...some code to get the .properties file content into a variable called `propertiesFileContent`

console.log(propertiesToJson(propertiesFileContent))
```

### `getProperties` (advanced use case)

Java's implementation of `Properties` is quite resilient. In fact, there are only two ways an exception can be thrown:

- The file is not found.
- A (`\u`) Unicode escape character is malformed.

This means that almost all files will be valid.

But what about a file that has duplicate keys? Duplicate keys have no reason to exist and they probably should have thrown errors as well but instead Java decided to simply overwrite the value with the latest occurrence in a file.

So how can we know if there were duplicate keys if we want to log some warnings? Simply by using `getProperties` which will return all the data that was used to parse the content. Here is an example on how it can be used:

```properties
# collisions-test.properties
hello: hello1
world: world1
world: world2
hello: hello2
world: world3
```

```ts
import { getProperties } from 'properties-file'

const properties = getProperties('assets/tests/collisions-test.properties')

properties.collection.forEach((property) => {
  console.log(`${property.key} => '${property.value}'`)
})

/**
 * Outputs:
 *
 * hello => 'hello2'
 * world => 'world3'
 *
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
 *
 */
```

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

```js
// properties-file.d.ts
declare module '*.properties' {
  const properties: { readonly [key: string]: string };
  export default properties;
}
```

By adding these configurations you should now be able to import directly `.properties` files just like this:

```ts
import helloWorld from './hello-world.properties'

console.dir(helloWorld)
```

Output:

```json
{ "hello": "world" }
```

## Why another `.properties` file package?

There are probably over 20 similar packages available but:

- A lot of the most popular packages have had no activity for over 5 years.
- A large portion of the packages will not replicate the current Java implementation.
- No package offers the same capabilities as this one.

Unfortunately the `.properties` file specification is not well documented. One reason for this is that it was originally used in Java to store configurations. Most applications will handle this using JSON, YAML or other modern formats today because the formats are more flexible.

### So why `.properties` files?

While many options exists today to handle configurations, `.properties` file remain one of the best option to store localizable strings (also known as messages). On the Java side, `PropertyResourceBundle` is how most implementations handle localization today. Because of its simplicity and maturity, `.properties` files remain one of the best options today when it comes to internationalization (i18n):

| File format   | Key/value based  | Supports inline comments | Built for localization | Good linguistic tools support |
| ------------- | ---------------- | ------------------------ | ---------------------- | ----------------------------- |
| `.properties` | Yes              | Yes                      | Yes (Resource Bundles) | Yes                           |
| `JSON`        | No (can do more) | No (requires JSON5)      | No                     | Depends on the schema         |
| `YAML`        | No (can do more) | Yes                      | No                     | Depends on the schema         |

By having good JavaScript/TypeScript support for `.properties` files, it provides more options when it comes to i18n.

### How does this package work?

Basically our goal was to offer parity with the Java implementation, which is the closest thing to a specification `.properties` file have. Here is in a nutshell the logic behind this package:

1. Split the file content by lines (create line objects)
2. Create `LineObjects` by combining multi-line properties and removing trailing backslash
3. Create `PropertyObjects` from `LineObjects` that combined all lines of a property
4. Identify the key/value delimiter and populate escaped keys and values.
5. Unescape keys and values
6. Create a `PropertiesObject` that will include all `PropertyObjects` while removing collisions

Just like Java, if a Unicode escaped characters (`\u`) is malformed, it will throw an error. But of course, we do not recommend using Unicode escaped characters but rather UTF-8 encoding that supports more characters.

## Additional references

- Java [Test Sandbox](https://codehs.com/sandbox/id/java-main-kYynuh?filename=TestProperties.java)
- Java's `Properties` class [documentation](https://docs.oracle.com/javase/9/docs/api/java/util/Properties.html)
- Java's `PropertyResourceBundle` [documentation](https://docs.oracle.com/javase/9/docs/api/java/util/PropertyResourceBundle.html)
- Java's Internationalization [Guide](https://docs.oracle.com/en/java/javase/18/intl/internationalization-overview.html)
- Wikipedia's .properties [page](https://en.wikipedia.org/wiki/.properties)

### Special mention

Thanks to [@calibr](https://github.com/calibr), the creator of [properties-file version 1.0](https://github.com/calibr/properties-file), for letting us use the [https://www.npmjs.com/package/properties-file](https://www.npmjs.com/package/properties-file) package name. We hope that it will make it easier to find our package.
