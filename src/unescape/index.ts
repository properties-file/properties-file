import {
  CH_BACKSLASH,
  CH_LOWER_F,
  CH_LOWER_N,
  CH_LOWER_R,
  CH_LOWER_T,
  CH_LOWER_U,
} from '../characters'

/**
 * Convert a hex-digit character code to its numeric value (0-15),
 * or return `-1` if the character is not a valid hex digit.
 *
 * @param charCode - A UTF-16 character code.
 *
 * @returns The hex value (0-15), or `-1` for invalid characters.
 */
const hexValue = (charCode: number): number => {
  if (charCode >= 48 && charCode <= 57) {
    return charCode - 48 // 0-9
  }
  if (charCode >= 65 && charCode <= 70) {
    return charCode - 55 // A-F
  }
  if (charCode >= 97 && charCode <= 102) {
    return charCode - 87 // a-f
  }
  return -1
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
        if (cursor + 4 >= length) {
          throw new Error(
            `malformed escaped unicode characters '${content.slice(cursor - 1, cursor + 5)}'`
          )
        }
        const h1 = hexValue(content.charCodeAt(cursor + 1))
        const h2 = hexValue(content.charCodeAt(cursor + 2))
        const h3 = hexValue(content.charCodeAt(cursor + 3))
        const h4 = hexValue(content.charCodeAt(cursor + 4))
        if (h1 < 0 || h2 < 0 || h3 < 0 || h4 < 0) {
          throw new Error(
            `malformed escaped unicode characters '${content.slice(cursor - 1, cursor + 5)}'`
          )
        }
        unescaped += String.fromCharCode((h1 << 12) | (h2 << 8) | (h3 << 4) | h4)
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
