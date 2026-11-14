/**
 * The pure parts of the release flow: version arithmetic, Conventional Commits parsing, and
 * reading and writing `CHANGELOG.md` entries. Nothing here touches the file system, git or the
 * network (see ./release.ts for the steps that do), so all of it is unit-tested directly.
 */

/** Matches a release version: `major.minor.patch`, digits only, without leading zeros. */
const REGEX_RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

/** Matches a Conventional Commits subject: `type(scope)!: description`. */
const REGEX_COMMIT_SUBJECT =
  /^(?<type>[a-z]+)(?:\((?<scope>[^()]+)\))?(?<breakingMark>!)?: (?<description>.+)$/

/**
 * Matches a line of a commit body that starts a breaking change note, capturing the note up to
 * the next blank line.
 */
const REGEX_BREAKING_CHANGE_NOTE = /^BREAKING[ -]CHANGE: (?<note>.+(?:\n.+)*)/m

/** Matches the subject git gives a revert commit, capturing the subject of the reverted one. */
const REGEX_REVERT_SUBJECT = /^Revert "(?<subject>.+)"$/

/** Matches the body line git gives a revert commit, capturing the hash of the reverted one. */
const REGEX_REVERTED_HASH = /^This reverts commit (?<hash>[\da-f]{7,40})\b/m

/** Matches a Markdown code span, which is kept as it is when a commit's text is escaped. */
const REGEX_CODE_SPAN = /(`[^`]*`)/

/** Matches the heading of any version entry in `CHANGELOG.md` (`# [1.0.0](…)`, `## [1.0.1](…)`). */
const REGEX_VERSION_HEADING = /^#{1,2} \[/

/** Matches the line that opens or closes a fenced code block. */
const REGEX_CODE_FENCE = /^\s*(?:```|~~~)/

/** Matches the compare link of a version entry heading, capturing its URL and its tag range. */
const REGEX_COMPARE_LINK = /\]\((?<url>[^()\s]+\/compare\/(?<range>[^()\s/]+))\)/

/** The type given to revert commits, whichever of their two subject forms they use. */
const REVERT_TYPE = 'revert'

/** The changelog sections built from commit types, in the order they are written. */
const COMMIT_SECTIONS = [
  { type: 'fix', title: 'Bug Fixes' },
  { type: 'feat', title: 'Features' },
  { type: 'perf', title: 'Performance Improvements' },
  { type: REVERT_TYPE, title: 'Reverts' },
]

/** The title of the changelog section listing breaking changes, written last. */
const BREAKING_CHANGES_TITLE = 'BREAKING CHANGES'

/** A commit as read from `git log`. */
export type GitCommit = {
  /** The full commit hash. */
  hash: string
  /** The first line of the commit message. */
  subject: string
  /** The commit message without its first line. */
  body: string
}

/** A commit the changelog can list. */
type ListedCommit = {
  /** The full commit hash. */
  hash: string
  /** The commit type (`feat`, `fix`, …). */
  type: string
  /** The scope between parentheses, when there is one. */
  scope: string | undefined
  /** The description after the colon (for a `Revert "…"` commit, the reverted subject). */
  description: string
  /** What the commit breaks, when it is marked as a breaking change. */
  breakingNote: string | undefined
}

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
  /** The commits made since the previous version, newest first (the order of `git log`). */
  commits: GitCommit[]
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
 * @throws If the URL is not an `https://github.com/` repository URL, which the compare and
 *   commit links of the changelog are built on.
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
 * Parse a commit the changelog can list: one whose subject follows Conventional Commits, or a
 * revert commit with the subject git gives it (`Revert "…"`).
 *
 * @param commit - The commit to parse.
 *
 * @returns The parsed commit, or `undefined` when its subject has another form (a merge commit,
 *   the release commit, …).
 */
const parseCommit = (commit: GitCommit): ListedCommit | undefined => {
  const revertedSubject = REGEX_REVERT_SUBJECT.exec(commit.subject)?.groups?.subject
  if (revertedSubject !== undefined) {
    return {
      hash: commit.hash,
      type: REVERT_TYPE,
      scope: undefined,
      description: revertedSubject,
      breakingNote: undefined,
    }
  }
  const groups = REGEX_COMMIT_SUBJECT.exec(commit.subject)?.groups
  if (groups === undefined) {
    return undefined
  }
  const description = groups.description.trim()
  // The note says what breaks; a `!` alone leaves the description as the only explanation.
  const note = REGEX_BREAKING_CHANGE_NOTE.exec(commit.body.replaceAll('\r\n', '\n'))?.groups?.note
  const markNote = groups.breakingMark === '!' ? description : undefined
  return {
    hash: commit.hash,
    type: groups.type,
    scope: groups.scope,
    description,
    breakingNote: note?.replaceAll(/\s*\n\s*/g, ' ').trim() ?? markNote,
  }
}

/**
 * Parse the commits the changelog can list, leaving out what was undone before the release: a
 * revert commit and the commit it reverts are both dropped when both are in the list. A revert
 * of a commit that is not in the list (it was released before) is kept.
 *
 * @param commits - The commits made since the previous version, newest first.
 *
 * @returns The commits to list.
 */
const parseCommits = (commits: GitCommit[]): ListedCommit[] => {
  const droppedHashes = new Set<string>()
  // Newest first, so that a revert which was itself reverted is dropped before it can drop
  // the commit it reverted.
  for (const commit of commits) {
    const revertedHash = REGEX_REVERTED_HASH.exec(commit.body)?.groups?.hash
    if (revertedHash === undefined || droppedHashes.has(commit.hash)) {
      continue
    }
    const revertedCommit = commits.find(
      (candidate) => candidate.hash.startsWith(revertedHash) && !droppedHashes.has(candidate.hash)
    )
    if (revertedCommit !== undefined) {
      droppedHashes.add(commit.hash).add(revertedCommit.hash)
    }
  }
  return commits
    .filter((commit) => !droppedHashes.has(commit.hash))
    .map((commit) => parseCommit(commit))
    .filter((commit) => commit !== undefined)
}

/**
 * Escape the characters of a commit's text that Markdown reads as emphasis (`*` and `_`), so
 * that `__proto__` is not rendered as a bold "proto". Code spans are left as they are.
 *
 * @param text - The text to escape.
 *
 * @returns The text, safe to write in a Markdown list item.
 */
const escapeEmphasis = (text: string): string =>
  text
    .split(REGEX_CODE_SPAN)
    // Splitting on a capturing group puts the code spans at the odd indexes.
    .map((part, index) => (index % 2 === 1 ? part : part.replaceAll(/[*_]/g, String.raw`\$&`)))
    .join('')

/**
 * Render one changelog list item for a commit.
 *
 * @param commit - The commit the item is about.
 * @param text - What the item says (the commit's description or its breaking change note).
 * @param repositoryUrl - The repository's web URL.
 *
 * @returns The list item: optional bold scope, the text, and a link to the commit.
 */
const renderCommitItem = (commit: ListedCommit, text: string, repositoryUrl: string): string =>
  `- ${commit.scope === undefined ? '' : `**${escapeEmphasis(commit.scope)}:** `}` +
  `${escapeEmphasis(text)} ` +
  `([${commit.hash.slice(0, 7)}](${repositoryUrl}/commit/${commit.hash}))`

/**
 * Order two commits of a changelog section: by scope (commits without a scope first), then by
 * description.
 *
 * @param first - The first commit.
 * @param second - The second commit.
 *
 * @returns A negative number, `0` or a positive number, as `Array.prototype.sort` expects.
 */
const compareCommits = (first: ListedCommit, second: ListedCommit): number => {
  const scopeOrder = (first.scope ?? '').localeCompare(second.scope ?? '')
  return scopeOrder === 0 ? first.description.localeCompare(second.description) : scopeOrder
}

/**
 * Count the commits marked as breaking changes (a `!` after the type or scope, or a
 * `BREAKING CHANGE:` note in the body), not counting those reverted since.
 *
 * @param commits - The commits made since the previous version, newest first.
 *
 * @returns The number of breaking commits.
 */
export const countBreakingCommits = (commits: GitCommit[]): number =>
  parseCommits(commits).filter((commit) => commit.breakingNote !== undefined).length

/**
 * Render the `CHANGELOG.md` entry of a release: a heading with the compare link and the date,
 * then one section per commit type that has commits (`fix`, `feat`, `perf` and reverts; other
 * types and commits that do not follow Conventional Commits are left out, and so are commits
 * reverted since), then the breaking changes.
 *
 * @param input - The release the entry describes.
 *
 * @returns The entry, ending with a line break. A release without listed commits is the
 *   heading alone.
 */
export const renderChangelogEntry = (input: ChangelogEntryInput): string => {
  const { version, previousVersion, date, repositoryUrl } = input
  const commits = parseCommits(input.commits).toSorted(compareCommits)

  const blocks = [
    `## [${version}](${repositoryUrl}/compare/v${previousVersion}...v${version}) (${date})`,
  ]
  for (const section of COMMIT_SECTIONS) {
    const items = commits
      .filter((commit) => commit.type === section.type)
      .map((commit) => renderCommitItem(commit, commit.description, repositoryUrl))
    if (items.length > 0) {
      blocks.push(`### ${section.title}`, items.join('\n'))
    }
  }
  const breakingItems: string[] = []
  for (const commit of commits) {
    if (commit.breakingNote !== undefined) {
      breakingItems.push(renderCommitItem(commit, commit.breakingNote, repositoryUrl))
    }
  }
  if (breakingItems.length > 0) {
    blocks.push(`### ${BREAKING_CHANGES_TITLE}`, breakingItems.join('\n'))
  }
  return `${blocks.join('\n\n')}\n`
}

/**
 * Find the headings of the version entries of a `CHANGELOG.md`. Lines inside fenced code
 * blocks are not headings, even when they look like one (a `# [section]` line in a
 * `.properties` example).
 *
 * @param lines - The lines of `CHANGELOG.md`.
 *
 * @returns The index of each version entry heading, in file order.
 */
const findVersionHeadings = (lines: string[]): number[] => {
  const headingIndexes: number[] = []
  let isInCodeBlock = false
  for (const [index, line] of lines.entries()) {
    if (REGEX_CODE_FENCE.test(line)) {
      isInCodeBlock = !isInCodeBlock
    } else if (!isInCodeBlock && REGEX_VERSION_HEADING.test(line)) {
      headingIndexes.push(index)
    }
  }
  return headingIndexes
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
  line.startsWith(`# [${version}]`) || line.startsWith(`## [${version}]`)

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
