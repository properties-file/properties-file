import { Property } from './property'
import { PropertyLine } from './property-line'

import { KeyValuePairObject } from '.'

/**
 * Byte-order mark.
 */
export const BOM = '\uFEFF'
export const BOM_CODE_POINT = BOM.charCodeAt(0)

/** Matches a line terminator: CRLF, bare CR, or bare LF (per the Java spec). */
export const REGEX_NEWLINE = /\r\n|\r|\n/

/** The default end of line character. */
export const DEFAULT_END_OF_LINE_CHARACTER = '\n'

/**
 * Get the first end of line (EOL) character from multiline content.
 *
 * @param content - The content of a `.properties` file.
 *
 * @returns The multiline content's first end of line (EOL) character.
 */
export const getFirstEolCharacter = (content: string): string | undefined => {
  for (let index = 0; index < content.length; index++) {
    const ch = content[index]
    if (ch === '\r') {
      return content[index + 1] === '\n' ? '\r\n' : '\r'
    }
    if (ch === '\n') {
      return '\n'
    }
  }
  return undefined
}

/**
 * A class representing the content of a .properties file.
 */
export class Properties {
  /** Does the .properties content starts with a BOM character? */
  public readonly hasBom: boolean
  /** The end of line character. */
  public readonly eolCharacter: string
  /** `.properties` content split by line. */
  protected lines: string[]
  /** The collection of property object. */
  public collection: Property[] = []
  /** Object associating keys with their starting line numbers. */
  public keyLineNumbers: KeyLineNumbers = {}
  /** Map from key to collection index for O(1) duplicate lookup. */
  private keyIndexMap: { [key: string]: number } = {}

  /**
   * Create `Properties` object.
   *
   * @param content - The content of a `.properties` file.
   */
  constructor(content: string | Buffer) {
    const stringContent = typeof content === 'string' ? content : content.toString()
    this.hasBom = stringContent.charCodeAt(0) === BOM_CODE_POINT
    this.eolCharacter = getFirstEolCharacter(stringContent) ?? DEFAULT_END_OF_LINE_CHARACTER
    this.lines = (this.hasBom ? stringContent.slice(1) : stringContent).split(REGEX_NEWLINE)
    this.parseLines()
  }

  /**
   * Parse the `.properties` content line by line.
   */
  protected parseLines(): void {
    /** Reset existing object properties to their initial values. */
    this.collection = []
    this.keyLineNumbers = {}
    this.keyIndexMap = {}

    /** Line number while parsing properties file content. */
    let lineNumber = 0
    /** The current property object being parsed. */
    let property: Property | undefined
    /** The previous property object that was parsed. */
    let previousProperty: Property | undefined

    for (const line of this.lines) {
      lineNumber++
      const propertyLine = new PropertyLine(line, !!property)

      if (property) {
        // Continue parsing an existing property.
        property.addLine(propertyLine)
        if (propertyLine.isContinuing) {
          continue
        }
      } else {
        // Check if the line is a new property.
        if (propertyLine.isComment || propertyLine.isBlank) {
          continue // Skip line if its a comment or blank.
        }

        // The line is a new property.
        property = new Property(propertyLine, lineNumber, previousProperty)

        if (propertyLine.isContinuing) {
          continue // Continue parsing the next line.
        }
      }

      // If the line does not continue, add the property to the collection.
      this.addToCollection(property)
      previousProperty = property
      property = undefined
    }
  }

  /**
   * Add a property object into a properties object collection.
   *
   * @param property - A property object, or undefined.
   *
   * @returns Undefined so that we conveniently overwrite the property object.
   */
  private addToCollection(property: Property): void {
    property.setKeyAndValue()

    if (this.keyLineNumbers[property.key]?.length) {
      this.keyLineNumbers[property.key].push(property.startingLineNumber)
      property.hasKeyCollisions = true
      property.keyCollisionLines = this.keyLineNumbers[property.key]

      // Replace the existing entry in the collection using the index map (O(1)).
      const existingIndex = this.keyIndexMap[property.key]
      this.collection[existingIndex] = property
      return
    }

    // Initialize the key line numbers.
    this.keyLineNumbers[property.key] = [property.startingLineNumber]

    // Add the property to the collection and record its index.
    this.keyIndexMap[property.key] = this.collection.length
    this.collection.push(property)
  }

  /**
   * Get keys that have collisions (more than one occurrence).
   */
  public getKeyCollisions(): KeyCollisions[] {
    const keyCollisions: KeyCollisions[] = []
    const keys = Object.keys(this.keyLineNumbers)
    for (const key of keys) {
      const startingLineNumbers = this.keyLineNumbers[key]
      if (startingLineNumbers.length > 1) {
        keyCollisions.push(new KeyCollisions(key, startingLineNumbers))
      }
    }
    return keyCollisions
  }

  /**
   * Get the key/value object representing the properties.
   *
   * @returns A key/value object representing the properties.
   */
  public toObject(): KeyValuePairObject {
    const keyValueObject: KeyValuePairObject = {}
    this.collection.forEach((property) => {
      keyValueObject[property.key] = property.value
    })
    return keyValueObject
  }

  /**
   * Format the object in `.properties`.
   *
   * @param endOfLineCharacter - The character used for end of lines.
   *
   * @returns The object in `.properties` format.
   */
  public format(endOfLineCharacter?: '\n' | '\r\n'): string {
    return `${this.hasBom ? BOM : ''}${this.lines.join(endOfLineCharacter || this.eolCharacter)}`
  }
}

/**
 * Object associating keys with their line numbers.
 */
export type KeyLineNumbers = {
  [key: string]: number[]
}

/**
 * A class representing key within a .properties file that had collisions (more than one occurrence).
 */
export class KeyCollisions {
  /** The key with collisions. */
  public key: string
  /** The starting line numbers where collisions are found. */
  public startingLineNumbers: number[]

  /**
   * Create a new key collision object.
   *
   * @param key - The key with collisions.
   * @param startingLineNumbers - The starting line numbers where collisions are found.
   */
  constructor(key: string, startingLineNumbers: number[]) {
    this.key = key
    this.startingLineNumbers = startingLineNumbers
  }

  /**
   * Get the number of the line from which the value will be used.
   */
  public getApplicableLineNumber(): number | undefined {
    return this.startingLineNumbers.slice(-1)[0]
  }
}
