/**
 * Parser tests for the Properties class — lossless round-trip, node fields,
 * query methods, normalization, and edge cases.
 */
import { readFileSync } from 'node:fs'

import { Properties, PropertiesNodeType } from '../src/parser'

import type { PropertyNode } from '../src/parser/nodes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that parsing and re-formatting the input produces the exact same string.
 *
 * @param input - The `.properties` file content to round-trip.
 */
const expectRoundTrip = (input: string): void => {
  const properties = new Properties(input)
  expect(properties.format()).toBe(input)
}

/**
 * Parse a single-property input and assert that at least one property node exists.
 *
 * @param input - The `.properties` file content containing one property.
 *
 * @returns The first {@link PropertyNode} for further assertions.
 */
const expectFirstProperty = (input: string): PropertyNode => {
  const properties = new Properties(input)
  const nodes = properties.getProperties()
  expect(nodes.length).toBeGreaterThanOrEqual(1)
  return nodes[0]
}

// ---------------------------------------------------------------------------
// Lossless round-trip
// ---------------------------------------------------------------------------

describe('Lossless round-trip (format() === input)', () => {
  it('round-trips an empty string', () => expectRoundTrip(''))
  it('round-trips key=value', () => expectRoundTrip('key=value'))
  it('round-trips key = value', () => expectRoundTrip('key = value'))
  it('round-trips key:value', () => expectRoundTrip('key:value'))
  it('round-trips key : value', () => expectRoundTrip('key : value'))
  it('round-trips whitespace separator', () => expectRoundTrip('key value'))
  it('round-trips key with no value', () => expectRoundTrip('empty'))
  it('round-trips key with empty value after =', () => expectRoundTrip('empty ='))
  it('round-trips empty key with = separator', () => expectRoundTrip('= no key'))
  it('round-trips CRLF line endings', () => expectRoundTrip('a = 1\r\nb = 2\r\n'))
  it('round-trips CR-only line endings', () => expectRoundTrip('a = 1\rb = 2\r'))
  it('round-trips BOM prefix', () => expectRoundTrip('\uFEFFkey = value'))
  it('round-trips file with only comments', () => expectRoundTrip('# c1\n! c2\n# c3'))
  it('round-trips file with only blank lines', () => expectRoundTrip('\n\n   \n'))
  it('round-trips mixed content', () => expectRoundTrip('# h\n\nk1 = v1\n# c\nk2 = v2\n'))
  it('round-trips multiline value', () => expectRoundTrip('key = value\\\n  continues\\\n  end'))
  it('round-trips multiline key', () => expectRoundTrip('multiline\\\nKey this is multiline'))
  it('round-trips triple continuation', () => expectRoundTrip('key = a\\\n  b\\\n  c\\\n  d'))
  it('round-trips escaped separators in key', () => expectRoundTrip(String.raw`key\:\=\ = value`))
  it('round-trips Unicode escapes', () => expectRoundTrip(String.raw`k = \u3053\u3093`))
  it('round-trips even backslashes (no continuation)', () => expectRoundTrip('k = v\\\\'))
  it('round-trips odd backslashes (continuation)', () => expectRoundTrip('k = v\\\\\\\n# next'))
  it('round-trips leading whitespace before key', () => expectRoundTrip('    key = value'))
  it('round-trips leading whitespace before comment', () => expectRoundTrip('    # indented'))
  it('round-trips trailing whitespace in value', () => expectRoundTrip('key = value    '))
  it('round-trips duplicate keys', () => expectRoundTrip('key = first\nkey = second'))
  it('round-trips the full test-all.properties file', () => {
    expectRoundTrip(readFileSync('assets/tests/test-all.properties', 'utf8'))
  })
  it('round-trips content ending without newline', () => expectRoundTrip('key = value'))
  it('round-trips content ending with newline', () => expectRoundTrip('key = value\n'))
  it('round-trips tab separator', () => expectRoundTrip('key\tvalue'))
  it('round-trips formfeed separator', () => expectRoundTrip('key\fvalue'))
  it('round-trips multi-space separator', () => expectRoundTrip('category    file format'))
})

// ---------------------------------------------------------------------------
// PropertyNode fields
// ---------------------------------------------------------------------------

describe('PropertyNode fields', () => {
  it('key, escapedKey, value, escapedValue', () => {
    const node = expectFirstProperty(String.raw`hello\=world = foo\nbar`)
    expect(node.key).toBe('hello=world')
    expect(node.escapedKey).toBe(String.raw`hello\=world`)
    expect(node.value).toBe('foo\nbar')
    expect(node.escapedValue).toBe(String.raw`foo\nbar`)
  })

  it('separator " = "', () => {
    const node = expectFirstProperty('key = value')
    expect(node.separatorLeading).toBe(' ')
    expect(node.separatorChar).toBe('=')
    expect(node.separatorTrailing).toBe(' ')
  })

  it('separator "=" (no spaces)', () => {
    const node = expectFirstProperty('key=value')
    expect(node.separatorLeading).toBe('')
    expect(node.separatorChar).toBe('=')
    expect(node.separatorTrailing).toBe('')
  })

  it('separator " : "', () => {
    const node = expectFirstProperty('key : value')
    expect(node.separatorLeading).toBe(' ')
    expect(node.separatorChar).toBe(':')
    expect(node.separatorTrailing).toBe(' ')
  })

  it('separator ":" (no spaces)', () => {
    const node = expectFirstProperty('key:value')
    expect(node.separatorLeading).toBe('')
    expect(node.separatorChar).toBe(':')
    expect(node.separatorTrailing).toBe('')
  })

  it('whitespace-only separator', () => {
    const node = expectFirstProperty('key value')
    expect(node.separatorLeading).toBe(' ')
    expect(node.separatorChar).toBeUndefined()
    expect(node.separatorTrailing).toBe('')
  })

  it('tab separator', () => {
    const node = expectFirstProperty('key\tvalue')
    expect(node.separatorLeading).toBe('\t')
    expect(node.separatorChar).toBeUndefined()
    expect(node.separatorTrailing).toBe('')
  })

  it('multi-space whitespace separator', () => {
    const node = expectFirstProperty('category    file format')
    expect(node.separatorLeading).toBe('    ')
    expect(node.separatorChar).toBeUndefined()
  })

  it('key-only (no separator)', () => {
    const node = expectFirstProperty('empty')
    expect(node.key).toBe('empty')
    expect(node.value).toBe('')
    expect(node.separatorLeading).toBe('')
    expect(node.separatorChar).toBeUndefined()
    expect(node.separatorTrailing).toBe('')
  })

  it('key-only with trailing whitespace', () => {
    const node = expectFirstProperty('keyonly   ')
    expect(node.key).toBe('keyonly')
    expect(node.value).toBe('')
    expect(node.separatorLeading).toBe('   ')
    expect(node.separatorChar).toBeUndefined()
  })

  it('whitespace before = then trailing whitespace after', () => {
    const node = expectFirstProperty('key  =  value')
    expect(node.separatorLeading).toBe('  ')
    expect(node.separatorChar).toBe('=')
    expect(node.separatorTrailing).toBe('  ')
  })

  it('whitespace before : followed by = (: is the separator)', () => {
    const node = expectFirstProperty('key :=value')
    expect(node.separatorLeading).toBe(' ')
    expect(node.separatorChar).toBe(':')
    expect(node.separatorTrailing).toBe('')
    expect(node.value).toBe('=value')
  })

  it('captures leadingWhitespace', () => {
    const node = expectFirstProperty('    key = value')
    expect(node.leadingWhitespace).toBe('    ')
    expect(node.key).toBe('key')
  })

  it('rawLines for single-line property', () => {
    const node = expectFirstProperty('key = value')
    expect(node.rawLines).toEqual(['key = value'])
  })

  it('rawLines for multiline value', () => {
    const node = expectFirstProperty('key = value\\\n  continues')
    expect(node.rawLines).toEqual(['key = value\\', '  continues'])
  })

  it('rawLines for multiline key', () => {
    const node = expectFirstProperty('multiline\\\nKey = value')
    expect(node.rawLines).toEqual(['multiline\\', 'Key = value'])
  })

  it('line numbers for single line', () => {
    const properties = new Properties('a = 1\nb = 2\nc = 3')
    const nodes = properties.getProperties()
    expect(nodes[1].startingLineNumber).toBe(2)
    expect(nodes[1].endingLineNumber).toBe(2)
  })

  it('line numbers for multiline', () => {
    const properties = new Properties('a = 1\nb = val\\\n  ue\nc = 3')
    const nodes = properties.getProperties()
    expect(nodes[1].startingLineNumber).toBe(2)
    expect(nodes[1].endingLineNumber).toBe(3)
  })

  it('empty key with = separator', () => {
    const node = expectFirstProperty('= value')
    expect(node.key).toBe('')
    expect(node.separatorChar).toBe('=')
  })

  it('empty key with : separator and leading whitespace', () => {
    const node = expectFirstProperty('    : value')
    expect(node.leadingWhitespace).toBe('    ')
    expect(node.key).toBe('')
    expect(node.separatorChar).toBe(':')
  })

  it('key-only ending with literal backslash (even count)', () => {
    const node = expectFirstProperty('evenLikeThis\\\\')
    expect(node.key).toBe('evenLikeThis\\')
    expect(node.value).toBe('')
  })

  it('even backslashes before : separator', () => {
    const node = expectFirstProperty(String.raw`keyWitheven\\:this colon is not escaped`)
    expect(node.key).toBe('keyWitheven\\')
    expect(node.separatorChar).toBe(':')
    expect(node.value).toBe('this colon is not escaped')
  })

  it('preserves trailing whitespace in value', () => {
    const node = expectFirstProperty('key = value with trailing    ')
    expect(node.value).toBe('value with trailing    ')
  })

  it('preserves non-breaking space in value', () => {
    const node = expectFirstProperty('key = \u00A0value')
    expect(node.value).toBe('\u00A0value')
  })
})

// ---------------------------------------------------------------------------
// CommentNode and BlankLineNode fields
// ---------------------------------------------------------------------------

describe('CommentNode fields', () => {
  it('parses # delimiter and body', () => {
    const comments = new Properties('# This is a comment').getComments()
    expect(comments).toHaveLength(1)
    expect(comments[0].delimiter).toBe('#')
    expect(comments[0].body).toBe(' This is a comment')
  })

  it('parses ! delimiter and body', () => {
    const comments = new Properties('! Another comment').getComments()
    expect(comments[0].delimiter).toBe('!')
    expect(comments[0].body).toBe(' Another comment')
  })

  it('captures leadingWhitespace', () => {
    const comments = new Properties('    # indented comment').getComments()
    expect(comments[0].leadingWhitespace).toBe('    ')
    expect(comments[0].rawLine).toBe('    # indented comment')
  })

  it('captures lineNumber', () => {
    const comments = new Properties('key = value\n# comment').getComments()
    expect(comments[0].lineNumber).toBe(2)
  })
})

describe('BlankLineNode fields', () => {
  it('captures empty blank line', () => {
    const blanks = new Properties('key = value\n\nkey2 = value2').getBlankLines()
    expect(blanks).toHaveLength(1)
    expect(blanks[0].rawLine).toBe('')
    expect(blanks[0].lineNumber).toBe(2)
  })

  it('captures whitespace-only blank line', () => {
    const blanks = new Properties('key = value\n   \nkey2 = value2').getBlankLines()
    expect(blanks[0].rawLine).toBe('   ')
  })
})

// ---------------------------------------------------------------------------
// Query methods
// ---------------------------------------------------------------------------

describe('Query methods', () => {
  it('getProperties() returns all PropertyNodes in order', () => {
    const nodes = new Properties('# comment\na = 1\n\nb = 2').getProperties()
    expect(nodes).toHaveLength(2)
    expect(nodes[0].key).toBe('a')
    expect(nodes[1].key).toBe('b')
  })

  it('getComments() returns all CommentNodes', () => {
    const comments = new Properties('# c1\na = 1\n! c2\nb = 2').getComments()
    expect(comments).toHaveLength(2)
    expect(comments[0].delimiter).toBe('#')
    expect(comments[1].delimiter).toBe('!')
  })

  it('getBlankLines() returns all BlankLineNodes', () => {
    const blanks = new Properties('a = 1\n\nb = 2\n\nc = 3').getBlankLines()
    expect(blanks).toHaveLength(2)
  })

  it('getPropertyNodes(key) returns all occurrences of a duplicate key', () => {
    const nodes = new Properties('key = first\nkey = second\nkey = third').getPropertyNodes('key')
    expect(nodes).toHaveLength(3)
    expect(nodes[0].value).toBe('first')
    expect(nodes[2].value).toBe('third')
  })

  it('getPropertyNodes(key) returns empty array for missing key', () => {
    expect(new Properties('a = 1').getPropertyNodes('missing')).toEqual([])
  })

  it('getEffectiveProperty(key) returns last occurrence', () => {
    const node = new Properties('key = first\nkey = second').getEffectiveProperty('key')
    expect(node).toBeDefined()
    expect(node!.value).toBe('second')
  })

  it('getEffectiveProperty(key) returns undefined for missing key', () => {
    expect(new Properties('a = 1').getEffectiveProperty('missing')).toBeUndefined()
  })

  it('getKeyCollisions() detects duplicate keys with their nodes', () => {
    const collisions = new Properties('key = first\nother = x\nkey = second').getKeyCollisions()
    expect(collisions).toHaveLength(1)
    expect(collisions[0].key).toBe('key')
    expect(collisions[0].nodes).toHaveLength(2)
    expect(collisions[0].nodes[0].value).toBe('first')
    expect(collisions[0].nodes[1].value).toBe('second')
  })

  it('getKeyCollisions() returns empty for no duplicates', () => {
    expect(new Properties('# comment\na = 1\nb = 2').getKeyCollisions()).toEqual([])
  })

  it('getLeadingNodes(key) returns comment + blank nodes before a property', () => {
    const leading = new Properties('a = 1\n# about b\n\nb = 2').getLeadingNodes('b')
    expect(leading).toHaveLength(2)
    expect(leading[0].type).toBe('comment')
    expect(leading[1].type).toBe('blank')
  })

  it('getLeadingNodes(key) stops at previous property boundary', () => {
    const leading = new Properties('# header\na = 1\n# about b\nb = 2').getLeadingNodes('b')
    expect(leading).toHaveLength(1)
    expect(leading[0].type).toBe('comment')
  })

  it('getLeadingNodes(key) returns empty array when property is first node', () => {
    expect(new Properties('a = 1\nb = 2').getLeadingNodes('a')).toEqual([])
  })

  it('getLeadingNodes(key) includes blank lines between comments', () => {
    const leading = new Properties('# line 1\n\n# line 2\nkey = value').getLeadingNodes('key')
    expect(leading).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// format() with normalization options
// ---------------------------------------------------------------------------

describe('format() with normalization options', () => {
  it('removeComments strips all comment lines', () => {
    const result = new Properties('# comment\nkey = value\n! another').format({
      removeComments: true,
    })
    expect(result).toBe('key = value')
  })

  it('removeBlankLines strips all blank lines', () => {
    const result = new Properties('a = 1\n\nb = 2\n\nc = 3').format({
      removeBlankLines: true,
    })
    expect(result).toBe('a = 1\nb = 2\nc = 3')
  })

  it('removeLeadingWhitespace strips indentation', () => {
    const result = new Properties('    key = value\n    # comment').format({
      removeLeadingWhitespace: true,
    })
    expect(result).toBe('key = value\n# comment')
  })

  it('deduplicateKeys keeps only last occurrence', () => {
    const result = new Properties('key = first\nother = x\nkey = second').format({
      deduplicateKeys: true,
    })
    expect(result).toBe('other = x\nkey = second')
  })

  it('deduplicateKeys skips earlier non-property nodes between duplicates', () => {
    const result = new Properties('key = first\n# comment\nkey = second').format({
      deduplicateKeys: true,
    })
    expect(result).toBe('# comment\nkey = second')
  })

  it('deduplicateKeys stops removing leading nodes at previous property boundary', () => {
    const result = new Properties('other = x\nkey = first\nkey = second').format({
      deduplicateKeys: true,
    })
    expect(result).toBe('other = x\nkey = second')
  })

  it('deduplicateKeys removes leading comments of removed duplicates', () => {
    const result = new Properties(
      '# about first\nkey = first\n# about second\nkey = second'
    ).format({ deduplicateKeys: true })
    expect(result).toBe('# about second\nkey = second')
  })

  it('deduplicateKeys preserves leading nodes when deduplicateKeysKeepLeadingNodes is true', () => {
    const result = new Properties(
      '# about first\nkey = first\n# about second\nkey = second'
    ).format({ deduplicateKeys: true, deduplicateKeysKeepLeadingNodes: true })
    expect(result).toBe('# about first\n# about second\nkey = second')
  })

  it('deduplicateKeys removes leading blank lines of removed duplicates', () => {
    const result = new Properties('\nkey = first\n\n# kept\nkey = second').format({
      deduplicateKeys: true,
    })
    expect(result).toBe('\n# kept\nkey = second')
  })

  it('separatorChar = standardizes all separators', () => {
    const result = new Properties('a : 1\nb 2').format({
      separatorChar: '=',
      separatorLeading: ' ',
      separatorTrailing: ' ',
    })
    expect(result).toBe('a = 1\nb = 2')
  })

  it('separatorChar : standardizes all separators', () => {
    const result = new Properties('a = 1\nb 2').format({
      separatorChar: ':',
      separatorLeading: ' ',
      separatorTrailing: ' ',
    })
    expect(result).toBe('a : 1\nb : 2')
  })

  it('separatorChar space standardizes to whitespace', () => {
    const result = new Properties('a = 1\nb : 2').format({
      separatorChar: ' ',
      separatorLeading: ' ',
      separatorTrailing: '',
    })
    expect(result).toBe('a 1\nb 2')
  })

  it('separatorLeading and separatorTrailing control whitespace', () => {
    const result = new Properties('key = value').format({
      separatorChar: '=',
      separatorLeading: '',
      separatorTrailing: '',
    })
    expect(result).toBe('key=value')
  })

  it('normalizes only separatorLeading without changing separatorChar', () => {
    const result = new Properties('key = value').format({ separatorLeading: '' })
    expect(result).toBe('key= value')
  })

  it('normalizes only separatorTrailing without changing separatorChar', () => {
    const result = new Properties('key = value').format({ separatorTrailing: '' })
    expect(result).toBe('key =value')
  })

  // eslint-disable-next-line unicorn/prefer-string-raw
  it('escapeUnicode converts non-ASCII to \\uXXXX', () => {
    const result = new Properties('key = \u00FC').format({ escapeUnicode: true })
    expect(result.toLowerCase()).toContain(String.raw`\u00fc`)
  })

  it('collapseMultiline joins continuation lines', () => {
    const result = new Properties('key = value\\\n  continues').format({
      collapseMultiline: true,
    })
    expect(result).toBe('key = valuecontinues')
  })

  it('wrapKeysAt wraps long keys', () => {
    const result = new Properties('verylongkeyname = value').format({ wrapKeysAt: 8 })
    expect(result).toContain('\\\n')
    expect(new Properties(result).toObject()).toEqual({ verylongkeyname: 'value' })
  })

  it('wrapValuesAt wraps long values', () => {
    const result = new Properties('key = this is a very long value that should wrap').format({
      wrapValuesAt: 20,
    })
    expect(result).toContain('\\\n')
    expect(new Properties(result).toObject()).toEqual({
      key: 'this is a very long value that should wrap',
    })
  })

  it('wrapValuesAt with short value does not wrap', () => {
    expect(new Properties('key = short').format({ wrapValuesAt: 100 })).toBe('key = short')
  })

  it('wrapKeysAt and wrapValuesAt with different widths', () => {
    const result = new Properties('verylongkeyname = this is a very long value').format({
      wrapKeysAt: 8,
      wrapValuesAt: 15,
    })
    expect(new Properties(result).toObject()).toEqual({
      verylongkeyname: 'this is a very long value',
    })
  })

  // eslint-disable-next-line unicorn/prefer-string-raw
  it('wrapValuesAt does not split \\uXXXX sequences', () => {
    const result = new Properties(String.raw`key = abc\u0041def`).format({
      wrapValuesAt: 6,
    })
    expect(result).not.toMatch(/\\u\d{0,3}\\\n/)
    expect(new Properties(result).toObject()).toEqual({ key: 'abcAdef' })
  })

  it('combines multiple options', () => {
    const result = new Properties('# comment\n\n    key : value\n    key : second').format({
      removeComments: true,
      removeBlankLines: true,
      removeLeadingWhitespace: true,
      deduplicateKeys: true,
      separatorChar: '=',
      separatorLeading: '',
      separatorTrailing: '',
    })
    expect(result).toBe('key=second')
  })

  it('preserves key order', () => {
    const result = new Properties('b = 2\na = 1\nc = 3').format({ separatorChar: '=' })
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('a'))
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('c'))
  })

  it('preserves BOM if present', () => {
    const result = new Properties('\uFEFFkey = value').format({})
    expect(result.codePointAt(0)).toBe(0xfeff)
  })

  it('format with empty options still normalizes (triggers rebuild path)', () => {
    const properties = new Properties('key = value')
    expect(properties.format({})).toBe('key = value')
  })

  it('preserves blank lines when normalizing separators', () => {
    const result = new Properties('a = 1\n\nb = 2').format({ separatorChar: ':' })
    expect(result).toContain('\n\n')
  })

  it('endOfLineCharacter overrides detected eol', () => {
    const result = new Properties('a = 1\nb = 2').format({
      endOfLineCharacter: '\r\n',
    })
    expect(result).toBe('a = 1\r\nb = 2')
  })

  it('separatorChar space without explicit separatorLeading defaults to single space', () => {
    const result = new Properties('key=value').format({ separatorChar: ' ' })
    expect(result).toBe('key value')
    expect(new Properties(result).toObject()).toEqual({ key: 'value' })
  })

  it('normalizes whitespace-only separator property preserving node separatorChar', () => {
    const result = new Properties('key value').format({
      separatorLeading: '\t',
    })
    expect(result).toBe('key\tvalue')
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('PropertiesNodeType constants', () => {
  it('matches the type discriminators on parsed nodes', () => {
    const properties = new Properties('# comment\n\nkey = value')
    const [comment, blank, property] = properties.nodes
    expect(comment.type).toBe(PropertiesNodeType.COMMENT)
    expect(blank.type).toBe(PropertiesNodeType.BLANK)
    expect(property.type).toBe(PropertiesNodeType.PROPERTY)
  })
})

describe('Edge cases', () => {
  it('handles content with only whitespace', () => {
    const properties = new Properties('   ')
    expect(properties.toObject()).toEqual({})
    expect(properties.getBlankLines()).toHaveLength(1)
  })

  it('detects EOL from first line terminator found', () => {
    expect(new Properties('a = 1\r\nb = 2\nc = 3').eolCharacter).toBe('\r\n')
  })

  // eslint-disable-next-line unicorn/prefer-string-raw
  it('defaults EOL to \\n when no line terminators present', () => {
    expect(new Properties('key = value').eolCharacter).toBe('\n')
  })

  it('handles property with escaped backslash before separator', () => {
    expect(new Properties(String.raw`key\\ = value`).toObject()).toEqual({ 'key\\': 'value' })
  })

  // eslint-disable-next-line unicorn/prefer-string-raw
  it('handles continuation at end of file (no content after \\)', () => {
    expect(new Properties('key = value\\').toObject()).toEqual({ key: 'value' })
  })

  it('handles empty continuation line', () => {
    expect(new Properties('key = value\\\n\\\nnext').toObject()).toEqual({ key: 'valuenext' })
  })

  it('comment-like line after continuation becomes part of value', () => {
    const properties = new Properties('key = value\\\n# not a comment')
    expect(properties.toObject()).toEqual({ key: 'value# not a comment' })
    expect(properties.getComments()).toHaveLength(0)
  })

  it('handles BOM detection', () => {
    expect(new Properties('\uFEFFkey = value').hasBom).toBe(true)
  })

  it('handles no BOM', () => {
    expect(new Properties('key = value').hasBom).toBe(false)
  })

  it('handles Buffer input', () => {
    expect(new Properties(Buffer.from('key = value')).toObject()).toEqual({ key: 'value' })
  })

  it('handles file ending with blank line', () => {
    expect(new Properties('key = value\n').getBlankLines()).toHaveLength(1)
  })

  it('handles file not ending with newline', () => {
    expect(new Properties('key = value').getBlankLines()).toHaveLength(0)
  })
})
