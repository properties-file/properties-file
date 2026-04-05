import type { KeyValuePairObject } from '.'

// ---------------------------------------------------------------------------
// Character codes (ES5-safe charCodeAt constants)
//
// Using numeric codes instead of string comparisons avoids allocating
// short-lived strings on every character check, which is the single
// biggest micro-optimization in this hot path.
// ---------------------------------------------------------------------------

const CH_TAB = 9 // \t
const CH_LF = 10 // \n
const CH_FF = 12 // \f
const CH_CR = 13 // \r
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Skip whitespace characters (space, tab, form feed) from a given position.
 *
 * @param str - The string to scan.
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
 * @returns `true` when the code represents a hex digit.
 */
const isHexDigit = (charCode: number): boolean =>
  (charCode >= 48 && charCode <= 57) || // 0-9
  (charCode >= 65 && charCode <= 70) || // A-F
  (charCode >= 97 && charCode <= 102) // a-f

/**
 * Convert a hex-digit character code to its numeric value (0-15).
 *
 * Uses arithmetic instead of `parseInt()` to avoid per-call string
 * allocation and parsing overhead in the hot Unicode-escape path.
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
 * Unescape a raw `.properties` key or value substring directly from the
 * source string, avoiding an intermediate `slice()` allocation.
 *
 * Uses a segment-based approach: scans for backslashes, flushes the literal
 * text between them in bulk via `slice()`, and only builds new characters
 * for actual escape sequences. This avoids character-by-character string
 * concatenation for the common case (mostly literal text with few escapes).
 *
 * When `hasBackslash` is `false`, the caller already knows no escapes are
 * present and the function returns the raw substring immediately.
 *
 * @param source - The full source string (or logical line).
 * @param start - Start index of the substring to unescape.
 * @param end - End index (exclusive) of the substring to unescape.
 * @param hasBackslash - Whether the substring contains any backslashes.
 * @param startLine - Line number of the property (used in error messages).
 *
 * @returns The unescaped string.
 *
 * @throws {@link Error} when a malformed `\\uXXXX` sequence is encountered.
 */
const unescapeContent = (
  source: string,
  start: number,
  end: number,
  hasBackslash: boolean,
  startLine: number
): string => {
  // Fast path: no backslashes means nothing to unescape — just slice once.
  if (!hasBackslash) {
    return source.slice(start, end)
  }

  let unescaped = ''
  let segmentStart = start
  let cursor = start

  while (cursor < end) {
    if (source.charCodeAt(cursor) !== CH_BACKSLASH) {
      cursor++
      continue
    }

    // Flush the literal segment preceding this backslash.
    if (cursor > segmentStart) {
      unescaped += source.slice(segmentStart, cursor)
    }

    cursor++ // Advance past the backslash.
    const escapedCharCode = source.charCodeAt(cursor)

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
        // \uXXXX — require exactly 4 hex digits after the 'u'.
        if (
          cursor + 4 >= end ||
          !isHexDigit(source.charCodeAt(cursor + 1)) ||
          !isHexDigit(source.charCodeAt(cursor + 2)) ||
          !isHexDigit(source.charCodeAt(cursor + 3)) ||
          !isHexDigit(source.charCodeAt(cursor + 4))
        ) {
          const errorContext = source.slice(cursor - 1, cursor + 5)
          throw new Error(
            `malformed escaped unicode characters '${errorContext}' in property starting at line ${startLine}`
          )
        }
        // Compute the code point via bit-shifting instead of parseInt().
        // Each hex digit occupies 4 bits, so we shift left by 12, 8, 4, 0.
        const codePoint =
          (hexValue(source.charCodeAt(cursor + 1)) << 12) |
          (hexValue(source.charCodeAt(cursor + 2)) << 8) |
          (hexValue(source.charCodeAt(cursor + 3)) << 4) |
          hexValue(source.charCodeAt(cursor + 4))
        unescaped += String.fromCharCode(codePoint)
        cursor += 5 // Skip past 'u' + 4 hex digits.
        break
      }
      default: {
        // Any other character after backslash is taken literally (Java behaviour).
        unescaped += source.charAt(cursor)
        cursor++
        break
      }
    }

    // The next literal segment starts after the escape sequence we just processed.
    segmentStart = cursor
  }

  // Flush the remaining literal segment (text after the last escape).
  if (segmentStart < end) {
    unescaped += source.slice(segmentStart, end)
  }

  return unescaped
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a `.properties` file content string into a key-value pair object.
 *
 * This is a functional, single-pass parser that implements the Java
 * `java.util.Properties` specification:
 *
 * - BOM detection and skipping
 * - Comment lines (`#` or `!`)
 * - Line continuations (trailing odd backslash)
 * - Key-value separator detection (`=`, `:`, or whitespace)
 * - Escape sequence processing (`\\n`, `\\t`, `\\r`, `\\f`, `\\\\`, `\\uXXXX`)
 * - Last-value-wins semantics for duplicate keys
 *
 * All character inspection uses `charCodeAt()` (ES5). No regex, no
 * intermediate object allocations.
 *
 * @param content - The content of a `.properties` file (string or Buffer).
 *
 * @returns A key-value pair object where every value is a string.
 */
export const parseProperties = (content: string | Buffer): KeyValuePairObject => {
  const source = typeof content === 'string' ? content : content.toString()
  const sourceLength = source.length
  const result: KeyValuePairObject = {}

  let position = 0
  let lineNumber = 1

  // Skip BOM (byte-order mark) if present at the start of the file.
  if (sourceLength > 0 && source.charCodeAt(0) === CH_BOM) {
    position = 1
  }

  // ---- Main loop: one iteration per logical line (property, comment, or blank) ----
  while (position < sourceLength) {
    // Skip leading whitespace at the start of a physical line.
    position = skipWhitespace(source, position, sourceLength)
    if (position >= sourceLength) {
      break
    }

    let charCode = source.charCodeAt(position)

    // ---- Blank line (bare newline after whitespace was skipped) ----
    if (charCode === CH_LF) {
      position++
      lineNumber++
      continue
    }
    if (charCode === CH_CR) {
      position++
      // Handle CRLF as a single newline.
      if (position < sourceLength && source.charCodeAt(position) === CH_LF) {
        position++
      }
      lineNumber++
      continue
    }

    // ---- Comment line (# or !) — skip to end of line ----
    if (charCode === CH_HASH || charCode === CH_BANG) {
      while (position < sourceLength) {
        charCode = source.charCodeAt(position)
        if (charCode === CH_LF) {
          position++
          lineNumber++
          break
        }
        if (charCode === CH_CR) {
          position++
          if (position < sourceLength && source.charCodeAt(position) === CH_LF) {
            position++
          }
          lineNumber++
          break
        }
        position++
      }
      continue
    }

    // ---- Parse a property (key = value) ----
    const propertyStartLine = lineNumber

    // Step 1: Collect the logical line by joining physical continuation lines.
    //
    // A trailing odd number of backslashes means the line continues on
    // the next physical line. The continuation backslash is stripped and
    // leading whitespace on the next line is skipped.
    //
    // Optimization: most properties are single-line. We scan the first
    // physical line and only allocate a `logicalLine` string if we encounter
    // a continuation. Otherwise we work directly on the source string using
    // start/end offsets (zero-copy).

    const firstLineStart = position
    let trailingBackslashCount = 0
    let lineHasBackslash = false

    // Scan to the end of the first physical line.
    while (position < sourceLength) {
      charCode = source.charCodeAt(position)
      if (charCode === CH_LF || charCode === CH_CR) {
        break
      }
      if (charCode === CH_BACKSLASH) {
        trailingBackslashCount++
        lineHasBackslash = true
      } else {
        trailingBackslashCount = 0
      }
      position++
    }

    const isContinuation = trailingBackslashCount % 2 === 1

    if (!isContinuation) {
      // ---- Fast path: single-line property (no continuation) ----
      // Work directly on the source string — no logicalLine allocation.
      const lineEnd = position

      // Advance past the newline character(s).
      if (position < sourceLength) {
        if (source.charCodeAt(position) === CH_CR) {
          position++
          if (position < sourceLength && source.charCodeAt(position) === CH_LF) {
            position++
          }
        } else {
          position++ // LF
        }
        lineNumber++
      }

      // Step 2: Find the key-value separator directly on the source.
      let keyEndPosition = firstLineStart
      let hasPrecedingBackslash = false

      while (keyEndPosition < lineEnd) {
        charCode = source.charCodeAt(keyEndPosition)

        if (charCode === CH_BACKSLASH) {
          hasPrecedingBackslash = !hasPrecedingBackslash
          keyEndPosition++
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
        keyEndPosition++
      }

      // Step 3: Determine where the value begins.
      let valueStartPosition = keyEndPosition

      if (valueStartPosition < lineEnd) {
        charCode = source.charCodeAt(valueStartPosition)

        if (charCode === CH_SPACE || charCode === CH_TAB || charCode === CH_FF) {
          valueStartPosition = skipWhitespace(source, valueStartPosition, lineEnd)
          if (valueStartPosition < lineEnd) {
            charCode = source.charCodeAt(valueStartPosition)
          }
        }

        if (valueStartPosition < lineEnd && (charCode === CH_EQUALS || charCode === CH_COLON)) {
          valueStartPosition++
          valueStartPosition = skipWhitespace(source, valueStartPosition, lineEnd)
        }
      }

      // Step 4: Unescape directly from the source string — no intermediate slice.
      result[
        unescapeContent(source, firstLineStart, keyEndPosition, lineHasBackslash, propertyStartLine)
      ] = unescapeContent(source, valueStartPosition, lineEnd, lineHasBackslash, propertyStartLine)
    } else {
      // ---- Slow path: multi-line property (has continuation) ----
      // Collect segments as slices and join once at the end to avoid
      // repeated string concatenation overhead.
      const segments: string[] = [source.slice(firstLineStart, position - 1)] // Strip trailing backslash.
      let logicalLineHasBackslash = lineHasBackslash

      // Advance past the newline.
      if (position < sourceLength) {
        if (source.charCodeAt(position) === CH_CR) {
          position++
          if (position < sourceLength && source.charCodeAt(position) === CH_LF) {
            position++
          }
        } else {
          position++ // LF
        }
        lineNumber++
      }

      // Continuation line: skip leading whitespace before appending.
      position = skipWhitespace(source, position, sourceLength)

      // Continue scanning continuation lines.
      for (;;) {
        const physicalLineStart = position
        trailingBackslashCount = 0
        let continuationHasBackslash = false

        while (position < sourceLength) {
          charCode = source.charCodeAt(position)
          if (charCode === CH_LF || charCode === CH_CR) {
            break
          }
          if (charCode === CH_BACKSLASH) {
            trailingBackslashCount++
            continuationHasBackslash = true
          } else {
            trailingBackslashCount = 0
          }
          position++
        }

        const nextContinuation = trailingBackslashCount % 2 === 1
        const physicalLineEnd = nextContinuation ? position - 1 : position

        segments.push(source.slice(physicalLineStart, physicalLineEnd))
        if (continuationHasBackslash) {
          logicalLineHasBackslash = true
        }

        // Advance past the newline.
        if (position < sourceLength) {
          if (source.charCodeAt(position) === CH_CR) {
            position++
            if (position < sourceLength && source.charCodeAt(position) === CH_LF) {
              position++
            }
          } else {
            position++ // LF
          }
          lineNumber++
        }

        if (!nextContinuation) {
          break
        }

        // Skip leading whitespace on continuation line.
        position = skipWhitespace(source, position, sourceLength)
      }

      // Join all segments into the logical line once.
      const logicalLine = segments.join('')

      // Step 2: Find the key-value separator on the logical line.
      const logicalLineLength = logicalLine.length
      let keyEndPosition = 0
      let hasPrecedingBackslash = false

      while (keyEndPosition < logicalLineLength) {
        charCode = logicalLine.charCodeAt(keyEndPosition)

        if (charCode === CH_BACKSLASH) {
          hasPrecedingBackslash = !hasPrecedingBackslash
          keyEndPosition++
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
        keyEndPosition++
      }

      // Step 3: Determine where the value begins.
      let valueStartPosition = keyEndPosition

      if (valueStartPosition < logicalLineLength) {
        charCode = logicalLine.charCodeAt(valueStartPosition)

        if (charCode === CH_SPACE || charCode === CH_TAB || charCode === CH_FF) {
          valueStartPosition = skipWhitespace(logicalLine, valueStartPosition, logicalLineLength)
          if (valueStartPosition < logicalLineLength) {
            charCode = logicalLine.charCodeAt(valueStartPosition)
          }
        }

        if (
          valueStartPosition < logicalLineLength &&
          (charCode === CH_EQUALS || charCode === CH_COLON)
        ) {
          valueStartPosition++
          valueStartPosition = skipWhitespace(logicalLine, valueStartPosition, logicalLineLength)
        }
      }

      // Step 4: Unescape and store.
      result[
        unescapeContent(logicalLine, 0, keyEndPosition, logicalLineHasBackslash, propertyStartLine)
      ] = unescapeContent(
        logicalLine,
        valueStartPosition,
        logicalLineLength,
        logicalLineHasBackslash,
        propertyStartLine
      )
    }
  }

  return result
}
