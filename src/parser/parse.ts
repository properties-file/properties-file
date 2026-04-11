import { unescapeContent } from '../unescape'

import type { BlankLineNode, CommentNode, PropertiesNode, PropertyNode } from './nodes'

// ---------------------------------------------------------------------------
// Character codes
// ---------------------------------------------------------------------------

const CH_TAB = 9 // \t
const CH_LF = 10 // \n
const CH_FF = 12 // \f
const CH_CR = 13 // \r
const CH_SPACE = 32 // ' '
const CH_BANG = 33 // !
const CH_HASH = 35 // #
const CH_COLON = 58 // :
const CH_EQUALS = 61 // =
const CH_BACKSLASH = 92 // \\
const CH_BOM = 0xfeff

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Characters that count as whitespace in .properties files (space, tab, formfeed). */
const isWhitespace = (charCode: number): boolean =>
  charCode === CH_SPACE || charCode === CH_TAB || charCode === CH_FF

/**
 * Count trailing backslashes in a string up to (but not including) `end`.
 *
 * @param str - The string to scan.
 * @param end - The exclusive end position.
 *
 * @returns The number of consecutive trailing backslashes.
 */
const countTrailingBackslashes = (string_: string, end: number): number => {
  let count = 0
  let pos = end - 1
  while (pos >= 0 && string_.charCodeAt(pos) === CH_BACKSLASH) {
    count++
    pos--
  }
  return count
}

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

/** Result of parsing a `.properties` file. */
export type ParseResult = {
  /** Whether the content starts with a BOM character. */
  hasBom: boolean
  /** The detected end-of-line character sequence. */
  eolCharacter: string
  /** All parsed nodes in file order. */
  nodes: PropertiesNode[]
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a `.properties` file into a lossless sequence of nodes.
 *
 * Every element in the file — properties, comments, and blank lines — is
 * preserved in order. Duplicate keys are all retained. The original content
 * can be reconstructed exactly by joining node raw lines with the EOL
 * character.
 *
 * @param content - The content of a `.properties` file.
 *
 * @returns The parse result with BOM info, detected EOL, and ordered nodes.
 */
export const parseDocument = (content: string | Buffer): ParseResult => {
  const source = typeof content === 'string' ? content : content.toString()
  const sourceLength = source.length

  // Detect BOM.
  let start = 0
  const hasBom = sourceLength > 0 && source.charCodeAt(0) === CH_BOM
  if (hasBom) {
    start = 1
  }

  // Detect EOL character from the first line terminator found.
  let eolCharacter = '\n'
  for (let index = start; index < sourceLength; index++) {
    const charCode = source.charCodeAt(index)
    if (charCode === CH_CR) {
      eolCharacter =
        index + 1 < sourceLength && source.charCodeAt(index + 1) === CH_LF ? '\r\n' : '\r'
      break
    }
    if (charCode === CH_LF) {
      eolCharacter = '\n'
      break
    }
  }

  // Split into physical lines. We preserve every line exactly as-is.
  // Note: we split from `start` to skip the BOM character.
  const rawContent = start > 0 ? source.slice(start) : source
  const physicalLines: string[] = rawContent.split(/\r\n|\r|\n/)

  const nodes: PropertiesNode[] = []
  let lineIndex = 0
  const lineCount = physicalLines.length

  while (lineIndex < lineCount) {
    const line = physicalLines[lineIndex]
    const lineNumber = lineIndex + 1

    // Find first non-whitespace character.
    let firstNonWs = 0
    const lineLength = line.length
    while (firstNonWs < lineLength && isWhitespace(line.charCodeAt(firstNonWs))) {
      firstNonWs++
    }

    // ---- Blank line ----
    if (firstNonWs >= lineLength) {
      const blankNode: BlankLineNode = {
        type: 'blank',
        rawLine: line,
        lineNumber,
      }
      nodes.push(blankNode)
      lineIndex++
      continue
    }

    const firstChar = line.charCodeAt(firstNonWs)

    // ---- Comment line ----
    if (firstChar === CH_HASH || firstChar === CH_BANG) {
      const commentNode: CommentNode = {
        type: 'comment',
        rawLine: line,
        leadingWhitespace: firstNonWs > 0 ? line.slice(0, firstNonWs) : '',
        delimiter: firstChar === CH_HASH ? '#' : '!',
        body: line.slice(firstNonWs + 1),
        lineNumber,
      }
      nodes.push(commentNode)
      lineIndex++
      continue
    }

    // ---- Property ----
    const rawLines: string[] = [line]
    const startingLineNumber = lineNumber
    const leadingWhitespace = firstNonWs > 0 ? line.slice(0, firstNonWs) : ''

    // Check if this line has a continuation backslash.
    let trailingBs = countTrailingBackslashes(line, lineLength)
    let isContinuation = trailingBs % 2 === 1

    // Collect continuation lines.
    while (isContinuation && lineIndex + 1 < lineCount) {
      lineIndex++
      const nextLine = physicalLines[lineIndex]
      rawLines.push(nextLine)

      const nextLength = nextLine.length
      trailingBs = countTrailingBackslashes(nextLine, nextLength)
      isContinuation = trailingBs % 2 === 1
    }

    const endingLineNumber = lineIndex + 1

    // Build the logical line by joining continuation lines.
    // - Strip the trailing continuation backslash from each continued line.
    // - Strip leading whitespace from continuation lines (not the first line).
    // If the file ended mid-continuation, the last line still has its trailing
    // backslash which needs to be stripped.
    const endsWithDanglingContinuation = isContinuation

    let logicalLine: string
    if (rawLines.length === 1) {
      // Single-line property: use content after leading whitespace.
      const sliced = firstNonWs > 0 ? line.slice(firstNonWs) : line
      logicalLine = endsWithDanglingContinuation ? sliced.slice(0, -1) : sliced
    } else {
      const segments: string[] = []
      for (let index = 0; index < rawLines.length; index++) {
        const rawLine = rawLines[index]
        let segStart: number
        let segEnd: number

        if (index === 0) {
          // First line: skip leading whitespace, strip trailing continuation backslash.
          segStart = firstNonWs
          segEnd = rawLine.length - 1 // Remove the continuation backslash.
        } else {
          // Continuation lines: skip leading whitespace.
          segStart = 0
          const segLength = rawLine.length
          while (segStart < segLength && isWhitespace(rawLine.charCodeAt(segStart))) {
            segStart++
          }
          // Strip trailing continuation backslash if this line also continues
          // (or if the file ended mid-continuation on this line).
          const isLastLine = index === rawLines.length - 1
          segEnd = isLastLine && !endsWithDanglingContinuation ? segLength : segLength - 1
        }

        segments.push(rawLine.slice(segStart, segEnd))
      }
      logicalLine = segments.join('')
    }

    // Parse the logical line to find the separator and extract key/value.
    const logicalLength = logicalLine.length
    let keyEnd = 0
    let hasPrecedingBackslash = false

    // Scan for the separator (first unescaped whitespace, =, or :).
    while (keyEnd < logicalLength) {
      const charCode = logicalLine.charCodeAt(keyEnd)

      if (charCode === CH_BACKSLASH) {
        hasPrecedingBackslash = !hasPrecedingBackslash
        keyEnd++
        continue
      }

      if (
        !hasPrecedingBackslash &&
        (charCode === CH_EQUALS || charCode === CH_COLON || isWhitespace(charCode))
      ) {
        break
      }

      hasPrecedingBackslash = false
      keyEnd++
    }

    const escapedKey = logicalLine.slice(0, keyEnd)

    // Determine separator components: leading whitespace, char, trailing whitespace.
    let separatorLeading = ''
    let separatorChar: '=' | ':' | undefined
    let separatorTrailing = ''
    let valueStart = keyEnd

    if (valueStart < logicalLength) {
      // Collect whitespace before a potential = or : separator.
      const wsStart = valueStart
      while (valueStart < logicalLength && isWhitespace(logicalLine.charCodeAt(valueStart))) {
        valueStart++
      }

      if (valueStart < logicalLength) {
        const nextChar = logicalLine.charCodeAt(valueStart)
        if (nextChar === CH_EQUALS || nextChar === CH_COLON) {
          // We have whitespace + separator char.
          separatorLeading = logicalLine.slice(wsStart, valueStart)
          separatorChar = nextChar === CH_EQUALS ? '=' : ':'
          valueStart++

          // Collect trailing whitespace after separator char.
          const trailStart = valueStart
          while (valueStart < logicalLength && isWhitespace(logicalLine.charCodeAt(valueStart))) {
            valueStart++
          }
          separatorTrailing = logicalLine.slice(trailStart, valueStart)
        } else {
          // The whitespace itself is the separator (no = or : follows).
          separatorLeading = logicalLine.slice(wsStart, valueStart)
        }
      } else {
        // Whitespace after key consumed to end of line — trailing whitespace becomes the separator.
        separatorLeading = logicalLine.slice(wsStart, valueStart)
      }
    }

    const escapedValue = logicalLine.slice(valueStart)

    // Unescape key and value.
    const key = escapedKey.indexOf('\\') !== -1 ? unescapeContent(escapedKey) : escapedKey
    const value = escapedValue.indexOf('\\') !== -1 ? unescapeContent(escapedValue) : escapedValue

    const propertyNode: PropertyNode = {
      type: 'property',
      rawLines,
      leadingWhitespace,
      key,
      escapedKey,
      separatorLeading,
      separatorChar,
      separatorTrailing,
      value,
      escapedValue,
      startingLineNumber,
      endingLineNumber,
    }
    nodes.push(propertyNode)

    lineIndex++
  }

  return { hasBom, eolCharacter, nodes }
}
