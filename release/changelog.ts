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
 * Matches a breaking change footer in a commit body, capturing its paragraph (up to the next
 * blank line).
 */
const REGEX_BREAKING_CHANGE_FOOTER = /^BREAKING[ -]CHANGE: (?<note>.+(?:\n.+)*)/m

/** Matches the heading of any version entry in `CHANGELOG.md` (`# [1.0.0](…)`, `## [1.0.1](…)`). */
const REGEX_VERSION_HEADING = /^#{1,2} \[/

/** Matches the first version entry heading of a whole `CHANGELOG.md`. */
const REGEX_FIRST_VERSION_HEADING = /^#{1,2} \[/m

/** Matches the compare link of a version entry heading, capturing its URL and its tag range. */
const REGEX_COMPARE_LINK = /\]\((?<url>[^()\s]+\/compare\/(?<range>[^()\s/]+))\)/

/** The changelog sections built from commit types, in the order they are written. */
const COMMIT_SECTIONS = [
  { type: 'fix', title: 'Bug Fixes' },
  { type: 'feat', title: 'Features' },
  { type: 'perf', title: 'Performance Improvements' },
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

/** A commit whose subject follows Conventional Commits. */
type ConventionalCommit = {
  /** The full commit hash. */
  hash: string
  /** The commit type (`feat`, `fix`, …). */
  type: string
  /** The scope between parentheses, when there is one. */
  scope: string | undefined
  /** The description after the colon. */
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
  /** The commits made since the previous version. */
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
 * Parse a commit whose subject follows Conventional Commits.
 *
 * @param commit - The commit to parse.
 *
 * @returns The parsed commit, or `undefined` when its subject has another form (a merge commit,
 *   the release commit, …).
 */
const parseCommit = (commit: GitCommit): ConventionalCommit | undefined => {
  const groups = REGEX_COMMIT_SUBJECT.exec(commit.subject)?.groups
  if (groups === undefined) {
    return undefined
  }
  // The footer says what breaks; a `!` alone leaves the description as the only explanation.
  const footerNote = REGEX_BREAKING_CHANGE_FOOTER.exec(commit.body)?.groups?.note
  const markNote = groups.breakingMark === '!' ? groups.description : undefined
  return {
    hash: commit.hash,
    type: groups.type,
    scope: groups.scope,
    description: groups.description,
    breakingNote: footerNote?.replaceAll(/\s*\n\s*/g, ' ').trim() ?? markNote,
  }
}

/**
 * Render one changelog list item for a commit.
 *
 * @param commit - The commit the item is about.
 * @param text - What the item says (the commit's description or its breaking change note).
 * @param repositoryUrl - The repository's web URL.
 *
 * @returns The list item: optional bold scope, the text, and a link to the commit.
 */
const renderCommitItem = (
  commit: ConventionalCommit,
  text: string,
  repositoryUrl: string
): string =>
  `- ${commit.scope === undefined ? '' : `**${commit.scope}:** `}${text} ` +
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
const compareCommits = (first: ConventionalCommit, second: ConventionalCommit): number => {
  const scopeOrder = (first.scope ?? '').localeCompare(second.scope ?? '')
  return scopeOrder === 0 ? first.description.localeCompare(second.description) : scopeOrder
}

/**
 * Count the commits marked as breaking changes (a `!` after the type or scope, or a
 * `BREAKING CHANGE:` footer).
 *
 * @param commits - The commits to look at.
 *
 * @returns The number of breaking commits.
 */
export const countBreakingCommits = (commits: GitCommit[]): number =>
  commits.filter((commit) => parseCommit(commit)?.breakingNote !== undefined).length

/**
 * Render the `CHANGELOG.md` entry of a release: a heading with the compare link and the date,
 * then one section per commit type that has commits (`fix`, `feat` and `perf`; other types
 * and commits that do not follow Conventional Commits are left out), then the breaking changes.
 *
 * @param input - The release the entry describes.
 *
 * @returns The entry, ending with a line break. A release without listed commits is the
 *   heading alone.
 */
export const renderChangelogEntry = (input: ChangelogEntryInput): string => {
  const { version, previousVersion, date, repositoryUrl } = input
  const commits = input.commits
    .map((commit) => parseCommit(commit))
    .filter((commit) => commit !== undefined)
    .toSorted(compareCommits)

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
  if (changelog.split(/\r?\n/).some((line) => isHeadingOfVersion(line, version))) {
    throw new Error(`🚨 CHANGELOG.md already has an entry for version ${version}`)
  }
  const position = changelog.search(REGEX_FIRST_VERSION_HEADING)
  return position === -1
    ? `${changelog.trimEnd()}\n\n${entry}`
    : `${changelog.slice(0, position)}${entry}\n${changelog.slice(position)}`
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
  const headingIndex = lines.findIndex((line) => isHeadingOfVersion(line, version))
  if (headingIndex === -1) {
    throw new Error(`🚨 CHANGELOG.md has no entry for version ${version}`)
  }
  const nextHeadingIndex = lines.findIndex(
    (line, index) => index > headingIndex && REGEX_VERSION_HEADING.test(line)
  )
  const blocks = [
    lines
      .slice(headingIndex + 1, nextHeadingIndex === -1 ? lines.length : nextHeadingIndex)
      .join('\n')
      .trim(),
  ]
  const compareLink = REGEX_COMPARE_LINK.exec(lines[headingIndex])?.groups
  if (compareLink !== undefined) {
    blocks.push(`**Full changelog**: [${compareLink.range}](${compareLink.url})`)
  }
  return `${blocks.filter((block) => block !== '').join('\n\n')}\n`
}
