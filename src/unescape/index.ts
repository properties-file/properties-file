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
export const unescapeContent = (escapedContent: string): string => {
  let unescapedContent = ''
  for (
    let character = escapedContent[0], position = 0;
    position < escapedContent.length;
    position++, character = escapedContent[position]
  ) {
    if (character === '\\') {
      const nextCharacter = escapedContent[position + 1]

      switch (nextCharacter) {
        case 'f': {
          // Formfeed.
          unescapedContent += '\f'
          position++
          break
        }
        case 'n': {
          // Newline.
          unescapedContent += '\n'
          position++
          break
        }
        case 'r': {
          // Carriage return.
          unescapedContent += '\r'
          position++
          break
        }
        case 't': {
          // Tab.
          unescapedContent += '\t'
          position++
          break
        }
        case 'u': {
          // Unicode character.
          const codePoint = escapedContent.slice(position + 2, position + 6)
          if (!/[\da-f]{4}/i.test(codePoint)) {
            // Code point can only be within Unicode's Multilingual Plane (BMP).
            throw new Error(`malformed escaped unicode characters '\\u${codePoint}'`)
          }
          unescapedContent += String.fromCodePoint(Number.parseInt(codePoint, 16))
          position += 5
          break
        }
        default: {
          // Otherwise the escape character is not required.
          unescapedContent += nextCharacter
          position++
        }
      }
    } else {
      // When there is \, simply add the character.
      unescapedContent += character
    }
  }

  return unescapedContent
}
