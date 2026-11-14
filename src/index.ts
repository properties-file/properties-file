import {
  CH_BACKSLASH,
  CH_BANG,
  CH_BOM,
  CH_COLON,
  CH_EQUALS,
  CH_FF,
  CH_HASH,
  CH_SPACE,
  CH_TAB,
} from './characters'
import { unescapeContent } from './unescape'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A key-value pair object.
 */
export type KeyValuePairObject = Record<string, string>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Skip whitespace characters (space, tab, form feed) from a given position.
 *
 * @param string - The string to scan.
 * @param pos - The starting position.
 * @param limit - The end boundary (exclusive).
 *
 * @returns The position of the first non-whitespace character, or `limit`.
 */
const skipWhitespace = (string: string, pos: number, limit: number): number => {
  while (pos < limit) {
    const charCode = string.charCodeAt(pos)
    if (![CH_SPACE, CH_TAB, CH_FF].includes(charCode)) {
      break
    }
    pos++
  }
  return pos
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Converts the content of a `.properties` file to a key-value pair object.
 *
 * This is a self-contained, zero-dependency parser optimized for minimal
 * bundle size. It implements the Java `java.util.Properties` specification:
 *
 * - BOM detection and skipping
 * - Comment lines (`#` or `!`)
 * - Line continuations (trailing odd backslash)
 * - Key-value separator detection (`=`, `:`, or whitespace)
 * - Escape sequence processing (`\\n`, `\\t`, `\\r`, `\\f`, `\\\\`, `\\uXXXX`)
 * - Last-value-wins semantics for duplicate keys
 *
 * @param content - The content of a `.properties` file.
 *
 * @returns A key/value object representing the content of a `.properties` file.
 */
export const getProperties = (content: string | Buffer): KeyValuePairObject => {
  const source = typeof content === 'string' ? content : content.toString()
  const result: KeyValuePairObject = {}

  // Strip BOM and split into physical lines using V8's optimized native split. No length check
  // is needed before reading the first character: on an empty string it reads as `NaN`.
  const lines = (source.charCodeAt(0) === CH_BOM ? source.slice(1) : source).split(/\r\n|\r|\n/)
  const lineCount = lines.length

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
    const line = lines[lineIndex]
    const lineLength = line.length

    // Skip leading whitespace.
    const firstNonWs = skipWhitespace(line, 0, lineLength)

    // Blank line.
    if (firstNonWs >= lineLength) {
      continue
    }

    const firstChar = line.charCodeAt(firstNonWs)

    // Comment line.
    if (firstChar === CH_HASH || firstChar === CH_BANG) {
      continue
    }

    // ---- Property line ----

    // Count trailing backslashes to detect continuation.
    let trailingBs = 0
    for (let pos = lineLength - 1; pos >= 0 && line.charCodeAt(pos) === CH_BACKSLASH; pos--) {
      trailingBs++
    }
    let isContinuation = trailingBs % 2 === 1

    // Build the logical line, starting from the content after leading whitespace.
    let logicalLine = firstNonWs > 0 ? line.slice(firstNonWs) : line

    if (isContinuation) {
      // Multi-line: collect continuation segments, each without its trailing backslash.
      const segments: string[] = [logicalLine.slice(0, -1)]

      while (isContinuation && lineIndex + 1 < lineCount) {
        lineIndex++
        const nextLine = lines[lineIndex]
        const nextLength = nextLine.length

        // Skip leading whitespace on continuation line.
        const start = skipWhitespace(nextLine, 0, nextLength)

        // Check continuation on this line.
        trailingBs = 0
        for (
          let pos = nextLength - 1;
          pos >= start && nextLine.charCodeAt(pos) === CH_BACKSLASH;
          pos--
        ) {
          trailingBs++
        }
        isContinuation = trailingBs % 2 === 1

        segments.push(
          isContinuation ? nextLine.slice(start, nextLength - 1) : nextLine.slice(start)
        )
      }

      logicalLine = segments.join('')
    }

    // Without any backslash there is nothing to unescape, in the key or in the value.
    const hasBackslash = logicalLine.includes('\\')

    // Find the key-value separator.
    const logicalLength = logicalLine.length
    let keyEnd = 0
    let hasPrecedingBackslash = false

    for (; keyEnd < logicalLength; keyEnd++) {
      const charCode = logicalLine.charCodeAt(keyEnd)
      if (charCode === CH_BACKSLASH) {
        hasPrecedingBackslash = !hasPrecedingBackslash
      } else if (hasPrecedingBackslash) {
        hasPrecedingBackslash = false
      } else if ([CH_EQUALS, CH_COLON, CH_SPACE, CH_TAB, CH_FF].includes(charCode)) {
        break
      }
    }

    // Determine where the value begins: after the whitespace following the key, then after one
    // `=` or `:` and the whitespace following it. No bounds check is needed: past the end of
    // the line, `skipWhitespace` returns its position unchanged and the character reads as
    // `NaN`, which is neither separator.
    let valueStart = skipWhitespace(logicalLine, keyEnd, logicalLength)
    const separatorCharCode = logicalLine.charCodeAt(valueStart)
    if (separatorCharCode === CH_EQUALS || separatorCharCode === CH_COLON) {
      valueStart = skipWhitespace(logicalLine, valueStart + 1, logicalLength)
    }

    // Unescape and store (last-wins for duplicate keys).
    const escapedKey = logicalLine.slice(0, keyEnd)
    const escapedValue = logicalLine.slice(valueStart)
    const key = hasBackslash ? unescapeContent(escapedKey) : escapedKey
    const value = hasBackslash ? unescapeContent(escapedValue) : escapedValue
    if (key === '__proto__') {
      // A plain assignment to `__proto__` goes through the setter inherited from
      // `Object.prototype`, which ignores a string: the key would be silently dropped.
      // Defining it creates a regular own property instead, as `JSON.parse` does on the
      // same engines. On Node.js 0.4, where `__proto__` is built into every object, the key
      // still does not appear in the result.
      Object.defineProperty(result, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    } else {
      result[key] = value
    }
  }

  return result
}
