/**
 * Bundler integration tests — what a `.properties` import evaluates to once it has gone through
 * each plugin. Rollup and esbuild are run for real on a temporary project; the webpack loader's
 * emitted module is evaluated directly (it is a plain function, no webpack needed); the Bun
 * plugin is driven through its own `onLoad` callback, since Bun itself cannot run under Jest.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInThisContext } from 'node:vm'

import { build } from 'esbuild'
import { rollup } from 'rollup'

import { getProperties } from '../src'
import bunPlugin from '../src/bundler/bun'
import esbuildPlugin from '../src/bundler/esbuild'
import rollupPlugin from '../src/bundler/rollup'
import webpackLoader from '../src/bundler/webpack'

import type { OnLoadCallback, PluginBuilder } from 'bun'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An ordinary file, with values that need escaping in the emitted JavaScript. */
const PLAIN_CONTENT = [
  'hello = world',
  `quotes = "double" and 'single'`,
  String.raw`escapes = back\\slash, new\nline, tab\t, line separator \u2028 end`,
  String.raw`unicode = caf\u00E9 and \u2615`,
  'constructor = a regular key',
].join('\n')

/**
 * The same file with a `__proto__` key. In a JavaScript object literal an entry with that name
 * sets the prototype instead of creating a property, so a plugin that emits the parsed object
 * as a literal loses the key.
 */
const PROTOTYPE_ACCESSOR_KEY_CONTENT = `${PLAIN_CONTENT}\n__proto__ = kept\nlast = value`

/** The two files every plugin is tested with: file name, then content. */
const FIXTURES: [string, string][] = [
  ['plain.properties', PLAIN_CONTENT],
  ['prototype-accessor-key.properties', PROTOTYPE_ACCESSOR_KEY_CONTENT],
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The CommonJS wrapper a module's code runs in. */
type CommonJsWrapper = (
  exports: Record<string, unknown>,
  module: { exports: Record<string, unknown> }
) => void

/**
 * Minimal runtime check backing {@link evaluateCommonJs}.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value is a function.
 */
const isCommonJsWrapper = (value: unknown): value is CommonJsWrapper => typeof value === 'function'

/**
 * Evaluate CommonJS module code the way a module loader does and return what it exports.
 *
 * The code runs in Node.js's main context, not in the sandbox Jest runs this file in: the
 * objects it creates have that context's `Object.prototype`, not this file's.
 *
 * @param code - The CommonJS module source.
 *
 * @returns The module's exports.
 */
const evaluateCommonJs = (code: string): Record<string, unknown> => {
  const wrapper: unknown = runInThisContext(`(function (exports, module) {${code}\n})`)
  if (!isCommonJsWrapper(wrapper)) {
    throw new Error('The module wrapper did not evaluate to a function.')
  }
  const commonJsModule = { exports: {} }
  wrapper(commonJsModule.exports, commonJsModule)
  return commonJsModule.exports
}

/**
 * Assert that the `properties` export of an evaluated module is exactly what `getProperties()`
 * returns for the same content: same keys in the same order, same values, all of them own
 * properties, on an object whose prototype is still an `Object.prototype` (the root of a
 * prototype chain; which context it belongs to depends on where the module was evaluated).
 *
 * @param moduleExports - The evaluated module's exports.
 * @param content - The `.properties` content the module was generated from.
 */
const expectExportedProperties = (
  moduleExports: Record<string, unknown>,
  content: string
): void => {
  const { properties } = moduleExports
  if (typeof properties !== 'object' || properties === null) {
    throw new Error('The module does not export a `properties` object.')
  }
  expect(Object.entries(properties)).toStrictEqual(Object.entries(getProperties(content)))
  const prototype: unknown = Object.getPrototypeOf(properties)
  expect(prototype).not.toBeNull()
  expect(Object.getPrototypeOf(prototype)).toBeNull()
}

/**
 * Minimal runtime check to hand the Bun plugin a stand-in for Bun's plugin builder: `onLoad` is
 * the only member the plugin uses.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value has an `onLoad` member.
 */
const isPluginBuilder = (value: unknown): value is PluginBuilder =>
  typeof value === 'object' && value !== null && 'onLoad' in value

/**
 * Minimal runtime check for the arguments Bun passes to an `onLoad` callback: `path` is the
 * only one the plugin reads.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value has a `path` member.
 */
const isOnLoadArguments = (value: unknown): value is Parameters<OnLoadCallback>[0] =>
  typeof value === 'object' && value !== null && 'path' in value

// ---------------------------------------------------------------------------
// Temporary project
// ---------------------------------------------------------------------------

const projectDirectory = mkdtempSync(path.join(tmpdir(), 'bundler-plugins-'))

for (const [fileName, content] of FIXTURES) {
  writeFileSync(path.join(projectDirectory, fileName), content)
  // One entry module per fixture, re-exporting what the `.properties` import provides.
  writeFileSync(
    path.join(projectDirectory, `${fileName}.entry.js`),
    `export { properties } from './${fileName}'\n`
  )
}

afterAll(() => {
  rmSync(projectDirectory, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.each(FIXTURES)('%s', (fileName, content) => {
  it('is exported unchanged by the webpack loader', () => {
    expectExportedProperties(evaluateCommonJs(webpackLoader(content)), content)
  })

  it('is exported unchanged by the Rollup plugin', async () => {
    const bundle = await rollup({
      input: path.join(projectDirectory, `${fileName}.entry.js`),
      plugins: [rollupPlugin()],
    })
    const { output } = await bundle.generate({ format: 'cjs' })
    await bundle.close()

    expectExportedProperties(evaluateCommonJs(output[0].code), content)
  })

  it('is exported unchanged by the esbuild plugin', async () => {
    const { outputFiles } = await build({
      entryPoints: [path.join(projectDirectory, `${fileName}.entry.js`)],
      bundle: true,
      write: false,
      format: 'cjs',
      plugins: [esbuildPlugin()],
      logLevel: 'silent',
    })

    expectExportedProperties(evaluateCommonJs(outputFiles[0].text), content)
  })

  it('is handed to Bun as the parsed object', async () => {
    const callbacks: OnLoadCallback[] = []
    const builder: unknown = {
      onLoad: (_constraints: unknown, callback: OnLoadCallback): void => {
        callbacks.push(callback)
      },
    }
    const onLoadArguments: unknown = { path: path.join(projectDirectory, fileName) }
    if (!isPluginBuilder(builder) || !isOnLoadArguments(onLoadArguments)) {
      throw new Error('The stand-ins for the Bun plugin API are malformed.')
    }

    await bunPlugin.setup(builder)
    expect(callbacks).toHaveLength(1)

    const result: unknown = await callbacks[0](onLoadArguments)
    expect(result).toHaveProperty('loader', 'object')
    if (typeof result !== 'object' || result === null || !('exports' in result)) {
      throw new Error('The Bun plugin did not return an `exports` object.')
    }
    const { exports: moduleExports } = result
    if (typeof moduleExports !== 'object' || moduleExports === null) {
      throw new Error('The Bun plugin did not return an `exports` object.')
    }
    expectExportedProperties({ ...moduleExports }, content)
  })
})

describe('Emitted code', () => {
  it('stays a plain object literal for a file without a `__proto__` key', () => {
    expect(webpackLoader('hello = world\nkey = value')).toBe(
      'exports.properties = {"hello":"world","key":"value"};'
    )
  })

  it('is parsed from JSON at run time for a file with a `__proto__` key', () => {
    expect(webpackLoader('hello = world\n__proto__ = kept')).toBe(
      String.raw`exports.properties = JSON.parse("{\"hello\":\"world\",\"__proto__\":\"kept\"}");`
    )
  })

  it('leaves files that are not `.properties` to the bundler', async () => {
    const entryPath = path.join(projectDirectory, 'not-properties.js')
    writeFileSync(entryPath, 'export const untouched = "module.properties.js"\n')

    const bundle = await rollup({ input: entryPath, plugins: [rollupPlugin()] })
    const { output } = await bundle.generate({ format: 'cjs' })
    await bundle.close()

    expect(evaluateCommonJs(output[0].code)).toStrictEqual({ untouched: 'module.properties.js' })
  })
})
