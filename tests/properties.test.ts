import { readFileSync } from 'node:fs'
import { BOM, getFirstEolCharacter, Properties } from '../src/properties'
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
      new Properties(String.raw`hello = \uhello`)
    }).toThrow(
      String.raw`malformed escaped unicode characters '\uhell' in property starting at line 1`
    )
  })

  it('decode escaped unicode characters', () => {
    const properties = new Properties(String.raw`city1=M\u00FCnchen
city2=B\u00FCckeburg`)
    expect(properties.toObject()).toEqual({ city1: 'München', city2: 'Bückeburg' })
  })

  it('`getKeyCollisions()` methods works as expected when not containing collisions', () => {
    expect(new Properties('hello = world').getKeyCollisions()).toEqual([])
  })

  const properties = new Properties(propertiesContent)

  it('`.toObject()` method works as expected', () => {
    expect(properties.toObject()).toEqual(expectedPropertiesObject)
  })

  it('`.format()` method works as expected', () => {
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`getKeyCollisions()` methods works as expected when containing collisions', () => {
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
    expect(property.key).toBe('hello')
    expect(property.value).toBe('world')
    // This one should do nothing as the key and value are already set.
    property.setKeyAndValue()
    expect(property.key).toBe('hello')
    expect(property.value).toBe('world')
  })

  it('`addLine()` method handles empty line as expected', () => {
    const property = new Property(new PropertyLine('', false), 1)
    property.addLine(new PropertyLine('', false))
    expect(property.linesContent).toBe('')
    expect(property.newlinePositions.length).toBe(0)
    expect(property.endingLineNumber).toBe(1)
  })
})

describe('The `getFirstEolCharacter()` API', () => {
  it('works as expected', () => {
    expect(getFirstEolCharacter('')).toEqual(undefined)
    expect(getFirstEolCharacter('hi\nhello\r\nworld')).toEqual('\n')
    expect(getFirstEolCharacter('hi\r\nhello\nworld')).toEqual('\r\n')
  })
})
