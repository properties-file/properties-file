/**
 * Shared scenario execution logic for the functional behavioral test harness.
 *
 * This is the single place that knows "how to run a scenario against the
 * TypeScript source". Both consumers call the same `executeScenario()`:
 *
 * - `generate.ts` calls it to compute the `expected` value written to
 *   `golden.json`.
 * - `functional.test.ts` calls it again at test time to compute the *actual*
 *   value, which it then compares against the checked-in `golden.json` entry.
 *
 * The compiled `dist/cjs` and `dist/esm` replay runners (`run-cjs.js` /
 * `run-esm.mts`) intentionally do NOT import this module — they are dumb,
 * dependency-free interpreters that mirror this same per-kind logic against
 * the build artifacts instead of the source.
 */
import { getProperties } from '../../src'
import { PropertiesEditor } from '../../src/editor'
import { escapeKey, escapeValue } from '../../src/escape'
import { Properties } from '../../src/parser'
import { unescapeContent } from '../../src/unescape'

import type { EditorOperation, Scenario } from './scenarios'
import type { KeyValuePairObject, PropertiesNode } from '../../src/parser'

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** A summarized node — only the JSON-safe scalar fields common to every node type. */
export type SummarizedNode = {
  type: string
  key?: string
  value?: string
  startingLineNumber?: number
}

/** The result of executing a `parse` scenario. */
export type ParseResult = {
  object: KeyValuePairObject
  nodes: SummarizedNode[]
  hasBom: boolean
}

/** The result of executing any scenario, matching the `expected` field shape in `golden.json`. */
export type ScenarioResult = ParseResult | string

/** A {@link Scenario} paired with its expected result, matching a `golden.json` entry. */
export type GoldenScenario = Scenario & { expected: ScenarioResult }

// ---------------------------------------------------------------------------
// Node summarization
// ---------------------------------------------------------------------------

/**
 * Reduce a {@link PropertiesNode} to its JSON-safe scalar fields for golden-file
 * comparison. Comment and blank line nodes expose their line number as
 * `lineNumber`; this is normalized to `startingLineNumber` here so every node
 * kind shares one field name in the golden schema.
 *
 * @param node - The node to summarize.
 *
 * @returns A JSON-serializable summary of the node.
 */
const summarizeNode = (node: PropertiesNode): SummarizedNode => {
  switch (node.type) {
    case 'property': {
      return {
        type: node.type,
        key: node.key,
        value: node.value,
        startingLineNumber: node.startingLineNumber,
      }
    }
    case 'comment': {
      return { type: node.type, startingLineNumber: node.lineNumber }
    }
    case 'blank': {
      return { type: node.type, startingLineNumber: node.lineNumber }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-kind execution
// ---------------------------------------------------------------------------

/**
 * Run a `parse` scenario: parse the input with both `getProperties()` and the
 * `Properties` node API, capturing the key/value object, summarized nodes, and BOM flag.
 *
 * @param input - The `.properties` content to parse.
 *
 * @returns The JSON-safe parse result.
 */
const runParseScenario = (input: string): ParseResult => {
  const parsed = new Properties(input)
  return {
    object: getProperties(input),
    nodes: parsed.nodes.map((node) => summarizeNode(node)),
    hasBom: parsed.hasBom,
  }
}

/**
 * Apply a single {@link EditorOperation} to a `PropertiesEditor`, dispatching on
 * `method` with args passed positionally exactly as the real method signature expects.
 *
 * @param editor - The editor instance to mutate.
 * @param operation - The operation to apply.
 */
const applyEditorOperation = (editor: PropertiesEditor, operation: EditorOperation): void => {
  switch (operation.method) {
    case 'insert': {
      editor.insert(operation.args[0], operation.args[1], operation.args[2])
      break
    }
    case 'update': {
      editor.update(operation.args[0], operation.args[1])
      break
    }
    case 'upsert': {
      editor.upsert(operation.args[0], operation.args[1], operation.args[2])
      break
    }
    case 'delete': {
      editor.delete(operation.args[0], operation.args[1])
      break
    }
  }
}

/**
 * Run an `editor` scenario: apply a sequence of mutation operations to a fresh
 * `PropertiesEditor` and return the formatted result.
 *
 * @param input - The `.properties` content to seed the editor with.
 * @param ops - The operations to apply, in order.
 *
 * @returns The formatted `.properties` content after all operations.
 */
const runEditorScenario = (input: string, ops: EditorOperation[]): string => {
  const editor = new PropertiesEditor(input)
  for (const operation of ops) {
    applyEditorOperation(editor, operation)
  }
  return editor.format()
}

/**
 * Execute a {@link Scenario} against the TypeScript source implementations.
 *
 * @param scenario - The scenario to execute.
 *
 * @returns The result, matching the `expected` field shape in `golden.json`.
 */
export const executeScenario = (scenario: Scenario): ScenarioResult => {
  switch (scenario.kind) {
    case 'parse': {
      return runParseScenario(scenario.input)
    }
    case 'format': {
      return new Properties(scenario.input).format(scenario.options)
    }
    case 'editor': {
      return runEditorScenario(scenario.input, scenario.ops)
    }
    case 'escape': {
      const escapeFunction = scenario.fn === 'escapeKey' ? escapeKey : escapeValue
      return escapeFunction(scenario.input, scenario.escapeUnicode)
    }
    case 'unescape': {
      return unescapeContent(scenario.input)
    }
  }
}
