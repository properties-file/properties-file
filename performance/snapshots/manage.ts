import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const rootDirectory = path.resolve(import.meta.dirname, '..', '..')
const snapshotsDirectory = path.resolve(import.meta.dirname, '.snapshots')

/** Project directories saved alongside each snapshot for quick restore. */
const SNAPSHOT_DIRECTORIES = ['src', 'dist']

/** Individual project files saved alongside each snapshot for reproducibility. */
const SNAPSHOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json']

/** Metadata stored alongside each snapshot. */
type SnapshotMetadata = {
  /** Name of the snapshot. */
  name: string
  /** ISO date string when the snapshot was taken. */
  date: string
  /** Git commit hash (short) at the time of the snapshot. */
  commit: string
  /** Git branch name at the time of the snapshot. */
  branch: string
  /** User-provided description. */
  description: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the short git commit hash.
 *
 * @returns The 7-character commit hash.
 */
const getGitCommit = (): string => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Get the current git branch name.
 *
 * @returns The branch name.
 */
const getGitBranch = (): string => {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Resolve the directory for a named snapshot.
 *
 * @param name - The snapshot name.
 *
 * @returns The absolute directory path.
 */
const snapshotDirectory = (name: string): string => path.resolve(snapshotsDirectory, name)

/**
 * Parse a snapshot metadata file.
 *
 * @param metadataPath - The path to the metadata JSON file.
 *
 * @returns The parsed metadata.
 */
const readMetadata = (metadataPath: string): SnapshotMetadata =>
  JSON.parse(readFileSync(metadataPath, 'utf8')) as SnapshotMetadata

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * Save current project code as a named snapshot.
 *
 * Copies `src/`, `dist/`, `package.json`, `package-lock.json`, and `tsconfig.json`
 * for quick restore. Requires `dist/` to exist (run `npm run build` first).
 *
 * @param name - The snapshot name.
 * @param description - A description of what this snapshot represents.
 */
const save = (name: string, description: string): void => {
  const directory = snapshotDirectory(name)

  if (existsSync(directory)) {
    throw new CliError(`Snapshot "${name}" already exists. Use 'delete' first to overwrite.`)
  }

  const distributionDirectory = path.resolve(rootDirectory, 'dist')
  if (!existsSync(distributionDirectory)) {
    throw new CliError('No dist/ directory found. Run `npm run build` before saving a snapshot.')
  }

  mkdirSync(directory, { recursive: true })

  // Copy src/ and dist/ for quick restore.
  for (const directoryName of SNAPSHOT_DIRECTORIES) {
    const source = path.resolve(rootDirectory, directoryName)
    if (existsSync(source)) {
      execSync(`cp -r "${source}" "${path.resolve(directory, directoryName)}"`, { stdio: 'pipe' })
    }
  }

  // Copy individual config files for reproducibility.
  for (const fileName of SNAPSHOT_FILES) {
    const source = path.resolve(rootDirectory, fileName)
    if (existsSync(source)) {
      execSync(`cp "${source}" "${path.resolve(directory, fileName)}"`, { stdio: 'pipe' })
    }
  }

  // Write metadata.
  const metadata: SnapshotMetadata = {
    name,
    date: new Date().toISOString(),
    commit: getGitCommit(),
    branch: getGitBranch(),
    description,
  }
  writeFileSync(path.resolve(directory, 'metadata.json'), JSON.stringify(metadata, null, 2))

  console.log(`\nSnapshot "${name}" saved.`)
  console.log(`  Commit: ${metadata.commit}`)
  console.log(`  Branch: ${metadata.branch}`)
  console.log(`  Path:   ${directory}`)
}

/**
 * List all saved snapshots.
 */
const list = (): void => {
  if (!existsSync(snapshotsDirectory)) {
    console.log('No snapshots found.')
    return
  }

  const names = readdirSync(snapshotsDirectory)
    .filter((name) => existsSync(path.resolve(snapshotsDirectory, name, 'metadata.json')))
    .toSorted()

  if (names.length === 0) {
    console.log('No snapshots found.')
    return
  }

  const nameWidth = Math.max(12, ...names.map((name) => name.length))
  console.log(
    `${'Name'.padEnd(nameWidth)}  ${'Date'.padEnd(19)}  ${'Commit'.padEnd(8)}  ${'Branch'.padEnd(20)}  Description`
  )
  console.log('-'.repeat(nameWidth + 65))

  for (const name of names) {
    const metadata = readMetadata(path.resolve(snapshotsDirectory, name, 'metadata.json'))
    const dateObject = new Date(metadata.date)
    const year = dateObject.getFullYear()
    const month = String(dateObject.getMonth() + 1).padStart(2, '0')
    const day = String(dateObject.getDate()).padStart(2, '0')
    const hours = String(dateObject.getHours()).padStart(2, '0')
    const minutes = String(dateObject.getMinutes()).padStart(2, '0')
    const seconds = String(dateObject.getSeconds()).padStart(2, '0')
    const date = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
    console.log(
      `${metadata.name.padEnd(nameWidth)}  ${date}  ${metadata.commit.padEnd(8)}  ${metadata.branch.padEnd(20)}  ${metadata.description || '-'}`
    )
  }
}

/**
 * Delete a saved snapshot.
 *
 * @param name - The snapshot name to delete.
 */
const deleteSnapshot = (name: string): void => {
  const directory = snapshotDirectory(name)

  if (!existsSync(directory)) {
    throw new CliError(`Snapshot "${name}" not found.`)
  }

  rmSync(directory, { recursive: true })
  console.log(`Snapshot "${name}" deleted.`)
}

/**
 * Restore a snapshot's source, compiled code, and config files into the project.
 *
 * Replaces the project's `src/` and `dist/` directories and restores
 * `package.json`, `package-lock.json`, and `tsconfig.json` from the snapshot,
 * allowing instant benchmarking of a previous approach without rebuilding.
 *
 * @param name - The snapshot name to restore.
 */
const restore = (name: string): void => {
  const directory = snapshotDirectory(name)
  const metadataPath = path.resolve(directory, 'metadata.json')

  if (!existsSync(directory)) {
    throw new CliError(`Snapshot "${name}" not found. Use 'list' to see available snapshots.`)
  }

  // Verify the snapshot has source code.
  const snapshotSourceDirectory = path.resolve(directory, 'src')
  if (!existsSync(snapshotSourceDirectory)) {
    throw new CliError(
      `Snapshot "${name}" does not contain source code (older snapshot). Save a new one first.`
    )
  }

  // Abort if the working tree has uncommitted changes to src/ or dist/.
  try {
    const status = execSync('git status --porcelain -- src/ dist/', {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()
    if (status) {
      throw new CliError(
        `Working tree has uncommitted changes in src/ or dist/. Commit or stash them before restoring.\n\n${status}`
      )
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    // Not a git repo or git not available — skip the check.
  }

  const metadata: SnapshotMetadata = existsSync(metadataPath)
    ? readMetadata(metadataPath)
    : { name, date: 'unknown', commit: 'unknown', branch: 'unknown', description: '' }

  // Replace project directories with snapshot copies.
  for (const directoryName of SNAPSHOT_DIRECTORIES) {
    const snapshotCopy = path.resolve(directory, directoryName)
    const projectCopy = path.resolve(rootDirectory, directoryName)
    if (existsSync(snapshotCopy)) {
      rmSync(projectCopy, { recursive: true, force: true })
      execSync(`cp -r "${snapshotCopy}" "${projectCopy}"`, { stdio: 'pipe' })
    }
  }

  // Restore individual config files from the snapshot.
  for (const fileName of SNAPSHOT_FILES) {
    const snapshotCopy = path.resolve(directory, fileName)
    const projectCopy = path.resolve(rootDirectory, fileName)
    if (existsSync(snapshotCopy)) {
      execSync(`cp "${snapshotCopy}" "${projectCopy}"`, { stdio: 'pipe' })
    }
  }

  console.log(`Snapshot "${name}" restored.`)
  console.log(`  Original commit: ${metadata.commit} (${metadata.branch})`)
  console.log(`  Saved on: ${metadata.date.slice(0, 19).replace('T', ' ')}`)
  if (metadata.description) {
    console.log(`  Description: ${metadata.description}`)
  }
  console.log(
    `\nBoth src/ and dist/ have been replaced along with config files. Run benchmarks to compare.`
  )
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage: npx tsx performance/snapshots/manage.ts <command> [options]

Commands:
  save <name> <description>   Save current src/ + dist/ + config as a named snapshot
  list                        List all saved snapshots
  restore <name>              Restore a snapshot's src/, dist/, and config into the project
  delete <name>               Delete a saved snapshot

Examples:
  npx tsx performance/snapshots/manage.ts save before-optimization "Baseline before parser rewrite"
  npx tsx performance/snapshots/manage.ts restore before-optimization
  npx tsx performance/snapshots/manage.ts list
  npx tsx performance/snapshots/manage.ts delete before-optimization

npm script shortcuts:
  npm run snapshot -- save my-snapshot "Description of this version"
  npm run snapshot -- restore my-snapshot
  npm run snapshot -- list`

/** Sentinel class used to distinguish CLI usage errors from unexpected failures. */
class CliError extends Error {}

/**
 * Throw a CLI usage error with a friendly message.
 *
 * @param message - The error message to display.
 */
const fail = (message: string): never => {
  throw new CliError(message)
}

/**
 * Require a snapshot name argument, throwing a friendly error if missing.
 *
 * @param name - The snapshot name from CLI arguments.
 * @param command - The command name (for error messages).
 *
 * @returns The validated name.
 */
const requireName = (name: string | undefined, command: string): string => {
  if (!name) {
    return fail(`Missing snapshot name for '${command}'.`)
  }
  return name
}

try {
  const [command, ...arguments_] = process.argv.slice(2)

  switch (command) {
    case 'save': {
      const saveName = requireName(arguments_[0], 'save')
      const saveDescription = arguments_.slice(1).join(' ')
      if (!saveDescription) {
        fail(`Missing description for 'save'. Describe what this snapshot represents.`)
      }
      save(saveName, saveDescription)
      break
    }
    case 'list': {
      list()
      break
    }
    case 'restore': {
      restore(requireName(arguments_[0], 'restore'))
      break
    }
    case 'delete': {
      deleteSnapshot(requireName(arguments_[0], 'delete'))
      break
    }
    default: {
      fail(command ? `Unknown command: ${command}` : 'No command provided.')
    }
  }
} catch (error) {
  if (error instanceof CliError) {
    console.error(`\n  ${error.message}\n\n${USAGE}\n`)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
  throw error
}
