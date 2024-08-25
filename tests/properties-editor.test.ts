import { PropertiesEditor } from '../src/editor'

let propertiesContent = 'hi\nhello = hello\n# This is a comment\nworld = world'
const properties = new PropertiesEditor(propertiesContent)

describe('The `PropertiesEditor` class', () => {
  it('`.update()` method does nothing when the key does not exist', () => {
    const result = properties.update('doesNotExist', {
      newValue: 'not going to be used',
    })
    expect(result).toEqual(false)
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method does nothing with no options', () => {
    const result = properties.update('hello')
    expect(result).toEqual(false)
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.insert()` method does nothing when a reference key is not found', () => {
    const result = properties.insert('notGoingToBeInserted', 'not going to be inserted', {
      referenceKey: 'doesNotExist',
    })
    expect(result).toEqual(false)
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.insertComment()` method does nothing when a reference key is not found', () => {
    const result = properties.insertComment('notGoingToBeInserted', {
      referenceKey: 'doesNotExist',
    })
    expect(result).toEqual(false)
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.delete()` method does nothing when a reference key is not found', () => {
    const result = properties.delete('doesNotExist')
    expect(result).toEqual(false)
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method can add a value to a key without value', () => {
    properties.update('hi', {
      newValue: 'there',
    })
    propertiesContent = 'hi = there\nhello = hello\n# This is a comment\nworld = world'
    expect(properties.format()).toEqual(propertiesContent)
    properties.delete('hi')
    propertiesContent = 'hello = hello\n# This is a comment\nworld = world'
  })

  it('`.insertComment()` method adds a comment at the end of the content when no options are provided', () => {
    properties.insertComment('This is a multiline\ncomment before the new third key')
    propertiesContent = `${propertiesContent}\n# This is a multiline\n# comment before the new third key`
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.insert()` method adds a property at the end of the content when no options are provided', () => {
    properties.insert('newKey3', 'This is my third key')
    propertiesContent = `${propertiesContent}\nnewKey3 = This is my third key`
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.insert()` method adds a property before a reference key with a comments on 2 lines', () => {
    properties.insert('newKey1', 'This is my first new key\non 2 lines', {
      separator: ':',
      referenceKey: 'newKey3',
      position: 'before',
      comment: 'This is a multiline\ncomment before the new first key',
      commentDelimiter: '!',
    })
    propertiesContent = [
      'hello = hello',
      '# This is a comment',
      'world = world',
      '! This is a multiline',
      '! comment before the new first key',
      'newKey1 : This is my first new key\\',
      'on 2 lines',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.insert()` method adds a property after a reference key with a comments', () => {
    properties.insert('newKey2', 'This is my second new key', {
      referenceKey: 'newKey1',
      comment: 'This is a comment for my new second key',
    })
    propertiesContent = [
      'hello = hello',
      '# This is a comment',
      'world = world',
      '! This is a multiline',
      '! comment before the new first key',
      'newKey1 : This is my first new key\\',
      'on 2 lines',
      '# This is a comment for my new second key',
      'newKey2 = This is my second new key',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.delete()` method removes a property from the content', () => {
    properties.delete('newKey1')
    propertiesContent = [
      'hello = hello',
      '# This is a comment',
      'world = world',
      '# This is a comment for my new second key',
      'newKey2 = This is my second new key',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method change the key, value and comment for an existing property', () => {
    properties.update('newKey2', {
      newKey: 'newKey1',
      newValue: 'this is the new value for the old newKey2\non 2 lines',
      newComment: 'The new comment for newKey1 that used to be newKey2\non 2 lines',
    })
    propertiesContent = [
      'hello = hello',
      '# This is a comment',
      'world = world',
      '# The new comment for newKey1 that used to be newKey2',
      '# on 2 lines',
      'newKey1 = this is the new value for the old newKey2\\',
      'on 2 lines',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.insertComment()` method adds a comment at the beginning of the content', () => {
    properties.insertComment('This is a new comment at the beginning of the file', {
      commentDelimiter: '!',
      position: 'before',
      referenceKey: 'hello',
    })
    propertiesContent = `! This is a new comment at the beginning of the file\n${propertiesContent}`
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.insert()` method adds a property at the beginning of the content', () => {
    properties.insert('こんにちは', 'こんにちは', {
      position: 'before',
      referenceKey: 'hello',
      escapeUnicode: true,
      separator: ' ',
      comment: 'こんにちは',
      commentDelimiter: '#',
    })
    propertiesContent = `# こんにちは\n\\u3053\\u3093\\u306b\\u3061\\u306f \\u3053\\u3093\\u306b\\u3061\\u306f\n${propertiesContent}`
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.insertComment()` method adds a comment after a property that is the first element', () => {
    properties.insertComment('This comment was inserted after こんにちは', {
      position: 'after',
      referenceKey: 'こんにちは',
    })
    propertiesContent = [
      '# こんにちは',
      String.raw`\u3053\u3093\u306b\u3061\u306f \u3053\u3093\u306b\u3061\u306f`,
      '# This comment was inserted after こんにちは',
      '! This is a new comment at the beginning of the file',
      'hello = hello',
      '# This is a comment',
      'world = world',
      '# The new comment for newKey1 that used to be newKey2',
      '# on 2 lines',
      'newKey1 = this is the new value for the old newKey2\\',
      'on 2 lines',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.insertComment()` method adds a comment after a property that is not first element', () => {
    properties.insertComment('This comment was inserted before `hello`', {
      position: 'before',
      referenceKey: 'hello',
    })
    propertiesContent = [
      '# こんにちは',
      String.raw`\u3053\u3093\u306b\u3061\u306f \u3053\u3093\u306b\u3061\u306f`,
      '# This comment was inserted before `hello`',
      '# This comment was inserted after こんにちは',
      '! This is a new comment at the beginning of the file',
      'hello = hello',
      '# This is a comment',
      'world = world',
      '# The new comment for newKey1 that used to be newKey2',
      '# on 2 lines',
      'newKey1 = this is the new value for the old newKey2\\',
      'on 2 lines',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.delete()` method removes a key without its comments', () => {
    properties.delete('こんにちは', false)
    propertiesContent = [
      '# こんにちは',
      '# This comment was inserted before `hello`',
      '# This comment was inserted after こんにちは',
      '! This is a new comment at the beginning of the file',
      'hello = hello',
      '# This is a comment',
      'world = world',
      '# The new comment for newKey1 that used to be newKey2',
      '# on 2 lines',
      'newKey1 = this is the new value for the old newKey2\\',
      'on 2 lines',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.delete()` method removes the first key correctly', () => {
    properties.delete('hello')
    propertiesContent = [
      '# This is a comment',
      'world = world',
      '# The new comment for newKey1 that used to be newKey2',
      '# on 2 lines',
      'newKey1 = this is the new value for the old newKey2\\',
      'on 2 lines',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method change the key, value and comment for an existing property while escaping unicode', () => {
    properties.update('newKey1', {
      newKey: 'newKey2',
      newValue: 'こんにちは',
      escapeUnicode: true,
      newComment: 'This is once again `newKey2`',
      commentDelimiter: '!',
      separator: ' ',
    })
    propertiesContent = [
      '# This is a comment',
      'world = world',
      '! This is once again `newKey2`',
      String.raw`newKey2 \u3053\u3093\u306b\u3061\u306f`,
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method changes only the key on 2 lines', () => {
    properties.update('world', {
      newKey: 'new\nKey1',
    })
    propertiesContent = [
      '# This is a comment',
      'new\\',
      'Key1 = world',
      '! This is once again `newKey2`',
      String.raw`newKey2 \u3053\u3093\u306b\u3061\u306f`,
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method changes only the value on 2 lines', () => {
    properties.update('newKey1', {
      newValue: 'new value for `newKey1`\non 2 lines',
    })
    propertiesContent = [
      '# This is a comment',
      'new\\',
      'Key1 = new value for `newKey1`\\',
      'on 2 lines',
      '! This is once again `newKey2`',
      String.raw`newKey2 \u3053\u3093\u306b\u3061\u306f`,
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method changes only the comment on 2 lines', () => {
    properties.update('newKey1', {
      newComment: 'This is the first comment of the file\non 2 lines',
    })
    propertiesContent = [
      '# This is the first comment of the file',
      '# on 2 lines',
      'new\\',
      'Key1 = new value for `newKey1`\\',
      'on 2 lines',
      '! This is once again `newKey2`',
      String.raw`newKey2 \u3053\u3093\u306b\u3061\u306f`,
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method changes only the key on a single line', () => {
    properties.update('newKey1', {
      newKey: 'newKey1',
      separator: ':',
      escapeUnicode: false,
    })
    propertiesContent = [
      '# This is the first comment of the file',
      '# on 2 lines',
      'newKey1 : new value for `newKey1`\\',
      'on 2 lines',
      '! This is once again `newKey2`',
      String.raw`newKey2 \u3053\u3093\u306b\u3061\u306f`,
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method changes only the separator on a single line', () => {
    properties.update('newKey2', {
      separator: '=',
      escapeUnicode: true,
    })
    propertiesContent = [
      '# This is the first comment of the file',
      '# on 2 lines',
      'newKey1 : new value for `newKey1`\\',
      'on 2 lines',
      '! This is once again `newKey2`',
      String.raw`newKey2 = \u3053\u3093\u306b\u3061\u306f`,
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method changes only the unescape unicode on a single line', () => {
    properties.update('newKey2', {
      escapeUnicode: false,
    })
    propertiesContent = [
      '# This is the first comment of the file',
      '# on 2 lines',
      'newKey1 : new value for `newKey1`\\',
      'on 2 lines',
      '! This is once again `newKey2`',
      'newKey2 = こんにちは',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method changes only the value on a single line', () => {
    properties.update('newKey2', {
      newValue: 'This is `newKey2`',
      separator: ' ',
      escapeUnicode: true,
    })
    propertiesContent = [
      '# This is the first comment of the file',
      '# on 2 lines',
      'newKey1 : new value for `newKey1`\\',
      'on 2 lines',
      '! This is once again `newKey2`',
      'newKey2 This is `newKey2`',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.update()` method changes only the comment on a single line', () => {
    properties.update('newKey2', {
      newComment: 'New comment for `newKey2`',
      commentDelimiter: '#',
      escapeUnicode: true,
    })
    propertiesContent = [
      '# This is the first comment of the file',
      '# on 2 lines',
      'newKey1 : new value for `newKey1`\\',
      'on 2 lines',
      '# New comment for `newKey2`',
      'newKey2 This is `newKey2`',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.insertComment()` method adds a comment after a property that is last element', () => {
    properties.insertComment('New comment after `newKey3`', {
      referenceKey: 'newKey3',
      commentDelimiter: '!',
    })
    propertiesContent = [
      '# This is the first comment of the file',
      '# on 2 lines',
      'newKey1 : new value for `newKey1`\\',
      'on 2 lines',
      '# New comment for `newKey2`',
      'newKey2 This is `newKey2`',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
      '! New comment after `newKey3`',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.upsert()` method inserts a new property at the end', () => {
    properties.upsert('newKey4', 'The value of the fourth key', {
      comment: 'comment before the new fourth key',
      commentDelimiter: '!',
    })
    propertiesContent = [
      '# This is the first comment of the file',
      '# on 2 lines',
      'newKey1 : new value for `newKey1`\\',
      'on 2 lines',
      '# New comment for `newKey2`',
      'newKey2 This is `newKey2`',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
      '! New comment after `newKey3`',
      '! comment before the new fourth key',
      'newKey4 = The value of the fourth key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.upsert()` method updates an existing property', () => {
    properties.upsert('newKey4', 'The new value of the fourth key', {
      comment: 'new comment before the new fourth key',
      commentDelimiter: '#',
      escapeUnicode: true,
      separator: ':',
    })
    propertiesContent = [
      '# This is the first comment of the file',
      '# on 2 lines',
      'newKey1 : new value for `newKey1`\\',
      'on 2 lines',
      '# New comment for `newKey2`',
      'newKey2 This is `newKey2`',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
      '# new comment before the new fourth key',
      'newKey4 : The new value of the fourth key',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })

  it('`.upsert()` method updates an existing property with no options', () => {
    properties.upsert('newKey4', 'The new value of the fourth key with no option')
    propertiesContent = [
      '# This is the first comment of the file',
      '# on 2 lines',
      'newKey1 : new value for `newKey1`\\',
      'on 2 lines',
      '# New comment for `newKey2`',
      'newKey2 This is `newKey2`',
      '# This is a multiline',
      '# comment before the new third key',
      'newKey3 = This is my third key',
      '# new comment before the new fourth key',
      'newKey4 : The new value of the fourth key with no option',
    ].join('\n')
    expect(properties.format()).toEqual(propertiesContent)
  })
})
