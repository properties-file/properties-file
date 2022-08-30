import { readFileSync } from 'node:fs'

import { getProperties, Properties, propertiesToJson, Property, PropertyLine } from '../src'
import {
  getProperties as getPropertiesFromContent,
  propertiesToJson as propertiesToJsonFromContent,
} from '../src/content'

describe('The test properties file', () => {
  it('is parsed the same way as Java', () => {
    const properties = getProperties('assets/tests/test-all.properties')

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

describe('The malformed unicode properties file', () => {
  it('throws an error', () => {
    expect(() => {
      getProperties('assets/tests/malformed-unicode-test.properties')
    }).toThrow('malformed escaped unicode characters')
  })
})

describe('The properties file with a BOM character', () => {
  it('works as expected', () => {
    const properties = getProperties('assets/tests/bom-test.properties').toJson()
    expect(properties).toEqual({ hello: 'world' })
  })
})

describe('The `Properties` class', () => {
  it('`toJson()` method works as expected', () => {
    const properties = propertiesToJsonFromContent('hello = world')
    expect(properties).toEqual({ hello: 'world' })
  })

  it('`add()` method works as expected', () => {
    const properties = new Properties()
    expect(properties.add(undefined)).toEqual(undefined)
  })

  it('collisions methods works as expected', () => {
    const properties = getPropertiesFromContent(
      'hello = world1\r\nhello2 = world\r\nhello = world2'
    )
    const collisions = properties.getKeyCollisions()
    expect(collisions).toEqual([{ key: 'hello', startingLineNumbers: [1, 3] }])
    expect(collisions[0].getApplicableLineNumber()).toEqual(3)
  })
})

describe('The `Property` class', () => {
  it('`findDelimiter()` method works as expected', () => {
    const property = new Property(new PropertyLine('hello = world', false), 1)
    property.setKeyAndValue()

    expect(property.setKeyAndValue()).toEqual(undefined)
  })
})

describe('The file `getProperties()` method', () => {
  it('throws an error when a file does not exist', () => {
    expect(() => {
      getProperties('this-file-does-not-exist')
    }).toThrow('file not found')
  })
})

describe('The file `propertiesToJson()` method', () => {
  it('works as expected', () => {
    const properties = propertiesToJson('assets/tests/collisions-test.properties', 'ascii')
    expect(properties).toEqual({ hello: 'hello2', world: 'world3' })
  })
})
