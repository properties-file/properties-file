import { PropertyLine } from './property-line'
import { unescapeContent } from './unescape'

const CH_TAB = 9 // \t
const CH_LF = 10 // \n
const CH_VT = 11 // \v
const CH_FF = 12 // \f
const CH_CR = 13 // \r
const CH_SPACE = 32 // ' '
const CH_COLON = 58 // :
const CH_EQUALS = 61 // =
const CH_BACKSLASH = 92 // \\

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
      this.escapedValue = this.linesContent.slice(this.separatorPosition + this.separatorLength)
      this.value = this.unescapeLine(this.escapedValue, this.startingLineNumber)
    } else {
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
   * Check whether a character code is whitespace (tab, LF, VT, FF, CR, space).
   *
   * @param charCode - A UTF-16 character code.
   * @returns `true` when the code represents a whitespace character.
   */
  private static isWhitespace(charCode: number): boolean {
    return (
      charCode === CH_SPACE ||
      charCode === CH_TAB ||
      charCode === CH_LF ||
      charCode === CH_VT ||
      charCode === CH_FF ||
      charCode === CH_CR
    )
  }

  /**
   * Find the character separating the key from the value.
   */
  private findSeparator(): void {
    // If the separator was already found, skip.
    if (this.hasNoKey || this.separator) {
      return
    }

    const content = this.linesContent
    const contentLength = content.length
    let hasPrecedingBackslash = false

    // Scan for the first unescaped separator character.
    for (let index = 0; index < contentLength; index++) {
      const charCode = content.charCodeAt(index)

      if (charCode === CH_BACKSLASH) {
        hasPrecedingBackslash = !hasPrecedingBackslash
        continue
      }

      if (hasPrecedingBackslash) {
        hasPrecedingBackslash = false
        continue
      }

      // Check if this is a separator character (whitespace, =, :).
      const isSeparator =
        charCode === CH_EQUALS ||
        charCode === CH_COLON ||
        charCode === CH_SPACE ||
        charCode === CH_TAB ||
        charCode === CH_FF

      if (!isSeparator) {
        continue
      }

      this.separatorPosition = index

      // Advance past leading whitespace in the separator.
      let separatorEnd = index
      while (
        separatorEnd < contentLength &&
        Property.isWhitespace(content.charCodeAt(separatorEnd))
      ) {
        separatorEnd++
      }

      // Check if there is an equal or colon character after whitespace.
      if (separatorEnd < contentLength) {
        const nextCharCode = content.charCodeAt(separatorEnd)
        if (nextCharCode === CH_EQUALS || nextCharCode === CH_COLON) {
          separatorEnd++
          // Skip trailing whitespace after = or :.
          while (
            separatorEnd < contentLength &&
            Property.isWhitespace(content.charCodeAt(separatorEnd))
          ) {
            separatorEnd++
          }
        }
      }

      this.separatorLength = separatorEnd - index
      this.valuePosition = separatorEnd
      this.separator = content.slice(index, separatorEnd)

      // If the line starts with a separator, the property has no key.
      if (!index) {
        this.hasNoKey = true
      }

      break
    }

    if (
      this.separatorPosition !== undefined &&
      this.newlinePositions.length > 0 &&
      this.newlinePositions[0] < this.separatorPosition
    ) {
      // If the separator is after the first newline, the key is on multiple lines.
      this.hasMultilineKey = true
    }
  }
}
