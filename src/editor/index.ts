import { escapeKey, escapeValue } from '../escape'
import { Properties } from '../parser/properties'

import type { BlankLineNode, CommentNode, PropertiesNode, PropertyNode } from '../parser/nodes'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The default separator between keys and values. */
const DEFAULT_SEPARATOR = '='

/** The default character used as comment delimiter. */
const DEFAULT_COMMENT_DELIMITER = '#'

/** Matches a line terminator: CRLF, bare CR, or bare LF. */
const REGEX_NEWLINE = /\r\n|\r|\n/

// ---------------------------------------------------------------------------
// Editor option types
// ---------------------------------------------------------------------------

/** Characters that can be used as key-value pair separators. */
export type KeyValuePairSeparator = '=' | ':' | ' '

/** Characters that can be used as comment delimiters. */
export type CommentDelimiter = '#' | '!'

/** Options for {@link PropertiesEditor.insert}. */
export type InsertOptions = {
  /**
   * Insert relative to this key (last occurrence). If the key is not found,
   * the property is appended at the end.
   */
  referenceKey?: string
  /** Position relative to the reference key. Default: `'after'`. */
  position?: 'before' | 'after'
  /** If `true`, escape non-ASCII characters as `\\uXXXX` sequences. Default: `false`. */
  escapeUnicode?: boolean
  /** Separator character to use between key and value. Default: `'='`. */
  separator?: KeyValuePairSeparator
  /**
   * Comment text to prepend before the property. Supports multi-line: newlines
   * in the string create separate comment nodes. Empty lines within the text
   * become blank line nodes.
   */
  comment?: string
  /** Delimiter character for the comment. Default: `'#'`. */
  commentDelimiter?: CommentDelimiter
}

/** Options for {@link PropertiesEditor.insertComment}. */
export type InsertCommentOptions = {
  /**
   * Insert relative to this key (last occurrence). If the key is not found,
   * the comment is appended at the end.
   */
  referenceKey?: string
  /** Position relative to the reference key. Default: `'after'`. */
  position?: 'before' | 'after'
  /** Delimiter character for the comment. Default: `'#'`. */
  commentDelimiter?: CommentDelimiter
}

/** Options for {@link PropertiesEditor.insertBlankLine}. */
export type InsertBlankLineOptions = {
  /**
   * Insert relative to this key (last occurrence). If the key is not found,
   * the blank line is appended at the end.
   */
  referenceKey?: string
  /** Position relative to the reference key. Default: `'after'`. */
  position?: 'before' | 'after'
}

/** Options for {@link PropertiesEditor.update}. */
export type UpdateOptions = {
  /** Replacement value. When not set, the original value is preserved. */
  newValue?: string
  /** Replacement key (rename). When not set, the original key is preserved. */
  newKey?: string
  /** If `true`, escape non-ASCII characters as `\\uXXXX` sequences. Default: `false`. */
  escapeUnicode?: boolean
  /** New separator character. When not set, the original separator is preserved. */
  separator?: KeyValuePairSeparator
  /**
   * Replacement comment text. When set, all comment and blank line nodes immediately
   * preceding the property (up to the previous property) are removed and replaced
   * with the new comment. Supports multi-line via newlines in the string.
   */
  newComment?: string
  /** Delimiter character for the new comment. Default: `'#'`. */
  commentDelimiter?: CommentDelimiter
}

/** Options for {@link PropertiesEditor.upsert}. */
export type UpsertOptions = {
  /** If `true`, escape non-ASCII characters as `\\uXXXX` sequences. Default: `false`. */
  escapeUnicode?: boolean
  /** Separator character. Default: `'='`. */
  separator?: KeyValuePairSeparator
  /**
   * Comment text. When inserting a new property, this is prepended as a comment.
   * When updating an existing property, this replaces the leading comment nodes.
   */
  comment?: string
  /** Delimiter character for the comment. Default: `'#'`. */
  commentDelimiter?: CommentDelimiter
}

/** Options for {@link PropertiesEditor.delete}. */
export type DeleteOptions = {
  /**
   * If `false`, only the property node itself is removed. If `true` (default),
   * all comment and blank line nodes immediately preceding the property (up to
   * the previous property) are also removed.
   */
  deleteLeadingNodes?: boolean
  /**
   * Which occurrence of the key to delete when duplicates exist.
   * - `'last'` (default) — deletes the last occurrence (the effective value in
   *   Java's last-wins semantics).
   * - `'first'` — deletes the first occurrence. Useful for cleaning up duplicate
   *   keys while keeping the effective value.
   */
  occurrence?: 'first' | 'last'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a {@link PropertyNode} from key, value, and formatting options.
 *
 * @param key - The unescaped key.
 * @param value - The unescaped value.
 * @param options - Formatting options.
 * @param lineNumber - The 1-based starting line number.
 *
 * @returns A new PropertyNode.
 */
const buildPropertyNode = (
  key: string,
  value: string,
  options: {
    escapeUnicode?: boolean
    separator?: KeyValuePairSeparator
  },
  lineNumber: number
): PropertyNode => {
  const escUnicode = options.escapeUnicode === true
  const escapedKey = escapeKey(key, escUnicode)
  const escapedValue = escapeValue(value, escUnicode)

  const separatorChar =
    options.separator === ' ' ? undefined : (options.separator ?? DEFAULT_SEPARATOR)
  const separatorLeading = separatorChar ? ' ' : ' '
  const separatorTrailing = separatorChar ? ' ' : ''

  const separatorString = separatorChar
    ? `${separatorLeading}${separatorChar}${separatorTrailing}`
    : separatorLeading

  const rawLine = `${escapedKey}${separatorString}${escapedValue}`
  const rawLines = rawLine.split(REGEX_NEWLINE)

  return {
    type: 'property',
    rawLines,
    leadingWhitespace: '',
    key,
    escapedKey,
    separatorLeading,
    separatorChar,
    separatorTrailing,
    value,
    escapedValue,
    startingLineNumber: lineNumber,
    endingLineNumber: lineNumber + rawLines.length - 1,
  }
}

/**
 * Build comment and blank line nodes from a comment string.
 *
 * Empty lines within the comment text become {@link BlankLineNode}s,
 * allowing natural grouping of multi-line comments with visual separation.
 *
 * @param comment - The comment text (may contain newlines for multi-line comments).
 * @param delimiter - The comment delimiter character.
 * @param startLineNumber - The 1-based starting line number.
 *
 * @returns An array of CommentNodes and BlankLineNodes.
 */
const buildCommentNodes = (
  comment: string,
  delimiter: CommentDelimiter,
  startLineNumber: number
): (CommentNode | BlankLineNode)[] => {
  const lines = comment.split(REGEX_NEWLINE)
  return lines.map((line, index): CommentNode | BlankLineNode => {
    if (line === '') {
      return {
        type: 'blank',
        rawLine: '',
        lineNumber: startLineNumber + index,
      }
    }
    return {
      type: 'comment',
      rawLine: `${delimiter} ${line}`,
      leadingWhitespace: '',
      delimiter,
      body: ` ${line}`,
      lineNumber: startLineNumber + index,
    }
  })
}

/**
 * Recalculate line numbers on all nodes after a mutation.
 *
 * @param nodes - The nodes array to update.
 */
const recalculateLineNumbers = (nodes: PropertiesNode[]): void => {
  let lineNumber = 1
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (node.type === 'property') {
      const lineCount = node.rawLines.length
      nodes[index] = {
        type: 'property',
        rawLines: node.rawLines,
        leadingWhitespace: node.leadingWhitespace,
        key: node.key,
        escapedKey: node.escapedKey,
        separatorLeading: node.separatorLeading,
        separatorChar: node.separatorChar,
        separatorTrailing: node.separatorTrailing,
        value: node.value,
        escapedValue: node.escapedValue,
        startingLineNumber: lineNumber,
        endingLineNumber: lineNumber + lineCount - 1,
      }
      lineNumber += lineCount
    } else if (node.type === 'comment') {
      nodes[index] = {
        type: 'comment',
        rawLine: node.rawLine,
        leadingWhitespace: node.leadingWhitespace,
        delimiter: node.delimiter,
        body: node.body,
        lineNumber,
      }
      lineNumber++
    } else {
      nodes[index] = {
        type: 'blank',
        rawLine: node.rawLine,
        lineNumber,
      }
      lineNumber++
    }
  }
}

// ---------------------------------------------------------------------------
// PropertiesEditor
// ---------------------------------------------------------------------------

/**
 * An editor for `.properties` files that extends the lossless {@link Properties}
 * parser with insert, update, delete, and upsert operations.
 */
export class PropertiesEditor extends Properties {
  /**
   * Find the first property node with the given key.
   *
   * @param key - The unescaped key to search for.
   *
   * @returns The matching node and its index in `this.nodes`, or `undefined`.
   */
  private findFirstProperty(key: string): { index: number; node: PropertyNode } | undefined {
    for (let index = 0; index < this.nodes.length; index++) {
      const node = this.nodes[index]
      if (node.type === 'property' && node.key === key) {
        return { index, node }
      }
    }
    return undefined
  }

  /**
   * Find the last property node with the given key.
   *
   * @param key - The unescaped key to search for.
   *
   * @returns The matching node and its index in `this.nodes`, or `undefined`.
   */
  private findLastProperty(key: string): { index: number; node: PropertyNode } | undefined {
    for (let index = this.nodes.length - 1; index >= 0; index--) {
      const node = this.nodes[index]
      if (node.type === 'property' && node.key === key) {
        return { index, node }
      }
    }
    return undefined
  }

  /**
   * Insert a new property.
   *
   * @param key - The unescaped key.
   * @param value - The unescaped value.
   * @param options - Insert options.
   */
  insert(key: string, value: string, options?: InsertOptions): void {
    const newNodes: PropertiesNode[] = []

    // Build comment nodes if requested.
    if (options?.comment !== undefined) {
      const delimiter = options.commentDelimiter ?? DEFAULT_COMMENT_DELIMITER
      newNodes.push(...buildCommentNodes(options.comment, delimiter, 0))
    }

    // Build property node.
    newNodes.push(
      buildPropertyNode(
        key,
        value,
        {
          escapeUnicode: options?.escapeUnicode,
          separator: options?.separator,
        },
        0
      )
    )

    // Determine insertion position.
    if (options?.referenceKey) {
      const reference = this.findLastProperty(options.referenceKey)
      if (reference !== undefined) {
        const insertIndex = options.position === 'before' ? reference.index : reference.index + 1
        this.nodes.splice(insertIndex, 0, ...newNodes)
        recalculateLineNumbers(this.nodes)
        return
      }
    }

    // Default: append at end.
    this.nodes.push(...newNodes)
    recalculateLineNumbers(this.nodes)
  }

  /**
   * Insert a comment.
   *
   * @param comment - The comment text (may contain newlines).
   * @param options - Insert comment options.
   */
  insertComment(comment: string, options?: InsertCommentOptions): void {
    const delimiter = options?.commentDelimiter ?? DEFAULT_COMMENT_DELIMITER
    const newNodes = buildCommentNodes(comment, delimiter, 0)

    if (options?.referenceKey) {
      const reference = this.findLastProperty(options.referenceKey)
      if (reference !== undefined) {
        const insertIndex = options.position === 'before' ? reference.index : reference.index + 1
        this.nodes.splice(insertIndex, 0, ...newNodes)
        recalculateLineNumbers(this.nodes)
        return
      }
    }

    this.nodes.push(...newNodes)
    recalculateLineNumbers(this.nodes)
  }

  /**
   * Insert a blank line.
   *
   * @param options - Insert blank line options.
   */
  insertBlankLine(options?: InsertBlankLineOptions): void {
    const blankNode: BlankLineNode = {
      type: 'blank',
      rawLine: '',
      lineNumber: 0,
    }

    if (options?.referenceKey) {
      const reference = this.findLastProperty(options.referenceKey)
      if (reference !== undefined) {
        const insertIndex = options.position === 'before' ? reference.index : reference.index + 1
        this.nodes.splice(insertIndex, 0, blankNode)
        recalculateLineNumbers(this.nodes)
        return
      }
    }

    this.nodes.push(blankNode)
    recalculateLineNumbers(this.nodes)
  }

  /**
   * Update an existing property.
   *
   * @param key - The unescaped key to update (uses last occurrence).
   * @param options - Update options.
   *
   * @returns `true` if the property was found and updated, `false` otherwise.
   */
  update(key: string, options: UpdateOptions): boolean {
    const found = this.findLastProperty(key)
    if (found === undefined) {
      return false
    }

    const { index, node: existing } = found

    // Determine new key/value.
    const newKey = options.newKey ?? existing.key
    const newValue = options.newValue ?? existing.value
    const escUnicode = options.escapeUnicode === true
    const escapedKey = escUnicode
      ? escapeKey(newKey, true)
      : options.newKey !== undefined
        ? escapeKey(newKey)
        : existing.escapedKey
    const escapedValue = escUnicode
      ? escapeValue(newValue, true)
      : options.newValue !== undefined
        ? escapeValue(newValue)
        : existing.escapedValue

    // Determine separator.
    const separatorChar = options.separator
      ? options.separator === ' '
        ? undefined
        : options.separator
      : existing.separatorChar
    const separatorLeading = options.separator
      ? separatorChar
        ? ' '
        : ' '
      : existing.separatorLeading
    const separatorTrailing = options.separator
      ? separatorChar
        ? ' '
        : ''
      : existing.separatorTrailing

    const separatorString = separatorChar
      ? `${separatorLeading}${separatorChar}${separatorTrailing}`
      : separatorLeading

    const rawLine = `${escapedKey}${separatorString}${escapedValue}`
    const rawLines = rawLine.split(REGEX_NEWLINE)

    const updatedNode: PropertyNode = {
      type: 'property',
      rawLines,
      leadingWhitespace: existing.leadingWhitespace,
      key: newKey,
      escapedKey,
      separatorLeading,
      separatorChar,
      separatorTrailing,
      value: newValue,
      escapedValue,
      startingLineNumber: existing.startingLineNumber,
      endingLineNumber: existing.startingLineNumber + rawLines.length - 1,
    }

    // Handle comment replacement.
    if (options.newComment !== undefined) {
      // Remove leading comment/blank nodes.
      let removeStart = index
      for (let search = index - 1; search >= 0; search--) {
        if (this.nodes[search].type === 'property') {
          break
        }
        removeStart = search
      }

      const delimiter = options.commentDelimiter ?? DEFAULT_COMMENT_DELIMITER
      const commentNodes = buildCommentNodes(options.newComment, delimiter, 0)

      this.nodes.splice(removeStart, index - removeStart + 1, ...commentNodes, updatedNode)
    } else {
      this.nodes[index] = updatedNode
    }

    recalculateLineNumbers(this.nodes)
    return true
  }

  /**
   * Update a property if it exists, or insert it if it doesn't.
   *
   * @param key - The unescaped key.
   * @param value - The unescaped value.
   * @param options - Upsert options.
   */
  upsert(key: string, value: string, options?: UpsertOptions): void {
    if (this.findLastProperty(key) !== undefined) {
      this.update(key, {
        newValue: value,
        escapeUnicode: options?.escapeUnicode,
        separator: options?.separator,
        newComment: options?.comment,
        commentDelimiter: options?.commentDelimiter,
      })
    } else {
      this.insert(key, value, options)
    }
  }

  /**
   * Delete an occurrence of a property.
   *
   * By default, deletes the last occurrence (the effective value in Java's last-wins
   * semantics). Use `{ occurrence: 'first' }` to delete the first occurrence instead,
   * which is useful for cleaning up duplicate keys while keeping the effective value.
   *
   * @param key - The unescaped key to delete.
   * @param options - Delete options.
   *
   * @returns The deleted {@link PropertyNode}, or `undefined` if the key was not found.
   */
  delete(key: string, options?: DeleteOptions): PropertyNode | undefined {
    const found =
      options?.occurrence === 'first' ? this.findFirstProperty(key) : this.findLastProperty(key)
    if (found === undefined) {
      return undefined
    }

    const { index, node: deleted } = found
    const deleteLeading = options?.deleteLeadingNodes !== false

    if (deleteLeading) {
      // Remove leading comment/blank nodes up to the previous property.
      let removeStart = index
      for (let search = index - 1; search >= 0; search--) {
        if (this.nodes[search].type === 'property') {
          break
        }
        removeStart = search
      }
      this.nodes.splice(removeStart, index - removeStart + 1)
    } else {
      this.nodes.splice(index, 1)
    }

    recalculateLineNumbers(this.nodes)
    return deleted
  }

  /**
   * Delete all occurrences of a key.
   *
   * @param key - The unescaped key to delete.
   *
   * @returns An array of the deleted {@link PropertyNode} instances.
   */
  deleteAll(key: string): PropertyNode[] {
    const deleted: PropertyNode[] = []
    for (let index = this.nodes.length - 1; index >= 0; index--) {
      const node = this.nodes[index]
      if (node.type === 'property' && node.key === key) {
        this.nodes.splice(index, 1)
        deleted.push(node)
      }
    }
    if (deleted.length > 0) {
      recalculateLineNumbers(this.nodes)
    }
    return deleted.reverse()
  }
}
