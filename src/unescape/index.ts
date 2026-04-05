// ---------------------------------------------------------------------------
// Character codes
// ---------------------------------------------------------------------------

const CH_BACKSLASH = 92 // \\
const CH_LOWER_F = 102 // f
const CH_LOWER_N = 110 // n
const CH_LOWER_R = 114 // r
const CH_LOWER_T = 116 // t
const CH_LOWER_U = 117 // u

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
 * @param charCode - A UTF-16 character code known to be a valid hex digit.
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
 * Tries to unescape the content from either key or value of a property.
 *
 * Uses a single-pass, segment-based approach with `charCodeAt()` instead of
 * regex. Scans for backslashes, flushes literal text in bulk via `slice()`,
 * and only builds new characters for actual escape sequences.
 *
 * @param content - The content to unescape.
 *
 * @returns The unescaped content.
 *
 * @throws Error if malformed escaped unicode characters are present.
 */
export const unescapeContent = (content: string): string => {
  // Fast path: no backslashes means nothing to unescape.
  if (content.indexOf('\\') === -1) {
    return content
  }

  const length = content.length
  let unescaped = ''
  let segmentStart = 0
  let cursor = 0

  while (cursor < length) {
    if (content.charCodeAt(cursor) !== CH_BACKSLASH) {
      cursor++
      continue
    }

    // Flush the literal segment preceding this backslash.
    if (cursor > segmentStart) {
      unescaped += content.slice(segmentStart, cursor)
    }

    cursor++ // Advance past the backslash.

    // Trailing backslash with nothing after it — keep it as a literal character.
    if (cursor >= length) {
      unescaped += '\\'
      segmentStart = cursor
      break
    }

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
        // \uXXXX — require exactly 4 hex digits after the 'u'.
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
        // Any other character after backslash is taken literally (Java behaviour).
        unescaped += content.charAt(cursor)
        cursor++
        break
      }
    }

    segmentStart = cursor
  }

  // Flush the remaining literal segment.
  if (segmentStart < length) {
    unescaped += content.slice(segmentStart, length)
  }

  return unescaped
}
