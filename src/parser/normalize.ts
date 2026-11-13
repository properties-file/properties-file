import { escapeKey, escapeValue } from '../escape'

import type { NormalizeOptions, PropertiesNode, PropertyNode } from './nodes'

const BOM = '\u{FEFF}'

/**
 * Wrap an escaped string at a target width using `\` line continuations.
 *
 * Avoids splitting `\\uXXXX` escape sequences across lines.
 *
 * @param escaped - The escaped string to wrap.
 * @param width - The maximum character width per line.
 *
 * @returns The wrapped string with `\` continuations.
 */
const wrapAtWidth = (escaped: string, width: number): string => {
  if (escaped.length <= width) {
    return escaped
  }

  const parts: string[] = []
  let position = 0
  const length = escaped.length

  while (position < length) {
    let end = Math.min(position + width, length)

    // Don't split a \uXXXX sequence (6 chars: \u + 4 hex digits).
    if (end < length) {
      // Check if we're in the middle of a \uXXXX sequence.
      for (let lookback = 0; lookback < 6 && end - lookback > position; lookback++) {
        const checkPosition = end - lookback
        if (
          checkPosition + 5 <= length &&
          escaped[checkPosition] === '\\' &&
          escaped[checkPosition + 1] === 'u'
        ) {
          // We found a \uXXXX starting at checkPosition — move end before it.
          end = checkPosition
          break
        }
      }
    }

    parts.push(escaped.slice(position, end))
    position = end
  }

  return parts.join('\\\n  ')
}

/**
 * Rebuild a property line from its parsed fields.
 *
 * @param node - The parsed property whose key, separator and value are re-serialized.
 * @param options - Normalization options.
 *
 * @returns The reconstructed property line(s) as a single string.
 */
const rebuildPropertyLine = (node: PropertyNode, options: NormalizeOptions): string => {
  const shouldEscapeUnicode = options.escapeUnicode === true

  // Determine leading whitespace.
  const shouldRemoveLeadingWhitespace = Boolean(options.removeLeadingWhitespace)
  const leading = shouldRemoveLeadingWhitespace ? '' : node.leadingWhitespace

  // Determine key content.
  let keyContent = shouldEscapeUnicode ? escapeKey(node.key, true) : node.escapedKey

  // Determine separator.
  let separatorLeading = options.separatorLeading ?? node.separatorLeading
  let separatorCharacter: string
  const separatorTrailing = options.separatorTrailing ?? node.separatorTrailing

  if (options.separatorChar !== undefined) {
    separatorCharacter = options.separatorChar === ' ' ? '' : options.separatorChar

    // When separatorChar is ' ', the leading whitespace IS the separator.
    if (options.separatorChar === ' ') {
      separatorLeading = options.separatorLeading ?? ' '
    }
  } else {
    separatorCharacter = node.separatorChar ?? ''
  }

  // Determine value content.
  let valueContent = shouldEscapeUnicode ? escapeValue(node.value, true) : node.escapedValue

  // Apply key wrapping.
  if (options.wrapKeysAt !== undefined && options.wrapKeysAt > 0) {
    keyContent = wrapAtWidth(keyContent, options.wrapKeysAt)
  }

  // Apply value wrapping.
  if (options.wrapValuesAt !== undefined && options.wrapValuesAt > 0) {
    valueContent = wrapAtWidth(valueContent, options.wrapValuesAt)
  }

  return `${leading}${keyContent}${separatorLeading}${separatorCharacter}${separatorTrailing}${valueContent}`
}

/**
 * Format a set of property nodes into normalized output.
 *
 * @param nodes - All nodes from the parsed document.
 * @param hasBom - Whether the original content had a BOM.
 * @param eolCharacter - The detected EOL character.
 * @param options - Normalization options.
 *
 * @returns The normalized `.properties` file content.
 */
export const formatNormalized = (
  nodes: PropertiesNode[],
  hasBom: boolean,
  eolCharacter: string,
  options: NormalizeOptions
): string => {
  const eol = options.endOfLineCharacter ?? eolCharacter

  // The optional boolean options tested by truthiness, read once. `Boolean()` rather than
  // `=== true`: for these checks any truthy value counts, including out-of-type ones from
  // untyped JavaScript callers (`1`).
  const shouldDeduplicateKeys = Boolean(options.deduplicateKeys)
  const shouldKeepLeadingNodes = Boolean(options.deduplicateKeysKeepLeadingNodes)
  const shouldRemoveComments = Boolean(options.removeComments)
  const shouldRemoveBlankLines = Boolean(options.removeBlankLines)
  const shouldRemoveLeadingWhitespace = Boolean(options.removeLeadingWhitespace)

  const requiresPropertyRebuild =
    options.separatorChar !== undefined ||
    options.separatorLeading !== undefined ||
    options.separatorTrailing !== undefined ||
    options.escapeUnicode === true ||
    options.collapseMultiline === true ||
    options.wrapKeysAt !== undefined ||
    options.wrapValuesAt !== undefined ||
    // Same truthiness test as for comment lines below, so that the option always applies to
    // both kinds of lines or to neither.
    shouldRemoveLeadingWhitespace

  // Pre-compute which node indices to keep when deduplicating.
  let skipIndices: Record<number, boolean> | undefined
  if (shouldDeduplicateKeys) {
    // Walk backward to find the last occurrence of each key. `seen` is a plain object used as
    // a dictionary (`Map` is ES2015 and not available in shipped ES5 output), so it inherits
    // `constructor`, `toString` and the other `Object.prototype` members: only its own
    // properties count as seen. A `__proto__` key (the name of the prototype accessor) is tracked
    // apart: assigning to that name goes to the prototype setter instead of storing a property.
    const seen: Record<string, boolean> = {}
    let hasSeenPrototypeAccessorKey = false
    const duplicateIndices: number[] = []
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]
      if (node.type !== 'property') {
        continue
      }

      const isPrototypeAccessorKey = node.key === '__proto__'
      if (
        isPrototypeAccessorKey
          ? hasSeenPrototypeAccessorKey
          : Object.prototype.hasOwnProperty.call(seen, node.key)
      ) {
        duplicateIndices.push(index)
      } else if (isPrototypeAccessorKey) {
        hasSeenPrototypeAccessorKey = true
      } else {
        seen[node.key] = true
      }
    }

    // Mark duplicate properties for removal, and optionally their leading nodes.
    skipIndices = {}
    for (const duplicateIndex of duplicateIndices) {
      skipIndices[duplicateIndex] = true
      if (!shouldKeepLeadingNodes) {
        // Walk backward from the duplicate to also skip its leading comment/blank nodes.
        for (let search = duplicateIndex - 1; search >= 0; search--) {
          if (nodes[search].type === 'property') {
            break
          }
          skipIndices[search] = true
        }
      }
    }
  }

  const parts: string[] = []

  // eslint-disable-next-line unicorn/no-for-loop -- the element is read only after the skipIndices check below; an entries()-style loop would read it eagerly for skipped nodes too
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    // Skip nodes marked for removal by deduplication (property + its leading comments/blanks).
    // A plain read compared to `true`, not an own-property check: `skipIndices` values are only
    // ever `true` when present, so the two are equivalent here, without the extra method-call
    // overhead of an existence check in this per-node loop.
    if (skipIndices?.[nodeIndex] === true) {
      continue
    }

    const node = nodes[nodeIndex]
    switch (node.type) {
      case 'comment': {
        if (shouldRemoveComments) {
          continue
        }
        parts.push(shouldRemoveLeadingWhitespace ? `${node.delimiter}${node.body}` : node.rawLine)
        break
      }
      case 'blank': {
        if (shouldRemoveBlankLines) {
          continue
        }
        parts.push(node.rawLine)
        break
      }
      case 'property': {
        parts.push(
          requiresPropertyRebuild ? rebuildPropertyLine(node, options) : node.rawLines.join(eol)
        )
        break
      }
    }
  }

  return (hasBom ? BOM : '') + parts.join(eol)
}
