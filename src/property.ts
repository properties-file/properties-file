import { PropertyLine } from './property-line'

/**
 * Object representing a property (key/value).
 */
export class Property {
  /** The line number at which the property starts. */
  public startingLineNumber: number
  /** The content of one or multiple lines when applicable. */
  public linesContent: string
  /** Positions of the newline characters if any. */
  public newlinePositions: number[] = []
  /** Starting line numbers of property objects with the same key. */
  public keyCollisionLines: number[] = []
  /** The starting position of the delimiter separating the key from the value. */
  public delimiterPosition: number | undefined
  /** The length of the delimiter, including its whitespace characters. */
  public delimiterLength: number | undefined

  /** The property key, including its escaped characters. */
  public escapedKey = ''
  /** The property value, including its escaped characters. */
  public escapedValue = ''

  /** The property key (unescaped). */
  public key = ''
  /** The property value (unescaped). */
  public value = ''

  /** Was the property's key used more than once? */
  public hasKeyCollisions = false
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
    if (this.linesContent.length) {
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
        this.escapedKey = this.linesContent.substring(0, this.delimiterPosition)
        this.key = this.unescape(this.escapedKey, this.startingLineNumber)
      }

      // Set value if present.
      if (!this.hasNoValue) {
        this.escapedValue = this.linesContent.substring(
          this.delimiterPosition + this.delimiterLength
        )
        this.value = this.unescape(this.escapedValue, this.startingLineNumber)
      }
    } else if (this.hasNoValue) {
      // Set key if present (no delimiter).
      this.escapedKey = this.linesContent
      this.key = this.unescape(this.escapedKey, this.startingLineNumber)
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
  public unescape(escapedContent: string, startingLineNumber: number): string {
    let unescapedContent = ''
    for (
      let position = 0, character = escapedContent[0];
      position < escapedContent.length;
      position++, character = escapedContent[position]
    ) {
      if (character === '\\') {
        const nextCharacter = escapedContent[position + 1]

        if (nextCharacter === 'f') {
          // Formfeed/
          unescapedContent += '\f'
          position++
        } else if (nextCharacter === 'n') {
          // Newline.
          unescapedContent += '\n'
          position++
        } else if (nextCharacter === 'r') {
          // Carriage return.
          unescapedContent += '\r'
          position++
        } else if (nextCharacter === 't') {
          // Tab.
          unescapedContent += '\t'
          position++
        } else if (nextCharacter === 'u') {
          // Unicode character.
          const codePoint = escapedContent.substring(position + 2, position + 6)
          if (!/[0-9a-f]{4}/i.test(codePoint)) {
            // Code point can only be within Unicode's Multilingual Plane (BMP).
            throw new Error(
              `malformed escaped unicode characters '\\u${codePoint}' in property starting at line ${startingLineNumber}`
            )
          }
          unescapedContent += String.fromCharCode(parseInt(codePoint, 16))
          position += 5
        } else {
          // Otherwise the escape character is not required.
          unescapedContent += nextCharacter
          position++
        }
      } else {
        // When there is \, simply add the character.
        unescapedContent += character
      }
    }

    return unescapedContent
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
      let position = 0, character = this.linesContent[0];
      position < this.linesContent.length;
      position++, character = this.linesContent[position]
    ) {
      // If the character is not a delimiter, check the next one.
      if (!/[ \t\f=:]/.test(character)) {
        continue
      }

      // Check if the delimiter might be escaped.
      const prefix = !position ? '' : this.linesContent.substring(0, position)

      if (prefix.length) {
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
      this.hasMultilineKey = !!(this.newlinePositions.length && this.newlinePositions[0] > position)

      // Check if the delimiter starts with a whitespace.
      let nextContent = this.linesContent.substring(position)
      const leadingWhitespaceMatch = nextContent.match(/^(?<whitespace>\s+)/)
      const leadingWhitespace = leadingWhitespaceMatch?.groups?.whitespace || ''

      // If there is a whitespace, move to the next character.
      if (leadingWhitespace.length) {
        delimiter += leadingWhitespace
        nextContent = nextContent.substring(leadingWhitespace.length)
      }

      // Check if there is an equal or colon character.
      if (/[=:]/.test(nextContent[0])) {
        delimiter += nextContent[0]
        nextContent = nextContent.substring(1)
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
      if (this.newlinePositions.length) {
        const firstLinePosition = this.newlinePositions[0]
        if (firstLinePosition > this.delimiterPosition) {
          this.hasMultilineKey = true
        }
      }
    }
  }
}
