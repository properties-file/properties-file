/**
 * The local half of the release flow, run through `npm run release` (see ./cli.ts): it checks
 * that the checkout is releasable, runs the build, bumps the version, writes the changelog
 * entry, then commits, tags and pushes. Pushing the tag starts the other half,
 * `.github/workflows/release.yml`, which publishes to npm and creates the GitHub release.
 *
 * The only commands it runs are `git`, `npm` and the repository's own `prettier`, and it asks
 * no question (git itself may still ask for credentials or a signing passphrase). Without
 * `--confirm` it is a dry run: it goes through the same steps while changing nothing.
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

/** The option that makes a release real. */
const CONFIRM_OPTION = '--confirm'

/** The option that asks for what is already the default, a dry run. */
const DRY_RUN_OPTION = '--dry-run'

/**
 * The variables npm sets when it is given `--dry-run` itself, or the likely typo `--dryrun`
 * (not an option of npm, which passes it on the same way). Without a `--` before the script's
 * arguments, that is where these options end up.
 */
const NPM_DRY_RUN_VARIABLES = ['npm_config_dry_run', 'npm_config_dryrun']

/** The variable npm sets when it is given `--confirm` itself, for want of a `--` before it. */
const NPM_CONFIRM_VARIABLE = 'npm_config_confirm'

/**
 * The variables git sets for the hooks it runs, pointing git at the repository and the index
 * of the operation in progress. The commands of a release must not inherit them: run from a
 * hook, as the tests of the release are by this repository's pre-commit hook, they would act
 * on the index of the commit being made instead of the one of the repository to release.
 */
const GIT_HOOK_VARIABLES = new Set(['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_WORK_TREE'])

/** How to call the release script, shown when its arguments are not usable. */
const USAGE = `Usage: npm run release -- <major | minor | patch | x.y.z> [${CONFIRM_OPTION}]`

/** Environment variables, as in `process.env`. */
type Environment = Record<string, string | undefined>

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
  /** The environment variables the commands of the release run with. */
  environment: Environment
  /** The release date, written to the changelog as a UTC `YYYY-MM-DD` date. */
  date: Date
  /** Whether the commands that change something print their output as they run. */
  shouldStreamOutput: boolean
  /** Receives every line the release reports. */
  log: (message: string) => void
}

/** Where the commands of a release run. */
type Workspace = {
  /** The root directory of the repository to release. */
  directoryPath: string
  /** The environment variables the commands run with. */
  environment: Environment
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
 * List the variables through which npm says that it was asked for a dry run.
 *
 * @param environment - The environment variables of the process.
 *
 * @returns The names of the {@link NPM_DRY_RUN_VARIABLES} that are set to anything but an
 *   empty string or `false`.
 */
const getNpmDryRunVariables = (environment: Environment): string[] =>
  NPM_DRY_RUN_VARIABLES.filter((name) => ![undefined, '', 'false'].includes(environment[name]))

/**
 * Parse the arguments of `npm run release`.
 *
 * A release is only real with `--confirm`: anything else is a dry run. This is what keeps a
 * mistyped command from releasing. npm keeps for itself every option written without a `--`
 * before the script's arguments (`npm run release patch --confirm`), so the script never
 * sees it and falls back to the dry run. If npm was itself asked for a dry run (see
 * {@link NPM_DRY_RUN_VARIABLES}), the release is a dry run whatever the script was given.
 *
 * @param commandArguments - The command line arguments, without the executable and script.
 * @param environment - The environment variables of the process.
 *
 * @returns The parsed arguments.
 *
 * @throws If there is an unknown option, both options at once, or not exactly one version
 *   argument.
 */
export const parseReleaseArguments = (
  commandArguments: string[],
  environment: Environment
): ReleaseArguments => {
  const options = commandArguments.filter((argument) => argument.startsWith('-'))
  const requests = commandArguments.filter((argument) => !argument.startsWith('-'))
  const unknownOption = options.find(
    (option) => option !== CONFIRM_OPTION && option !== DRY_RUN_OPTION
  )
  if (unknownOption !== undefined) {
    throw new Error(`🚨 unknown option "${unknownOption}"\n${USAGE}`)
  }
  if (options.includes(CONFIRM_OPTION) && options.includes(DRY_RUN_OPTION)) {
    throw new Error(`🚨 ${CONFIRM_OPTION} and ${DRY_RUN_OPTION} cannot be used together\n${USAGE}`)
  }
  if (requests.length !== 1) {
    throw new Error(`🚨 expected exactly one version argument\n${USAGE}`)
  }
  return {
    request: requests[0],
    isDryRun: !options.includes(CONFIRM_OPTION) || getNpmDryRunVariables(environment).length > 0,
  }
}

/**
 * Explain a dry run that the person releasing may not have meant: npm kept `--confirm` for
 * itself, or was asked for a dry run while the script was given `--confirm`.
 *
 * @param commandArguments - The command line arguments, without the executable and script.
 * @param environment - The environment variables of the process.
 *
 * @returns What to tell the person releasing, or `undefined` when there is nothing to explain.
 */
export const explainDryRun = (
  commandArguments: string[],
  environment: Environment
): string | undefined => {
  if (commandArguments.includes(CONFIRM_OPTION)) {
    const variables = getNpmDryRunVariables(environment)
    return variables.length > 0
      ? `⚠️  ${CONFIRM_OPTION} was given, but npm was asked for a dry run ` +
          `(${variables.join(', ')}).`
      : undefined
  }
  return environment[NPM_CONFIRM_VARIABLE] === undefined
    ? undefined
    : `⚠️  npm kept ${CONFIRM_OPTION} for itself: write it after a \`--\` (${USAGE.slice('Usage: '.length)}).`
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
 * @param workspace - Where to run the command.
 * @param command - The executable.
 * @param commandArguments - Its arguments (passed as-is, without a shell).
 * @param shouldStreamOutput - Whether the command prints to the terminal instead of having its
 *   output captured.
 *
 * @returns The outcome of the command.
 */
const runCommand = (
  workspace: Workspace,
  command: string,
  commandArguments: string[],
  shouldStreamOutput = false
): CommandResult => {
  const outputMode = shouldStreamOutput ? 'inherit' : 'pipe'
  const result = spawnSync(command, commandArguments, {
    cwd: workspace.directoryPath,
    env: workspace.environment,
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
 * @param workspace - Where to run the command.
 * @param gitArguments - What to pass to `git` (subcommand, options, …).
 *
 * @returns What the command printed, without trailing whitespace.
 *
 * @throws If the command fails.
 */
const readGit = (workspace: Workspace, gitArguments: string[]): string => {
  const result = runCommand(workspace, 'git', gitArguments)
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
 * @param workspace - The repository.
 * @param tag - The tag name.
 *
 * @returns `true` if the tag exists locally.
 */
const hasLocalTag = (workspace: Workspace, tag: string): boolean =>
  runCommand(workspace, 'git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`]).isSuccess

/**
 * List the changed and the untracked files of the working tree. Untracked files are always
 * listed, whatever the `status.showUntrackedFiles` setting of the person releasing.
 *
 * @param workspace - The repository.
 *
 * @returns The output of `git status --porcelain` (empty when the working tree is clean).
 */
const readWorkingTreeChanges = (workspace: Workspace): string =>
  readGit(workspace, ['status', '--porcelain', '--untracked-files=normal'])

/**
 * List what stands in the way of a release: the checkout must be on the release branch, clean
 * and at the tip of the remote branch, the tag of the current version must be part of its
 * history, and the new tag must not exist anywhere yet. The remote is read with
 * `git ls-remote` at the URL the release is pushed to, so nothing is fetched and the local
 * repository is not changed.
 *
 * @param workspace - The repository.
 * @param tag - The tag of the version to release.
 * @param previousTag - The tag of the current version.
 *
 * @returns One line per problem (empty when the release can go ahead).
 */
const getPreflightProblems = (workspace: Workspace, tag: string, previousTag: string): string[] => {
  const problems: string[] = []

  const branch = readGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== RELEASE_BRANCH) {
    problems.push(`the current branch is "${branch}", releases are made from "${RELEASE_BRANCH}"`)
  }

  if (readWorkingTreeChanges(workspace) !== '') {
    problems.push('the working tree has uncommitted changes')
  }

  // The changelog entry lists the commits made since that tag: if the tag is not in the
  // history of HEAD, it would also list commits the current version already has.
  if (
    hasLocalTag(workspace, previousTag) &&
    !runCommand(workspace, 'git', [
      'merge-base',
      '--is-ancestor',
      `refs/tags/${previousTag}`,
      'HEAD',
    ]).isSuccess
  ) {
    problems.push(`the tag of the current version (${previousTag}) is not an ancestor of HEAD`)
  }

  if (hasLocalTag(workspace, tag)) {
    problems.push(`the tag ${tag} already exists locally`)
  }

  // The push URL, which is not the URL `git ls-remote origin` reads when the two differ.
  const pushUrls = runCommand(workspace, 'git', ['remote', 'get-url', '--push', '--all', REMOTE])
  if (pushUrls.isSuccess && pushUrls.output.includes('\n')) {
    // A push goes to each of them, and is only atomic for one at a time.
    return [...problems, `the remote "${REMOTE}" has several push URLs, a release needs one`]
  }
  const branchReference = `refs/heads/${RELEASE_BRANCH}`
  const tagReference = `refs/tags/${tag}`
  const remote = pushUrls.isSuccess
    ? runCommand(workspace, 'git', ['ls-remote', pushUrls.output, branchReference, tagReference])
    : pushUrls
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
  const head = readGit(workspace, ['rev-parse', 'HEAD'])
  if (remoteHashes.get(branchReference) !== head) {
    problems.push(`HEAD is not the tip of ${REMOTE}/${RELEASE_BRANCH} (pull or push first)`)
  }
  if (remoteHashes.has(tagReference)) {
    problems.push(`the tag ${tag} already exists on "${REMOTE}"`)
  }
  return problems
}

/**
 * Read the commits made since a tag, newest first, without merge commits. Only what the
 * format asks for is printed, even for someone whose `log.showSignature` setting adds the
 * signature of each commit to every `git log`.
 *
 * @param workspace - The repository.
 * @param tag - The tag to start after.
 *
 * @returns The commits between the tag and `HEAD`.
 */
const readCommitsSince = (workspace: Workspace, tag: string): GitCommit[] =>
  readGit(workspace, [
    'log',
    '--no-merges',
    '--no-show-signature',
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
 * (no file, no git object, no reference, locally or on the remote). What is wrong with the
 * checkout (see {@link getPreflightProblems}) is then reported as a warning, so that the
 * remaining steps can still be previewed; what the steps cannot be worked out without (the
 * release files, the tag of the current version, a version without a changelog entry) stops a
 * dry run too.
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
  const workspace = {
    directoryPath,
    environment: {
      ...Object.fromEntries(
        Object.entries(options.environment).filter(([name]) => !GIT_HOOK_VARIABLES.has(name))
      ),
      // Keeps the commands that only read (`git status`) from refreshing the index file on
      // the way: a dry run writes nothing at all.
      GIT_OPTIONAL_LOCKS: '0',
    },
  }

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
    const result = runCommand(workspace, command, commandArguments, options.shouldStreamOutput)
    if (!result.isSuccess) {
      throw new Error(`🚨 ${result.failure}`)
    }
  }

  // The three files are committed together, and restored together if a step fails.
  const trackedFiles = new Set(readGit(workspace, ['ls-files', '--', ...RELEASE_FILES]).split('\n'))
  const untrackedFiles = RELEASE_FILES.filter((file) => !trackedFiles.has(file))
  if (untrackedFiles.length > 0) {
    throw new Error(`🚨 not tracked by git in this directory: ${untrackedFiles.join(', ')}`)
  }

  const { version: currentVersion, packageRepositoryUrl } = readPackageManifest(directoryPath)
  const repositoryUrl = getRepositoryUrl(packageRepositoryUrl)
  const version = resolveNextVersion(currentVersion, options.request)
  const tag = `v${version}`
  const previousTag = `v${currentVersion}`
  log(
    `📦 Releasing ${currentVersion} → ${version}${isDryRun ? ' (dry run: nothing is changed)' : ''}`
  )

  const problems = getPreflightProblems(workspace, tag, previousTag)
  if (problems.length > 0) {
    const list = problems.map((problem) => `   - ${problem}`).join('\n')
    if (!isDryRun) {
      throw new Error(`🚨 cannot release:\n${list}`)
    }
    log(`⚠️  A real release would stop here:\n${list}`)
  }

  // The changelog entry lists the commits made since the tag of the current version.
  if (!hasLocalTag(workspace, previousTag)) {
    throw new Error(
      `🚨 the tag of the current version (${previousTag}) does not exist locally (try \`git fetch --tags\`)`
    )
  }

  const commits = readCommitsSince(workspace, previousTag)
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
    // The build formats files and rewrites the README size badge. Such changes belong in a
    // commit of their own, not in the release commit: they are left in the working tree.
    const changes = readWorkingTreeChanges(workspace)
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
    // The pre-commit hook is the build, which just ran: only the version and the changelog
    // entry changed since.
    execute('git', ['commit', '--no-verify', '--message', `🔖 release ${tag}`])
  })
  if (isNormalizedError(committed)) {
    // The tree was clean before these steps, so restoring the release files loses nothing.
    const restored = runCommand(workspace, 'git', ['checkout', 'HEAD', '--', ...RELEASE_FILES])
    throw new Error(
      `${committed.message}\n   ${
        restored.isSuccess
          ? `↩️  ${RELEASE_FILES.join(', ')} were restored, nothing was committed.`
          : `⚠️  ${RELEASE_FILES.join(', ')} could not be restored (${restored.failure}).`
      }`
    )
  }

  // Atomic: the branch and the tag are both accepted, or neither is. Nothing else is pushed,
  // even for someone whose `push.followTags` setting sends every reachable tag along.
  const pushArguments = [
    'push',
    '--atomic',
    '--no-follow-tags',
    REMOTE,
    `refs/heads/${RELEASE_BRANCH}`,
    `refs/tags/${tag}`,
  ]
  const pushed = noThrow(() => {
    execute('git', ['tag', '--annotate', tag, '--message', `Release ${version}`])
    execute('git', pushArguments)
  })
  if (isNormalizedError(pushed)) {
    throw new Error(
      [
        pushed.message,
        `   The release commit exists locally. Check what reached "${REMOTE}" with:`,
        `     git ls-remote "$(git remote get-url --push ${REMOTE})" refs/heads/${RELEASE_BRANCH} refs/tags/${tag}`,
        `   To retry (create the tag first if \`git tag --list ${tag}\` prints nothing):`,
        `     git tag --annotate ${tag} --message "Release ${version}"`,
        `     git ${pushArguments.join(' ')}`,
        '   To undo, if nothing was pushed:',
        `     git tag --delete ${tag}`,
        '     git reset --hard HEAD~1',
        `   If the push was rejected because ${REMOTE}/${RELEASE_BRANCH} has new commits: undo, pull, and release again.`,
      ].join('\n')
    )
  }

  log(
    isDryRun
      ? `✅ Dry run of ${tag} complete, nothing was changed. To release it: ` +
          `npm run release -- ${options.request} ${CONFIRM_OPTION}`
      : `✅ ${tag} is pushed. The release workflow now tests it, publishes it to npm and creates ` +
          `the GitHub release: ${repositoryUrl}/actions/workflows/release.yml`
  )
  return version
}
