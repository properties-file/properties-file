/**
 * The local half of the release flow, run through `npm run release` (see ./cli.ts): it checks
 * that the checkout is releasable, runs the build, bumps the version, writes the changelog
 * entry, then commits, tags and pushes. Pushing the tag starts the other half,
 * `.github/workflows/release.yml`, which publishes to npm and creates the GitHub release.
 *
 * It only needs `git` and `npm` (plus the repository's own `prettier`), is not interactive, and
 * with `--dry-run` goes through the same steps while changing nothing.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { isNormalizedError, noThrow } from '../utilities/no-throw'

import {
  countBreakingCommits,
  getRepositoryUrl,
  insertChangelogEntry,
  renderChangelogEntry,
  resolveNextVersion,
} from './changelog'

import type { GitCommit } from './changelog'

/** The only branch releases are made from. */
const RELEASE_BRANCH = 'main'

/** The git remote releases are pushed to. */
const REMOTE = 'origin'

/** The files a release changes, which are committed together. */
const RELEASE_FILES = ['CHANGELOG.md', 'package.json', 'package-lock.json']

/** Separates the fields of one commit in the `git log` output (ASCII unit separator). */
const FIELD_SEPARATOR = String.fromCodePoint(0x1f)

/** Separates the commits in the `git log` output (ASCII record separator). */
const RECORD_SEPARATOR = String.fromCodePoint(0x1e)

/** How to call the release script, shown when its arguments are not usable. */
const USAGE = 'Usage: npm run release -- <major | minor | patch | x.y.z> [--dry-run]'

/** What `npm run release` was asked to do. */
export type ReleaseArguments = {
  /** `major`, `minor`, `patch`, or an explicit version. */
  request: string
  /** Whether to go through the steps without changing anything. */
  isDryRun: boolean
}

/** The options of {@link release}. */
export type ReleaseOptions = ReleaseArguments & {
  /** The root directory of the repository to release. */
  directoryPath: string
  /** The release date, written to the changelog as a UTC `YYYY-MM-DD` date. */
  date: Date
  /** Whether the commands that change something print their output as they run. */
  shouldStreamOutput: boolean
  /** Receives every line the release reports. */
  log: (message: string) => void
}

/** The outcome of a command. */
type CommandResult = {
  /** Whether the command ran and exited with code 0. */
  isSuccess: boolean
  /** What the command printed to its standard output, unless it was streamed. */
  output: string
  /** Why the command failed, when it did. */
  failure: string
}

/**
 * Parse the arguments of `npm run release`.
 *
 * @param commandArguments - The command line arguments, without the executable and script.
 *
 * @returns The parsed arguments.
 *
 * @throws If there is an unknown option, or not exactly one version argument.
 */
export const parseReleaseArguments = (commandArguments: string[]): ReleaseArguments => {
  const options = commandArguments.filter((argument) => argument.startsWith('-'))
  const requests = commandArguments.filter((argument) => !argument.startsWith('-'))
  const unknownOption = options.find((option) => option !== '--dry-run')
  if (unknownOption !== undefined) {
    throw new Error(`🚨 unknown option "${unknownOption}"\n${USAGE}`)
  }
  if (requests.length !== 1) {
    throw new Error(`🚨 expected exactly one version argument\n${USAGE}`)
  }
  return { request: requests[0], isDryRun: options.includes('--dry-run') }
}

/**
 * Write a command the way it would be typed in a shell, for messages.
 *
 * @param command - The executable.
 * @param commandArguments - Its arguments.
 *
 * @returns The command line, with double quotes around the arguments that contain a space.
 */
const formatCommand = (command: string, commandArguments: string[]): string =>
  [command, ...commandArguments].map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ')

/**
 * Run a command and wait for it.
 *
 * @param directoryPath - The directory to run the command in.
 * @param command - The executable.
 * @param commandArguments - Its arguments (passed as-is, without a shell).
 * @param shouldStreamOutput - Whether the command prints to the terminal instead of having its
 *   output captured.
 *
 * @returns The outcome of the command.
 */
const runCommand = (
  directoryPath: string,
  command: string,
  commandArguments: string[],
  shouldStreamOutput = false
): CommandResult => {
  const outputMode = shouldStreamOutput ? 'inherit' : 'pipe'
  const result = spawnSync(command, commandArguments, {
    cwd: directoryPath,
    encoding: 'utf8',
    stdio: ['ignore', outputMode, outputMode],
  })
  const isSuccess = result.error === undefined && result.status === 0
  // Streamed output is not captured: `stdout` and `stderr` are `null` then, despite their types.
  const [output, errorOutput] = shouldStreamOutput ? ['', ''] : [result.stdout, result.stderr]
  return {
    isSuccess,
    // Only the end: the leading space of `git status --porcelain` lines is meaningful.
    output: output.trimEnd(),
    failure: isSuccess
      ? ''
      : [
          `\`${formatCommand(command, commandArguments)}\` failed`,
          result.error?.message ?? errorOutput.trim(),
        ]
          .filter((part) => part !== '')
          .join(': '),
  }
}

/**
 * Run a read-only git command that is expected to succeed, and get its output.
 *
 * @param directoryPath - The directory to run the command in.
 * @param gitArguments - What to pass to `git` (subcommand, options, …).
 *
 * @returns What the command printed, without trailing whitespace.
 *
 * @throws If the command fails.
 */
const readGit = (directoryPath: string, gitArguments: string[]): string => {
  const result = runCommand(directoryPath, 'git', gitArguments)
  if (!result.isSuccess) {
    throw new Error(`🚨 ${result.failure}`)
  }
  return result.output
}

/**
 * Read the version and the repository URL from `package.json`.
 *
 * @param directoryPath - The root directory of the repository.
 *
 * @returns The current version and the `repository.url` value.
 *
 * @throws If `package.json` does not have both as strings.
 */
const readPackageManifest = (
  directoryPath: string
): { version: string; packageRepositoryUrl: string } => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(directoryPath, 'package.json'), 'utf8')
  )
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string' ||
    !('repository' in manifest) ||
    typeof manifest.repository !== 'object' ||
    manifest.repository === null ||
    !('url' in manifest.repository) ||
    typeof manifest.repository.url !== 'string'
  ) {
    throw new Error('🚨 package.json must have a "version" and a "repository.url"')
  }
  return { version: manifest.version, packageRepositoryUrl: manifest.repository.url }
}

/**
 * Check whether a tag exists in the local repository.
 *
 * @param directoryPath - The root directory of the repository.
 * @param tag - The tag name.
 *
 * @returns `true` if the tag exists locally.
 */
const hasLocalTag = (directoryPath: string, tag: string): boolean =>
  runCommand(directoryPath, 'git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`])
    .isSuccess

/**
 * List what stands in the way of a release: the checkout must be on the release branch, clean
 * and at the tip of the remote branch, and the new tag must not exist anywhere yet. The remote
 * is read with `git ls-remote`, so nothing is fetched and the local repository is not changed.
 *
 * @param directoryPath - The root directory of the repository.
 * @param tag - The tag of the version to release.
 *
 * @returns One line per problem (empty when the release can go ahead).
 */
const getPreflightProblems = (directoryPath: string, tag: string): string[] => {
  const problems: string[] = []

  const branch = readGit(directoryPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== RELEASE_BRANCH) {
    problems.push(`the current branch is "${branch}", releases are made from "${RELEASE_BRANCH}"`)
  }

  if (readGit(directoryPath, ['status', '--porcelain']) !== '') {
    problems.push('the working tree has uncommitted changes')
  }

  if (hasLocalTag(directoryPath, tag)) {
    problems.push(`the tag ${tag} already exists locally`)
  }

  const branchReference = `refs/heads/${RELEASE_BRANCH}`
  const tagReference = `refs/tags/${tag}`
  const remote = runCommand(directoryPath, 'git', [
    'ls-remote',
    REMOTE,
    branchReference,
    tagReference,
  ])
  if (!remote.isSuccess) {
    return [...problems, `the remote "${REMOTE}" could not be read (${remote.failure})`]
  }
  // One `<hash>\t<reference>` line per reference that exists on the remote.
  const remoteHashes = new Map(
    remote.output
      .split('\n')
      .filter((line) => line !== '')
      .map((line): [string, string] => {
        const [hash, reference] = line.split('\t', 2)
        return [reference, hash]
      })
  )
  const head = readGit(directoryPath, ['rev-parse', 'HEAD'])
  if (remoteHashes.get(branchReference) !== head) {
    problems.push(`HEAD is not the tip of ${REMOTE}/${RELEASE_BRANCH} (pull or push first)`)
  }
  if (remoteHashes.has(tagReference)) {
    problems.push(`the tag ${tag} already exists on "${REMOTE}"`)
  }
  return problems
}

/**
 * Read the commits made since a tag, newest first, without merge commits.
 *
 * @param directoryPath - The root directory of the repository.
 * @param tag - The tag to start after.
 *
 * @returns The commits between the tag and `HEAD`.
 */
const readCommitsSince = (directoryPath: string, tag: string): GitCommit[] =>
  readGit(directoryPath, [
    'log',
    '--no-merges',
    '--format=%H%x1f%s%x1f%b%x1e',
    `refs/tags/${tag}..HEAD`,
  ])
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [hash, subject, body] = record.split(FIELD_SEPARATOR)
      return { hash, subject, body }
    })

/**
 * Release a new version: check the checkout, build, bump the version, write the changelog
 * entry, commit, tag and push. In a dry run the same steps are reported and nothing is changed
 * (no file, no git object, no reference, locally or on the remote); problems that would stop a
 * real release are reported as warnings so the remaining steps can still be previewed.
 *
 * @param options - What to release and how.
 *
 * @returns The released version.
 *
 * @throws If the release cannot be made. Before the release commit exists, the files the
 *   release changed are restored; after it, the error says how to retry or undo.
 */
export const release = (options: ReleaseOptions): string => {
  const { directoryPath, isDryRun, log } = options

  /**
   * Run one of the commands that change something, or only report it in a dry run.
   *
   * @param command - The executable.
   * @param commandArguments - Its arguments.
   *
   * @throws If the command fails.
   */
  const execute = (command: string, commandArguments: string[]): void => {
    log(
      `   ${isDryRun ? '⏭️  would run' : '🏃 running'}: ${formatCommand(command, commandArguments)}`
    )
    if (isDryRun) {
      return
    }
    const result = runCommand(directoryPath, command, commandArguments, options.shouldStreamOutput)
    if (!result.isSuccess) {
      throw new Error(`🚨 ${result.failure}`)
    }
  }

  const { version: currentVersion, packageRepositoryUrl } = readPackageManifest(directoryPath)
  const repositoryUrl = getRepositoryUrl(packageRepositoryUrl)
  const version = resolveNextVersion(currentVersion, options.request)
  const tag = `v${version}`
  const previousTag = `v${currentVersion}`
  log(
    `📦 Releasing ${currentVersion} → ${version}${isDryRun ? ' (dry run: nothing is changed)' : ''}`
  )

  // The changelog entry lists the commits made since the previous release's tag.
  if (!hasLocalTag(directoryPath, previousTag)) {
    throw new Error(
      `🚨 the tag of the current version (${previousTag}) does not exist locally (try \`git fetch --tags\`)`
    )
  }

  const problems = getPreflightProblems(directoryPath, tag)
  if (problems.length > 0) {
    const list = problems.map((problem) => `   - ${problem}`).join('\n')
    if (!isDryRun) {
      throw new Error(`🚨 cannot release:\n${list}`)
    }
    log(`⚠️  A real release would stop here:\n${list}`)
  }

  const commits = readCommitsSince(directoryPath, previousTag)
  const breakingCommitCount = countBreakingCommits(commits)
  if (breakingCommitCount > 0 && !version.endsWith('.0.0')) {
    log(
      `⚠️  ${String(breakingCommitCount)} commit(s) since ${previousTag} are marked as breaking ` +
        `changes, but ${version} is not a major version`
    )
  }
  const entry = renderChangelogEntry({
    version,
    previousVersion: currentVersion,
    date: options.date.toISOString().slice(0, 10),
    repositoryUrl,
    commits,
  })
  const changelogPath = path.join(directoryPath, 'CHANGELOG.md')
  // Computed before anything is changed: this fails if the version already has an entry.
  const changelog = insertChangelogEntry(readFileSync(changelogPath, 'utf8'), version, entry)

  // The full gate (lint, compile, tests, package checks), before anything is committed.
  execute('npm', ['run', 'build'])
  if (!isDryRun) {
    // The build formats files and rewrites the README size badge; a release must not carry
    // such changes along, nor leave them behind.
    const changes = readGit(directoryPath, ['status', '--porcelain'])
    if (changes !== '') {
      throw new Error(`🚨 \`npm run build\` changed files, commit them first:\n${changes}`)
    }
  }

  const committed = noThrow(() => {
    execute('npm', ['version', version, '--no-git-tag-version'])
    log(`   ${isDryRun ? '⏭️  would add' : '📝 adding'} to CHANGELOG.md:\n\n${entry}`)
    if (!isDryRun) {
      writeFileSync(changelogPath, changelog)
    }
    execute('npx', ['--no-install', 'prettier', '--write', 'CHANGELOG.md'])
    execute('git', ['add', ...RELEASE_FILES])
    // The pre-commit hook is the build, which just ran on this exact tree.
    execute('git', ['commit', '--no-verify', '--message', `🔖 release ${tag}`])
  })
  if (isNormalizedError(committed)) {
    // The tree was clean before these steps, so restoring the release files loses nothing.
    const restored = runCommand(directoryPath, 'git', ['checkout', 'HEAD', '--', ...RELEASE_FILES])
    throw new Error(
      `${committed.message}\n   ${
        restored.isSuccess
          ? `↩️  ${RELEASE_FILES.join(', ')} were restored, nothing was committed.`
          : `⚠️  ${RELEASE_FILES.join(', ')} could not be restored (${restored.failure}).`
      }`
    )
  }

  const pushReferences = [`refs/heads/${RELEASE_BRANCH}`, `refs/tags/${tag}`]
  const pushed = noThrow(() => {
    execute('git', ['tag', '--annotate', tag, '--message', `Release ${version}`])
    // Atomic: the branch and the tag are both accepted, or neither is.
    execute('git', ['push', '--atomic', REMOTE, ...pushReferences])
  })
  if (isNormalizedError(pushed)) {
    throw new Error(
      [
        pushed.message,
        `   The release commit exists locally. Check what reached "${REMOTE}" with:`,
        `     git ls-remote ${REMOTE} ${pushReferences.join(' ')}`,
        `   To retry (create the tag first if \`git tag --list ${tag}\` prints nothing):`,
        `     git tag --annotate ${tag} --message "Release ${version}"`,
        `     git push --atomic ${REMOTE} ${pushReferences.join(' ')}`,
        '   To undo, if nothing was pushed:',
        `     git tag --delete ${tag}`,
        '     git reset --hard HEAD~1',
      ].join('\n')
    )
  }

  log(
    isDryRun
      ? `✅ Dry run of ${tag} complete, nothing was changed.`
      : `✅ ${tag} is pushed. The release workflow now tests it, publishes it to npm and creates ` +
          `the GitHub release: ${repositoryUrl}/actions/workflows/release.yml`
  )
  return version
}
