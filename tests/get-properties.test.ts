import { readFileSync } from 'node:fs'

import { getProperties, Properties } from '../src'
import { BOM } from '../src/properties'

describe('The `getProperties()` API', () => {
  it('is parsed the same way as Java', () => {
    const content = readFileSync('assets/tests/test-all.properties')
    const result = getProperties(content)

    const sortedEntries = Object.entries(result).toSorted(([a], [b]) => a.localeCompare(b))

    let output = ''
    for (const [key, value] of sortedEntries) {
      output += `${output.length > 0 ? '\r\n' : ''}${key} => '${value}'`
    }

    const javaOutput = readFileSync('assets/tests/test-all-java-console-output', 'utf8')
    expect(output).toEqual(javaOutput)
  })

  it('is parsed the same way as `Properties.toObject()`', () => {
    const content = readFileSync('assets/tests/test-all.properties')
    const fromGetProperties = getProperties(content)
    const fromProperties = new Properties(content).toObject()
    expect(fromGetProperties).toEqual(fromProperties)
  })

  it('works with an empty string', () => {
    expect(getProperties('')).toEqual({})
  })

  it('works with a string input', () => {
    expect(getProperties('hello = world')).toEqual({ hello: 'world' })
  })

  it('works with a Buffer input', () => {
    expect(getProperties(Buffer.from('hello = world'))).toEqual({ hello: 'world' })
  })

  it('handles BOM characters', () => {
    expect(getProperties(`${BOM}hello = world`)).toEqual({ hello: 'world' })
  })

  it('handles comment lines with # and !', () => {
    expect(getProperties('# comment\n! another\nhello = world')).toEqual({ hello: 'world' })
  })

  it('handles blank lines', () => {
    expect(getProperties('\n\nhello = world\n\n')).toEqual({ hello: 'world' })
  })

  it('handles CRLF line endings', () => {
    expect(getProperties('hello = world\r\nfoo = bar')).toEqual({ hello: 'world', foo: 'bar' })
  })

  it('handles CR-only line endings', () => {
    expect(getProperties('hello = world\rfoo = bar')).toEqual({ hello: 'world', foo: 'bar' })
  })

  it('handles different separator types', () => {
    expect(getProperties('a=1\nb:2\nc 3\nd\t4\ne\f5')).toEqual({
      a: '1',
      b: '2',
      c: '3',
      d: '4',
      e: '5',
    })
  })

  it('handles separator with surrounding whitespace', () => {
    expect(getProperties('hello  =  world')).toEqual({ hello: 'world' })
    expect(getProperties('hello  :  world')).toEqual({ hello: 'world' })
  })

  it('handles whitespace-only separator followed by = or :', () => {
    expect(getProperties('hello = world')).toEqual({ hello: 'world' })
  })

  it('handles key with no value', () => {
    expect(getProperties('empty')).toEqual({ empty: '' })
  })

  it('handles key with empty value after separator', () => {
    expect(getProperties('empty =')).toEqual({ empty: '' })
  })

  it('handles value without a key', () => {
    expect(getProperties('= no key')).toEqual({ '': 'no key' })
  })

  it('handles key collisions (last value wins)', () => {
    expect(getProperties('key = first\nkey = second')).toEqual({ key: 'second' })
  })

  it('handles line continuations', () => {
    expect(getProperties('hello = world\\\n  continued')).toEqual({ hello: 'worldcontinued' })
  })

  it('handles line continuations with CRLF', () => {
    expect(getProperties('hello = world\\\r\n  continued')).toEqual({ hello: 'worldcontinued' })
  })

  it('handles multiline key continuations', () => {
    expect(getProperties('multi\\\nline this is a multiline key')).toEqual({
      multiline: 'this is a multiline key',
    })
  })

  it('handles even number of trailing backslashes (no continuation)', () => {
    expect(getProperties('evenKey = This is on one line\\\\')).toEqual({
      evenKey: 'This is on one line\\',
    })
  })

  it('handles odd number of trailing backslashes (continuation)', () => {
    expect(getProperties('oddKey = line one\\\\\\\n# line two')).toEqual({
      oddKey: String.raw`line one\# line two`,
    })
  })

  it('handles escape sequences in values', () => {
    expect(
      getProperties(String.raw`key = newline\n, carriage\r, tab\t, formfeed\f, backslash\\`)
    ).toEqual({ key: 'newline\n, carriage\r, tab\t, formfeed\f, backslash\\' })
  })

  it('handles escape sequences in keys', () => {
    expect(getProperties(String.raw`key\:with\=special\ chars = value`)).toEqual({
      'key:with=special chars': 'value',
    })
  })

  it('handles non-escape backslash sequences', () => {
    expect(getProperties(String.raw`key = ran\d\o\m`)).toEqual({ key: 'random' })
  })

  it('decodes Unicode escape sequences', () => {
    expect(getProperties(String.raw`city = M\u00FCnchen`)).toEqual({ city: 'M\u00FCnchen' })
  })

  it('decodes multiple Unicode escape sequences', () => {
    expect(getProperties(String.raw`hello = \u3053\u3093\u306b\u3061\u306f`)).toEqual({
      hello: '\u3053\u3093\u306B\u3061\u306F',
    })
  })

  it('throws on malformed Unicode escape sequences', () => {
    expect(() => getProperties(String.raw`hello = \uhello`)).toThrow(
      String.raw`malformed escaped unicode characters '\uhell' in property starting at line 1`
    )
  })

  it('throws on incomplete Unicode escape sequences', () => {
    expect(() => getProperties(String.raw`hello = \u00`)).toThrow(
      String.raw`malformed escaped unicode characters '\u00' in property starting at line 1`
    )
  })

  it('throws with correct line number for malformed Unicode on later lines', () => {
    expect(() => getProperties('first = ok\nsecond = \\uhello')).toThrow(
      'in property starting at line 2'
    )
  })

  it('handles leading whitespace on lines', () => {
    expect(getProperties('    hello = world')).toEqual({ hello: 'world' })
  })

  it('handles whitespace-only lines', () => {
    expect(getProperties('   \nhello = world')).toEqual({ hello: 'world' })
  })

  it('handles content with only whitespace', () => {
    expect(getProperties('   ')).toEqual({})
  })

  it('handles content with only a comment', () => {
    expect(getProperties('# just a comment')).toEqual({})
  })

  it('handles comment with no trailing newline', () => {
    expect(getProperties('# comment')).toEqual({})
  })

  it('handles property with no trailing newline', () => {
    expect(getProperties('hello = world')).toEqual({ hello: 'world' })
  })

  it('handles CRLF comments', () => {
    expect(getProperties('# comment\r\nhello = world')).toEqual({ hello: 'world' })
  })

  it('handles CR-only comments', () => {
    expect(getProperties('# comment\rhello = world')).toEqual({ hello: 'world' })
  })

  it('handles CRLF blank lines', () => {
    expect(getProperties('\r\nhello = world')).toEqual({ hello: 'world' })
  })

  it('handles value with leading spaces preserved via escape', () => {
    expect(getProperties(String.raw`key = \   three leading spaces`)).toEqual({
      key: '   three leading spaces',
    })
  })

  it('handles escaped backslash in key', () => {
    expect(getProperties(String.raw`key\\With\\Backslashes = value`)).toEqual({
      'key\\With\\Backslashes': 'value',
    })
  })

  it('handles continuation at end of content', () => {
    expect(getProperties('hello = world\\')).toEqual({ hello: 'world' })
  })

  it('handles CR at end of content (blank line)', () => {
    expect(getProperties('hello = world\r')).toEqual({ hello: 'world' })
  })

  it('handles CR-only line ending inside property', () => {
    expect(getProperties('hello = world\rfoo = bar\r')).toEqual({ hello: 'world', foo: 'bar' })
  })

  it('handles key with trailing whitespace only (no value, no separator char)', () => {
    expect(getProperties('keyonly   ')).toEqual({ keyonly: '' })
  })

  it('handles continuation with CR-only newline', () => {
    expect(getProperties('hello = val\\\rue')).toEqual({ hello: 'value' })
  })

  it('handles property ending at EOF without newline', () => {
    expect(getProperties('key = value')).toEqual({ key: 'value' })
  })

  it('handles tab separator with whitespace before = after', () => {
    expect(getProperties('key\t=\tvalue')).toEqual({ key: 'value' })
  })

  it('handles formfeed separator', () => {
    expect(getProperties('key\fvalue')).toEqual({ key: 'value' })
  })

  it('handles whitespace before colon separator', () => {
    expect(getProperties('key \t: value')).toEqual({ key: 'value' })
  })

  it('handles CR-only blank line (not CRLF)', () => {
    expect(getProperties('\rhello = world')).toEqual({ hello: 'world' })
  })

  it('handles CR blank line at end of content', () => {
    expect(getProperties('hello = world\r')).toEqual({ hello: 'world' })
  })

  it('handles CR-only property line ending (not continuation)', () => {
    expect(getProperties('a = 1\rb = 2')).toEqual({ a: '1', b: '2' })
  })

  it('handles content ending without newline after continuation', () => {
    expect(getProperties('key = val\\\nue')).toEqual({ key: 'value' })
  })

  it('handles triple continuation (3+ physical lines)', () => {
    expect(getProperties('key = a\\\n  b\\\n  c\\\n  d')).toEqual({ key: 'abcd' })
  })

  it('handles escaped key character in multi-line property', () => {
    expect(getProperties('k\\=ey = val\\\n  ue')).toEqual({ 'k=ey': 'value' })
  })

  it('handles CRLF in continuation lines beyond the first', () => {
    expect(getProperties('key = a\\\r\n  b\\\r\n  c')).toEqual({ key: 'abc' })
  })

  it('handles whitespace separator in multi-line property', () => {
    expect(getProperties('key val\\\n  ue')).toEqual({ key: 'value' })
  })

  it('handles tab separator in multi-line property', () => {
    expect(getProperties('key\tval\\\n  ue')).toEqual({ key: 'value' })
  })

  it('handles CR-only newline in continuation loop (no LF after CR)', () => {
    expect(getProperties('key = a\\\r  b\\\r  c')).toEqual({ key: 'abc' })
  })

  it('handles multi-line property with = separator after whitespace', () => {
    expect(getProperties('key \t= val\\\n  ue')).toEqual({ key: 'value' })
  })

  it('handles multi-line property with colon separator after whitespace', () => {
    expect(getProperties('key : val\\\n  ue')).toEqual({ key: 'value' })
  })

  it('handles multi-line property where key fills entire logical line', () => {
    expect(getProperties('keyonly\\\n')).toEqual({ keyonly: '' })
  })

  it('handles multi-line property with formfeed separator', () => {
    expect(getProperties('key\f= val\\\nue')).toEqual({ key: 'value' })
  })

  it('handles multi-line key-only with trailing whitespace (no value)', () => {
    expect(getProperties('key  \\\n  ')).toEqual({ key: '' })
  })

  it('handles multi-line property with = separator and no preceding whitespace', () => {
    expect(getProperties('key=val\\\nue')).toEqual({ key: 'value' })
  })
})
