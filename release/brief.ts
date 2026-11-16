/**
 * The brief of a release, run through `npm run release -- brief` (see ./cli.ts): what whoever
 * writes the release notes needs to read first. It lists the commits made since the last
 * release, builds the package and says which of its files differ from the version on npm, then
 * prints the release notes guidelines and the commands that come next.
 *
 * It is written for an AI agent as much as for a person: everything needed to decide whether
 * to release, and to write the notes, is in its output.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

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
  readPackageManifest,
  runCommand,
} from './workspace'

import type { Environment } from './workspace'

/**
 * The command that builds what `npm pack` packs. Not the full `npm run build` of a release:
 * the brief only needs the files of the package, not the checks.
 */
const PACKAGE_BUILD_COMMAND = ['npm', 'run', 'build-artifacts']

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
 * Print the brief of the next release. Nothing tracked by git is changed: the only files
 * written are the ones the build of the package writes.
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
  const publishedPackageSpec =
    options.publishedPackageSpec ?? `${manifest.name}@${manifest.version}`

  log(`# Release brief: ${manifest.name}, currently at ${manifest.version}`)

  if (hasLocalTag(workspace, previousTag)) {
    const commits = readCommitsSince(workspace, previousTag)
    log(
      [
        '',
        `## Commits since ${previousTag} (${String(commits.length)})`,
        '',
        ...(commits.length === 0
          ? ['None.']
          : commits.map((commit) => `- ${commit.hash.slice(0, 7)} ${commit.subject}`)),
        '',
        'These are raw material, not release notes: a commit message can be inaccurate, and',
        'most commits change nothing for users. Read a commit with `git show <hash>`.',
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
      `(The package as \`${PACKAGE_BUILD_COMMAND.join(' ')}\` builds it from this checkout.)\n`
  )
  const [buildCommand, ...buildArguments] = PACKAGE_BUILD_COMMAND
  // The output of the build is not part of the brief: it is only shown if the build fails.
  const build = runCommand(workspace, buildCommand, buildArguments)
  if (!build.isSuccess) {
    throw new Error(`🚨 ${build.failure}`)
  }
  const comparison = compareWithPublishedPackage(workspace, publishedPackageSpec)
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
        'A difference is what makes a release possible, not what makes it worth making: see',
        'the guidelines.',
      ].join('\n')
    )
  }

  log(`\n## Guidelines (${GUIDELINES_PATH})\n`)
  log(readFileSync(path.join(directoryPath, GUIDELINES_PATH), 'utf8').trimEnd())
}
