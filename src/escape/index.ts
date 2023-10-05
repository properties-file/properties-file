/**
 * Escape a property key.
 *
 * @param unescapedKey - A property key to be escaped.
 * @param escapeUnicode - Escape unicode characters into ISO-8859-1 compatible encoding?
 *
 * @return The escaped key.
 */
export const escapeKey = (unescapedKey: string, escapeUnicode = false): string => {
  return escapeContent(unescapedKey, true, escapeUnicode)
}

/**
 * Escape property value.
 *
 * @param unescapedValue - Property value to be escaped.
 * @param escapeUnicode - Escape unicode characters into ISO-8859-1 compatible encoding?
 *
 * @return The escaped value.
 */
export const escapeValue = (unescapedValue: string, escapeUnicode = false): string => {
  return escapeContent(unescapedValue, false, escapeUnicode)
}

/**
 * Escape the content from either key or value of a property.
 *
 * @param unescapedContent - The content to escape.
 * @param escapeSpace - Escape spaces?
 * @param escapeUnicode - Escape unicode characters into ISO-8859-1 compatible encoding?
 *
 * @returns The unescaped content.
 */
const escapeContent = (
  unescapedContent: string,
  escapeSpace: boolean,
  escapeUnicode: boolean
): string =>
  // By using a regular expression we avoid iterating through all characters and improve performance.
  unescapedContent.replace(/[\s!#:=\\]|[^\u0020-\u007E]/g, (character) => {
    switch (character) {
      case ' ': {
        // Escape space if required, or if it's the first character.
        return escapeSpace || character === unescapedContent[0] ? '\\ ' : ' '
      }
      case '\\': {
        // Backslash.
        return '\\\\'
      }
      case '\f': {
        // Formfeed.
        return '\\f'
      }
      case '\n': {
        // Newline.
        return '\\n'
      }
      case '\r': {
        // Carriage return.
        return '\\r'
      }
      case '\t': {
        // Tab.
        return '\\t'
      }
      case '=':
      case ':':
      case '#':
      case '!': {
        // =, :, # and !.
        return `\\${character}`
      }
      default: {
        if (escapeUnicode) {
          const codePoint: number = character.codePointAt(0) as number // Can never be `undefined`.
          if (codePoint < 0x0020 || codePoint > 0x007e) {
            // Any character that is not in the range of ASCII printable characters.
            return `\\u${codePoint.toString(16).padStart(4, '0')}`
          }
        }
        return character
      }
    }
  })
