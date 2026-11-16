/**
 * The pure parts of the release flow: version arithmetic, and reading and writing
 * `CHANGELOG.md` entries. Nothing here touches the file system, git or the network (see
 * ./release.ts for the steps that do), so all of it is unit-tested directly.
 */

/** Matches a release version: `major.minor.patch`, digits only, without leading zeros. */
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
const REGEX_CODE_FENCE = /^\s*(?<marker>`{3,}|~{3,})/

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
      `🚨 "${request}" is not "major", "minor", "patch" or a plain major.minor.patch version`
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
 * Tell which lines of a Markdown text open, are in, or close a fenced code block. As in
 * Markdown, a block is only closed by a fence of the character that opened it, at least as
 * long, with nothing after it and not indented much more; without one it goes on to the end
 * of the text.
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
    const rest = marker === undefined ? '' : line.trimStart().slice(marker.length)
    if (opening === undefined) {
      // A backtick fence followed by another backtick is inline code, not a block.
      if (marker === undefined || (marker.startsWith('`') && rest.includes('`'))) {
        codeBlockLines.push('outside')
      } else {
        opening = { marker, indentation }
        codeBlockLines.push('opening')
      }
    } else if (line.trim() !== '' && indentation < opening.indentation) {
      codeBlockLines.push('escaped')
    } else if (
      marker !== undefined &&
      marker.startsWith(opening.marker) &&
      rest.trim() === '' &&
      indentation - opening.indentation < 4
    ) {
      opening = undefined
      codeBlockLines.push('closing')
    } else {
      codeBlockLines.push('content')
    }
  }
  return codeBlockLines
}

/**
 * Check the release notes a release was given, and put them in the form they are written in:
 * Unix line endings, no blank line before or after.
 *
 * What the notes say and how they are laid out is for `docs/release-notes-guidelines.md`: they
 * are written as they are (prettier then formats the changelog as a whole). Only what would
 * break the changelog is refused.
 *
 * @param notes - The release notes, in Markdown.
 *
 * @returns The notes to write under the heading of the changelog entry.
 *
 * @throws If the notes are empty, if one of their lines has the form of an entry heading (the
 *   changelog would then be read as having one more entry), or if they leave a code block or
 *   an HTML comment open (every older entry would become part of it).
 */
export const normalizeReleaseNotes = (notes: string): string => {
  const normalizedNotes = (notes.startsWith(BYTE_ORDER_MARK) ? notes.slice(1) : notes)
    // Every form of line ending, a lone `\r` included: prettier would take one for the line
    // ending of the whole changelog, and rewrite every line of it.
    .replaceAll(/\r\n?/g, '\n')
    .replace(/^(?:[^\S\n]*\n)+/, '')
    .trimEnd()
  const lines = normalizedNotes.split('\n')
  if (normalizedNotes === '') {
    throw new Error('🚨 the release notes are empty')
  }
  const headingLine = lines.find((line) => REGEX_VERSION_HEADING.test(line))
  if (headingLine !== undefined) {
    throw new Error(
      `🚨 the release notes have a line in the form of a changelog entry heading: ${headingLine}`
    )
  }
  const codeBlockLines = readCodeBlockLines(lines)
  // A block that is still open at the end: the last line is in one, whatever its indentation.
  if (codeBlockLines.at(-1) !== 'outside' && codeBlockLines.at(-1) !== 'closing') {
    const openingIndex = codeBlockLines.lastIndexOf('opening')
    throw new Error(
      `🚨 the release notes have a code block that is never closed (line ${String(openingIndex + 1)}: ` +
        `${lines[openingIndex]}): the rest of the changelog would become part of it. End the block ` +
        'with a line that has nothing but the marks that open it (``` or ~~~), indented like it.'
    )
  }
  const escapedIndex = codeBlockLines.indexOf('escaped')
  if (escapedIndex !== -1) {
    const openingIndex = codeBlockLines.lastIndexOf('opening', escapedIndex)
    throw new Error(
      `🚨 the release notes have a code block (line ${String(openingIndex + 1)}: ${lines[openingIndex]}) ` +
        `with a line that is indented less than it (line ${String(escapedIndex + 1)}: ${lines[escapedIndex]}): ` +
        'Markdown ends the block at that line, and the rest of the changelog could become part ' +
        'of another one. Indent every line of the block at least as much as the line that ' +
        'opens it.'
    )
  }
  // An HTML comment that is left open, outside code, hides what follows it.
  const textLines = lines.map((line, index) =>
    codeBlockLines[index] === 'outside' ? line.replaceAll(REGEX_INLINE_CODE, '') : ''
  )
  const commentIndex = textLines.findLastIndex((line) => line.includes('<!--'))
  if (
    commentIndex !== -1 &&
    !textLines
      .slice(commentIndex)
      .join('\n')
      .includes('-->', textLines[commentIndex].lastIndexOf('<!--'))
  ) {
    throw new Error(
      `🚨 the release notes have an HTML comment that is never closed (line ${String(commentIndex + 1)}: ` +
        `${lines[commentIndex]}): the rest of the changelog would not be shown. Close it with ` +
        '"-->", or remove it.'
    )
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
      .trim(),
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
 *   exactly one entry more than before, or if its older entries are not what they were.
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
  const previousLines = previousChangelog.split(/\r?\n/)
  const firstHeadingIndex = findVersionHeadings(previousLines).at(0)
  const olderEntries =
    firstHeadingIndex === undefined
      ? ''
      : previousLines.slice(firstHeadingIndex).join('\n').trimEnd()
  if (!changelog.replaceAll('\r\n', '\n').trimEnd().endsWith(olderEntries)) {
    throw new Error(
      '🚨 CHANGELOG.md would not keep its older entries as they were. Either the release ' +
        'notes leave something open that takes them in (a code block, an HTML tag), or the ' +
        'file was not formatted with prettier before the release'
    )
  }
}
