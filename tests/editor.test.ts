/**
 * Editor tests for PropertiesEditor — insert, update, delete, upsert operations.
 */
import { PropertiesEditor } from '../src/editor'
import { Properties } from '../src/parser'

describe('PropertiesEditor', () => {
  // ─── insert ───────────────────────────────────────────────────────

  it('insert adds property at end', () => {
    const editor = new PropertiesEditor('a = 1')
    editor.insert('b', '2')
    expect(editor.toObject()).toEqual({ a: '1', b: '2' })
    expect(editor.format()).toContain('b')
  })

  it('insert adds before reference key', () => {
    const editor = new PropertiesEditor('a = 1\nc = 3')
    editor.insert('b', '2', { referenceKey: 'c', position: 'before' })
    const result = editor.format()
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('c'))
  })

  it('insert adds after reference key', () => {
    const editor = new PropertiesEditor('a = 1\nc = 3')
    editor.insert('b', '2', { referenceKey: 'a', position: 'after' })
    const result = editor.format()
    expect(result.indexOf('b')).toBeGreaterThan(result.indexOf('a'))
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('c'))
  })

  it('insert with custom separator :', () => {
    const editor = new PropertiesEditor('')
    editor.insert('key', 'value', { separator: ':' })
    expect(editor.format()).toContain(':')
  })

  it('insert with custom separator space', () => {
    const editor = new PropertiesEditor('')
    editor.insert('key', 'value', { separator: ' ' })
    const result = editor.format()
    expect(result).not.toContain('=')
    expect(result).not.toContain(':')
    expect(new Properties(result).toObject()).toEqual({ key: 'value' })
  })

  it('insert with comment', () => {
    const editor = new PropertiesEditor('')
    editor.insert('key', 'value', { comment: 'A comment' })
    const result = editor.format()
    expect(result).toContain('# A comment')
    expect(result).toContain('key')
  })

  it('insert with ! comment delimiter', () => {
    const editor = new PropertiesEditor('')
    editor.insert('key', 'value', { comment: 'A comment', commentDelimiter: '!' })
    expect(editor.format()).toContain('! A comment')
  })

  it('insert with escapeUnicode', () => {
    const editor = new PropertiesEditor('')
    editor.insert('\u00FC', '\u00FC', { escapeUnicode: true })
    const result = editor.format()
    expect(result.toLowerCase()).toContain(String.raw`\u00fc`)
  })

  it('insert appends at end when referenceKey not found', () => {
    const editor = new PropertiesEditor('a = 1')
    editor.insert('b', '2', { referenceKey: 'missing' })
    expect(editor.toObject()).toEqual({ a: '1', b: '2' })
  })

  // ─── insertComment ────────────────────────────────────────────────

  it('insertComment adds a comment at end', () => {
    const editor = new PropertiesEditor('key = value')
    editor.insertComment('A comment')
    expect(editor.format()).toContain('# A comment')
  })

  it('insertComment with multi-line string creates multiple CommentNodes', () => {
    const editor = new PropertiesEditor('key = value')
    editor.insertComment('Line 1\nLine 2\nLine 3')
    const comments = editor.getComments()
    expect(comments.length).toBeGreaterThanOrEqual(3)
  })

  it('insertComment with referenceKey before', () => {
    const editor = new PropertiesEditor('a = 1\nb = 2')
    editor.insertComment('Before b', { referenceKey: 'b', position: 'before' })
    const result = editor.format()
    expect(result.indexOf('Before b')).toBeLessThan(result.indexOf('b = 2'))
  })

  it('insertComment with referenceKey after', () => {
    const editor = new PropertiesEditor('a = 1\nb = 2')
    editor.insertComment('After a', { referenceKey: 'a', position: 'after' })
    const result = editor.format()
    expect(result.indexOf('After a')).toBeGreaterThan(result.indexOf('a = 1'))
    expect(result.indexOf('After a')).toBeLessThan(result.indexOf('b = 2'))
  })

  it('insertComment with ! delimiter', () => {
    const editor = new PropertiesEditor('key = value')
    editor.insertComment('A comment', { commentDelimiter: '!' })
    expect(editor.format()).toContain('! A comment')
  })

  it('insertComment with blank lines in multi-line text', () => {
    const editor = new PropertiesEditor('key = value')
    editor.insertComment('Line 1\n\nLine 2')
    const comments = editor.getComments()
    const blanks = editor.getBlankLines()
    expect(comments).toHaveLength(2)
    expect(blanks).toHaveLength(1)
    const result = editor.format()
    expect(result).toContain('# Line 1\n\n# Line 2')
  })

  // ─── insertBlankLine ──────────────────────────────────────────────

  it('insertBlankLine adds a blank line at end', () => {
    const editor = new PropertiesEditor('a = 1')
    editor.insertBlankLine()
    expect(editor.getBlankLines()).toHaveLength(1)
    expect(editor.format()).toBe('a = 1\n')
  })

  it('insertBlankLine before a reference key', () => {
    const editor = new PropertiesEditor('a = 1\nb = 2')
    editor.insertBlankLine({ referenceKey: 'b', position: 'before' })
    expect(editor.format()).toBe('a = 1\n\nb = 2')
  })

  it('insertBlankLine after a reference key', () => {
    const editor = new PropertiesEditor('a = 1\nb = 2')
    editor.insertBlankLine({ referenceKey: 'a', position: 'after' })
    expect(editor.format()).toBe('a = 1\n\nb = 2')
  })

  it('insertBlankLine appends when referenceKey not found', () => {
    const editor = new PropertiesEditor('a = 1')
    editor.insertBlankLine({ referenceKey: 'missing' })
    expect(editor.getBlankLines()).toHaveLength(1)
  })

  it('insertComment appends at end when referenceKey not found', () => {
    const editor = new PropertiesEditor('a = 1')
    editor.insertComment('comment', { referenceKey: 'missing' })
    expect(editor.format()).toContain('# comment')
  })

  // ─── update ───────────────────────────────────────────────────────

  it('update changes value', () => {
    const editor = new PropertiesEditor('key = old')
    editor.update('key', { newValue: 'new' })
    expect(editor.toObject()).toEqual({ key: 'new' })
  })

  it('update changes key (rename)', () => {
    const editor = new PropertiesEditor('old = value')
    editor.update('old', { newKey: 'new' })
    expect(editor.toObject()).toEqual({ new: 'value' })
  })

  it('update changes separator', () => {
    const editor = new PropertiesEditor('key = value')
    editor.update('key', { separator: ':' })
    expect(editor.format()).toContain(':')
    expect(editor.toObject()).toEqual({ key: 'value' })
  })

  it('update with separator space', () => {
    const editor = new PropertiesEditor('key = value')
    editor.update('key', { separator: ' ' })
    const result = editor.format()
    expect(result).not.toContain('=')
    expect(new Properties(result).toObject()).toEqual({ key: 'value' })
  })

  it('update with newComment replaces leading comment nodes', () => {
    const editor = new PropertiesEditor('# old comment\nkey = value')
    editor.update('key', { newComment: 'new comment' })
    const result = editor.format()
    expect(result).toContain('# new comment')
    expect(result).not.toContain('old comment')
  })

  it('update with newComment when property has leading comments adjacent to another property', () => {
    const editor = new PropertiesEditor('a = 1\n# old\nb = 2')
    editor.update('b', { newComment: 'new' })
    const result = editor.format()
    expect(result).toContain('# new')
    expect(result).not.toContain('# old')
  })

  it('update with empty options preserves property', () => {
    const editor = new PropertiesEditor('key = value')
    editor.update('key', {})
    expect(editor.format()).toBe('key = value')
  })

  it('update with escapeUnicode', () => {
    const editor = new PropertiesEditor('key = \u00FC')
    editor.update('key', { escapeUnicode: true })
    expect(editor.format().toLowerCase()).toContain(String.raw`\u00fc`)
  })

  it('update returns false for missing key', () => {
    const editor = new PropertiesEditor('a = 1')
    expect(editor.update('missing', { newValue: 'x' })).toBe(false)
  })

  // ─── delete ───────────────────────────────────────────────────────

  it('delete removes property and returns the deleted node', () => {
    const editor = new PropertiesEditor('a = 1\nb = 2\nc = 3')
    const deleted = editor.delete('b')
    expect(deleted).toBeDefined()
    if (deleted === undefined) {
      return
    }
    expect(deleted.key).toBe('b')
    expect(deleted.value).toBe('2')
    expect(editor.toObject()).toEqual({ a: '1', c: '3' })
  })

  it('delete removes property with preceding comments', () => {
    const editor = new PropertiesEditor('a = 1\n# about b\nb = 2\nc = 3')
    editor.delete('b')
    const result = editor.format()
    expect(result).not.toContain('about b')
    expect(result).not.toContain('b = 2')
  })

  it('delete without removing leading nodes', () => {
    const editor = new PropertiesEditor('a = 1\n# about b\nb = 2\nc = 3')
    editor.delete('b', { deleteLeadingNodes: false })
    const result = editor.format()
    expect(result).toContain('about b')
    expect(result).not.toContain('b = 2')
  })

  it('delete returns undefined for missing key', () => {
    const editor = new PropertiesEditor('a = 1')
    expect(editor.delete('missing')).toBeUndefined()
  })

  it('delete with occurrence first removes the first occurrence', () => {
    const editor = new PropertiesEditor('key = first\nkey = second\nkey = third')
    const deleted = editor.delete('key', { occurrence: 'first' })
    expect(deleted).toBeDefined()
    if (deleted === undefined) {
      return
    }
    expect(deleted.value).toBe('first')
    expect(editor.toObject()).toEqual({ key: 'third' })
    expect(editor.getPropertyNodes('key')).toHaveLength(2)
  })

  it('delete with occurrence first removes leading comments', () => {
    const editor = new PropertiesEditor('# about first\nkey = first\n# about second\nkey = second')
    editor.delete('key', { occurrence: 'first' })
    const result = editor.format()
    expect(result).not.toContain('about first')
    expect(result).not.toContain('key = first')
    expect(result).toContain('# about second')
    expect(result).toContain('key = second')
  })

  it('delete with occurrence first and deleteLeadingNodes false keeps comments', () => {
    const editor = new PropertiesEditor('# about first\nkey = first\n# about second\nkey = second')
    editor.delete('key', { occurrence: 'first', deleteLeadingNodes: false })
    const result = editor.format()
    expect(result).toContain('# about first')
    expect(result).not.toContain('key = first')
    expect(result).toContain('key = second')
  })

  it('delete with occurrence first returns undefined for missing key', () => {
    const editor = new PropertiesEditor('a = 1')
    expect(editor.delete('missing', { occurrence: 'first' })).toBeUndefined()
  })

  it('delete duplicates using getKeyCollisions and occurrence first', () => {
    const editor = new PropertiesEditor(
      '# first\nkey = first\n# second\nkey = second\n# third\nkey = third'
    )
    const collisions = editor.getKeyCollisions()
    for (const collision of collisions) {
      for (let index = 0; index < collision.nodes.length - 1; index++) {
        editor.delete(collision.key, { occurrence: 'first' })
      }
    }
    const result = editor.format()
    expect(result).toBe('# third\nkey = third')
    expect(editor.toObject()).toEqual({ key: 'third' })
  })

  // ─── deleteAll ────────────────────────────────────────────────────

  it('deleteAll removes all occurrences and returns deleted nodes', () => {
    const editor = new PropertiesEditor('key = first\nother = x\nkey = second\nkey = third')
    const deleted = editor.deleteAll('key')
    expect(deleted).toHaveLength(3)
    expect(deleted[0].value).toBe('first')
    expect(deleted[1].value).toBe('second')
    expect(deleted[2].value).toBe('third')
    expect(editor.toObject()).toEqual({ other: 'x' })
  })

  it('deleteAll returns empty array for missing key', () => {
    const editor = new PropertiesEditor('a = 1')
    expect(editor.deleteAll('missing')).toEqual([])
  })

  // ─── upsert ───────────────────────────────────────────────────────

  it('upsert inserts if key does not exist', () => {
    const editor = new PropertiesEditor('a = 1')
    editor.upsert('b', '2')
    expect(editor.toObject()).toEqual({ a: '1', b: '2' })
  })

  it('upsert updates if key exists', () => {
    const editor = new PropertiesEditor('a = 1')
    editor.upsert('a', '2')
    expect(editor.toObject()).toEqual({ a: '2' })
  })

  it('upsert updates with all options', () => {
    const editor = new PropertiesEditor('a = 1')
    editor.upsert('a', '\u00FC', {
      escapeUnicode: true,
      separator: ':',
      comment: 'Updated',
      commentDelimiter: '!',
    })
    const result = editor.format()
    expect(result).toContain('! Updated')
    expect(result).toContain(':')
    expect(result.toLowerCase()).toContain(String.raw`\u00fc`)
  })

  // ─── Integration ──────────────────────────────────────────────────

  it('insert preserves newlines in values through round-trip (issue #82)', () => {
    const editor = new PropertiesEditor('')
    const value = 'new\nline'
    editor.insert('test', value)
    const reparsed = new Properties(editor.format())
    expect(reparsed.toObject().test).toBe(value)
  })

  it('format() after editing produces valid properties content', () => {
    const editor = new PropertiesEditor('a = 1\nb = 2')
    editor.insert('c', '3')
    editor.update('a', { newValue: 'updated' })
    editor.delete('b')
    const result = editor.format()
    const reparsed = new Properties(result)
    expect(reparsed.toObject()).toEqual({ a: 'updated', c: '3' })
  })

  it('editing updates line numbers correctly', () => {
    const editor = new PropertiesEditor('a = 1\nb = 2\nc = 3')
    editor.delete('a')
    const nodes = editor.getProperties()
    expect(nodes[0].key).toBe('b')
    expect(nodes[0].startingLineNumber).toBe(1)
  })
})
