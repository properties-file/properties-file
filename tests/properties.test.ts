import { readFileSync } from 'node:fs'
import { Properties, getProperties } from '../src'
import { BOM } from '../src/properties'
import { Property } from '../src/property'
import { PropertyLine } from '../src/property-line'

describe('The test properties file', () => {
  it('is parsed the same way as Java', () => {
    const properties = new Properties(readFileSync('assets/tests/test-all.properties'))

    properties.collection.sort((referenceObject, comparedObject) => {
      return referenceObject.key.localeCompare(comparedObject.key)
    })

    let output = ''
    for (const property of properties.collection) {
      output += `${output.length > 0 ? '\r\n' : ''}${property.key} => '${property.value}'`
    }

    const javaOutput = readFileSync('assets/tests/test-all-java-console-output', 'utf8')
    expect(output).toEqual(javaOutput)
  })
})

const propertiesContent =
  'hello = hello1\nworld = world1\nworld = world2\nhello = hello2\nworld = world3'
const expectedPropertiesObject = { hello: 'hello2', world: 'world3' }

describe('The `Properties` class', () => {
  const emptyProperties = new Properties('')
  it('works as expected when empty', () => {
    expect(emptyProperties.format()).toEqual('')
  })

  it('throws an error when there are malformed unicode characters', () => {
    expect(() => {
      getProperties('hello = \\uhello')
    }).toThrow('malformed escaped unicode characters')
  })

  const properties = new Properties(propertiesContent)

  it('`.toObject()` method works as expected', () => {
    expect(properties.toObject()).toEqual(expectedPropertiesObject)
  })

  it('`.format()` method works as expected', () => {
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`getKeyCollisions()` methods works as expected', () => {
    const collisions = properties.getKeyCollisions()
    expect(collisions).toEqual([
      { key: 'hello', startingLineNumbers: [1, 4] },
      { key: 'world', startingLineNumbers: [2, 3, 5] },
    ])
    expect(collisions[0].getApplicableLineNumber()).toEqual(4)
  })

  // BOM character tests
  const propertiesContentWithBom = `${BOM}hello = world`
  const expectedPropertiesObjectWithBom = { hello: 'world' }
  const propertiesWithBom = new Properties(propertiesContentWithBom)

  it('`.toObject()` method works as expected with a BOM character', () => {
    expect(propertiesWithBom.toObject()).toEqual(expectedPropertiesObjectWithBom)
  })

  it('`.format()` method works as expected with a BOM character', () => {
    expect(propertiesWithBom.format()).toEqual(propertiesContentWithBom)
  })
})

describe('The `Property` class', () => {
  it('`setKeyAndValue()` method works as expected', () => {
    const property = new Property(new PropertyLine('hello = world', false), 1)
    property.setKeyAndValue()
    expect(property.setKeyAndValue()).toEqual(undefined)
  })
})

describe('The `getProperties()` API', () => {
  it('works as expected', () => {
    const properties = getProperties(propertiesContent)
    expect(properties).toEqual(expectedPropertiesObject)
  })
})
