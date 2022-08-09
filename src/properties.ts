import { KeyValueObject } from './'
import { Property } from './property'

/**
 * A class representing the content of a .properties file.
 */
export class Properties {
  /** The collection of property object. */
  public collection: Property[] = []
  /** Object associating keys with their starting line numbers. */
  public keyLineNumbers: KeyLineNumbers = {}

  /**
   * Add a property object into a properties object collection.
   *
   * @param property - A property object, or undefined.
   *
   * @returns Undefined so that we conveniently overwrite the property object.
   */
  public add(property: Property | undefined): undefined {
    if (property === undefined) return undefined

    property.setKeyAndValue()

    if (this.keyLineNumbers[property.key]?.length) {
      this.keyLineNumbers[property.key].push(property.startingLineNumber)
      property.hasKeyCollisions = true
      property.keyCollisionLines = this.keyLineNumbers[property.key]

      // Remove collision so that we can overwrite it with the latest object.
      this.collection = this.collection.filter(
        (existingPropertyObject) => existingPropertyObject.key !== property.key
      )
    } else {
      // Initialize the key line numbers.
      this.keyLineNumbers[property.key] = [property.startingLineNumber]
    }

    // Add the property to the collection.
    this.collection.push(property)

    return undefined
  }

  /**
   * Get keys that have collisions (more than one occurrence).
   */
  public getKeyCollisions(): KeyCollisions[] {
    const keyCollisions: KeyCollisions[] = []
    for (const [key, startingLineNumbers] of Object.entries(this.keyLineNumbers)) {
      if (startingLineNumbers.length > 1) {
        keyCollisions.push(new KeyCollisions(key, startingLineNumbers))
      }
    }
    return keyCollisions
  }

  /**
   * Get the JSON (key/value) representation of the properties.
   *
   * @returns A key/value representing the properties of the object.
   */
  public toJson(): KeyValueObject {
    const keyValueObject: KeyValueObject = {}
    this.collection.forEach((property) => {
      keyValueObject[property.key] = property.value
    })
    return keyValueObject
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
  public getApplicableLineNumber(): number {
    return this.startingLineNumbers.slice(-1)[0]
  }
}
