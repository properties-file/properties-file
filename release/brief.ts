/**
 * The brief of a release, run through `npm run release -- brief` (see ./cli.ts): what whoever
 * writes the release notes needs to read first. It lists the commits made since the last
 * release, those that change the source of the package apart from the others; builds the
 * package and says which of its files differ from the version on npm, leaving both where they
 * can be compared; then prints the release notes guidelines, which end with the steps of a
 * release.
 *
 * It is written for an AI agent as much as for a person: what is needed to decide whether to
 * release and to write the notes is in its output, or one command it gives away.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readNotesRules } from './notes-rules'
import {
  compareWithPublishedPackage,
  describePackageDifference,
  isSamePackage,
} from './package-diff'
import { GUIDELINES_PATH } from './release'
import {
  createWorkspace,
  hasLocalTag,
  readCommitsSince,
  readGit,
  readPackageManifest,
  runCommand,
} from './workspace'

import type { Environment, GitCommit } from './workspace'

/**
 * The command that builds what `npm pack` packs. Not the full `npm run build` of a release:
 * the brief only needs the files of the package, not the checks.
 */
const PACKAGE_BUILD_COMMAND = ['npm', 'run', 'build-artifacts']

/**
 * Where the source of the package is, as git pathspecs: `src/`, without the scripts that build
 * the package. A commit that changes nothing there cannot change what the package does.
 */
const SOURCE_PATHSPECS = ['src', ':(exclude)src/build-scripts']

/** The options of {@link brief}. */
export type BriefOptions = {
  /** The root directory of the repository. */
  directoryPath: string
  /** The environment variables the commands of the brief run with. */
  environment: Environment
  /** Receives every line the brief reports. */
  log: (message: string) => void
  /**
   * What `npm pack` fetches as the version that is already published, to compare the package
   * with it. The current version on the registry (`<name>@<version>`) when left out.
   */
  publishedPackageSpec?: string
}

/**
 * List commits, one per line.
 *
 * @param commits - What to list, in the order to list it.
 *
 * @returns The lines: the abbreviated hash and the subject of each commit, or `None.`.
 */
const listCommits = (commits: GitCommit[]): string[] =>
  commits.length === 0
    ? ['None.']
    : commits.map(
        // A control character in a subject (an escape sequence, a stray separator) is not
        // printed.
        (commit) => `- ${commit.hash.slice(0, 7)} ${commit.subject.replaceAll(/\p{Cc}/gu, ' ')}`
      )

/**
 * Print the brief of the next release. Nothing tracked by git is changed: the only files
 * written are the ones the build of the package writes, and the two packages that are
 * compared, in a temporary directory.
 *
 * @param options - Where to look and how to report.
 *
 * @throws If the package cannot be built or packed, or if the guidelines cannot be read.
 */
export const brief = (options: BriefOptions): void => {
  const { directoryPath, log } = options
  const workspace = createWorkspace(directoryPath, options.environment)
  const manifest = readPackageManifest(directoryPath)
  const previousTag = `v${manifest.version}`
  // Rules of the notes that cannot be read are better known now than when the notes are
  // written.
  readNotesRules(directoryPath)
  const publishedPackageSpec =
    options.publishedPackageSpec ?? `${manifest.name}@${manifest.version}`

  log(`# Release brief: ${manifest.name}, currently at ${manifest.version}`)

  const changes = readGit(workspace, ['status', '--porcelain', '--untracked-files=normal'])
  if (changes !== '') {
    log(
      '\n⚠️  The working tree has uncommitted changes. The package below is built from the ' +
        `working tree, not from the last commit, and a release would refuse to start:\n${changes}`
    )
  }

  if (hasLocalTag(workspace, previousTag)) {
    const sourceCommits = readCommitsSince(workspace, previousTag, SOURCE_PATHSPECS)
    const sourceHashes = new Set(sourceCommits.map((commit) => commit.hash))
    const otherCommits = readCommitsSince(workspace, previousTag).filter(
      (commit) => !sourceHashes.has(commit.hash)
    )
    const sourceDiffCommand = `git diff ${previousTag} -- ${SOURCE_PATHSPECS.map((pathspec) => `'${pathspec}'`).join(' ')}`
    log(
      [
        '',
        `## Commits since ${previousTag} that change the source of the package (${String(sourceCommits.length)})`,
        '',
        ...listCommits(sourceCommits),
        '',
        `What they changed, all together: \`${sourceDiffCommand}\`. One commit: \`git show <hash>\`.`,
        'A commit message is raw material, not a release note: it can be inaccurate, and its',
        'type (`fix`, `build`, `docs`…) does not say whether users are affected.',
        '',
        `## Other commits since ${previousTag} (${String(otherCommits.length)})`,
        '',
        ...listCommits(otherCommits),
        '',
        'These change the build, tests, tooling, documentation or dependencies. The two lists',
        'are split by path, not by what users see: one of these commits matters to users when',
        'it changes the files of the package, listed below. A build script can add or change',
        'a published file without touching the source.',
      ].join('\n')
    )
  } else {
    log(
      `\n⚠️  The tag of the current version (${previousTag}) does not exist locally (try ` +
        '`git fetch --tags`), so the commits made since cannot be listed.'
    )
  }

  log(
    `\n## Files of the package that differ from ${publishedPackageSpec}\n\n` +
      `(The package as \`${PACKAGE_BUILD_COMMAND.join(' ')}\` builds it from this checkout. Line ` +
      'endings are not compared; of `package.json`, neither are the version, the development ' +
      'dependencies and the scripts that do not run at install.)\n'
  )
  const [buildCommand, ...buildArguments] = PACKAGE_BUILD_COMMAND
  // The output of the build is not part of the brief: it is only shown if the build fails.
  const build = runCommand(workspace, buildCommand, buildArguments)
  if (!build.isSuccess) {
    throw new Error(`🚨 ${build.failure}`)
  }
  const keptPath = mkdtempSync(path.join(tmpdir(), 'release-brief-'))
  const comparison = compareWithPublishedPackage(workspace, publishedPackageSpec, keptPath)
  if (comparison.difference === undefined) {
    log(
      `⚠️  ${publishedPackageSpec} could not be fetched, so the package was not compared with ` +
        `it (${comparison.failure}).`
    )
  } else if (isSamePackage(comparison.difference)) {
    log(
      'None: the package is the same as the published one. There is nothing to release, and ' +
        '`npm run release` would refuse to.'
    )
  } else {
    log(
      [
        ...describePackageDifference(comparison.difference).map((line) => `- ${line}`),
        '',
        `Both packages are in ${keptPath} (a temporary directory), under \`published\` and`,
        '`current`. To see how a file differs (without its line endings; for `package.json`, the fields that were not compared show too):',
        `\`diff -u --strip-trailing-cr ${path.join(keptPath, 'published')}/<file> ${path.join(keptPath, 'current')}/<file>\``,
        'Each of the two can be loaded by its path, to run both versions side by side (this loads its main entry; for another one, give the path of its file):',
        `\`node -p "require('${path.join(keptPath, 'published')}')"\` and the same with \`current\`.`,
        '',
        'A difference is what makes a release possible, not what makes it worth making: see',
        'the guidelines.',
      ].join('\n')
    )
  }

  log(`\n## Guidelines (${GUIDELINES_PATH})\n`)
  log(readFileSync(path.join(directoryPath, GUIDELINES_PATH), 'utf8').trimEnd())
}
