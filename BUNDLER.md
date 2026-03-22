# Bundler Integrations

`properties-file` provides first-class bundler integrations that let you import `.properties` files
directly into your application. Each integration is available as a separate export path under
`properties-file/bundler/*`.

## Webpack / Rspack

The Webpack loader also works with [Rspack](https://rspack.rs/) with no additional configuration.

```js
// webpack.config.js (or rspack.config.js)
module.exports = {
  module: {
    rules: [
      {
        test: /\.properties$/i,
        use: [
          {
            loader: 'properties-file/bundler/webpack',
          },
        ],
      },
    ],
  },
}
```

## Rollup / Vite / Rolldown

A single Rollup plugin covers [Vite](https://vite.dev/) (which uses Rollup/Rolldown internally)
and standalone [Rollup](https://rollupjs.org/) builds.

```js
// vite.config.js
import propertiesFile from 'properties-file/bundler/rollup'

export default {
  plugins: [propertiesFile()],
}
```

```js
// rollup.config.js
import propertiesFile from 'properties-file/bundler/rollup'

export default {
  plugins: [propertiesFile()],
}
```

## esbuild

Works with [esbuild](https://esbuild.github.io/) and tools built on top of it
(e.g., [tsup](https://tsup.egoist.dev/)).

```js
import * as esbuild from 'esbuild'
import propertiesFile from 'properties-file/bundler/esbuild'

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  plugins: [propertiesFile()],
})
```

## Bun

Works with [Bun](https://bun.sh/) at both runtime and build time.

**Runtime** — register the plugin so that `import` resolves `.properties` files at runtime:

```ts
import propertiesFile from 'properties-file/bundler/bun'

Bun.plugin(propertiesFile)
```

**Build time** — use it as a build plugin:

```ts
import propertiesFile from 'properties-file/bundler/bun'

await Bun.build({
  entrypoints: ['src/index.ts'],
  plugins: [propertiesFile],
})
```

## Type Declaration

Once a bundler integration is configured, the `.properties` type should be available in your IDE
when using `import`. If you ever need to add it manually, create a `*.properties` type declaration
file at the root of your application:

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

## Usage

Once configured, you can import `.properties` files directly:

```ts
import { properties } from './messages.properties'

console.log(properties['greeting.hello']) // Hello World!
```
