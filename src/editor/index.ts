import { escapeKey, escapeValue } from '../escape'
import { Properties } from '../properties'
import { Property } from '../property'

/** The default separator between keys and values. */
export const DEFAULT_SEPARATOR = '='

/** The default character used as comment delimiter. */
export const DEFAULT_COMMENT_DELIMITER = '#'

/** Characters that can be used as key-value pair separators. */
export type KeyValuePairSeparator = ' ' | ':' | '='

/** Characters that can be used as comment delimiters. */
export type CommentDelimiter = '#' | '!'

/** Options on the `Properties.insert` method. */
export type InsertOptions = {
  /** The name of the key to insert before or after. If the key not found, the new property will not be inserted. */
  referenceKey?: string
  /** The position of the insertion related to the `referenceKey` (default is `after`) */
  position?: 'before' | 'after'
  /** Escape unicode characters into ISO-8859-1 compatible encoding? */
  escapeUnicode?: boolean
  /** The key/value separator character. */
  separator?: KeyValuePairSeparator
  /** A comment to insert before. */
  comment?: string
  /** The comment's delimiter. */
  commentDelimiter?: CommentDelimiter
}

/** Options on the `Properties.insertComment` method. */
export type InsertCommentOptions = {
  /** The name of the key to insert before or after. If the key not found, the new property will not be inserted. */
  referenceKey?: string
  /** The position of the insertion related to the `referenceKey` (default is `after`) */
  position?: 'before' | 'after'
  /** The comment's delimiter. */
  commentDelimiter?: CommentDelimiter
}

/** Options on the `Properties.update` method. */
export type UpdateOptions = {
  /** Optionally replace the existing value with a new value. */
  newValue?: string
  /** Optionally replace the existing key with a new key name. */
  newKey?: string
  /** Escape unicode characters into ISO-8859-1 compatible encoding? */
  escapeUnicode?: boolean
  /** A key/value separator character. */
  separator?: ' ' | ':' | '='
  /** Optionally insert a new comment, or replace the existing one (including white-space characters). */
  newComment?: string
  /** The comment's delimiter. */
  commentDelimiter?: CommentDelimiter
}

/** Options on the `Properties.upsert` method. */
export type UpsertOptions = {
  /** Escape unicode characters into ISO-8859-1 compatible encoding? */
  escapeUnicode?: boolean
  /** The key/value separator character. */
  separator?: KeyValuePairSeparator
  /** A comment to insert before. */
  comment?: string
  /** The comment's delimiter. */
  commentDelimiter?: CommentDelimiter
}

/**
 * A .properties file editor.
 */
export class PropertiesEditor extends Properties {
  /** Is line parsing required to re-async the object's properties? */
  private needsLineParsing = false

  /**
   * Create `PropertiesEditor` object.
   *
   * @param content - The content of a `.properties` file.
   */
  constructor(content: string) {
    super(content)
  }

  /**
   * Parse the `.properties` content line by line only when needed.
   */
  private parseLinesIfNeeded(): void {
    if (this.needsLineParsing) {
      this.parseLines()
      this.needsLineParsing = false
    }
  }

  /**
   * Insert a new property in the existing object (by default it will be at the end).
   *
   * @param key - A property key (unescaped).
   * @param value - A property value (unescaped).
   * @param options - Additional options.
   *
   * @returns True if the key was inserted, otherwise false.
   */
  public insert(key: string, value: string, options?: InsertOptions): boolean {
    const escapeUnicode = options?.escapeUnicode || false
    const separator = options?.separator
      ? options.separator === ' '
        ? ' '
        : ` ${options.separator} `
      : ` ${DEFAULT_SEPARATOR} `.replace('  ', ' ')
    const referenceKey = options?.referenceKey
    const position = options?.position || 'after'

    if (referenceKey) {
      this.parseLinesIfNeeded()
    }

    // Allow multiline keys.
    const multilineKey = key
      .split(/\r?\n/)
      .map((key) => escapeKey(key, escapeUnicode))
      .join('\\\n')

    // Allow multiline values.
    const multilineValue = value
      .split(/\r?\n/)
      .map((value) => escapeValue(value, escapeUnicode))
      .join('\\\n')

    // Allow multiline comments.
    const commentPrefix = `${options?.commentDelimiter || DEFAULT_COMMENT_DELIMITER} `
    const multilineComment =
      options?.comment === undefined
        ? ''
        : `${`${commentPrefix}${options.comment}`.split(/\r?\n/).join(`\n${commentPrefix}`)}\n`

    const newLines = `${multilineComment}${multilineKey}${separator}${multilineValue}`.split(/\n/)

    if (referenceKey === undefined) {
      // Insert the new property at the end if the reference key was not defined.
      this.lines.push(...newLines)
      this.needsLineParsing = true
      return true
    } else {
      // Find the last occurrence of the reference key.
      const property = [...this.collection]
        .reverse()
        .find((property) => property.key === referenceKey)

      // Insert the new property when a reference key defined only when found.
      if (property) {
        const insertPosition =
          position === 'after'
            ? property.endingLineNumber
            : property.previousProperty?.endingLineNumber ?? 0
        this.lines = [
          ...this.lines.slice(0, insertPosition),
          ...newLines,
          ...this.lines.slice(insertPosition),
        ]
        this.needsLineParsing = true
        return true
      }
      return false
    }
  }

  /**
   * Insert a new comment in the existing object (by default it will be at the end).
   *
   * @param comment - The comment to add.
   * @param options - Additional options.
   *
   * @returns True if the comment was inserted, otherwise false.
   */
  public insertComment(comment: string, options?: InsertCommentOptions): boolean {
    const referenceKey = options?.referenceKey
    const position = options?.position || 'after'

    if (referenceKey) {
      this.parseLinesIfNeeded()
    }

    // Allow multiline comments.
    const commentPrefix = `${options?.commentDelimiter || DEFAULT_COMMENT_DELIMITER} `
    const newLines = `${commentPrefix}${comment}`
      .replace(/\r?\n/g, `\n${commentPrefix}`)
      .split(/\n/)

    if (referenceKey === undefined) {
      // Insert the new comment at the end if the reference key was not defined.
      this.lines.push(...newLines)
      this.needsLineParsing = true
      return true
    } else {
      // Find the last occurrence of the reference key.
      const property = [...this.collection]
        .reverse()
        .find((property) => property.key === referenceKey)

      // Insert the new comment when a reference key defined only when found.
      if (property) {
        const insertPosition =
          position === 'after'
            ? property.endingLineNumber
            : property.previousProperty?.endingLineNumber ?? 0
        this.lines = [
          ...this.lines.slice(0, insertPosition),
          ...newLines,
          ...this.lines.slice(insertPosition),
        ]
        this.needsLineParsing = true
        return true
      }
      return false
    }
  }

  /**
   * Delete the last occurrence of a given key from the existing object.
   *
   * @param key - The name of the key to delete.
   * @param deleteCommentsAndWhiteSpace - By default, comments and white-space characters before the key will be deleted.
   *
   * @returns True if the key was deleted, otherwise false.
   */
  public delete(key: string, deleteCommentsAndWhiteSpace = true): boolean {
    this.parseLinesIfNeeded()

    // Find the last occurrence of the key.
    const property = [...this.collection].reverse().find((property) => property.key === key)

    if (property) {
      const startLine = deleteCommentsAndWhiteSpace
        ? property.previousProperty?.endingLineNumber ?? 0
        : property.startingLineNumber - 1
      const endLine = property.endingLineNumber
      this.lines = [...this.lines.slice(0, startLine), ...this.lines.slice(endLine)]
      this.needsLineParsing = true
      return true
    }
    return false
  }

  /**
   * Restore the original newline characters of a key.
   *
   * @param property - A property object.
   *
   * @returns The key with its original newlines characters restored.
   */
  private getKeyWithNewlines(property: Property): string {
    return property.newlinePositions.length === 0
      ? property.key
      : // eslint-disable-next-line unicorn/no-array-reduce
        [...property.key].reduce<string>(
          (accumulator, character, index) =>
            `${accumulator}${property.newlinePositions.includes(index) ? '\n' : ''}${character}`,
          ''
        )
  }

  /**
   * Restore the original newline characters of a value.
   *
   * @param property - A property object.
   *
   * @returns The value with its original newlines characters restored.
   */
  private getValueWithNewlines(property: Property): string {
    return property.newlinePositions.length === 0 || property.valuePosition === undefined
      ? property.value
      : // eslint-disable-next-line unicorn/no-array-reduce
        [...property.value].reduce<string>(
          (accumulator, character, index) =>
            `${accumulator}${
              property.newlinePositions.includes(index + (property.valuePosition as number))
                ? '\n'
                : ''
            }${character}`,
          ''
        )
  }

  /**
   * Update the last occurrence of a given key from the existing object.
   *
   * @param key - The name of the key to update.
   * @param options - Additional options.
   *
   * @returns True if the key was updated, otherwise false.
   */
  public update(key: string, options?: UpdateOptions): boolean {
    this.parseLinesIfNeeded()

    // Find the last occurrence of the key to update.
    const property = [...this.collection].reverse().find((property) => property.key === key)

    if (!property || !options) {
      return false
    }

    const escapeUnicode = options.escapeUnicode || false
    const separator = options.separator
      ? options.separator === ' '
        ? ' '
        : ` ${options.separator} `
      : property.separator || ` ${DEFAULT_SEPARATOR} `.replace('  ', ' ')

    // Allow multiline keys.
    const multilineKey = (options.newKey ?? this.getKeyWithNewlines(property))
      .split(/\r?\n/)
      .map((key) => escapeKey(key, escapeUnicode))
      .join('\\\n')

    // Allow multiline values.
    const multilineValue = (options.newValue ?? this.getValueWithNewlines(property))
      .split(/\r?\n/)
      .map((value) => escapeValue(value, escapeUnicode))
      .join('\\\n')

    // Allow multiline comments.
    const commentPrefix = `${options.commentDelimiter || DEFAULT_COMMENT_DELIMITER} `
    const multilineComment =
      options.newComment === undefined
        ? ''
        : `${`${commentPrefix}${options.newComment}`.split(/\r?\n/).join(`\n${commentPrefix}`)}\n`

    const newLines = `${multilineComment}${multilineKey}${separator}${multilineValue}`.split(/\n/)

    // Replace the existing property with the new one.
    this.lines = [
      ...this.lines.slice(
        0,
        options.newComment === undefined
          ? property.startingLineNumber - 1
          : property.previousProperty?.endingLineNumber ?? 0
      ),
      ...newLines,
      ...this.lines.slice(property.endingLineNumber),
    ]
    this.needsLineParsing = true
    return true
  }

  /**
   * Update a key if it exist, otherwise add it at the end.
   *
   * @param key - A property key (unescaped).
   * @param value - A property value (unescaped).
   * @param options - Additional options.
   *
   * @returns True if the key was updated or inserted, otherwise false.
   */
  public upsert(key: string, value: string, options?: UpsertOptions): boolean {
    this.parseLinesIfNeeded()

    return this.keyLineNumbers[key]
      ? this.update(key, {
          newValue: value,
          newComment: options?.comment,
          commentDelimiter: options?.commentDelimiter,
          separator: options?.separator,
          escapeUnicode: options?.escapeUnicode,
        })
      : this.insert(key, value, options)
  }
}
