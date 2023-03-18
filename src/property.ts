import { PropertyLine } from './property-line'

/**
 * Object representing a property (key/value).
 */
export class Property {
  /** The length of the delimiter, including its whitespace characters. */
  public delimiterLength: number | undefined
  /** The starting position of the delimiter separating the key from the value. */
  public delimiterPosition: number | undefined
  /** The property key, including its escaped characters. */
  public escapedKey = ''
  /** The property value, including its escaped characters. */
  public escapedValue = ''
  /** Was the property's key used more than once? */
  public hasKeyCollisions = false
  /** The property key (unescaped). */
  public key = ''
  /** Starting line numbers of property objects with the same key. */
  public keyCollisionLines: number[] = []
  /** The content of one or multiple lines when applicable. */
  public linesContent: string
  /** Positions of the newline characters if any. */
  public newlinePositions: number[] = []
  /** The line number at which the property starts. */
  public startingLineNumber: number
  /** The property value (unescaped). */
  public value = ''

  /** Does the key definition spread across multiple lines? */
  private hasMultilineKey = false
  /** Is the key empty? */
  private hasNoKey = false
  /** Is the value empty? */
  private hasNoValue = false

  /**
   * Create a new property object.
   *
   * @param propertyLine - A property line object.
   * @param startingLineNumber - The line number at which the property starts.
   */
  constructor(propertyLine: PropertyLine, startingLineNumber: number) {
    this.linesContent = propertyLine.content
    this.startingLineNumber = startingLineNumber
  }

  /**
   * Add the a line to a multiline property object.
   *
   * @param propertyLine - A property line object.
   */
  public addLine(propertyLine: PropertyLine): void {
    if (this.linesContent.length > 0) {
      this.newlinePositions.push(this.linesContent.length)
    }
    this.linesContent += propertyLine.content
  }

  /**
   * Set the property's key and value.
   */
  public setKeyAndValue(): void {
    this.findDelimiter()

    if (this.delimiterPosition !== undefined && this.delimiterLength !== undefined) {
      // Set key if present.
      if (!this.hasNoKey) {
        this.escapedKey = this.linesContent.slice(0, this.delimiterPosition)
        this.key = Property.unescape(this.escapedKey, this.startingLineNumber)
      }

      // Set value if present.
      if (!this.hasNoValue) {
        this.escapedValue = this.linesContent.slice(this.delimiterPosition + this.delimiterLength)
        this.value = Property.unescape(this.escapedValue, this.startingLineNumber)
      }
    } else if (this.hasNoValue) {
      // Set key if present (no delimiter).
      this.escapedKey = this.linesContent
      this.key = Property.unescape(this.escapedKey, this.startingLineNumber)
    }
  }

  /**
   * Unescape the content from either key or value of a property.
   *
   * @param escapedContent - The content to unescape.
   * @param startingLineNumber - The starting line number of the content being unescaped.
   *
   * @returns The unescaped content.
   */
  public static unescape(escapedContent: string, startingLineNumber: number): string {
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
            // Formfeed/
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
              throw new Error(
                `malformed escaped unicode characters '\\u${codePoint}' in property starting at line ${startingLineNumber}`
              )
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

  /**
   * Escape property key.
   *
   * @param unescapedKey Property key to be escaped.
   * @return Escaped string.
   */
  public static escapeKey(unescapedKey: string, escapeUnicode = true): string {
    return Property.escape(unescapedKey, true, escapeUnicode)
  }

  /**
   * Escape property value.
   *
   * @param unescapedValue Property value to be escaped.
   * @return Escaped string.
   */
  public static escapeValue(unescapedValue: string, escapeUnicode = true): string {
    return Property.escape(unescapedValue, false, escapeUnicode)
  }

  /**
   * Internal escape method.
   *
   * @param unescapedContent Text to be escaped.
   * @param escapeSpace Whether all spaces should be escaped
   * @param escapeUnicode Whether unicode chars should be escaped
   * @return Escaped string.
   */
  private static escape(
    unescapedContent: string,
    escapeSpace: boolean,
    escapeUnicode: boolean
  ): string {
    const result: string[] = []

    // eslint-disable-next-line unicorn/no-for-loop
    for (let index = 0; index < unescapedContent.length; index++) {
      const char = unescapedContent[index]
      switch (char) {
        case ' ': {
          // Escape space if required, or if it is first character
          if (escapeSpace || index === 0) {
            result.push('\\ ')
          } else {
            result.push(' ')
          }
          break
        }
        case '\\': {
          result.push('\\\\')
          break
        }
        case '\f': {
          // Form-feed
          result.push('\\f')
          break
        }
        case '\n': {
          // Newline
          result.push('\\n')
          break
        }
        case '\r': {
          // Carriage return
          result.push('\\r')
          break
        }
        case '\t': {
          // Tab
          result.push('\\t')
          break
        }
        case '=': // Fall through
        case ':': // Fall through
        case '#': // Fall through
        case '!': {
          result.push('\\', char)
          break
        }
        default: {
          if (escapeUnicode) {
            const codePoint: number = char.codePointAt(0) as number // can never be undefined
            if (codePoint < 0x0020 || codePoint > 0x007e) {
              result.push('\\u', codePoint.toString(16).padStart(4, '0'))
              break
            }
          }
          // Normal char
          result.push(char)
          break
        }
      }
    }

    return result.join('')
  }

  /**
   * Find the delimiting characters separating the key from the value.
   */
  private findDelimiter(): void {
    // If the delimiter was already found, skip.
    if (this.hasNoKey || this.hasNoValue || this.delimiterPosition) {
      return
    }

    for (
      let character = this.linesContent[0], position = 0;
      position < this.linesContent.length;
      position++, character = this.linesContent[position]
    ) {
      // If the character is not a delimiter, check the next one.
      if (!/[\t\f :=]/.test(character)) {
        continue
      }

      // Check if the delimiter might be escaped.
      const prefix = position ? this.linesContent.slice(0, position) : ''

      if (prefix.length > 0) {
        const backslashMatch = prefix.match(/(?<backslashes>\\+)$/)
        if (backslashMatch?.groups) {
          const delimiterIsEscaped = !!(backslashMatch.groups.backslashes.length % 2)
          if (delimiterIsEscaped) {
            // If the delimiter is escaped, check the next character.
            continue
          }
        }
      }

      let delimiter = ''
      this.delimiterPosition = position
      this.hasMultilineKey = !!(
        this.newlinePositions.length > 0 && this.newlinePositions[0] > position
      )

      // Check if the delimiter starts with a whitespace.
      let nextContent = this.linesContent.slice(position)
      const leadingWhitespaceMatch = nextContent.match(/^(?<whitespace>\s+)/)
      const leadingWhitespace = leadingWhitespaceMatch?.groups?.whitespace || ''

      // If there is a whitespace, move to the next character.
      if (leadingWhitespace.length > 0) {
        delimiter += leadingWhitespace
        nextContent = nextContent.slice(leadingWhitespace.length)
      }

      // Check if there is an equal or colon character.
      if (/[:=]/.test(nextContent[0])) {
        delimiter += nextContent[0]
        nextContent = nextContent.slice(1)
        // If an equal or colon character was found, try to get trailing whitespace.
        const trailingWhitespaceMatch = nextContent.match(/^(?<whitespace>\s+)/)
        const trailingWhitespace = trailingWhitespaceMatch?.groups?.whitespace || ''
        delimiter += trailingWhitespace
      }

      this.delimiterLength = delimiter.length

      // If the line starts with a delimiter, the property has no key.
      if (!position) {
        this.hasNoKey = true
      }

      break
    }

    // If there was no delimiter found, the property has no value.
    if (this.delimiterPosition === undefined) {
      this.hasNoValue = true
    } else {
      // If the delimiter is after the first newline, mark the key as multiline.
      if (this.newlinePositions.length > 0) {
        const firstLinePosition = this.newlinePositions[0]
        if (firstLinePosition > this.delimiterPosition) {
          this.hasMultilineKey = true
        }
      }
    }
  }
}
