import { PropertyLine } from './property-line'
import { unescapeContent } from './unescape'

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
        this.key = this.unescapeLine(this.escapedKey, this.startingLineNumber)
      }

      // Set value if present.
      if (!this.hasNoValue) {
        this.escapedValue = this.linesContent.slice(this.delimiterPosition + this.delimiterLength)
        this.value = this.unescapeLine(this.escapedValue, this.startingLineNumber)
      }
    } else if (this.hasNoValue) {
      // Set key if present (no delimiter).
      this.escapedKey = this.linesContent
      this.key = this.unescapeLine(this.escapedKey, this.startingLineNumber)
    }
  }

  /**
   * Unescape the content from either key or value of a property.
   *
   * @param escapedContent - The content to unescape.
   * @param startingLineNumber - The starting line number of the content being unescaped.
   *
   * @returns The unescaped content.
   *
   * @throws {@link Error}
   * This exception is thrown if malformed escaped unicode characters are present.
   */
  private unescapeLine(escapedContent: string, startingLineNumber: number): string {
    try {
      return unescapeContent(escapedContent)
    } catch (error) {
      throw new Error(
        `${(error as Error).message} in property starting at line ${startingLineNumber}`
      )
    }
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
