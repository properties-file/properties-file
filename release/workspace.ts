/**
 * What the release commands share to look at a repository: running `git` and `npm`, and reading
 * the package manifest (see ./release.ts and ./brief.ts for what they do with it).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The variables git sets for the hooks it runs, pointing git at the repository and the index
 * of the operation in progress. The commands of a release must not inherit them: run from a
 * hook, as the tests of the release are by this repository's pre-commit hook, they would act
 * on the index of the commit being made instead of the one of the repository to release.
 */
const GIT_HOOK_VARIABLES = new Set(['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_WORK_TREE'])

/** Separates the fields of one commit in the `git log` output (ASCII unit separator). */
const FIELD_SEPARATOR = String.fromCodePoint(0x1f)

/** Separates the commits in the `git log` output (ASCII record separator). */
const RECORD_SEPARATOR = String.fromCodePoint(0x1e)

/** Environment variables, as in `process.env`. */
export type Environment = Record<string, string | undefined>

/** Where the commands of a release run. */
export type Workspace = {
  /** The root directory of the repository to release. */
  directoryPath: string
  /** The environment variables the commands run with. */
  environment: Environment
}

/** The outcome of a command. */
export type CommandResult = {
  /** Whether the command ran and exited with code 0. */
  isSuccess: boolean
  /** What the command printed to its standard output, unless it was streamed. */
  output: string
  /** Why the command failed, when it did. */
  failure: string
}

/** What the release commands read from `package.json`. */
export type PackageManifest = {
  /** The name of the package. */
  name: string
  /** The current version. */
  version: string
  /** The `repository.url` value. */
  packageRepositoryUrl: string
}

/** A commit as read from `git log`. */
export type GitCommit = {
  /** The full commit hash. */
  hash: string
  /** The first line of the commit message. */
  subject: string
  /** The commit message without its first line. */
  body: string
}

/**
 * Describe where the commands of a release run.
 *
 * @param directoryPath - The root directory of the repository to release.
 * @param environment - The environment variables of the process.
 *
 * @returns The workspace: the directory, and the environment without the variables git sets
 *   for its hooks.
 */
export const createWorkspace = (directoryPath: string, environment: Environment): Workspace => ({
  directoryPath,
  environment: {
    ...Object.fromEntries(
      Object.entries(environment).filter(([name]) => !GIT_HOOK_VARIABLES.has(name))
    ),
    // Keeps the commands that only read (`git status`) from refreshing the index file on the
    // way: a dry run writes nothing at all.
    GIT_OPTIONAL_LOCKS: '0',
  },
})

/**
 * Write a command the way it would be typed in a shell, for messages.
 *
 * @param command - The executable.
 * @param commandArguments - Its arguments.
 *
 * @returns The command line, with double quotes around the arguments that contain a space.
 */
export const formatCommand = (command: string, commandArguments: string[]): string =>
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
export const runCommand = (
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
export const readGit = (workspace: Workspace, gitArguments: string[]): string => {
  const result = runCommand(workspace, 'git', gitArguments)
  if (!result.isSuccess) {
    throw new Error(`🚨 ${result.failure}`)
  }
  return result.output
}

/**
 * Read the name, the version and the repository URL from `package.json`.
 *
 * @param directoryPath - The root directory of the repository.
 *
 * @returns What the release commands need from the manifest.
 *
 * @throws If `package.json` does not have the three of them as strings.
 */
export const readPackageManifest = (directoryPath: string): PackageManifest => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(directoryPath, 'package.json'), 'utf8')
  )
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('name' in manifest) ||
    typeof manifest.name !== 'string' ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string' ||
    !('repository' in manifest) ||
    typeof manifest.repository !== 'object' ||
    manifest.repository === null ||
    !('url' in manifest.repository) ||
    typeof manifest.repository.url !== 'string'
  ) {
    throw new Error('🚨 package.json must have a "name", a "version" and a "repository.url"')
  }
  return {
    name: manifest.name,
    version: manifest.version,
    packageRepositoryUrl: manifest.repository.url,
  }
}

/**
 * Check whether a tag exists in the local repository.
 *
 * @param workspace - The repository.
 * @param tag - The tag name.
 *
 * @returns `true` if the tag exists locally.
 */
export const hasLocalTag = (workspace: Workspace, tag: string): boolean =>
  runCommand(workspace, 'git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`]).isSuccess

/**
 * Read the commits made since a tag, newest first, without merge commits. Only what the
 * format asks for is printed, in UTF-8, even for someone whose git settings add the
 * signature of each commit to every `git log` (`log.showSignature`) or print it in another
 * encoding (`i18n.logOutputEncoding`).
 *
 * @param workspace - The repository.
 * @param tag - The tag to start after.
 *
 * @returns The commits between the tag and `HEAD`.
 */
export const readCommitsSince = (workspace: Workspace, tag: string): GitCommit[] =>
  readGit(workspace, [
    'log',
    '--no-merges',
    '--no-show-signature',
    '--encoding=UTF-8',
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
