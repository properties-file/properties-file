/**
 * The pure parts of the release flow: version arithmetic, and reading and writing
 * `CHANGELOG.md` entries. Nothing here touches the file system, git or the network (see
 * ./release.ts for the steps that do), so all of it is unit-tested directly.
 */

/** Matches a release version: `major.minor.patch`, digits only, without leading zeros. */
import { Lexer } from 'marked'

import { isNormalizedError, noThrow } from '../utilities/no-throw'

const REGEX_RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

/**
 * Matches the heading of any version entry in `CHANGELOG.md`: a level 1 or 2 heading that
 * starts with a version as a link (`# [1.0.0](…)`, `## [1.0.1](…)`, `## [1.0.2 — 1.0.9](…)`).
 * Nothing else is taken for one, such as a `# [section]` line in a `.properties` example.
 */
const REGEX_VERSION_HEADING = /^#{1,2} \[\d+\.\d+\.\d[^\]]*\]\(/

/** The character some editors put at the start of a file, which is not part of its text. */
export const BYTE_ORDER_MARK = String.fromCodePoint(0xfe_ff)

/**
 * Matches the start of a line that can open or close a fenced code block, capturing its marker
 * (three or more backticks or tildes).
 */
const REGEX_CODE_FENCE = /^[\t ]*(?<marker>`{3,}|~{3,})/

/**
 * Matches the start of what Markdown copies as HTML although the parser used here does not
 * always tell: a processing instruction (`<?`), a declaration (`<!x`), a comment or a
 * `CDATA` section.
 */
const REGEX_HTML_START = /(?<!(?:^|[^\\])(?:\\\\)*\\)<(?:\?|![A-Z[-])/i

/**
 * Matches the beginning of a line that could define a link (or a footnote) for the whole
 * document: an opening bracket at the start of the line, or of what a quote or a list item
 * holds.
 */
const REGEX_LINK_DEFINITION_START = /^(?:[\t >]|[*+-][\t ]|\d+[.)][\t ])*\[/

/**
 * Check whether a line could define a link, `[label]: url`, wherever Markdown would find a
 * definition. Nothing is asked of what follows the label: what a definition can end with (an
 * address, a title in one of three forms, with escapes) is read differently by the parsers,
 * and a rule that reads it could be got around.
 *
 * @param line - A line of release notes, without its inline code.
 *
 * @returns `true` if the line starts with a bracket and has, after it, `]:`.
 */
const isLinkDefinitionLine = (line: string): boolean => {
  const start = REGEX_LINK_DEFINITION_START.exec(line)?.[0]
  return start !== undefined && line.includes(']:', start.length)
}

/** Matches a footnote, which GitHub adds to Markdown: its reference or its definition. */
const REGEX_FOOTNOTE = /(?<!(?:^|[^\\])(?:\\\\)*\\)\[\^[^\]\t\n\r ][^\]]*\]/

/**
 * Check whether a line could hold the text of a footnote, `[^label]: …`, wherever GitHub
 * would find one. Nothing is asked of what the label is made of: GitHub and JavaScript do not
 * agree on which characters are spaces, and a rule that reads characters could be got around.
 *
 * @param line - A line of release notes, as it is written.
 *
 * @returns `true` if the line has `[^` and, after it, `]:`.
 */
const hasFootnoteText = (line: string): boolean => {
  const start = line.indexOf('[^')
  return start !== -1 && line.includes(']:', start)
}

/** Matches the definition of a footnote, at the beginning of a line of a file. */
const REGEX_FOOTNOTE_DEFINITION = /^(?:[\t >]|[*+-][\t ]|\d+[.)][\t ])*\[\^[^\]]+\]:/

/** Matches a caret, as it is or as one of the entities Markdown reads as one. */
const REGEX_CARET = /\^|&#0*94;|&#x0*5e;|&Hat;/i

/** What stands for inline code in a line that is checked as text: a character no check reads. */
const INLINE_CODE_MARK = String.fromCodePoint(0xff_fc)

/** Matches a link whose address is given elsewhere, by a label: `[text][label]`. */
const REGEX_LINK_REFERENCE = /(?<!(?:^|[^\\])(?:\\\\)*\\)\[[^\]]+\]\[[^\]]*\]/

/** Matches a line that ends with what opens a fenced code block: backticks and a language. */
const REGEX_TRAILING_CODE_FENCE = /`{3,}[\w+-]*[\t ]*$/

/** Matches a line that starts a list item and opens a fenced code block on the same line. */
const REGEX_ITEM_CODE_FENCE = /^[\t ]*(?:[*+-]|\d+[.)])[\t ]+(?:`{3,}|~{3,})/

/**
 * What a line of Markdown is to its fenced code blocks. An `escaped` line is in a block by the
 * fences, but indented less than the line that opens it: when the block is in a list item,
 * Markdown ends the item, and the block with it, at that line.
 */
export type CodeBlockLine = 'opening' | 'content' | 'closing' | 'outside' | 'escaped'

/** Matches inline code, between as many backticks as it starts with. */
export const REGEX_INLINE_CODE = /(?<fence>`+).*?\k<fence>/g

/** Matches the compare link of a version entry heading, capturing its URL and its tag range. */
const REGEX_COMPARE_LINK = /\]\((?<url>[^()\s]+\/compare\/(?<range>[^()\s/]+))\)/

/** What a changelog entry is rendered from. */
export type ChangelogEntryInput = {
  /** The version being released. */
  version: string
  /** The version released before it, which the compare link starts from. */
  previousVersion: string
  /** The release date (`YYYY-MM-DD`). */
  date: string
  /** The repository's web URL (see {@link getRepositoryUrl}). */
  repositoryUrl: string
  /** The release notes (see {@link normalizeReleaseNotes}). */
  notes: string
}

/**
 * Check whether a string is a version this flow can release: plain `major.minor.patch`.
 * Pre-release and build suffixes are not supported.
 *
 * @param version - The version to check.
 *
 * @returns `true` if the version is a plain `major.minor.patch` version.
 */
export const isReleaseVersion = (version: string): boolean => REGEX_RELEASE_VERSION.test(version)

/**
 * Compare two release versions.
 *
 * @param first - A version accepted by {@link isReleaseVersion}.
 * @param second - A version accepted by {@link isReleaseVersion}.
 *
 * @returns A negative number if `first` is lower than `second`, a positive number if it is
 *   higher, and `0` if they are equal.
 */
export const compareVersions = (first: string, second: string): number => {
  const firstParts = first.split('.').map(Number)
  const secondParts = second.split('.').map(Number)
  for (const [index, part] of firstParts.entries()) {
    if (part !== secondParts[index]) {
      return part - secondParts[index]
    }
  }
  return 0
}

/**
 * Resolve the version to release from what was asked for.
 *
 * @param currentVersion - The version in `package.json`.
 * @param request - `major`, `minor`, `patch`, or an explicit `major.minor.patch` version.
 *
 * @returns The version to release.
 *
 * @throws If the current version or the request is not usable, or if an explicit version is
 *   not higher than the current one.
 */
export const resolveNextVersion = (currentVersion: string, request: string): string => {
  if (!isReleaseVersion(currentVersion)) {
    throw new Error(
      `🚨 the current version (${currentVersion}) is not a plain major.minor.patch version`
    )
  }
  const [major, minor, patch] = currentVersion.split('.').map(Number)
  if (request === 'major') {
    return [major + 1, 0, 0].join('.')
  }
  if (request === 'minor') {
    return [major, minor + 1, 0].join('.')
  }
  if (request === 'patch') {
    return [major, minor, patch + 1].join('.')
  }
  if (!isReleaseVersion(request)) {
    throw new Error(
      `🚨 "${request}" is not "major", "minor", "patch" or a plain major.minor.patch version` +
        (isReleaseVersion(request.replace(/^v/i, ''))
          ? `: write it without its first letter, ${request.slice(1)}`
          : '')
    )
  }
  if (compareVersions(request, currentVersion) <= 0) {
    throw new Error(`🚨 ${request} is not higher than the current version (${currentVersion})`)
  }
  return request
}

/**
 * Get the repository's web URL from the `repository.url` of `package.json`.
 *
 * @param packageRepositoryUrl - The `repository.url` value (e.g. `git+https://…/name.git`).
 *
 * @returns The URL without its `git+` prefix and `.git` suffix.
 *
 * @throws If the URL is not an `https://github.com/` repository URL, which the compare link of
 *   a changelog entry is built on.
 */
export const getRepositoryUrl = (packageRepositoryUrl: string): string => {
  const repositoryUrl = packageRepositoryUrl.replace(/^git\+/, '').replace(/\.git$/, '')
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(repositoryUrl)) {
    throw new Error(
      `🚨 the package.json "repository.url" (${packageRepositoryUrl}) is not an ` +
        `https://github.com/ repository URL`
    )
  }
  return repositoryUrl
}

/**
 * Measure how far a line is indented, a tab going to the next multiple of four as in Markdown.
 *
 * @param line - The line to measure.
 *
 * @returns The number of columns before the first character that is not a space or a tab.
 */
const getIndentation = (line: string): number => {
  let indentation = 0
  for (const character of line) {
    if (character === ' ') {
      indentation++
    } else if (character === '\t') {
      indentation += 4 - (indentation % 4)
    } else {
      break
    }
  }
  return indentation
}

/**
 * Tell which lines of a Markdown text open, are in, or close a fenced code block. A block is
 * only closed by a fence of the character that opened it, at least as long, with nothing
 * after it and indented at least like it, which closes a block wherever Markdown could (what
 * follows is then checked as text, not skipped as code); without one it goes on to
 * the end of the text. Only spaces and tabs indent a line.
 *
 * @param lines - The lines of the text.
 *
 * @returns What each line is, in the same order.
 */
export const readCodeBlockLines = (lines: string[]): CodeBlockLine[] => {
  const codeBlockLines: CodeBlockLine[] = []
  // The marker and the indentation of the fence that opened the block the line is in.
  let opening: { marker: string; indentation: number } | undefined
  for (const line of lines) {
    const indentation = getIndentation(line)
    const marker = REGEX_CODE_FENCE.exec(line)?.groups?.marker
    // What the line has after the marker: the language of a block that opens, and nothing
    // for one that closes.
    const rest = marker === undefined ? '' : line.replace(/^[\t ]+/, '').slice(marker.length)
    if (opening === undefined) {
      // A backtick fence followed by another backtick is inline code, not a block.
      if (marker === undefined || (marker.startsWith('`') && rest.includes('`'))) {
        codeBlockLines.push('outside')
      } else {
        opening = { marker, indentation }
        codeBlockLines.push('opening')
      }
    } else if (!/^[\t ]*$/.test(line) && indentation < opening.indentation) {
      codeBlockLines.push('escaped')
    } else if (
      marker !== undefined &&
      marker.startsWith(opening.marker) &&
      // Only spaces and tabs can follow the fence that closes a block.
      /^[\t ]*$/.test(rest)
    ) {
      opening = undefined
      codeBlockLines.push('closing')
    } else {
      codeBlockLines.push('content')
    }
  }
  return codeBlockLines
}

/** What the parser found in a Markdown text, with the properties this module reads. */
type MarkdownToken = {
  /** The kind of thing it is: `heading`, `html`, `code`… */
  type: string
  /** The text it was read from. */
  raw: string
  /** The level of a heading, and `0` for anything else. */
  depth: number
  /** What it says, without the marks of what it is: the title of a heading. */
  text: string
}

/** Matches the title of a version entry heading: a version as a link. */
const REGEX_VERSION_TITLE = /^\[\d+\.\d+\.\d[^\]]*\]\(/

/**
 * Read a Markdown text the way a Markdown renderer does (here, the one of GitHub).
 *
 * @param text - What to read.
 *
 * @returns What the parser found, as plain data: a tree of tokens.
 */
const readMarkdown = (text: string): unknown => {
  const tokens: unknown = new Lexer().lex(text)
  return tokens
}

/**
 * Read the labels of the links a Markdown text defines for its whole document
 * (`[label]: url`), as the parser finds them: on one line or several, in any container.
 *
 * @param text - The Markdown text.
 *
 * @returns The labels, as they are written.
 */
const readLinkLabels = (text: string): string[] => Object.keys(new Lexer().lex(text).links)

/**
 * Find everything of a kind in what the parser found, however deep it is.
 *
 * @param value - What {@link readMarkdown} returned, or a part of it.
 * @param type - The kind of token to find.
 *
 * @returns The tokens of that kind, in the order of the text.
 */
const findTokens = (value: unknown, type: string): MarkdownToken[] => {
  if (Array.isArray(value)) {
    return value.flatMap((element: unknown) => findTokens(element, type))
  }
  if (typeof value !== 'object' || value === null) {
    return []
  }
  const found: MarkdownToken[] = []
  if ('type' in value && value.type === type && 'raw' in value && typeof value.raw === 'string') {
    found.push({
      type,
      raw: value.raw,
      depth: 'depth' in value && typeof value.depth === 'number' ? value.depth : 0,
      text: 'text' in value && typeof value.text === 'string' ? value.text : '',
    })
  }
  return [...found, ...Object.values(value).flatMap((child: unknown) => findTokens(child, type))]
}

/**
 * Say where something the parser found is in the text, for an error.
 *
 * @param lines - The lines of the text.
 * @param raw - The text the token was read from.
 *
 * @returns The number of the first line that has the start of it, and that line.
 */
const describePlace = (lines: string[], raw: string): string => {
  const start = raw.trim().split('\n', 1)[0]
  const index = lines.findIndex((line) => line.includes(start))
  return index === -1 ? start : `line ${String(index + 1)}: ${lines[index]}`
}

/**
 * Check that the entries a changelog had are read as they were, now that it has one more:
 * whatever the notes of the new entry are, they cannot take in what follows them (a code
 * block or a tag left open) or change it (a link definition).
 *
 * @param previousChangelog - The content of `CHANGELOG.md` before the release.
 * @param changelog - Its content with the entry of the release.
 *
 * @returns `true` if a Markdown parser reads the older entries as it did before.
 */
const areOlderEntriesKept = (previousChangelog: string, changelog: string): boolean => {
  const previousLines = previousChangelog.split(/\r?\n/)
  const firstHeadingIndex = findVersionHeadings(previousLines).at(0)
  if (firstHeadingIndex === undefined) {
    return true
  }
  // How many things the older entries are, then those things as they are read in each
  // changelog as a whole: what comes before them can define the links they use.
  const olderEntries = readMarkdown(previousLines.slice(firstHeadingIndex).join('\n').trimEnd())
  const previousEntries = readMarkdown(previousChangelog.replaceAll('\r\n', '\n').trimEnd())
  const entries = readMarkdown(changelog.replaceAll('\r\n', '\n').trimEnd())
  return (
    Array.isArray(olderEntries) &&
    Array.isArray(previousEntries) &&
    Array.isArray(entries) &&
    JSON.stringify(entries.slice(-olderEntries.length)) ===
      JSON.stringify(previousEntries.slice(-olderEntries.length))
  )
}

/**
 * Find what release notes would do to the footnotes of a changelog that has some. GitHub
 * numbers the footnotes of a whole file together, and takes for a reference to one more
 * spellings than a look at the text can tell (a caret that is escaped or written as an
 * entity, in what only looks like code): where there are footnotes to refer to, notes do not
 * get a caret at all.
 *
 * @param normalizedNotes - The notes (see {@link cleanReleaseNotes}).
 * @param previousChangelog - The content of `CHANGELOG.md` before the release.
 *
 * @returns What is wrong and what to do about it, or `undefined` when the changelog has no
 *   footnote or the notes no caret.
 */
export const findFootnoteHazard = (
  normalizedNotes: string,
  previousChangelog: string
): string | undefined => {
  const changelogLines = previousChangelog.split(/\r?\n/)
  const footnoteIndex = changelogLines.findIndex((line) => REGEX_FOOTNOTE_DEFINITION.test(line))
  if (footnoteIndex === -1) {
    return undefined
  }
  const lines = normalizedNotes.split('\n')
  const caretIndex = lines.findIndex((line) => REGEX_CARET.test(line))
  return caretIndex === -1
    ? undefined
    : `🚨 CHANGELOG.md has the text of a footnote (its line ${String(footnoteIndex + 1)}: ${changelogLines[footnoteIndex]}), ` +
        `and the release notes have a caret (line ${String(caretIndex + 1)}: ${lines[caretIndex]}). ` +
        'GitHub numbers the footnotes of the whole file together and reads a "[^label]" in ' +
        'more spellings than can be told from the text, so a caret in the notes could change ' +
        'the footnotes of the older entries. Write that part of the notes without a "^" (in ' +
        'words, or with another example), or take that line out of CHANGELOG.md in a commit ' +
        'of its own first (it counts even when it is an example in a code block).'
}

/**
 * Check, before anything is written, that release notes leave the older entries of the
 * changelog as they are (see {@link areOlderEntriesKept}).
 *
 * @param previousChangelog - The content of `CHANGELOG.md` before the release.
 * @param changelog - Its content with the entry of the release.
 *
 * @throws If the older entries would not be read as they are now.
 */
export const assertOlderEntriesKept = (previousChangelog: string, changelog: string): void => {
  if (!areOlderEntriesKept(previousChangelog, changelog)) {
    throw new Error(
      '🚨 with these release notes, the older entries of CHANGELOG.md would not be read as ' +
        'they are now: the notes leave something open that takes them in, or change what ' +
        'they mean (a code block that is not closed, a list or a quote that goes on, a link ' +
        'definition). Check that every code block of the notes is closed and indented under ' +
        'its item, and that the notes end with a complete item.'
    )
  }
}

/**
 * Put release notes in the form they are written in: Unix line endings, no blank line before
 * or after.
 *
 * @param notes - The release notes, as they were given.
 *
 * @returns The notes to check, and to write under the heading of the changelog entry.
 */
export const cleanReleaseNotes = (notes: string): string =>
  (notes.startsWith(BYTE_ORDER_MARK) ? notes.slice(1) : notes)
    // Every form of line ending, a lone `\r` included: prettier would take one for the line
    // ending of the whole changelog, and rewrite every line of it.
    .replaceAll(/\r\n?/g, '\n')
    .replace(/^(?:[^\S\n]*\n)+/, '')
    .trimEnd()

/**
 * Find a code block of release notes that Markdown would not end where the notes do: every
 * older entry of the changelog could become part of it.
 *
 * @param lines - The lines of the notes.
 *
 * @returns What is wrong with each such block and what to do about it, or `undefined`.
 */
const findCodeBlockHazard = (lines: string[]): string | undefined => {
  /**
   * Name lines of the notes, for a message.
   *
   * @param indexes - Which lines to name.
   *
   * @returns Their numbers and what they say.
   */
  const describeLines = (indexes: number[]): string =>
    indexes.map((index) => `line ${String(index + 1)}: ${lines[index]}`).join('; ')

  // Every line that opens a block where one cannot be opened.
  const misplacedIndexes = lines.flatMap((line, index) => {
    const fence = REGEX_ITEM_CODE_FENCE.exec(line)?.[0]
    const isMisplaced =
      fence === undefined
        ? // After the text of the line: backticks that open something and close nothing.
          !REGEX_CODE_FENCE.test(line) &&
          REGEX_TRAILING_CODE_FENCE.test(line) &&
          line.split('```').length % 2 === 0
        : // With a backtick after the fence, the line has inline code, not the start of a block.
          !line.slice(fence.length).includes('`')
    return isMisplaced ? index : []
  })
  const misplacedHazards: string[] = []
  if (misplacedIndexes.length > 0) {
    const quoteIndexes = misplacedIndexes.filter((index) => /^[\t ]*>/.test(lines[index]))
    // A line that would open or close a block, were it not for a character that does not
    // show: it looks right, and is told apart.
    const hiddenIndexes = misplacedIndexes.filter(
      (index) =>
        !quoteIndexes.includes(index) &&
        REGEX_CODE_FENCE.test(lines[index].replaceAll(/[^\t\u{20}-\u{7E}]/gu, ''))
    )
    const otherIndexes = misplacedIndexes.filter(
      (index) => !quoteIndexes.includes(index) && !hiddenIndexes.includes(index)
    )
    misplacedHazards.push(
      ...(hiddenIndexes.length === 0
        ? []
        : [
            `🚨 the release notes have a character that does not show before or after the marks of a code block (${describeLines(hiddenIndexes)}): a space that is not an ordinary one, most often, which comes with text copied from a page. ` +
              'Markdown does not read that line as one that opens or closes a block. Delete ' +
              'what is around the marks, and type the spaces again.',
          ]),
      ...(quoteIndexes.length === 0
        ? []
        : [
            `🚨 the release notes have a code block in a quote (${describeLines(quoteIndexes)}), which this release cannot check. Take the block out of the ` +
              'quote: put it under a list item, indented like the text of the item.',
          ]),
      ...(otherIndexes.length === 0
        ? []
        : [
            `🚨 the release notes open a code block on a line that has something else, the start of a list item or its text (${describeLines(otherIndexes)}). Put the line that opens the block on a line of its own, ` +
              'indented under the item like the rest of the block, after a first line of the item ' +
              'that says what the code shows.',
          ])
    )
    // A block opened on a line that has something else: where the blocks end cannot be told
    // while that line is there, and nothing else is said of them. A block in a quote does
    // not disturb the others.
    if (otherIndexes.length > 0 || hiddenIndexes.length > 0) {
      return misplacedHazards.join('\n\n')
    }
  }

  // Every block that Markdown would not end where the notes do, so that one run says them all.
  const hazards = [...misplacedHazards]
  const codeBlockLines = readCodeBlockLines(lines)
  const tildeFenceIndexes = lines.flatMap((line, index) =>
    codeBlockLines[index] === 'opening' && /^[\t ]*~/.test(line) && line.includes('`') ? index : []
  )
  if (tildeFenceIndexes.length > 0) {
    hazards.push(
      `🚨 the release notes open a code block with "~~~" on a line that has a backtick (${describeLines(tildeFenceIndexes)}): once formatted, the block is opened with backticks, and ` +
        'that line would open nothing. Take the backtick out of the line.'
    )
  }
  const openingIndexes = codeBlockLines.flatMap((kind, index) => (kind === 'opening' ? index : []))
  for (const [position, openingIndex] of openingIndexes.entries()) {
    const nextOpeningIndex = openingIndexes.at(position + 1) ?? lines.length
    const closingIndex = codeBlockLines.indexOf('closing', openingIndex)
    const isClosed = closingIndex !== -1 && closingIndex < nextOpeningIndex
    const escapedIndex = codeBlockLines.indexOf('escaped', openingIndex)
    if (
      isClosed &&
      getIndentation(lines[closingIndex]) - getIndentation(lines[openingIndex]) >= 4
    ) {
      hazards.push(
        `🚨 the release notes have a code block (${describeLines([openingIndex])}) ` +
          `whose last line is indented much more than it (${describeLines([closingIndex])}): ` +
          'Markdown reads that line as code, not as the end of the block, and the rest of the ' +
          'changelog would become part of it. Indent it like the line that opens the block.'
      )
    }
    if (isClosed && escapedIndex !== -1 && escapedIndex < closingIndex) {
      hazards.push(
        `🚨 the release notes have a code block (${describeLines([openingIndex])}) ` +
          `with a line that is indented less than it (${describeLines([escapedIndex])}): ` +
          'Markdown ends the block at that line, and the rest of the changelog could become part ' +
          'of another one. Indent every line of the block at least as much as the line that ' +
          'opens it.'
      )
    }
    if (isClosed) {
      continue
    }
    // A block that is still open at the end of the notes.
    const marker = REGEX_CODE_FENCE.exec(lines[openingIndex])?.groups?.marker ?? ''
    // A line that would close the block, were it not for a character that does not show.
    const hiddenClosingIndex = lines.findIndex((line, index) => {
      const visibleMarks = line.replaceAll(/[^\u{21}-\u{7E}]/gu, '')
      return (
        index > openingIndex &&
        codeBlockLines[index] === 'content' &&
        visibleMarks.startsWith(marker) &&
        visibleMarks.replaceAll(marker.charAt(0), '') === '' &&
        !/^[\t ]*[`~]+[\t ]*$/.test(line)
      )
    })
    if (hiddenClosingIndex !== -1) {
      hazards.push(
        `🚨 the release notes have a character that does not show before or after the marks of a code block (${describeLines([hiddenClosingIndex])}): a space that is not an ordinary one, most often, which comes with text copied from a page. ` +
          'Markdown does not read that line as one that opens or closes a block. Delete ' +
          'what is around the marks, and type the spaces again.'
      )
      continue
    }
    // A line that would close the block, were it indented like the line that opens it.
    const unindentedClosingIndex = lines.findIndex(
      (line, index) =>
        index > openingIndex &&
        codeBlockLines[index] === 'escaped' &&
        line.replaceAll(/[\t ]/g, '').startsWith(marker) &&
        line.replaceAll(/[\t ]/g, '').replaceAll(marker.charAt(0), '') === ''
    )
    hazards.push(
      unindentedClosingIndex === -1
        ? `🚨 the release notes have a code block that is never closed (${describeLines([openingIndex])}): ` +
            'the rest of the changelog would become part of it. End the block ' +
            'with a line that has nothing but the marks that open it (``` or ~~~), indented like it.'
        : `🚨 the release notes have a code block (${describeLines([openingIndex])}) ` +
            `that its last line does not close (${describeLines([unindentedClosingIndex])}): ` +
            'that line is indented less than the one that opens the block, so Markdown reads it ' +
            'as the start of another block, which the rest of the changelog would become part ' +
            'of. Indent it like the line that opens the block.'
    )
  }
  return hazards.length === 0 ? undefined : hazards.join('\n\n')
}

/**
 * Say why release notes cannot have HTML, and what to write instead.
 *
 * @param places - Where the HTML is in the notes: each place once.
 *
 * @returns What is wrong and what to do about it.
 */
const describeHtmlHazard = (places: string[]): string =>
  `🚨 the release notes have HTML (${places.join('; ')}): Markdown copies it as it is, and a tag or a ` +
  'comment that is left open would take in the rest of the changelog. Put it in backticks if ' +
  'it is code (a type like `Promise<string>` is read as a tag), write it in Markdown, or ' +
  'remove it.'

/**
 * Find a control character in a line: one that does not show and is not a tab.
 *
 * @param line - A line of release notes.
 *
 * @returns The first such character, or `undefined`.
 */
const findControlCharacter = (line: string): string | undefined => {
  for (const character of line) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint === 127 || (character !== '\t' && codePoint < 32)) {
      return character
    }
  }
  return undefined
}

/**
 * Find what release notes have that would be read as part of the changelog itself, or that
 * Markdown would copy into it as it is: an entry heading, HTML.
 *
 * @param normalizedNotes - The notes (see {@link cleanReleaseNotes}).
 * @param lines - Their lines.
 *
 * @returns What is wrong with each such thing and what to do about it, or `undefined`.
 */
const findContentHazard = (normalizedNotes: string, lines: string[]): string | undefined => {
  // Everything there is, so that one run says all of it.
  const hazards: string[] = []
  const controlIndex = lines.findIndex((line) => findControlCharacter(line) !== undefined)
  if (controlIndex !== -1) {
    const control = findControlCharacter(lines[controlIndex]) ?? ''
    const name = `U+${(control.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
    hazards.push(
      `🚨 the release notes have a control character (${name}, line ${String(controlIndex + 1)}: ` +
        `${lines[controlIndex].replaceAll(control, () => `<${name}>`)}): it does not show, and ` +
        'with some of them GitHub and git stop reading CHANGELOG.md as text. Delete it.'
    )
  }
  const headingIndex = lines.findIndex((line) => REGEX_VERSION_HEADING.test(line))
  if (headingIndex !== -1) {
    hazards.push(
      '🚨 the release notes have a line in the form of a changelog entry heading ' +
        `(line ${String(headingIndex + 1)}: ${lines[headingIndex]}): remove it, the release writes ` +
        'the heading of the entry itself'
    )
  }
  // What the parser does not always tell, looked for in the text that is not code: the HTML
  // it does not take for HTML, and the definition of a link, which changes every use of its
  // label in the older entries (labels are compared in ways the parser does not follow).
  const codeBlockLines = readCodeBlockLines(lines)
  const textLines = lines.map((line, index) =>
    // Inline code leaves a mark where it was: what is around it still reads as it did.
    codeBlockLines[index] === 'outside'
      ? line.replaceAll(REGEX_INLINE_CODE, () => INLINE_CODE_MARK)
      : ''
  )
  const htmlPlaces = lines.flatMap((line, index) =>
    REGEX_HTML_START.test(textLines[index]) ? `line ${String(index + 1)}: ${line}` : []
  )
  // A footnote: no parser used here knows them, and GitHub numbers those of the whole
  // changelog together, whatever entry they are in. Every line that has one is named: a
  // reference and its definition go together.
  const footnotePlaces = lines.flatMap((line, index) =>
    REGEX_FOOTNOTE.test(textLines[index]) ? `line ${String(index + 1)}: ${line}` : []
  )
  if (footnotePlaces.length > 0) {
    hazards.push(
      `🚨 the release notes have a footnote (${footnotePlaces.join('; ')}): GitHub numbers the ` +
        'footnotes of the whole changelog together, so one in the notes changes those of the ' +
        'older entries, and it is not rendered in the release. Write what it says in the item ' +
        'itself and take out both its mark and its text, or put it in backticks if it is code ' +
        '(part of a regular expression, for instance).'
    )
  }
  // The text of a footnote is looked for in code too: where code ends is not read in the same
  // way by everything that reads Markdown, and GitHub is what counts for footnotes. Such a
  // line is named with the part of it that reads like one.
  const codeFootnotePlaces = lines.flatMap((line, index) => {
    if (REGEX_FOOTNOTE.test(textLines[index]) || !hasFootnoteText(line)) {
      return []
    }
    const spanStart = line.indexOf('[^')
    const span = line.slice(spanStart, line.indexOf(']:', spanStart) + 2)
    return `line ${String(index + 1)}: ${line}, at "${span}"`
  })
  if (codeFootnotePlaces.length > 0) {
    hazards.push(
      `🚨 the release notes have code that reads like the text of a footnote (${codeFootnotePlaces.join('; ')}): ` +
        'a line that has "[^" and, further on, "]:" is refused in code too, whatever is ' +
        'between them, since GitHub decides what is code and numbers the footnotes of the ' +
        'whole changelog together. Put the two on different lines, or show that example in ' +
        'another way.'
    )
  }
  // Every line that defines a link; the text of a footnote, which looks like one, was named
  // as what it is.
  const definitionPlaces = lines.flatMap((line, index) =>
    isLinkDefinitionLine(textLines[index]) && !hasFootnoteText(line)
      ? `line ${String(index + 1)}: ${line}`
      : []
  )
  if (definitionPlaces.length > 0) {
    // With the links that use it, which are to write in another way too: one run says both.
    const referencePlaces = lines.flatMap((line, index) =>
      REGEX_LINK_REFERENCE.test(textLines[index]) ? `line ${String(index + 1)}: ${line}` : []
    )
    hazards.push(
      `🚨 the release notes define a link for the whole changelog (${definitionPlaces.join('; ')}): ` +
        'a line "[label]: url" changes every "[label]" of the older ' +
        'entries. Write the link where it is used: [text](url). A line that starts with ' +
        'words in brackets and is not meant as a link is to start in another way: the words ' +
        String.raw`in backticks, or "\[" for the bracket.` +
        (referencePlaces.length === 0 ? '' : ` Where it is used: ${referencePlaces.join('; ')}`)
    )
  }
  // A link by reference, whose definition the notes cannot have: it would use one of the
  // older entries in the changelog, and none in the release.
  const referenceIndex = textLines.findIndex((line) => REGEX_LINK_REFERENCE.test(line))
  if (referenceIndex !== -1 && definitionPlaces.length === 0) {
    hazards.push(
      `🚨 the release notes have a link by reference (line ${String(referenceIndex + 1)}: ` +
        `${lines[referenceIndex]}): its address would be on a line of its own, "[label]: url", ` +
        'which the notes cannot have. Write the address in the link, [text](url), or put it in ' +
        'backticks if it is code (two pairs of brackets in a row).'
    )
  }
  // What only a parser can tell: an entry heading that is not written like the others
  // (indented, underlined), which formatting would make one of them, and HTML, which Markdown
  // copies as it is and which can take in everything after it.
  const tokens = noThrow(() => {
    // With the end of the last line: the notes are followed by other lines in the changelog,
    // and a tag that ends them is only read as one when something follows it.
    const allTokens = readMarkdown(`${normalizedNotes}\n`)
    return {
      headings: findTokens(allTokens, 'heading'),
      html: findTokens(allTokens, 'html'),
      linkLabels: readLinkLabels(normalizedNotes),
    }
  })
  if (isNormalizedError(tokens)) {
    return [
      ...hazards,
      `🚨 the release notes could not be read as Markdown (${tokens.message}): they nest quotes or lists too deep. Write them more simply.`,
    ].join('\n\n')
  }
  // A definition the look at the lines did not find: its label is on more than one line.
  const linkLabel = tokens.linkLabels.at(0)
  if (
    linkLabel !== undefined &&
    definitionPlaces.length === 0 &&
    footnotePlaces.length === 0 &&
    codeFootnotePlaces.length === 0
  ) {
    const labelIndex = lines.findIndex((line) => line.includes(']:'))
    hazards.push(
      '🚨 the release notes define a link for the whole changelog ' +
        `(${labelIndex === -1 ? `the label "${linkLabel.trim()}"` : `line ${String(labelIndex + 1)}: ${lines[labelIndex]}`}): ` +
        'a definition "[label]: url" changes every "[label]" of the older entries. Write the ' +
        'link where it is used: [text](url).'
    )
  }
  const heading = tokens.headings.find(
    (token) => token.depth <= 2 && REGEX_VERSION_TITLE.test(token.text)
  )
  if (heading !== undefined && headingIndex === -1) {
    hazards.push(
      '🚨 the release notes have a heading in the form of a changelog entry heading ' +
        `(${describePlace(lines, heading.raw)}): remove it, the release writes the heading of ` +
        'the entry itself'
    )
  }
  // Every line of what the parser read as HTML (a block of it has several), with the tag
  // itself when it is only a part of its line.
  const parsedHtmlPlaces = tokens.html.flatMap((token) =>
    token.raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((part) => {
        const place = describePlace(lines, part)
        return place.replace(/^line \d+: /, '').trim() === part.trim()
          ? place
          : `${place}, at "${part.trim()}"`
      })
  )
  // Every place once, so that one run says all there is to take out: a line the look at the
  // text found too is named as the parser names it.
  const allHtmlPlaces = [
    ...new Set([
      ...htmlPlaces.filter((place) =>
        parsedHtmlPlaces.every((parsedPlace) => !parsedPlace.startsWith(place))
      ),
      ...parsedHtmlPlaces,
    ]),
  ].toSorted(
    (first, second) =>
      Number(/^line (?<number>\d+)/.exec(first)?.groups?.number ?? 0) -
      Number(/^line (?<number>\d+)/.exec(second)?.groups?.number ?? 0)
  )
  if (allHtmlPlaces.length > 0) {
    hazards.push(describeHtmlHazard(allHtmlPlaces))
  }
  return hazards.length === 0 ? undefined : hazards.join('\n\n')
}

/**
 * Find what release notes would do to the changelog they are written into, whatever the rules
 * of the repository are.
 *
 * @param normalizedNotes - The notes (see {@link cleanReleaseNotes}).
 *
 * @returns What is wrong with their code blocks, which changes how everything after is read,
 *   and with what they contain, each `undefined` when nothing is.
 */
export const findNotesHazards = (
  normalizedNotes: string
): { codeBlock: string | undefined; content: string | undefined } => {
  const lines = normalizedNotes.split('\n')
  return {
    codeBlock: findCodeBlockHazard(lines),
    content: findContentHazard(normalizedNotes, lines),
  }
}

/**
 * Check the release notes a release was given, and put them in the form they are written in
 * (see {@link cleanReleaseNotes}).
 *
 * What the notes say and how they are laid out is for `docs/release-notes-guidelines.md`: they
 * are written as they are (prettier then formats the changelog as a whole). Only what would
 * break the changelog is refused.
 *
 * @param notes - The release notes, in Markdown.
 *
 * @returns The notes to write under the heading of the changelog entry.
 *
 * @throws If the notes are empty, if they have a heading in the form of an entry heading (the
 *   changelog would be read as having one more entry), if they leave a code block open or
 *   open one on the line of an item (every older entry could become part of it), or if they
 *   have HTML.
 */
export const normalizeReleaseNotes = (notes: string): string => {
  const normalizedNotes = cleanReleaseNotes(notes)
  if (normalizedNotes === '') {
    throw new Error('🚨 the release notes are empty')
  }
  const hazards = findNotesHazards(normalizedNotes)
  const hazard = hazards.codeBlock ?? hazards.content
  if (hazard !== undefined) {
    throw new Error(hazard)
  }
  return normalizedNotes
}

/**
 * Render the `CHANGELOG.md` entry of a release: a heading with the compare link and the date,
 * then the release notes.
 *
 * @param input - The release the entry describes.
 *
 * @returns The entry, ending with a line break.
 *
 * @throws If the notes cannot be used (see {@link normalizeReleaseNotes}).
 */
export const renderChangelogEntry = (input: ChangelogEntryInput): string => {
  const { version, previousVersion, date, repositoryUrl } = input
  const compareUrl = `${repositoryUrl}/compare/v${previousVersion}...v${version}`
  return `## [${version}](${compareUrl}) (${date})\n\n${normalizeReleaseNotes(input.notes)}\n`
}

/**
 * Find the headings of the version entries of a `CHANGELOG.md`.
 *
 * @param lines - The lines of `CHANGELOG.md`.
 *
 * @returns The index of each version entry heading, in file order.
 */
const findVersionHeadings = (lines: string[]): number[] =>
  lines.flatMap((line, index) => (REGEX_VERSION_HEADING.test(line) ? index : []))

/**
 * Read what a `CHANGELOG.md` has before its entries: its title, and what it says of itself.
 *
 * @param changelog - The content of `CHANGELOG.md`.
 *
 * @returns Its content up to the heading of its first entry, or all of it when it has none.
 */
export const readChangelogTitle = (changelog: string): string => {
  const lines = changelog.split(/\r?\n/)
  const firstHeadingIndex = findVersionHeadings(lines).at(0)
  return firstHeadingIndex === undefined ? changelog : lines.slice(0, firstHeadingIndex).join('\n')
}

/**
 * Check whether a `CHANGELOG.md` line is the heading of a given version's entry.
 *
 * @param line - The line to check.
 * @param version - The version to look for.
 *
 * @returns `true` if the line is that version's heading.
 */
const isHeadingOfVersion = (line: string, version: string): boolean =>
  line.startsWith(`# [${version}](`) || line.startsWith(`## [${version}](`)

/**
 * Add a release entry to a `CHANGELOG.md`, above the entries it already has.
 *
 * @param changelog - The current content of `CHANGELOG.md`.
 * @param version - The version the entry is for.
 * @param entry - The entry (see {@link renderChangelogEntry}).
 *
 * @returns The new content of `CHANGELOG.md`.
 *
 * @throws If the changelog already has an entry for that version.
 */
export const insertChangelogEntry = (changelog: string, version: string, entry: string): string => {
  // Split on `\n` alone: with Windows line endings each line keeps its `\r`, so joining the
  // lines back gives the original content.
  const lines = changelog.split('\n')
  const headingIndexes = findVersionHeadings(lines)
  if (headingIndexes.some((index) => isHeadingOfVersion(lines[index], version))) {
    throw new Error(`🚨 CHANGELOG.md already has an entry for version ${version}`)
  }
  if (headingIndexes.length === 0) {
    return `${changelog.trimEnd()}\n\n${entry}`
  }
  const [firstHeadingIndex] = headingIndexes
  return [...lines.slice(0, firstHeadingIndex), entry, ...lines.slice(firstHeadingIndex)].join('\n')
}

/**
 * Get the notes of a release from `CHANGELOG.md`, for its GitHub release: the content of the
 * version's entry without its heading, followed by a "Full changelog" line when the heading
 * has a compare link.
 *
 * @param changelog - The content of `CHANGELOG.md`.
 * @param version - The version to get the notes of.
 *
 * @returns The release notes, ending with a line break.
 *
 * @throws If the changelog has no entry for that version.
 */
export const extractReleaseNotes = (changelog: string, version: string): string => {
  const lines = changelog.split(/\r?\n/)
  const headingIndexes = findVersionHeadings(lines)
  const headingIndex = headingIndexes.find((index) => isHeadingOfVersion(lines[index], version))
  if (headingIndex === undefined) {
    throw new Error(`🚨 CHANGELOG.md has no entry for version ${version}`)
  }
  const nextHeadingIndex = headingIndexes.find((index) => index > headingIndex) ?? lines.length
  const blocks = [
    lines
      .slice(headingIndex + 1, nextHeadingIndex)
      .join('\n')
      .replace(/^(?:[^\S\n]*\n)+/, '')
      .trimEnd(),
  ]
  const compareLink = REGEX_COMPARE_LINK.exec(lines[headingIndex])?.groups
  if (compareLink !== undefined) {
    blocks.push(`**Full changelog**: [${compareLink.range}](${compareLink.url})`)
  }
  return `${blocks.filter((block) => block !== '').join('\n\n')}\n`
}

/**
 * Check that a changelog reads as it did before a release, with the entry of the release
 * added: the last check before the release is committed, after prettier formatted the file.
 *
 * @param previousChangelog - The content of `CHANGELOG.md` before the release.
 * @param changelog - Its content now.
 * @param version - The version being released.
 *
 * @throws If the version has no entry that can be read, if the changelog does not have
 *   exactly one entry more than before, or if its older entries are not what they were, as
 *   text or as a Markdown parser reads them.
 */
export const assertChangelogEntryAdded = (
  previousChangelog: string,
  changelog: string,
  version: string
): void => {
  extractReleaseNotes(changelog, version)
  const previousCount = findVersionHeadings(previousChangelog.split(/\r?\n/)).length
  const count = findVersionHeadings(changelog.split(/\r?\n/)).length
  if (count !== previousCount + 1) {
    throw new Error(
      `🚨 CHANGELOG.md had ${String(previousCount)} entries and now reads as having ` +
        `${String(count)}: the release would not add exactly one`
    )
  }
  // Whatever the notes are, the entries that were there stay as they were: if formatting the
  // file with the new entry changed them, the notes left something open that took them in.
  if (!areOlderEntriesKept(previousChangelog, changelog)) {
    throw new Error(
      '🚨 CHANGELOG.md would not keep its older entries as they were, once formatted. Either ' +
        'the file was not formatted with prettier before the release, or the release notes ' +
        'leave something open that takes the older entries in (a code block, a list)'
    )
  }
}
