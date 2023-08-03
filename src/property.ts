import { PropertyLine } from './property-line'
import { unescapeContent } from './unescape'

/**
 * Object representing a property (key/value).
 */
export class Property {
  /** The content of one or multiple lines when applicable. */
  public linesContent: string

  /** The property key (unescaped). */
  public key = ''
  /** The property key, including its escaped characters. */
  public escapedKey = ''
  /** Is the key empty? */
  private hasNoKey = false
  /** Does the key definition spread across multiple lines? */
  private hasMultilineKey = false

  /** Starting line numbers of property objects with the same key. */
  public keyCollisionLines: number[] = []
  /** Was the property's key used more than once? */
  public hasKeyCollisions = false

  /** The key/value pair separator */
  public separator: string | undefined
  /** The length of the key/value pair separator, including its whitespace characters. */
  public separatorLength: number | undefined
  /** The starting position of the key/value pair separator. */
  public separatorPosition: number | undefined

  /** The property value (unescaped). */
  public value = ''
  /** The starting position of the value. */
  public valuePosition: number | undefined
  /** The property value, including its escaped characters. */
  public escapedValue = ''
  /** Is the value empty? */
  private hasNoValue = false

  /** Positions of the newline characters if any. */
  public newlinePositions: number[] = []

  /** The line number at which the property starts. */
  public readonly startingLineNumber: number
  /** The line number at which the property ends. */
  public endingLineNumber: number

  /** The previous property object if it exists. */
  public readonly previousProperty?: Property
  /** The next property object if it exists. */
  public nextProperty?: Property

  /**
   * Create a new property object.
   *
   * @param propertyLine - A property line object.
   * @param startingLineNumber - The line number at which the property starts.
   */
  constructor(propertyLine: PropertyLine, startingLineNumber: number, previousProperty?: Property) {
    this.linesContent = propertyLine.content
    this.startingLineNumber = startingLineNumber
    this.endingLineNumber = startingLineNumber
    this.previousProperty = previousProperty
    previousProperty?.setNextProperty(this)
  }

  /**
   * Set the next property object.
   *
   * @param property - The next property object
   */
  public setNextProperty(property: Property): void {
    this.nextProperty = property
  }

  /**
   * Add the a line to a multiline property object.
   *
   * @param propertyLine - A property line object.
   */
  public addLine(propertyLine: PropertyLine): void {
    if (this.linesContent.length > 0) {
      this.newlinePositions.push(this.linesContent.length)
      this.endingLineNumber++
    }
    this.linesContent += propertyLine.content
  }

  /**
   * Set the property's key and value.
   */
  public setKeyAndValue(): void {
    this.findSeparator()

    if (this.separatorPosition !== undefined && this.separatorLength !== undefined) {
      // Set key if present.
      if (!this.hasNoKey) {
        this.escapedKey = this.linesContent.slice(0, this.separatorPosition)
        this.key = this.unescapeLine(this.escapedKey, this.startingLineNumber)
      }

      // Set value if present.
      if (!this.hasNoValue) {
        this.escapedValue = this.linesContent.slice(this.separatorPosition + this.separatorLength)
        this.value = this.unescapeLine(this.escapedValue, this.startingLineNumber)
      }
    } else if (this.hasNoValue) {
      // Set key if present (no separator).
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
   * Find the character separating the key from the value.
   */
  private findSeparator(): void {
    // If the separator was already found, skip.
    if (this.hasNoKey || this.hasNoValue || this.separatorPosition) {
      return
    }

    for (
      let character = this.linesContent[0], position = 0;
      position < this.linesContent.length;
      position++, character = this.linesContent[position]
    ) {
      // If the character is not a separator, check the next one.
      if (!/[\t\f :=]/.test(character)) {
        continue
      }

      // Check if the separator might be escaped.
      const prefix = position ? this.linesContent.slice(0, position) : ''

      if (prefix.length > 0) {
        const backslashMatch = prefix.match(/(?<backslashes>\\+)$/)
        if (backslashMatch?.groups) {
          const separatorIsEscaped = !!(backslashMatch.groups.backslashes.length % 2)
          if (separatorIsEscaped) {
            // If the separator is escaped, check the next character.
            continue
          }
        }
      }

      let separator = ''
      this.separatorPosition = position

      // Check if the separator starts with a whitespace.
      let nextContent = this.linesContent.slice(position)
      // All white-space characters, excluding non-breaking spaces.
      const leadingWhitespaceMatch = nextContent.match(/^(?<whitespace>[\t\n\v\f\r ]+)/)
      const leadingWhitespace = leadingWhitespaceMatch?.groups?.whitespace || ''

      // If there is a whitespace, move to the next character.
      if (leadingWhitespace.length > 0) {
        separator += leadingWhitespace
        nextContent = nextContent.slice(leadingWhitespace.length)
      }

      // Check if there is an equal or colon character.
      if (/[:=]/.test(nextContent[0])) {
        separator += nextContent[0]
        nextContent = nextContent.slice(1)
        // If an equal or colon character was found, try to get trailing whitespace.
        const trailingWhitespaceMatch = nextContent.match(/^(?<whitespace>[\t\n\v\f\r ]+)/)
        const trailingWhitespace = trailingWhitespaceMatch?.groups?.whitespace || ''
        separator += trailingWhitespace
      }

      this.separatorLength = separator.length
      this.valuePosition = this.separatorPosition + this.separatorLength
      this.separator = this.linesContent.slice(
        this.separatorPosition,
        this.separatorPosition + this.separatorLength
      )

      // If the line starts with a separator, the property has no key.
      if (!position) {
        this.hasNoKey = true
      }

      break
    }

    if (this.separatorPosition === undefined) {
      // If there was no separator found, the property has no value.
      this.hasNoValue = true
    } else if (
      this.newlinePositions.length > 0 &&
      this.newlinePositions[0] < this.separatorPosition
    ) {
      // If the separator is after the first newline, the key is on multiple lines.
      this.hasMultilineKey = true
    }
  }
}
