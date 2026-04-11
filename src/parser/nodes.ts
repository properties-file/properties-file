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

/**
 * Options for {@link Properties.format} when producing normalized output.
 *
 * When no options are passed to `format()`, the output is a lossless reconstruction
 * of the original content. Passing any option triggers normalization, rebuilding
 * property lines from their parsed fields.
 */
export type NormalizeOptions = {
  /** Override the end-of-line character. Defaults to the EOL detected from the source. */
  endOfLineCharacter?: '\n' | '\r\n'
  /** If `true`, remove all comment lines from the output. Default: `false`. */
  removeComments?: boolean
  /** If `true`, remove all blank lines from the output. Default: `false`. */
  removeBlankLines?: boolean
  /** If `true`, strip leading whitespace from all property and comment lines. Default: `false`. */
  removeLeadingWhitespace?: boolean
  /**
   * If `true`, keep only the last occurrence of each duplicate key (Java's last-wins
   * semantics). Earlier occurrences and their leading comment/blank line nodes are
   * removed from the output. Set `deduplicateKeysKeepLeadingNodes` to `true` to
   * preserve the leading nodes. Default: `false`.
   */
  deduplicateKeys?: boolean
  /**
   * When `deduplicateKeys` is `true`, controls whether comment and blank line nodes
   * preceding removed duplicates are preserved (`true`) or also removed (`false`).
   * Default: `false` (leading nodes are removed along with the duplicate).
   */
  deduplicateKeysKeepLeadingNodes?: boolean
  /**
   * Standardize the separator character across all properties. When set, every
   * property is rewritten to use this separator. Original separators are preserved
   * if not set. Use `' '` for whitespace-only separators (no `=` or `:`).
   */
  separatorChar?: '=' | ':' | ' '
  /**
   * Whitespace to place before the separator character (e.g. `' '` for `key = value`,
   * `''` for `key=value`). When not set, each property's original leading whitespace
   * is preserved.
   */
  separatorLeading?: string
  /**
   * Whitespace to place after the separator character (e.g. `' '` for `key = value`,
   * `''` for `key=value`). When not set, each property's original trailing whitespace
   * is preserved.
   */
  separatorTrailing?: string
  /**
   * If `true`, re-escape all non-ASCII characters as `\\uXXXX` sequences. Useful for
   * producing ISO-8859-1 compatible output. Default: `false` (preserves original encoding).
   */
  escapeUnicode?: boolean
  /**
   * If `true`, collapse multiline keys and values (joined via `\\` line continuations)
   * into single lines. Default: `false` (preserves original line structure).
   */
  collapseMultiline?: boolean
  /**
   * Wrap keys at this character width using `\\` line continuations. Only applies to
   * keys longer than the specified width. `\\uXXXX` sequences are never split across
   * lines. `undefined` = no wrapping.
   */
  wrapKeysAt?: number
  /**
   * Wrap values at this character width using `\\` line continuations. Only applies to
   * values longer than the specified width. `\\uXXXX` sequences are never split across
   * lines. `undefined` = no wrapping.
   */
  wrapValuesAt?: number
}
