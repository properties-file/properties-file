/**
 * Matches malformed Unicode escape sequences: a `\u` not followed by 4 hex digits.
 * Java's `.properties` parser treats `\u12345` as `\u1234` + literal `5`, so only a
 * missing 4th hex digit is invalid.
 */
const REGEX_INVALID_UNICODE_ESCAPE = /\\u(?![0-9a-fA-F]{4})/

/**
 * Captures supported escape sequences: standard (`\\f`, `\\n`, `\\r`, `\\t`), Unicode (`\\uXXXX`),
 * and any other character following a backslash.
 */
const REGEX_ESCAPE = /\\(?:([fnrt])|u([0-9a-fA-F]{4})|(.))/g

/** Maps single-letter escape codes to their actual characters. */
const ESCAPE_MAP = { f: '\f', n: '\n', r: '\r', t: '\t' } as const

/**
 * Tries to unescape the content from either key or value of a property.
 *
 * @param content - The content to unescape.
 *
 * @returns The unescaped content.
 *
 * @throws Error if malformed escaped unicode characters are present.
 */
export const unescapeContent = (content: string): string => {
  // Performance optimization: avoid regex if no escape characters are present.
  if (!content.includes('\\')) {
    return content
  }

  // Validate all \u sequences first. Note: Java has a bug where it attempts to read
  // 4 characters after \u without validating they exist in the input buffer, potentially
  // reading garbage memory. Our implementation properly validates before processing.
  const malformedUnicodeMatch = content.match(REGEX_INVALID_UNICODE_ESCAPE)
  if (malformedUnicodeMatch) {
    const startIndex = malformedUnicodeMatch.index!
    const errorContext = content.slice(startIndex, startIndex + 6)
    throw new Error(`malformed escaped unicode characters '${errorContext}'`)
  }

  // Process all valid escape sequences.
  return content.replace(
    REGEX_ESCAPE,
    (_match: string, regularEscape?: string, unicodeHex?: string, otherChar?: string): string => {
      if (regularEscape) {
        // Handle standard escape sequences.
        return ESCAPE_MAP[regularEscape as keyof typeof ESCAPE_MAP]
      }

      if (unicodeHex) {
        // Handle valid \uXXXX sequences.
        return String.fromCodePoint(Number.parseInt(unicodeHex, 16))
      }

      // Handle any other character after \ (taken literally per Java behavior).
      return otherChar!
    }
  )
}
