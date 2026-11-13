/**
 * Shared reader tests that verify both `getProperties()` and `Properties.toObject()`
 * produce identical results for all inputs. This ensures both parsing paths — the
 * fast functional parser and the lossless OO parser — are fully compliant.
 */
import { readFileSync } from 'node:fs'

import { getProperties } from '../src'
import { Properties } from '../src/parser'

import type { KeyValuePairObject } from '../src/parser/nodes'

/**
 * Read properties using the fast functional parser.
 *
 * @param content - The `.properties` file content.
 *
 * @returns The parsed key-value object.
 */
const readUsingGetProperties = (content: string | Buffer): KeyValuePairObject =>
  getProperties(content)

/**
 * Read properties using the lossless object-oriented parser.
 *
 * @param content - The `.properties` file content.
 *
 * @returns The parsed key-value object.
 */
const readUsingToObject = (content: string | Buffer): KeyValuePairObject =>
  new Properties(content).toObject()

/**
 * Every name a plain object inherits from `Object.prototype` (`constructor`, `toString`,
 * `__proto__`…), as provided by the engine running the tests.
 */
const OBJECT_PROTOTYPE_MEMBER_NAMES = Object.getOwnPropertyNames(Object.prototype)

/** Two readers that must produce identical results. */
const readers: [string, (content: string | Buffer) => KeyValuePairObject][] = [
  ['getProperties()', readUsingGetProperties],
  ['Properties.toObject()', readUsingToObject],
]

describe.each(readers)('%s', (_name, read) => {
  it('matches Java output for test-all.properties', () => {
    const content = readFileSync('assets/tests/test-all.properties')
    const result = read(content)

    const sortedEntries = Object.entries(result).toSorted(([a], [b]) => a.localeCompare(b))

    let output = ''
    for (const [key, value] of sortedEntries) {
      output += `${output.length > 0 ? '\r\n' : ''}${key} => '${value}'`
    }

    const javaOutput = readFileSync('assets/tests/test-all-java-console-output', 'utf8')
    expect(output).toStrictEqual(javaOutput)
  })

  it('works with an empty string', () => {
    expect(read('')).toStrictEqual({})
  })

  it('works with a string input', () => {
    expect(read('hello = world')).toStrictEqual({ hello: 'world' })
  })

  it('works with a Buffer input', () => {
    expect(read(Buffer.from('hello = world'))).toStrictEqual({ hello: 'world' })
  })

  it('handles BOM characters', () => {
    expect(read('\u{FEFF}hello = world')).toStrictEqual({ hello: 'world' })
  })

  it('handles comment lines with # and !', () => {
    expect(read('# comment\n! another\nhello = world')).toStrictEqual({ hello: 'world' })
  })

  it('handles blank lines', () => {
    expect(read('\n\nhello = world\n\n')).toStrictEqual({ hello: 'world' })
  })

  it('handles CRLF line endings', () => {
    expect(read('hello = world\r\nfoo = bar')).toStrictEqual({ hello: 'world', foo: 'bar' })
  })

  it('handles CR-only line endings', () => {
    expect(read('hello = world\rfoo = bar')).toStrictEqual({ hello: 'world', foo: 'bar' })
  })

  it('handles different separator types', () => {
    expect(read('a=1\nb:2\nc 3\nd\t4\ne\f5')).toStrictEqual({
      a: '1',
      b: '2',
      c: '3',
      d: '4',
      e: '5',
    })
  })

  it('handles separator with surrounding whitespace', () => {
    expect(read('hello  =  world')).toStrictEqual({ hello: 'world' })
    expect(read('hello  :  world')).toStrictEqual({ hello: 'world' })
  })

  it('handles key with no value', () => {
    expect(read('empty')).toStrictEqual({ empty: '' })
  })

  it('handles key with empty value after separator', () => {
    expect(read('empty =')).toStrictEqual({ empty: '' })
  })

  it('handles value without a key', () => {
    expect(read('= no key')).toStrictEqual({ '': 'no key' })
  })

  it('handles key collisions (last value wins)', () => {
    expect(read('key = first\nkey = second')).toStrictEqual({ key: 'second' })
  })

  it.each(OBJECT_PROTOTYPE_MEMBER_NAMES)(
    'stores the `Object.prototype` member name `%s` as a regular key',
    (key) => {
      const result = read(`${key} = value`)

      expect(Object.keys(result)).toStrictEqual([key])
      expect(Object.getOwnPropertyDescriptor(result, key)).toStrictEqual({
        value: 'value',
        writable: true,
        enumerable: true,
        configurable: true,
      })
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    }
  )

  it('handles collisions on a `__proto__` key, escaped or not (last value wins)', () => {
    const result = read(String.raw`__proto__ = first
\u005F_proto__ = second`)

    expect(Object.keys(result)).toStrictEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe('second')
  })

  it('handles line continuations', () => {
    expect(read('hello = world\\\n  continued')).toStrictEqual({ hello: 'worldcontinued' })
  })

  it('handles line continuations with CRLF', () => {
    expect(read('hello = world\\\r\n  continued')).toStrictEqual({ hello: 'worldcontinued' })
  })

  it('handles multiline key continuations', () => {
    expect(read('multi\\\nline this is a multiline key')).toStrictEqual({
      multiline: 'this is a multiline key',
    })
  })

  it('handles even number of trailing backslashes (no continuation)', () => {
    expect(read('evenKey = This is on one line\\\\')).toStrictEqual({
      evenKey: 'This is on one line\\',
    })
  })

  it('handles odd number of trailing backslashes (continuation)', () => {
    expect(read('oddKey = line one\\\\\\\n# line two')).toStrictEqual({
      oddKey: String.raw`line one\# line two`,
    })
  })

  it('handles escape sequences in values', () => {
    expect(
      read(String.raw`key = newline\n, carriage\r, tab\t, formfeed\f, backslash\\`)
    ).toStrictEqual({
      key: 'newline\n, carriage\r, tab\t, formfeed\f, backslash\\',
    })
  })

  it('handles escape sequences in keys', () => {
    expect(read(String.raw`key\:with\=special\ chars = value`)).toStrictEqual({
      'key:with=special chars': 'value',
    })
  })

  it('handles non-escape backslash sequences', () => {
    expect(read(String.raw`key = ran\d\o\m`)).toStrictEqual({ key: 'random' })
  })

  it('decodes Unicode escape sequences', () => {
    expect(read(String.raw`city = M\u00FCnchen`)).toStrictEqual({ city: 'M\u{FC}nchen' })
  })

  it('decodes multiple Unicode escape sequences', () => {
    expect(read(String.raw`hello = \u3053\u3093\u306b\u3061\u306f`)).toStrictEqual({
      hello: '\u{3053}\u{3093}\u{306B}\u{3061}\u{306F}',
    })
  })

  it('handles leading whitespace on lines', () => {
    expect(read('    hello = world')).toStrictEqual({ hello: 'world' })
  })

  it('handles whitespace-only lines', () => {
    expect(read('   \nhello = world')).toStrictEqual({ hello: 'world' })
  })

  it('handles content with only whitespace', () => {
    expect(read(' '.repeat(3))).toStrictEqual({})
  })

  it('handles content with only a comment', () => {
    expect(read('# just a comment')).toStrictEqual({})
  })

  it('handles CRLF comments', () => {
    expect(read('# comment\r\nhello = world')).toStrictEqual({ hello: 'world' })
  })

  it('handles CR-only comments', () => {
    expect(read('# comment\rhello = world')).toStrictEqual({ hello: 'world' })
  })

  it('handles CRLF blank lines', () => {
    expect(read('\r\nhello = world')).toStrictEqual({ hello: 'world' })
  })

  it('handles CR-only blank line', () => {
    expect(read('\rhello = world')).toStrictEqual({ hello: 'world' })
  })

  it('handles value with leading spaces preserved via escape', () => {
    expect(read(String.raw`key = \   three leading spaces`)).toStrictEqual({
      key: '   three leading spaces',
    })
  })

  it('handles escaped backslash in key', () => {
    expect(read(String.raw`key\\With\\Backslashes = value`)).toStrictEqual({
      'key\\With\\Backslashes': 'value',
    })
  })

  it('handles continuation at end of content', () => {
    expect(read('hello = world\\')).toStrictEqual({ hello: 'world' })
  })

  it('handles key with trailing whitespace only (no value)', () => {
    expect(read('keyonly   ')).toStrictEqual({ keyonly: '' })
  })

  it('handles continuation with CR-only newline', () => {
    expect(read('hello = val\\\rue')).toStrictEqual({ hello: 'value' })
  })

  it('handles tab separator with whitespace before = after', () => {
    expect(read('key\t=\tvalue')).toStrictEqual({ key: 'value' })
  })

  it('handles formfeed separator', () => {
    expect(read('key\fvalue')).toStrictEqual({ key: 'value' })
  })

  it('handles whitespace before colon separator', () => {
    expect(read('key \t: value')).toStrictEqual({ key: 'value' })
  })

  it('handles triple continuation (3+ physical lines)', () => {
    expect(read('key = a\\\n  b\\\n  c\\\n  d')).toStrictEqual({ key: 'abcd' })
  })

  it('handles escaped key character in multi-line property', () => {
    expect(read('k\\=ey = val\\\n  ue')).toStrictEqual({ 'k=ey': 'value' })
  })

  it('handles CRLF in continuation lines beyond the first', () => {
    expect(read('key = a\\\r\n  b\\\r\n  c')).toStrictEqual({ key: 'abc' })
  })

  it('handles CR-only newline in continuation loop', () => {
    expect(read('key = a\\\r  b\\\r  c')).toStrictEqual({ key: 'abc' })
  })

  it('handles multi-line property where key fills entire logical line', () => {
    expect(read('keyonly\\\n')).toStrictEqual({ keyonly: '' })
  })

  it('handles backslash appearing only in continuation line', () => {
    expect(read('key = hello\\\n  \\tworld')).toStrictEqual({ key: 'hello\tworld' })
  })

  it('handles multiline property with leading whitespace', () => {
    expect(read('  key = val\\\n  ue')).toStrictEqual({ key: 'value' })
  })

  it('handles multi-line key-only with trailing whitespace (no value)', () => {
    expect(read('key  \\\n  ')).toStrictEqual({ key: '' })
  })

  it('handles multi-line property with = separator and no preceding whitespace', () => {
    expect(read('key=val\\\nue')).toStrictEqual({ key: 'value' })
  })

  it('throws on malformed Unicode escape sequences', () => {
    expect(() => read(String.raw`hello = \uhello`)).toThrow('malformed')
  })

  it('throws on incomplete Unicode escape sequences', () => {
    expect(() => read(String.raw`hello = \u00`)).toThrow('malformed')
  })
})
