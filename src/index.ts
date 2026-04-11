// ---------------------------------------------------------------------------
// Character codes (ES5-safe charCodeAt constants)
// ---------------------------------------------------------------------------

const CH_TAB = 9 // \t
const CH_FF = 12 // \f
const CH_SPACE = 32 // ' '
const CH_BANG = 33 // !
const CH_HASH = 35 // #
const CH_COLON = 58 // :
const CH_EQUALS = 61 // =
const CH_BACKSLASH = 92 // \\
const CH_LOWER_F = 102 // f
const CH_LOWER_N = 110 // n
const CH_LOWER_R = 114 // r
const CH_LOWER_T = 116 // t
const CH_LOWER_U = 117 // u
const CH_BOM = 0xfeff

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A key-value pair object.
 */
export type KeyValuePairObject = {
  [key: string]: string
}

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
    if (charCode !== CH_SPACE && charCode !== CH_TAB && charCode !== CH_FF) {
      break
    }
    pos++
  }
  return pos
}

/**
 * Check whether a character code is a hexadecimal digit (0-9, A-F, a-f).
 *
 * @param charCode - A UTF-16 character code.
 *
 * @returns `true` when the code represents a hex digit.
 */
const isHexDigit = (charCode: number): boolean =>
  (charCode >= 48 && charCode <= 57) || // 0-9
  (charCode >= 65 && charCode <= 70) || // A-F
  (charCode >= 97 && charCode <= 102) // a-f

/**
 * Convert a hex-digit character code to its numeric value (0-15).
 *
 * @param charCode - A UTF-16 character code known to be a valid hex digit.
 *
 * @returns The numeric value of the hex digit.
 */
const hexValue = (charCode: number): number => {
  if (charCode >= 48 && charCode <= 57) {
    return charCode - 48 // 0-9
  }
  if (charCode >= 65 && charCode <= 70) {
    return charCode - 55 // A-F
  }
  return charCode - 87 // a-f
}

/**
 * Unescape a `.properties` string containing escape sequences.
 *
 * @param content - The escaped string to process.
 *
 * @returns The unescaped string.
 *
 * @throws {@link Error} when a malformed `\\uXXXX` sequence is encountered.
 */
const unescapeContent = (content: string): string => {
  const length = content.length
  let unescaped = ''
  let segmentStart = 0
  let cursor = 0

  while (cursor < length) {
    if (content.charCodeAt(cursor) !== CH_BACKSLASH) {
      cursor++
      continue
    }

    if (cursor > segmentStart) {
      unescaped += content.slice(segmentStart, cursor)
    }

    cursor++
    const escapedCharCode = content.charCodeAt(cursor)

    switch (escapedCharCode) {
      case CH_LOWER_N: {
        unescaped += '\n'
        cursor++
        break
      }
      case CH_LOWER_T: {
        unescaped += '\t'
        cursor++
        break
      }
      case CH_LOWER_R: {
        unescaped += '\r'
        cursor++
        break
      }
      case CH_LOWER_F: {
        unescaped += '\f'
        cursor++
        break
      }
      case CH_LOWER_U: {
        if (
          cursor + 4 >= length ||
          !isHexDigit(content.charCodeAt(cursor + 1)) ||
          !isHexDigit(content.charCodeAt(cursor + 2)) ||
          !isHexDigit(content.charCodeAt(cursor + 3)) ||
          !isHexDigit(content.charCodeAt(cursor + 4))
        ) {
          const errorContext = content.slice(cursor - 1, cursor + 5)
          throw new Error(`malformed escaped unicode characters '${errorContext}'`)
        }
        const codePoint =
          (hexValue(content.charCodeAt(cursor + 1)) << 12) |
          (hexValue(content.charCodeAt(cursor + 2)) << 8) |
          (hexValue(content.charCodeAt(cursor + 3)) << 4) |
          hexValue(content.charCodeAt(cursor + 4))
        unescaped += String.fromCharCode(codePoint)
        cursor += 5
        break
      }
      default: {
        unescaped += content.charAt(cursor)
        cursor++
        break
      }
    }

    segmentStart = cursor
  }

  if (segmentStart < length) {
    unescaped += content.slice(segmentStart, length)
  }

  return unescaped
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

  // Strip BOM and split into physical lines using V8's optimized native split.
  const rawContent = source.length > 0 && source.charCodeAt(0) === CH_BOM ? source.slice(1) : source
  const lines = rawContent.split(/\r\n|\r|\n/)
  const lineCount = lines.length
  let lineIndex = 0

  while (lineIndex < lineCount) {
    const line = lines[lineIndex]
    const lineLength = line.length

    // Skip leading whitespace.
    const firstNonWs = skipWhitespace(line, 0, lineLength)

    // Blank line.
    if (firstNonWs >= lineLength) {
      lineIndex++
      continue
    }

    const firstChar = line.charCodeAt(firstNonWs)

    // Comment line.
    if (firstChar === CH_HASH || firstChar === CH_BANG) {
      lineIndex++
      continue
    }

    // ---- Property line ----

    // Count trailing backslashes to detect continuation.
    let trailingBs = 0
    for (let pos = lineLength - 1; pos >= 0 && line.charCodeAt(pos) === CH_BACKSLASH; pos--) {
      trailingBs++
    }
    let isContinuation = trailingBs % 2 === 1

    // Build the logical line.
    let logicalLine: string
    let hasBackslash: boolean

    if (!isContinuation) {
      // Single-line: use content after leading whitespace directly.
      logicalLine = firstNonWs > 0 ? line.slice(firstNonWs) : line
      hasBackslash = logicalLine.indexOf('\\') !== -1
    } else {
      // Multi-line: collect continuation segments.
      const firstSegment = (firstNonWs > 0 ? line.slice(firstNonWs) : line).slice(0, -1)
      const segments: string[] = [firstSegment]
      hasBackslash = firstSegment.indexOf('\\') !== -1

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

        const segment = isContinuation
          ? nextLine.slice(start, nextLength - 1)
          : nextLine.slice(start)
        if (!hasBackslash && segment.indexOf('\\') !== -1) {
          hasBackslash = true
        }
        segments.push(segment)
      }

      logicalLine = segments.join('')
    }

    // Find the key-value separator.
    const logicalLength = logicalLine.length
    let keyEnd = 0
    let hasPrecedingBackslash = false

    while (keyEnd < logicalLength) {
      const charCode = logicalLine.charCodeAt(keyEnd)
      if (charCode === CH_BACKSLASH) {
        hasPrecedingBackslash = !hasPrecedingBackslash
        keyEnd++
        continue
      }
      if (
        !hasPrecedingBackslash &&
        (charCode === CH_EQUALS ||
          charCode === CH_COLON ||
          charCode === CH_SPACE ||
          charCode === CH_TAB ||
          charCode === CH_FF)
      ) {
        break
      }
      hasPrecedingBackslash = false
      keyEnd++
    }

    // Determine where the value begins.
    let valueStart = keyEnd
    if (valueStart < logicalLength) {
      let charCode = logicalLine.charCodeAt(valueStart)
      if (charCode === CH_SPACE || charCode === CH_TAB || charCode === CH_FF) {
        valueStart = skipWhitespace(logicalLine, valueStart, logicalLength)
        if (valueStart < logicalLength) {
          charCode = logicalLine.charCodeAt(valueStart)
        }
      }
      if (valueStart < logicalLength && (charCode === CH_EQUALS || charCode === CH_COLON)) {
        valueStart++
        valueStart = skipWhitespace(logicalLine, valueStart, logicalLength)
      }
    }

    // Unescape and store (last-wins for duplicate keys).
    const escapedKey = logicalLine.slice(0, keyEnd)
    const escapedValue = logicalLine.slice(valueStart)
    result[hasBackslash ? unescapeContent(escapedKey) : escapedKey] = hasBackslash
      ? unescapeContent(escapedValue)
      : escapedValue

    lineIndex++
  }

  return result
}
