// ---------------------------------------------------------------------------
// Character codes (ES5-safe charCodeAt constants)
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
 * Unescape a raw `.properties` key or value substring.
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

    if (cursor > segmentStart) {
      unescaped += source.slice(segmentStart, cursor)
    }

    cursor++
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
        const codePoint =
          (hexValue(source.charCodeAt(cursor + 1)) << 12) |
          (hexValue(source.charCodeAt(cursor + 2)) << 8) |
          (hexValue(source.charCodeAt(cursor + 3)) << 4) |
          hexValue(source.charCodeAt(cursor + 4))
        unescaped += String.fromCharCode(codePoint)
        cursor += 5
        break
      }
      default: {
        unescaped += source.charAt(cursor)
        cursor++
        break
      }
    }

    segmentStart = cursor
  }

  if (segmentStart < end) {
    unescaped += source.slice(segmentStart, end)
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
  const sourceLength = source.length
  const result: KeyValuePairObject = {}

  let position = 0
  let lineNumber = 1

  if (sourceLength > 0 && source.charCodeAt(0) === CH_BOM) {
    position = 1
  }

  while (position < sourceLength) {
    position = skipWhitespace(source, position, sourceLength)
    if (position >= sourceLength) {
      break
    }

    let charCode = source.charCodeAt(position)

    if (charCode === CH_LF) {
      position++
      lineNumber++
      continue
    }
    if (charCode === CH_CR) {
      position++
      if (position < sourceLength && source.charCodeAt(position) === CH_LF) {
        position++
      }
      lineNumber++
      continue
    }

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

    const propertyStartLine = lineNumber
    const firstLineStart = position
    let trailingBackslashCount = 0
    let lineHasBackslash = false

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
      const lineEnd = position

      if (position < sourceLength) {
        if (source.charCodeAt(position) === CH_CR) {
          position++
          if (position < sourceLength && source.charCodeAt(position) === CH_LF) {
            position++
          }
        } else {
          position++
        }
        lineNumber++
      }

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

      result[
        unescapeContent(source, firstLineStart, keyEndPosition, lineHasBackslash, propertyStartLine)
      ] = unescapeContent(source, valueStartPosition, lineEnd, lineHasBackslash, propertyStartLine)
    } else {
      const segments: string[] = [source.slice(firstLineStart, position - 1)]
      let logicalLineHasBackslash = lineHasBackslash

      if (position < sourceLength) {
        if (source.charCodeAt(position) === CH_CR) {
          position++
          if (position < sourceLength && source.charCodeAt(position) === CH_LF) {
            position++
          }
        } else {
          position++
        }
        lineNumber++
      }

      position = skipWhitespace(source, position, sourceLength)

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

        if (position < sourceLength) {
          if (source.charCodeAt(position) === CH_CR) {
            position++
            if (position < sourceLength && source.charCodeAt(position) === CH_LF) {
              position++
            }
          } else {
            position++
          }
          lineNumber++
        }

        if (!nextContinuation) {
          break
        }

        position = skipWhitespace(source, position, sourceLength)
      }

      const logicalLine = segments.join('')
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
