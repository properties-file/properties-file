/**
 * The local half of the release flow, run through `npm run release` (see ./cli.ts): it checks
 * that the checkout is releasable, runs the build, checks that the package differs from the
 * published one, bumps the version, writes the release notes it is given into the changelog,
 * then commits, tags and pushes. Pushing the tag starts the other half,
 * `.github/workflows/release.yml`, which stages the version on npm and creates the GitHub
 * release; a maintainer then approves the staged version.
 *
 * The only commands it runs are `git`, `npm` and the repository's own `prettier`, and it asks
 * no question (git itself may still ask for credentials or a signing passphrase). Without
 * `--confirm` it is a dry run: it goes through the same steps while changing nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { isNormalizedError, noThrow } from '../utilities/no-throw'

import {
  assertChangelogEntryAdded,
  getRepositoryUrl,
  insertChangelogEntry,
  normalizeReleaseNotes,
  renderChangelogEntry,
  resolveNextVersion,
} from './changelog'
import { describeNotesProblems, findNotesProblems, readNotesRules } from './notes-rules'
import { compareWithPublishedPackage, isSamePackage } from './package-diff'
import {
  createWorkspace,
  formatCommand,
  hasLocalTag,
  readGit,
  readPackageManifest,
  runCommand,
} from './workspace'

import type { Environment, Workspace } from './workspace'

/** The only branch releases are made from. */
const RELEASE_BRANCH = 'main'

/** The git remote releases are pushed to. */
const REMOTE = 'origin'

/** The files a release changes, which are committed together. */
const RELEASE_FILES = ['CHANGELOG.md', 'package.json', 'package-lock.json']

/** The command that prints what changed since the last release, and the guidelines. */
const BRIEF_COMMAND = 'brief'

/** The option that makes a release real. */
const CONFIRM_OPTION = '--confirm'

/** The option that asks for what is already the default, a dry run. */
const DRY_RUN_OPTION = '--dry-run'

/** What says what goes in the release notes, and when a release is worth making. */
export const GUIDELINES_PATH = 'docs/release-notes-guidelines.md'

/**
 * The variables npm sets when it is given `--dry-run` itself, or the likely typo `--dryrun`
 * (not an option of npm, which passes it on the same way). Without a `--` before the script's
 * arguments, that is where these options end up.
 */
const NPM_DRY_RUN_VARIABLES = ['npm_config_dry_run', 'npm_config_dryrun']

/** The variable npm sets when it is given `--confirm` itself, for want of a `--` before it. */
const NPM_CONFIRM_VARIABLE = 'npm_config_confirm'

/** How to call the release script, shown when its arguments are not usable. */
export const USAGE = [
  'Usage:',
  `  npm run release -- ${BRIEF_COMMAND}`,
  '      What changed since the last release, and the release notes guidelines.',
  `  npm run release -- <major | minor | patch | x.y.z> [${CONFIRM_OPTION}] <<'NOTES'`,
  '  (the release notes, in Markdown)',
  '  NOTES',
  `      A dry run of the release, or the release itself with ${CONFIRM_OPTION}.`,
].join('\n')

/** What `npm run release` was asked to do. */
export type ReleaseArguments =
  | {
      /** Print the brief (see ./brief.ts). */
      command: 'brief'
    }
  | {
      /** Release, or go through a release without changing anything. */
      command: 'release'
      /** `major`, `minor`, `patch`, or an explicit version. */
      request: string
      /** Whether to go through the steps without changing anything. */
      isDryRun: boolean
    }

/** The options of {@link release}. */
export type ReleaseOptions = {
  /** `major`, `minor`, `patch`, or an explicit version. */
  request: string
  /** Whether to go through the steps without changing anything. */
  isDryRun: boolean
  /** The release notes, in Markdown, as the command received them on its standard input. */
  notes: string
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
  /**
   * What `npm pack` fetches as the version that is already published, to compare the package
   * with it. The current version on the registry (`<name>@<version>`) when left out.
   */
  publishedPackageSpec?: string
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
 * @throws If there is an unknown option, both options at once, an option with the brief, or
 *   not exactly one argument that is not an option.
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
    throw new Error(`🚨 expected "${BRIEF_COMMAND}" or exactly one version argument\n${USAGE}`)
  }
  if (requests[0] === BRIEF_COMMAND) {
    if (options.length > 0) {
      throw new Error(`🚨 "${BRIEF_COMMAND}" takes no option\n${USAGE}`)
    }
    return { command: 'brief' }
  }
  return {
    command: 'release',
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
      ? `⚠️  ${CONFIRM_OPTION} was given, but npm was asked for a dry run (${variables.join(', ')}).`
      : undefined
  }
  return environment[NPM_CONFIRM_VARIABLE] === undefined
    ? undefined
    : `⚠️  npm kept ${CONFIRM_OPTION} for itself: write it after the \`--\` that separates the ` +
        `arguments of the script from those of npm.`
}

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

  // The compare link of the changelog entry starts at that tag, which the release must
  // therefore come after.
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
 * Release a new version: check the checkout, build, check that the package changed, bump the
 * version, write the release notes into the changelog, commit, tag and push. In a dry run the
 * same steps are reported and nothing is changed (no file, no git object, no reference,
 * locally or on the remote). What is wrong with the checkout (see
 * {@link getPreflightProblems}) is then reported as a warning, so that the remaining steps can
 * still be previewed; what the steps cannot be worked out without (the release files, the
 * release notes and their form, the tag of the current version, a version without a changelog
 * entry) stops a
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
  const workspace = createWorkspace(directoryPath, options.environment)

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

  if (options.notes.trim() === '') {
    throw new Error(`🚨 no release notes were given on the standard input\n${USAGE}`)
  }

  // The three files are committed together, and restored together if a step fails.
  const trackedFiles = new Set(readGit(workspace, ['ls-files', '--', ...RELEASE_FILES]).split('\n'))
  const untrackedFiles = RELEASE_FILES.filter((file) => !trackedFiles.has(file))
  if (untrackedFiles.length > 0) {
    throw new Error(`🚨 not tracked by git in this directory: ${untrackedFiles.join(', ')}`)
  }

  const manifest = readPackageManifest(directoryPath)
  const currentVersion = manifest.version
  const repositoryUrl = getRepositoryUrl(manifest.packageRepositoryUrl)
  const version = resolveNextVersion(currentVersion, options.request)
  const tag = `v${version}`
  const previousTag = `v${currentVersion}`

  // The form of the notes, by the rules of the repository when it has some.
  const notesRules = readNotesRules(directoryPath)
  if (notesRules !== undefined) {
    const notesProblems = findNotesProblems(normalizeReleaseNotes(options.notes), notesRules, {
      version,
      isMajor: version.endsWith('.0.0'),
    })
    if (notesProblems.length > 0) {
      throw new Error(
        `${describeNotesProblems(notesProblems, notesRules)}\n\n` +
          `   What the notes should say is in ${GUIDELINES_PATH}.`
      )
    }
  }
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

  // The release is what changed since that tag, which the compare link of the entry shows.
  if (!hasLocalTag(workspace, previousTag)) {
    throw new Error(
      `🚨 the tag of the current version (${previousTag}) does not exist locally (try \`git fetch --tags\`)`
    )
  }

  const entry = renderChangelogEntry({
    version,
    previousVersion: currentVersion,
    date: options.date.toISOString().slice(0, 10),
    repositoryUrl,
    notes: options.notes,
  })
  const changelogPath = path.join(directoryPath, 'CHANGELOG.md')
  const previousChangelog = readFileSync(changelogPath, 'utf8')
  // Computed before anything is changed: this fails if the version already has an entry.
  const changelog = insertChangelogEntry(previousChangelog, version, entry)

  // The full gate (lint, compile, tests, package checks), before anything is committed.
  execute('npm', ['run', 'build'])
  const publishedPackageSpec = options.publishedPackageSpec ?? `${manifest.name}@${currentVersion}`
  if (isDryRun) {
    log(`   ⏭️  would compare the package with ${publishedPackageSpec}, and stop if it is the same`)
  } else {
    // The build formats files and rewrites the README size badge. Such changes belong in a
    // commit of their own, not in the release commit: they are left in the working tree.
    const changes = readWorkingTreeChanges(workspace)
    if (changes !== '') {
      throw new Error(`🚨 \`npm run build\` changed files, commit them first:\n${changes}`)
    }
    // A release is for users: one that publishes the same files again has nothing for them.
    log(`   📦 comparing the package with ${publishedPackageSpec}`)
    const comparison = compareWithPublishedPackage(workspace, publishedPackageSpec)
    if (comparison.difference === undefined) {
      log(
        `⚠️  The package could not be compared with ${publishedPackageSpec}, which could not ` +
          `be fetched (${comparison.failure})`
      )
    } else if (isSamePackage(comparison.difference)) {
      throw new Error(
        `🚨 nothing to release: the files of the package are the same as in ${publishedPackageSpec}`
      )
    }
  }

  const committed = noThrow(() => {
    execute('npm', ['version', version, '--no-git-tag-version'])
    log(`   ${isDryRun ? '⏭️  would add' : '📝 adding'} to CHANGELOG.md:\n\n${entry}`)
    if (!isDryRun) {
      writeFileSync(changelogPath, changelog)
    }
    execute('npx', ['--no-install', 'prettier', '--write', 'CHANGELOG.md'])
    if (!isDryRun) {
      // The file as it will be committed: prettier formatted it as a whole.
      assertChangelogEntryAdded(previousChangelog, readFileSync(changelogPath, 'utf8'), version)
    }
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
  // even for someone whose `push.followTags` setting sends every reachable tag along, and
  // each reference is pushed to its own name, whatever `remote.origin.push` maps it to.
  const pushArguments = [
    'push',
    '--atomic',
    '--no-follow-tags',
    REMOTE,
    `refs/heads/${RELEASE_BRANCH}:refs/heads/${RELEASE_BRANCH}`,
    `refs/tags/${tag}:refs/tags/${tag}`,
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
      ? [
          `✅ Dry run of ${tag} complete, nothing was changed.`,
          '   Not checked by a dry run: that `npm run build` passes without changing a file, and ' +
            'that the package differs from the published one. The release checks both before ' +
            'it changes anything.',
          `   Next: check the notes above against ${GUIDELINES_PATH} ` +
            `(\`npm run release -- ${BRIEF_COMMAND}\` prints it with what changed), then show a ` +
            'maintainer the version and the notes, and wait for their go-ahead.',
          `   To release: the same command with ${CONFIRM_OPTION} after the version. The ` +
            'maintainer will then have to approve the version on npm.',
        ].join('\n')
      : [
          `✅ ${tag} is pushed. It is not on npm yet. What happens next:`,
          `   1. The release workflow tests the version, builds it and stages it on npm: ` +
            `${repositoryUrl}/actions/workflows/release.yml`,
          '   2. A maintainer approves the staged version with two-factor authentication: on ' +
            'npmjs.com (the Staged Packages tab), or with `npm stage approve <stage-id>`. ' +
            'The summary of the workflow run gives the id, and the shasum to check first. ' +
            'Tell them when the version is waiting.',
          `   3. ${manifest.name}@${version} is then public: ` +
            `\`npm view ${manifest.name}@${version} version\` prints the version once it is.`,
        ].join('\n')
  )
  return version
}
