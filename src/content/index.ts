import { KeyValueObject } from '../'
import { Properties } from '../properties'
import { Property } from '../property'
import { PropertyLine } from '../property-line'

/**
 * Get a `Properties` object from the content of a `.properties` file.
 *
 * @param content - the content of a `.properties` file.
 *
 * @returns A `Properties` object representing the content of a `.properties` file.
 */
export const getProperties = (content: string): Properties => {
  // Remove BOM character if present and create an array from lines.
  const lines = (content.codePointAt(0) === 0xfeff ? content.slice(1) : content).split(/\r?\n/)

  /** Line number while parsing properties file content. */
  let lineNumber = 0
  /** The current property object being parsed. */
  let property: Property | undefined
  /** The collection of property objects. */
  const properties = new Properties()

  for (const line of lines) {
    lineNumber++
    const propertyLine = new PropertyLine(line, !!property)

    if (!property) {
      // Check if the line is a new property.
      if (propertyLine.isComment || propertyLine.isBlank) {
        continue // Skip line if its a comment or blank.
      }

      // The line is a new property.
      property = new Property(propertyLine, lineNumber)

      if (propertyLine.continues) {
        continue // Continue parsing the next line.
      }
    } else {
      // Continue parsing an existing property.
      property.addLine(propertyLine)
      if (propertyLine.continues) {
        continue
      }
    }

    // If the line does not continue, add the property to the collection.
    property = properties.add(property)
  }

  return properties
}

/**
 * Converts the content of a `.properties` file to JSON.
 *
 * @param content - the content of a `.properties` file.
 *
 * @returns A (JSON) key/value object representing the content of a `.properties` file.
 */
export const propertiesToJson = (content: string): KeyValueObject => getProperties(content).toJson()
