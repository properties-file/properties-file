import { escapeKey, escapeValue } from '../escape'

import type { NormalizeOptions, PropertiesNode, PropertyNode } from './nodes'

const BOM = '\uFEFF'

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
 * @param node - The property node.
 * @param options - Normalization options.
 *
 * @returns The reconstructed property line(s) as a single string.
 */
const rebuildPropertyLine = (node: PropertyNode, options: NormalizeOptions): string => {
  const useEscapeUnicode = options.escapeUnicode === true

  // Determine leading whitespace.
  const leading = options.removeLeadingWhitespace ? '' : node.leadingWhitespace

  // Determine key content.
  let keyContent = useEscapeUnicode ? escapeKey(node.key, true) : node.escapedKey

  // Determine separator.
  let separatorLeading: string
  let separatorCharacter: string
  let separatorTrailing: string

  if (options.separatorChar !== undefined) {
    separatorLeading = options.separatorLeading ?? node.separatorLeading
    separatorCharacter = options.separatorChar === ' ' ? '' : options.separatorChar
    separatorTrailing = options.separatorTrailing ?? node.separatorTrailing

    // When separatorChar is ' ', the leading whitespace IS the separator.
    if (options.separatorChar === ' ') {
      separatorLeading = options.separatorLeading ?? ' '
    }
  } else {
    separatorLeading = options.separatorLeading ?? node.separatorLeading
    separatorCharacter = node.separatorChar ?? ''
    separatorTrailing = options.separatorTrailing ?? node.separatorTrailing
  }

  // Determine value content.
  let valueContent = useEscapeUnicode ? escapeValue(node.value, true) : node.escapedValue

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
  const needsPropertyRebuild =
    options.separatorChar !== undefined ||
    options.separatorLeading !== undefined ||
    options.separatorTrailing !== undefined ||
    options.escapeUnicode === true ||
    options.collapseMultiline === true ||
    options.wrapKeysAt !== undefined ||
    options.wrapValuesAt !== undefined ||
    options.removeLeadingWhitespace === true

  // Pre-compute which node indices to keep when deduplicating.
  let skipIndices: Record<number, boolean> | undefined
  if (options.deduplicateKeys) {
    // Walk backward to find the last occurrence of each key.
    const seen: Record<string, boolean> = {}
    const duplicateIndices: number[] = []
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]
      if (node.type === 'property') {
        if (seen[node.key]) {
          duplicateIndices.push(index)
        } else {
          seen[node.key] = true
        }
      }
    }

    // Mark duplicate properties for removal, and optionally their leading nodes.
    skipIndices = {}
    for (const duplicateIndex of duplicateIndices) {
      skipIndices[duplicateIndex] = true
      if (!options.deduplicateKeysKeepLeadingNodes) {
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

  // eslint-disable-next-line unicorn/no-for-loop -- need index for keepIndices lookup, entries() is ES2015
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    // Skip nodes marked for removal by deduplication (property + its leading comments/blanks).
    if (skipIndices?.[nodeIndex]) {
      continue
    }

    const node = nodes[nodeIndex]
    switch (node.type) {
      case 'comment': {
        if (options.removeComments) {
          continue
        }
        parts.push(options.removeLeadingWhitespace ? `${node.delimiter}${node.body}` : node.rawLine)
        break
      }
      case 'blank': {
        if (options.removeBlankLines) {
          continue
        }
        parts.push(node.rawLine)
        break
      }
      case 'property': {
        if (needsPropertyRebuild) {
          parts.push(rebuildPropertyLine(node, options))
        } else {
          parts.push(node.rawLines.join(eol))
        }
        break
      }
    }
  }

  return (hasBom ? BOM : '') + parts.join(eol)
}
