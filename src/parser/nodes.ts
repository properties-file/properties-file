// ---------------------------------------------------------------------------
// Node type constants
// ---------------------------------------------------------------------------

/** Constants for the `type` discriminator on each node. */
export const PropertiesNodeType = {
  /** A property (key-value pair). */
  PROPERTY: 'property',
  /** A comment line (`#` or `!`). */
  COMMENT: 'comment',
  /** A blank line. */
  BLANK: 'blank',
} as const

// ---------------------------------------------------------------------------
// Node types — lossless representation of every element in a .properties file
// ---------------------------------------------------------------------------

/**
 * A property (key-value pair), potentially spanning multiple physical lines
 * via backslash continuation.
 */
export type PropertyNode = {
  /** Discriminator. */
  readonly type: 'property'
  /** Physical lines as-is (without EOL characters), for lossless reconstruction. */
  readonly rawLines: string[]
  /** Leading whitespace before the key on the first physical line. */
  readonly leadingWhitespace: string
  /** The unescaped key. */
  readonly key: string
  /** The key as written in the source (after continuation joining, before unescaping). */
  readonly escapedKey: string
  /** Whitespace between the key and the separator character. */
  readonly separatorLeading: string
  /**
   * The core separator character.
   *
   * - `'='` or `':'` when an explicit delimiter is used.
   * - `undefined` when whitespace alone separates key from value, or when
   *   the property is key-only with no separator.
   */
  readonly separatorChar: '=' | ':' | undefined
  /** Whitespace between the separator character and the value. */
  readonly separatorTrailing: string
  /** The unescaped value. */
  readonly value: string
  /** The value as written in the source (after continuation joining, before unescaping). */
  readonly escapedValue: string
  /** 1-based line number where this property starts. */
  readonly startingLineNumber: number
  /** 1-based line number where this property ends. */
  readonly endingLineNumber: number
}

/**
 * A comment line starting with `#` or `!`.
 */
export type CommentNode = {
  /** Discriminator. */
  readonly type: 'comment'
  /** The full line as-is (without the EOL character). */
  readonly rawLine: string
  /** Leading whitespace before the delimiter. */
  readonly leadingWhitespace: string
  /** The comment delimiter character. */
  readonly delimiter: '#' | '!'
  /** The text after the delimiter (including any space immediately after it). */
  readonly body: string
  /** 1-based line number. */
  readonly lineNumber: number
}

/**
 * A blank line (may contain only whitespace characters).
 */
export type BlankLineNode = {
  /** Discriminator. */
  readonly type: 'blank'
  /** The raw whitespace content of the line (without the EOL character). */
  readonly rawLine: string
  /** 1-based line number. */
  readonly lineNumber: number
}

/** Discriminated union of all node types in a `.properties` file. */
export type PropertiesNode = PropertyNode | CommentNode | BlankLineNode

// ---------------------------------------------------------------------------
// Key-value pair object
// ---------------------------------------------------------------------------

/** A plain key-value pair object where every value is a string. */
export type KeyValuePairObject = {
  [key: string]: string
}

// ---------------------------------------------------------------------------
// Key collision tracking
// ---------------------------------------------------------------------------

/** Information about a key that appears more than once. */
export type KeyCollisions = {
  /** The duplicate key. */
  key: string
  /** All property nodes with this key, in file order. */
  nodes: PropertyNode[]
}

// ---------------------------------------------------------------------------
// Normalization options
// ---------------------------------------------------------------------------

/** Options for {@link Properties.format} when producing normalized output. */
export type NormalizeOptions = {
  /** End-of-line character to use. Defaults to the detected EOL from the source. */
  endOfLineCharacter?: '\n' | '\r\n'
  /** If `true`, remove all comment lines. Default: `false`. */
  removeComments?: boolean
  /** If `true`, remove all blank lines. Default: `false`. */
  removeBlankLines?: boolean
  /** If `true`, remove leading whitespace from all lines. Default: `false`. */
  removeLeadingWhitespace?: boolean
  /** If `true`, keep only the last occurrence of each key. Default: `false`. */
  deduplicateKeys?: boolean
  /** Standardize the separator character. Original separators are preserved if not set. */
  separatorChar?: '=' | ':' | ' '
  /** Whitespace to place before the separator character. */
  separatorLeading?: string
  /** Whitespace to place after the separator character. */
  separatorTrailing?: string
  /** If `true`, escape all non-ASCII characters as `\\uXXXX` sequences. Default: `false`. */
  escapeUnicode?: boolean
  /** If `true`, collapse multiline keys and values to single lines. Default: `false`. */
  collapseMultiline?: boolean
  /** Wrap keys at this character width using line continuations. `undefined` = no wrapping. */
  wrapKeysAt?: number
  /** Wrap values at this character width using line continuations. `undefined` = no wrapping. */
  wrapValuesAt?: number
}
