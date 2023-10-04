/**
 * Unescape the content from either key or value of a property.
 *
 * @param escapedContent - The content to unescape.
 *
 * @returns The unescaped content.
 *
 * @throws {@link Error}
 * This exception is thrown if malformed escaped unicode characters are present.
 */
export const unescapeContent = (escapedContent: string): string =>
  escapedContent.replace(/\\[^u]|\\u.{4}/g, (escapeSequence: string): string => {
    const nextCharacter = escapeSequence.charAt(1)
    switch (nextCharacter) {
      case 'f': {
        // Formfeed.
        return '\f'
      }
      case 'n': {
        // Newline.
        return '\n'
      }
      case 'r': {
        // Carriage return.
        return '\r'
      }
      case 't': {
        // Tab.
        return '\t'
      }
      case 'u': {
        // Unicode character.
        const codePoint = escapeSequence.slice(2, 6)
        if (!/[\da-f]{4}/i.test(codePoint)) {
          // Code point can only be within Unicode's Multilingual Plane (BMP).
          throw new Error(`malformed escaped unicode characters '\\u${codePoint}'`)
        }
        return String.fromCodePoint(Number.parseInt(codePoint, 16))
      }
      default: {
        return nextCharacter
      }
    }
  })
