import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Number of entries to generate in each synthetic payload. */
const ENTRY_COUNT = 10_000

/**
 * Pure key/value pairs — no escapes, no comments, no whitespace variation.
 * Tests the parser's best-case fast path.
 *
 * @returns A `.properties`-formatted string with {@link ENTRY_COUNT} entries.
 */
export const generatePureKeyValue = (): string => {
  const lines: string[] = []
  for (let index = 0; index < ENTRY_COUNT; index++) {
    lines.push(`key${index}=value${index}`)
  }
  return lines.join('\n')
}

/**
 * Comment-heavy — majority of lines are `#` or `!` comments interleaved with key/value pairs.
 * Tests the comment-skip logic in the parser.
 *
 * @returns A `.properties`-formatted string with ~{@link ENTRY_COUNT} comment lines.
 */
export const generateCommentHeavy = (): string => {
  const lines: string[] = []
  for (let index = 0; index < ENTRY_COUNT; index++) {
    lines.push(
      index % 2 === 0 ? `# This is comment number ${index}` : `! Another comment style ${index}`
    )
    if (index % 5 === 0) {
      lines.push(`key${index}=value${index}`)
    }
  }
  return lines.join('\n')
}

/**
 * Whitespace-heavy — blank lines, leading/trailing whitespace, whitespace separators.
 * Tests trimming and whitespace-handling paths.
 *
 * @returns A `.properties`-formatted string with {@link ENTRY_COUNT} whitespace-padded entries.
 */
export const generateWhitespaceHeavy = (): string => {
  const lines: string[] = []
  for (let index = 0; index < ENTRY_COUNT; index++) {
    lines.push('', `    key${index}    =    value with trailing spaces${index}    `, '')
    if (index % 3 === 0) {
      lines.push(`  spaceSeparated${index} value${index}`)
    }
  }
  return lines.join('\n')
}

/**
 * Unicode escapes — values encoded entirely with `\uXXXX` sequences.
 * Stresses the regex-heavy unescapeContent path (most expensive code path).
 *
 * @returns A `.properties`-formatted string with {@link ENTRY_COUNT} unicode-escaped entries.
 */
export const generateUnicodeEscapes = (): string => {
  const lines: string[] = []
  for (let index = 0; index < ENTRY_COUNT; index++) {
    const text = `value${index}`
    // `for...of` over a string iterates by Unicode code point. Pure ASCII payloads, but using
    // `codePointAt` keeps us aligned with `unicorn/prefer-code-point` and avoids the
    // `no-misused-spread` warning that `[...text]` triggers.
    let escaped = ''
    for (const character of text) {
      const codePoint = character.codePointAt(0)
      if (codePoint === undefined) {
        continue
      }
      escaped += String.raw`\u` + codePoint.toString(16).padStart(4, '0')
    }
    lines.push(`key${index}=${escaped}`)
  }
  return lines.join('\n')
}

/**
 * Multiline values — entries with `\` line continuations.
 * Tests the isContinuing path in the parser.
 *
 * @returns A `.properties`-formatted string with {@link ENTRY_COUNT} multiline entries.
 */
export const generateMultilineValues = (): string => {
  const lines: string[] = []
  for (let index = 0; index < ENTRY_COUNT; index++) {
    lines.push(`key${index}=line1of${index}\\`, `  line2of${index}\\`, `  line3of${index}`)
  }
  return lines.join('\n')
}

/**
 * Mixed/realistic — existing test-all.properties repeated to reach scale.
 * Real-world baseline with all feature combinations.
 *
 * @returns A `.properties`-formatted string built from repeating the test fixture.
 */
export const generateMixed = (): string => {
  const testFile = readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'assets', 'tests', 'test-all.properties'),
    'utf8'
  )
  const repetitions = Math.ceil(ENTRY_COUNT / testFile.split('\n').length)
  const chunks: string[] = []
  for (let index = 0; index < repetitions; index++) {
    chunks.push(testFile)
  }
  return chunks.join('\n')
}

/** A named payload generator for use in benchmark suites. */
export type Payload = {
  /** Human-readable name shown in benchmark output. */
  name: string
  /** Function that generates the `.properties` content. */
  generate: () => string
}

/** All available benchmark payloads, each targeting a different parser code path. */
export const payloads: Payload[] = [
  { name: 'Pure key/value', generate: generatePureKeyValue },
  { name: 'Comment-heavy', generate: generateCommentHeavy },
  { name: 'Whitespace-heavy', generate: generateWhitespaceHeavy },
  { name: 'Unicode escapes', generate: generateUnicodeEscapes },
  { name: 'Multiline values', generate: generateMultilineValues },
  { name: 'Mixed/realistic', generate: generateMixed },
]
