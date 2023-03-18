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
): string => {
  let escapedContent = ''
  for (
    let character = unescapedContent[0], position = 0;
    position < unescapedContent.length;
    position++, character = unescapedContent[position]
  ) {
    switch (character) {
      case ' ': {
        // Escape space if required, or if it is first character.
        escapedContent += escapeSpace || position === 0 ? '\\ ' : ' '
        break
      }
      // Backslash.
      case '\\': {
        escapedContent += '\\\\'
        break
      }
      case '\f': {
        // Formfeed.
        escapedContent += '\\f'
        break
      }
      case '\n': {
        // Newline.
        escapedContent += '\\n'
        break
      }
      case '\r': {
        // Carriage return.
        escapedContent += '\\r'
        break
      }
      case '\t': {
        // Tab.
        escapedContent += '\\t'
        break
      }
      case '=':
      case ':':
      case '#':
      case '!': {
        // Escapes =, :, # and !.
        escapedContent += `\\${character}`
        break
      }
      default: {
        if (escapeUnicode) {
          const codePoint: number = character.codePointAt(0) as number // Can never be `undefined`.
          if (codePoint < 0x0020 || codePoint > 0x007e) {
            escapedContent += `\\u${codePoint.toString(16).padStart(4, '0')}`
            break
          }
        }
        // Non-escapable characters.
        escapedContent += character
        break
      }
    }
  }

  return escapedContent
}
