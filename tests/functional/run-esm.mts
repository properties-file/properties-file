/**
 * Functional behavioral test replay runner — ESM/TypeScript edition.
 *
 * Loads the scenario matrix from `golden.json` (generated from source by `generate.ts`) and
 * replays every scenario against the compiled `dist/esm` artifacts, deep-comparing actual
 * output against the expected output that was captured from the TypeScript source. Structurally
 * parallel to `run-cjs.js`, which replays the same scenarios against `dist/cjs` on Node.js
 * 0.4.0 (and therefore must stay plain ES5 JavaScript — this runner only targets modern
 * Node.js, so it can be TypeScript, executed via `tsx`).
 *
 * Like `run-cjs.js`, this runner deliberately does NOT share runtime logic with
 * `execute-scenario.ts` — it is an independent interpreter of the same golden data, which is
 * part of what the replay cross-checks. Only *types* are imported from the harness (erased at
 * compile time), and the built modules are loaded dynamically and validated structurally, since
 * the compiled `dist/esm` output has no type information of its own.
 *
 * Usage:
 *   npx tsx tests/functional/run-esm.mts [distributionRoot]
 *
 * `distributionRoot` defaults to `<repo>/dist/esm` (resolved relative to this file) and can be
 * overridden to an absolute path.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { isNormalizedError, noThrow } from '../../utilities/no-throw'

import type { GoldenScenario, ParseResult, SummarizedNode } from './execute-scenario'
import type { EditorOperation } from './scenarios'
import type { NormalizeOptions } from '../../src/parser'

// ---------------------------------------------------------------------------
// Structural types for the built modules
// ---------------------------------------------------------------------------

/** The subset of a parsed `Properties` instance the replay reads. */
type PropertiesInstance = {
  nodes: {
    type: string
    key?: string
    value?: string
    startingLineNumber?: number
    lineNumber?: number
  }[]
  hasBom: boolean
  format: (options?: NormalizeOptions) => string
}

/** The subset of a `PropertiesEditor` instance the replay drives. */
type PropertiesEditorInstance = {
  insert: (key: string, value: string, options?: object) => void
  update: (key: string, options: object) => void
  upsert: (key: string, value: string, options?: object) => void
  delete: (key: string, options?: object) => void
  format: () => string
}

/** All entry points the replay loads from `dist/esm`. */
type BuiltModules = {
  getProperties: (content: string) => Record<string, string>
  Properties: new (content: string) => PropertiesInstance
  PropertiesEditor: new (content: string) => PropertiesEditorInstance
  escapeKey: (key: string, escapeUnicode: boolean) => string
  escapeValue: (value: string, escapeUnicode: boolean) => string
  unescapeContent: (content: string) => string
}

/**
 * Dynamic `import()` whose return type is narrowed from `any` to `unknown`, so every member
 * access below goes through an explicit structural check.
 *
 * @param specifier - The module URL to import.
 *
 * @returns The imported module namespace, typed as `unknown`.
 */
const dynamicImport = async (specifier: string): Promise<unknown> => import(specifier)

/**
 * Check whether a value is a plain object usable as a string-keyed record.
 *
 * @param value - The value to check.
 *
 * @returns `true` if `value` is a non-null object.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Read an export from a dynamically imported module namespace.
 *
 * @param moduleNamespace - The imported module namespace.
 * @param memberName - The export to read.
 *
 * @returns The exported value, or `undefined` if the namespace has no such member.
 */
const readModuleExport = (moduleNamespace: unknown, memberName: string): unknown =>
  isRecord(moduleNamespace) ? moduleNamespace[memberName] : undefined

/**
 * Check that every collected module export is a function. The compiled output carries no type
 * information, so (exactly like the golden data itself) module shapes are validated
 * structurally here — and behaviorally by the scenario comparison itself.
 *
 * @param candidate - The collected exports, one per {@link BuiltModules} member.
 *
 * @returns Whether every member is a function, narrowing `candidate` to {@link BuiltModules}.
 */
const isBuiltModules = (
  candidate: Record<keyof BuiltModules, unknown>
): candidate is BuiltModules =>
  Object.values(candidate).every((member) => typeof member === 'function')

// ---------------------------------------------------------------------------
// Locate golden.json and the dist/esm root
// ---------------------------------------------------------------------------

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const distributionRoot = process.argv[2] ?? path.join(currentDirectory, '..', '..', 'dist', 'esm')
const goldenPath = path.join(currentDirectory, 'golden.json')

/**
 * Structural check for a golden.json entry — just enough to guard the `JSON.parse()` unknown
 * boundary (the file is generated and trusted; see `generate.ts`).
 *
 * @param value - The value to check.
 *
 * @returns Whether `value` looks like a {@link GoldenScenario}.
 */
const isGoldenScenario = (value: unknown): value is GoldenScenario =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  'kind' in value &&
  typeof value.kind === 'string' &&
  'expected' in value

const parsedGolden: unknown = JSON.parse(readFileSync(goldenPath, 'utf8'))
if (!Array.isArray(parsedGolden) || parsedGolden.some((entry) => !isGoldenScenario(entry))) {
  throw new Error(`Invalid golden file at ${goldenPath}: expected an array of scenario entries.`)
}
const scenarios: GoldenScenario[] = parsedGolden.filter((entry) => isGoldenScenario(entry))

/**
 * Build a `file://` module URL for a path relative to the distribution root.
 *
 * @param relativePath - The path relative to the distribution root (e.g. `parser/index.js`).
 *
 * @returns The absolute `file://` URL for dynamic import.
 */
const toModuleUrl = (relativePath: string): string =>
  pathToFileURL(path.join(distributionRoot, relativePath)).href

const indexNamespace = await dynamicImport(toModuleUrl('index.js'))
const parserNamespace = await dynamicImport(toModuleUrl(path.join('parser', 'index.js')))
const editorNamespace = await dynamicImport(toModuleUrl(path.join('editor', 'index.js')))
const escapeNamespace = await dynamicImport(toModuleUrl(path.join('escape', 'index.js')))
const unescapeNamespace = await dynamicImport(toModuleUrl(path.join('unescape', 'index.js')))

const builtModulesCandidate = {
  getProperties: readModuleExport(indexNamespace, 'getProperties'),
  Properties: readModuleExport(parserNamespace, 'Properties'),
  PropertiesEditor: readModuleExport(editorNamespace, 'PropertiesEditor'),
  escapeKey: readModuleExport(escapeNamespace, 'escapeKey'),
  escapeValue: readModuleExport(escapeNamespace, 'escapeValue'),
  unescapeContent: readModuleExport(unescapeNamespace, 'unescapeContent'),
}
if (!isBuiltModules(builtModulesCandidate)) {
  throw new Error(
    `The built modules under ${distributionRoot} do not expose the expected function exports.`
  )
}
const builtModules: BuiltModules = builtModulesCandidate

// ---------------------------------------------------------------------------
// Deep equality (objects, arrays, primitives; key-set equality for objects)
// ---------------------------------------------------------------------------

/**
 * Deep-compare two JSON-shaped values: objects (by full key-set equality), arrays, and
 * primitives.
 *
 * @param a - The first value.
 * @param b - The second value.
 *
 * @returns `true` if the values are structurally identical.
 */
const isDeepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true
  }
  if (typeof a !== typeof b) {
    return false
  }
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false
  }

  const isArrayA = Array.isArray(a)
  const isArrayB = Array.isArray(b)
  if (isArrayA !== isArrayB) {
    return false
  }

  if (isArrayA && isArrayB) {
    if (a.length !== b.length) {
      return false
    }
    return a.every((value, index) => isDeepEqual(value, b[index]))
  }

  if (!isRecord(a) || !isRecord(b)) {
    return false
  }
  const aKeys = Object.keys(a).toSorted((left, right) => left.localeCompare(right))
  const bKeys = Object.keys(b).toSorted((left, right) => left.localeCompare(right))
  if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) {
    return false
  }
  return aKeys.every((key) => isDeepEqual(a[key], b[key]))
}

// ---------------------------------------------------------------------------
// Per-kind interpreters (independent of execute-scenario.ts — see the module doc)
// ---------------------------------------------------------------------------

/**
 * Reduce a parsed node to its JSON-safe scalar fields, normalizing comment/blank `lineNumber`
 * to `startingLineNumber` — mirroring the golden schema produced by `execute-scenario.ts`.
 *
 * @param node - The node to summarize.
 *
 * @returns A JSON-serializable summary of the node.
 */
const summarizeNode = (node: PropertiesInstance['nodes'][number]): SummarizedNode =>
  node.type === 'property'
    ? {
        type: node.type,
        key: node.key,
        value: node.value,
        startingLineNumber: node.startingLineNumber,
      }
    : { type: node.type, startingLineNumber: node.lineNumber }

/**
 * Run a `parse` scenario against the built modules: parse the input with both `getProperties()`
 * and the `Properties` node API, capturing the key/value object, summarized nodes, and BOM flag.
 *
 * @param input - The `.properties` content to parse.
 *
 * @returns The JSON-safe parse result.
 */
const runParseScenario = (input: string): ParseResult => {
  const parsed = new builtModules.Properties(input)
  return {
    object: builtModules.getProperties(input),
    nodes: parsed.nodes.map((node) => summarizeNode(node)),
    hasBom: parsed.hasBom,
  }
}

/**
 * Apply a single {@link EditorOperation} to a built `PropertiesEditor` instance, dispatching on
 * `method` with the scenario's args tuple spread positionally.
 *
 * @param editor - The editor instance to mutate.
 * @param operation - The operation to apply.
 */
const applyEditorOperation = (
  editor: PropertiesEditorInstance,
  operation: EditorOperation
): void => {
  switch (operation.method) {
    case 'insert': {
      editor.insert(...operation.args)
      break
    }
    case 'update': {
      editor.update(...operation.args)
      break
    }
    case 'upsert': {
      editor.upsert(...operation.args)
      break
    }
    case 'delete': {
      editor.delete(...operation.args)
      break
    }
  }
}

/**
 * Execute a scenario against the built `dist/esm` modules — this runner's independent
 * counterpart to `executeScenario()` in `execute-scenario.ts` (see the module doc).
 *
 * @param scenario - The golden scenario to replay.
 *
 * @returns The replayed result, to be compared against the scenario's `expected` value.
 */
const runScenario = (scenario: GoldenScenario): unknown => {
  switch (scenario.kind) {
    case 'parse': {
      return runParseScenario(scenario.input)
    }
    case 'format': {
      return new builtModules.Properties(scenario.input).format(scenario.options)
    }
    case 'editor': {
      const editor = new builtModules.PropertiesEditor(scenario.input)
      for (const operation of scenario.ops) {
        applyEditorOperation(editor, operation)
      }
      return editor.format()
    }
    case 'escape': {
      const escapeFunction =
        scenario.fn === 'escapeKey' ? builtModules.escapeKey : builtModules.escapeValue
      return escapeFunction(scenario.input, scenario.escapeUnicode)
    }
    case 'unescape': {
      return builtModules.unescapeContent(scenario.input)
    }
  }
}

// ---------------------------------------------------------------------------
// Run all scenarios
// ---------------------------------------------------------------------------

let passCount = 0
let failCount = 0

for (const scenario of scenarios) {
  const actual = noThrow(() => runScenario(scenario))

  if (isNormalizedError(actual)) {
    failCount++
    console.log(`FAIL [${scenario.id}]: threw ${actual.message}`)
    continue
  }

  if (isDeepEqual(actual, scenario.expected)) {
    passCount++
  } else {
    failCount++
    console.log(`FAIL [${scenario.id}]`)
    console.log(`  expected: ${JSON.stringify(scenario.expected)}`)
    console.log(`  actual:   ${JSON.stringify(actual)}`)
  }
}

if (failCount > 0) {
  console.log(
    `\n[run-esm] Node ${process.version}: ${passCount}/${passCount + failCount} scenarios passed — FAILED`
  )
  // eslint-disable-next-line unicorn/no-process-exit -- CLI test runner: a non-zero exit code is the intended signal for scripts/CI.
  process.exit(1)
}

console.log(`[run-esm] Node ${process.version}: ${passCount}/${passCount} scenarios passed`)
