/**
 * Pure-data scenario matrix for the functional behavioral test harness.
 *
 * This is the single source of scenario *definitions* (inputs only — no
 * expected values). Two consumers execute this same table through the shared
 * `executeScenario()` function in `execute-scenario.ts`, so the "how do I run
 * a scenario" logic exists exactly once:
 *
 * - `generate.ts` executes every scenario against the TypeScript source and
 *   writes the results to `golden.json` (checked in).
 * - `functional.test.ts` re-executes every scenario against the source and
 *   asserts the result still matches the checked-in `golden.json`, acting as
 *   an automatic staleness check inside the normal Jest suite.
 * - `run-cjs.js` / `run-esm.mts` replay `golden.json` against the compiled
 *   `dist/cjs` and `dist/esm` artifacts with their own dumb interpreters.
 */
import { readFileSync } from 'node:fs'

import type { DeleteOptions, InsertOptions, UpdateOptions, UpsertOptions } from '../../src/editor'
import type { NormalizeOptions } from '../../src/parser'

// ---------------------------------------------------------------------------
// Scenario schema (JSON-serializable — interpreted by dumb ES5/ESM runners)
// ---------------------------------------------------------------------------

/** Exercises `getProperties()` and the `Properties` node API. */
export type ParseScenario = {
  id: string
  kind: 'parse'
  input: string
}

/** Exercises `Properties.format()`. */
export type FormatScenario = {
  id: string
  kind: 'format'
  input: string
  options: NormalizeOptions
}

/** A single `PropertiesEditor` method call, with args matching the real method signature. */
export type EditorOperation =
  | { method: 'insert'; args: [string, string, InsertOptions?] }
  | { method: 'update'; args: [string, UpdateOptions] }
  | { method: 'upsert'; args: [string, string, UpsertOptions?] }
  | { method: 'delete'; args: [string, DeleteOptions?] }

/** Exercises `PropertiesEditor` mutation methods. */
export type EditorScenario = {
  id: string
  kind: 'editor'
  input: string
  ops: EditorOperation[]
}

/** Exercises `escapeKey` / `escapeValue`. */
export type EscapeScenario = {
  id: string
  kind: 'escape'
  fn: 'escapeKey' | 'escapeValue'
  input: string
  escapeUnicode: boolean
}

/** Exercises `unescapeContent`. */
export type UnescapeScenario = {
  id: string
  kind: 'unescape'
  input: string
}

/** The full scenario matrix, shared by the generator, the Jest staleness check, and the replay runners. */
export type Scenario =
  ParseScenario | FormatScenario | EditorScenario | EscapeScenario | UnescapeScenario

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

// Normalize to LF regardless of the local checkout's line-ending settings (Git's
// `text=auto` may check the fixture out with CRLF on some machines/platforms even
// though the committed blob is LF-only) so the scenario matrix is deterministic
// across environments, not dependent on ambient working-tree state. Read relative
// to the repository root, matching the convention used by the rest of the test
// suite (e.g. `tests/reader.test.ts`) — both `tsx` (via the npm scripts) and Jest
// run with the repository root as their working directory.
const fixture = readFileSync('assets/tests/test-all.properties', 'utf8').replaceAll(
  /\r\n|\r/g,
  '\n'
)
const fixtureWithBom = `\u{FEFF}${fixture}`
const fixtureWithCrlf = fixture.replaceAll('\n', '\r\n')

// ---------------------------------------------------------------------------
// Parse scenarios
// ---------------------------------------------------------------------------

/**
 * Build a `parse` scenario definition.
 *
 * @param id - Unique scenario id.
 * @param input - The `.properties` content to parse.
 *
 * @returns The {@link ParseScenario} definition.
 */
const parseScenario = (id: string, input: string): ParseScenario => ({ id, kind: 'parse', input })

const continuationHeavyInput = [
  'first = one \\',
  '  two \\',
  '  three \\',
  '  four',
  'second\\',
  'Key = value for a multi-line key',
  'evenBackslashes = literal\\\\',
  'oddBackslashes = continues\\\\\\',
  '  after odd backslashes',
].join('\n')

const duplicateKeysInput = [
  '# section',
  'dup = one',
  'dup = two',
  'dup = three',
  'other = value',
  'dup = four',
].join('\n')

const parseScenarios: ParseScenario[] = [
  parseScenario('parse-fixture', fixture),
  parseScenario('parse-fixture-bom', fixtureWithBom),
  parseScenario('parse-fixture-crlf', fixtureWithCrlf),
  parseScenario('parse-empty', ''),
  parseScenario('parse-whitespace-only', '   \t  \n   \n\t  '),
  parseScenario('parse-comment-only', '# just a comment\n! another comment\n   # indented comment'),
  parseScenario('parse-continuation-heavy', continuationHeavyInput),
  parseScenario('parse-duplicate-keys', duplicateKeysInput),
  // Astral (outside-BMP) characters are represented as UTF-16 surrogate pairs, per the Java
  // .properties format (a \uXXXX escape is one code unit; astral characters take two escapes).
  parseScenario(
    'parse-astral-characters',
    'emoji = raw \u{1F600} and escaped \\uD83D\\uDE00\nkey\u{1F680} = value'
  ),
]

// ---------------------------------------------------------------------------
// Format scenarios
// ---------------------------------------------------------------------------

/**
 * Build a `format` scenario definition against the fixture content.
 *
 * @param id - Unique scenario id.
 * @param options - Normalization options to pass to `format()`.
 *
 * @returns The {@link FormatScenario} definition.
 */
const formatScenario = (id: string, options: NormalizeOptions): FormatScenario => ({
  id,
  kind: 'format',
  input: fixture,
  options,
})

const formatScenarios: FormatScenario[] = [
  formatScenario('format-empty-options', {}),
  formatScenario('format-escape-unicode', { escapeUnicode: true }),
  formatScenario('format-separator-equals', { separatorChar: '=' }),
  formatScenario('format-separator-colon', { separatorChar: ':' }),
  formatScenario('format-separator-space', { separatorChar: ' ' }),
  formatScenario('format-separator-tight', { separatorLeading: '', separatorTrailing: '' }),
  formatScenario('format-separator-spaced', { separatorLeading: ' ', separatorTrailing: ' ' }),
  formatScenario('format-wrap-values', { wrapValuesAt: 40 }),
  formatScenario('format-wrap-keys', { wrapKeysAt: 20 }),
  formatScenario('format-collapse-multiline', { collapseMultiline: true }),
  formatScenario('format-remove-comments', { removeComments: true }),
  formatScenario('format-remove-blank-lines', { removeBlankLines: true }),
  formatScenario('format-deduplicate-keys', { deduplicateKeys: true }),
  formatScenario('format-deduplicate-keys-keep-leading', {
    deduplicateKeys: true,
    deduplicateKeysKeepLeadingNodes: true,
  }),
  formatScenario('format-remove-leading-whitespace', { removeLeadingWhitespace: true }),
  formatScenario('format-eol-crlf', { endOfLineCharacter: '\r\n' }),
  formatScenario('format-combo-escape-colon-wrap', {
    escapeUnicode: true,
    separatorChar: ':',
    wrapValuesAt: 30,
  }),
  formatScenario('format-combo-remove-dedupe', {
    removeComments: true,
    removeBlankLines: true,
    deduplicateKeys: true,
  }),
  formatScenario('format-combo-collapse-wrap-equals', {
    collapseMultiline: true,
    wrapValuesAt: 50,
    separatorChar: '=',
  }),
  formatScenario('format-combo-leading-space-crlf', {
    removeLeadingWhitespace: true,
    separatorChar: ' ',
    endOfLineCharacter: '\r\n',
  }),
]

// ---------------------------------------------------------------------------
// Editor scenarios
// ---------------------------------------------------------------------------

const editorSeed = [
  '# Header comment',
  'app.name = MyApp',
  '',
  'app.version = 1.0.0',
  'app.version = 2.0.0',
  '',
  '# Feature flags',
  'feature.enabled = true',
  'feature.disabled = false',
  'legacy.key = to-delete',
].join('\n')

/**
 * Build an `editor` scenario definition from a sequence of operations applied
 * to a fresh `PropertiesEditor` seeded from {@link editorSeed}.
 *
 * @param id - Unique scenario id.
 * @param ops - The operations to apply, in order.
 *
 * @returns The {@link EditorScenario} definition.
 */
const editorScenario = (id: string, ops: EditorOperation[]): EditorScenario => ({
  id,
  kind: 'editor',
  input: editorSeed,
  ops,
})

const editorScenarios: EditorScenario[] = [
  editorScenario('editor-insert-plain', [{ method: 'insert', args: ['new.key', 'new.value'] }]),
  editorScenario('editor-insert-with-options', [
    {
      method: 'insert',
      args: [
        'greeting',
        'München',
        { comment: 'A new setting', commentDelimiter: '!', separator: ':', escapeUnicode: true },
      ],
    },
  ]),
  editorScenario('editor-insert-with-position', [
    {
      method: 'insert',
      args: ['inserted.before', 'X', { referenceKey: 'app.version', position: 'before' }],
    },
  ]),
  editorScenario('editor-update-new-value', [
    { method: 'update', args: ['feature.enabled', { newValue: 'false' }] },
  ]),
  editorScenario('editor-update-new-comment', [
    { method: 'update', args: ['feature.disabled', { newComment: 'Now disabled by default' }] },
  ]),
  editorScenario('editor-upsert-existing', [
    { method: 'upsert', args: ['app.name', 'RenamedApp'] },
  ]),
  editorScenario('editor-upsert-new', [{ method: 'upsert', args: ['new.upserted', 'value123'] }]),
  editorScenario('editor-delete-last', [{ method: 'delete', args: ['app.version'] }]),
  editorScenario('editor-delete-first-occurrence', [
    { method: 'delete', args: ['app.version', { occurrence: 'first' }] },
  ]),
  editorScenario('editor-delete-keep-leading', [
    { method: 'delete', args: ['feature.enabled', { deleteLeadingNodes: false }] },
  ]),
  editorScenario('editor-multi-op-sequence', [
    { method: 'upsert', args: ['app.version', '3.0.0'] },
    { method: 'insert', args: ['app.author', 'Team', { comment: 'Author info' }] },
    { method: 'delete', args: ['legacy.key'] },
    {
      method: 'update',
      args: ['feature.disabled', { newValue: 'true', newKey: 'feature.isDisabled' }],
    },
  ]),
]

// ---------------------------------------------------------------------------
// Escape scenarios
// ---------------------------------------------------------------------------

/**
 * Build an `escape` scenario definition.
 *
 * @param id - Unique scenario id.
 * @param escapeFunctionName - Which escape function to exercise.
 * @param input - The unescaped input string.
 * @param escapeUnicode - Whether to escape non-ASCII characters as `\uXXXX`.
 *
 * @returns The {@link EscapeScenario} definition.
 */
const escapeScenario = (
  id: string,
  escapeFunctionName: 'escapeKey' | 'escapeValue',
  input: string,
  escapeUnicode: boolean
): EscapeScenario => ({ id, kind: 'escape', fn: escapeFunctionName, input, escapeUnicode })

const escapeScenarios: EscapeScenario[] = [
  escapeScenario('escape-key-ascii', 'escapeKey', 'simpleKey', false),
  escapeScenario('escape-value-ascii', 'escapeValue', 'simpleValue', false),
  escapeScenario('escape-key-spaces', 'escapeKey', 'key with spaces', false),
  escapeScenario('escape-value-spaces-leading', 'escapeValue', '   leading spaces value', false),
  escapeScenario('escape-key-tabs', 'escapeKey', 'key\twith\ttabs', false),
  escapeScenario('escape-value-tabs', 'escapeValue', 'value\twith\ttab', false),
  escapeScenario('escape-key-delimiters', 'escapeKey', 'key=with:delims#and!bang', false),
  escapeScenario('escape-value-delimiters', 'escapeValue', 'value=with:delims#and!bang', false),
  escapeScenario('escape-key-backslash', 'escapeKey', String.raw`back\slash\key`, false),
  escapeScenario('escape-value-backslash', 'escapeValue', String.raw`c:\wiki\templates`, false),
  escapeScenario(
    'escape-value-control-chars',
    'escapeValue',
    'line\nbreak\ttab\rcr\fformfeed',
    false
  ),
  escapeScenario('escape-key-control-chars', 'escapeKey', 'line\nbreak\ttab\rcr\fformfeed', false),
  escapeScenario('escape-value-umlaut-no-unicode', 'escapeValue', 'München (ü)', false),
  escapeScenario('escape-value-umlaut-unicode', 'escapeValue', 'München (ü)', true),
  escapeScenario('escape-key-umlaut-unicode', 'escapeKey', 'ümlaut', true),
  escapeScenario('escape-value-cjk-no-unicode', 'escapeValue', 'こんにちは', false),
  escapeScenario('escape-value-cjk-unicode', 'escapeValue', 'こんにちは', true),
  escapeScenario('escape-key-cjk-unicode', 'escapeKey', 'こんにちは', true),
  escapeScenario('escape-value-null-char', 'escapeValue', 'before\u{0}after', false),
  escapeScenario('escape-value-null-char-unicode', 'escapeValue', 'before\u{0}after', true),
  escapeScenario('escape-value-astral-no-unicode', 'escapeValue', 'smile \u{1F600} end', false),
  escapeScenario('escape-value-astral-unicode', 'escapeValue', 'smile \u{1F600} end', true),
  escapeScenario('escape-key-astral-unicode', 'escapeKey', 'key\u{1F680}', true),
]

// ---------------------------------------------------------------------------
// Unescape scenarios
// ---------------------------------------------------------------------------

/**
 * Build an `unescape` scenario definition.
 *
 * @param id - Unique scenario id.
 * @param input - The escaped input string.
 *
 * @returns The {@link UnescapeScenario} definition.
 */
const unescapeScenario = (id: string, input: string): UnescapeScenario => ({
  id,
  kind: 'unescape',
  input,
})

const unescapeScenarios: UnescapeScenario[] = [
  unescapeScenario('unescape-cjk', String.raw`\u3053\u3093\u306b\u3061\u306f`),
  unescapeScenario('unescape-mixed-escapes', String.raw`line1\nline2\ttab\\backslash\u00FC end`),
  unescapeScenario('unescape-lone-trailing-backslash', 'a value that ends with a backslash\\'),
  unescapeScenario('unescape-unknown-escape', String.raw`unknown\q sequence`),
  unescapeScenario('unescape-double-backslash', String.raw`c:\\wiki\\templates`),
  unescapeScenario('unescape-delimiters', String.raw`key\=\:\#\!end`),
  unescapeScenario('unescape-no-backslash-fastpath', 'plain text no escapes at all'),
  unescapeScenario('unescape-ascii-unicode-escapes', String.raw`\u0041\u0042\u0043`),
  unescapeScenario('unescape-astral-surrogate-pair', String.raw`emoji \uD83D\uDE00 end`),
]

// ---------------------------------------------------------------------------
// The full matrix
// ---------------------------------------------------------------------------

/** The full scenario matrix, shared by `generate.ts`, `functional.test.ts`, and the replay runners. */
export const scenarios: Scenario[] = [
  ...parseScenarios,
  ...formatScenarios,
  ...editorScenarios,
  ...escapeScenarios,
  ...unescapeScenarios,
]
