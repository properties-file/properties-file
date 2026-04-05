import { exec, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  averageBenchmarkResults,
  buildComparison,
  buildMarkdownReport,
  parseBenchmarkResults,
  printComparison,
} from '../shared/compare-utilities'

const rootDirectory = path.resolve(import.meta.dirname, '..', '..')
const resultsDirectory = path.resolve(import.meta.dirname, '.results')
const snapshotsDirectory = path.resolve(import.meta.dirname, '..', 'snapshots', '.snapshots')
const temporaryDirectory = path.resolve(tmpdir(), 'properties-file-benchmark')
const baselineTemporaryDirectory = path.resolve(temporaryDirectory, 'baseline')
const currentTemporaryDirectory = path.resolve(temporaryDirectory, 'current')
const baselinePath = path.resolve(resultsDirectory, 'baseline', 'results.json')
const currentPath = path.resolve(resultsDirectory, 'current', 'results.json')
const reportPath = path.resolve(resultsDirectory, 'comparison.md')

/** Directories copied into each isolated benchmark environment. */
const PROJECT_DIRECTORIES = ['src', 'performance', 'node_modules', 'assets']

// ─── Shell helpers ───────────────────────────────────────────────────────────

/**
 * Execute a shell command synchronously and return its trimmed stdout.
 *
 * @param command - The shell command to execute.
 * @param cwd - Working directory (defaults to the project root).
 *
 * @returns The trimmed stdout output.
 */
const execCommand = (command: string, cwd = rootDirectory): string =>
  execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

/**
 * Run benchmarks in an isolated project copy.
 *
 * @param directory - The isolated project directory.
 * @param outputPath - Where to write the JSON results.
 *
 * @returns A promise that resolves when the benchmark completes.
 */
const runBenchIn = (directory: string, outputPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = exec(
      `npx tsx performance/benchmarks/run.ts "${outputPath}"`,
      { cwd: directory },
      (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
    )
    child.stdout?.pipe(process.stdout)
    child.stderr?.pipe(process.stderr)
  })

// ─── Git helpers ─────────────────────────────────────────────────────────────

/**
 * Find the most recent semver release tag (e.g. `v3.7.0` or `3.7.0`).
 *
 * @returns The tag name.
 *
 * @throws Error if no release tag is found.
 */
const getLatestReleaseTag = (): string => {
  const tags = execCommand('git tag --sort=-version:refname')
  const releaseTag = tags.split('\n').find((tag) => /^v?\d+\.\d+\.\d+$/.test(tag))
  if (!releaseTag) {
    throw new Error('No release tag found')
  }
  return releaseTag
}

// ─── Environment setup ──────────────────────────────────────────────────────

/**
 * Create an isolated copy of the project for benchmarking.
 *
 * Only copies the directories needed to run benchmarks, plus `package.json`.
 *
 * @param targetDirectory - The directory to create the copy in.
 */
const createIsolatedCopy = (targetDirectory: string): void => {
  mkdirSync(targetDirectory, { recursive: true })
  for (const directory of PROJECT_DIRECTORIES) {
    execSync(
      `cp -r "${path.resolve(rootDirectory, directory)}" "${path.resolve(targetDirectory, directory)}"`,
      { stdio: 'pipe' }
    )
  }
  execSync(
    `cp "${path.resolve(rootDirectory, 'package.json')}" "${path.resolve(targetDirectory, 'package.json')}"`,
    { stdio: 'pipe' }
  )
}

/** Remove the temporary directory used during comparison. */
const cleanup = (): void => {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}

// ─── Comparison modes ────────────────────────────────────────────────────────

/**
 * Compare current benchmarks against the latest release tag.
 *
 * Creates two isolated project copies, replaces the baseline's `src/` with the
 * tagged version, runs both in parallel for fair comparison, then produces a
 * terminal table and a Markdown report.
 *
 * @param runs - Number of benchmark iterations to average (default 1).
 */
const compareAgainstTag = async (runs: number): Promise<void> => {
  mkdirSync(path.resolve(resultsDirectory, 'baseline'), { recursive: true })
  mkdirSync(path.resolve(resultsDirectory, 'current'), { recursive: true })

  const tag = getLatestReleaseTag()
  console.log(`Comparing against latest release: ${tag}`)
  if (runs > 1) {
    console.log(`Averaging over ${runs} runs`)
  }
  console.log('')

  const baselineRuns = []
  const currentRuns = []

  for (let run = 1; run <= runs; run++) {
    if (runs > 1) {
      console.log(`── Run ${run}/${runs} ──`)
    }

    // Clean up any leftover temp dirs from previous interrupted runs.
    cleanup()

    try {
      console.log('Preparing isolated benchmark environments...')
      createIsolatedCopy(currentTemporaryDirectory)
      createIsolatedCopy(baselineTemporaryDirectory)

      // Replace baseline's src/ with the release tag version.
      rmSync(path.resolve(baselineTemporaryDirectory, 'src'), { recursive: true })
      execCommand(`git archive ${tag} -- src/ | tar -x -C "${baselineTemporaryDirectory}"`)

      // Run both benchmarks in parallel so they share the same system conditions.
      console.log('Running benchmarks in parallel (current + baseline)...\n')
      await Promise.all([
        runBenchIn(currentTemporaryDirectory, currentPath),
        runBenchIn(baselineTemporaryDirectory, baselinePath),
      ])
    } finally {
      cleanup()
    }

    baselineRuns.push(parseBenchmarkResults(readFileSync(baselinePath, 'utf8')))
    currentRuns.push(parseBenchmarkResults(readFileSync(currentPath, 'utf8')))
  }

  const baseline = averageBenchmarkResults(baselineRuns)
  const current = averageBenchmarkResults(currentRuns)

  const rows = buildComparison(baseline, current)
  printComparison(rows)
  writeFileSync(reportPath, buildMarkdownReport(tag, rows))

  console.log(`\nReport saved to ${reportPath}`)
  console.log(`JSON results: ${baselinePath}, ${currentPath}`)
}

/**
 * Compare current benchmarks against a saved snapshot.
 *
 * Creates two isolated project copies — one with current source and one with
 * the snapshot's saved source — and runs both in parallel so they share the
 * same system conditions, just like the tag comparison mode.
 *
 * @param name - The snapshot name to compare against.
 * @param runs - Number of benchmark iterations to average (default 1).
 */
const compareAgainstSnapshot = async (name: string, runs: number): Promise<void> => {
  const snapshotDirectory = path.resolve(snapshotsDirectory, name)
  const snapshotSourceDirectory = path.resolve(snapshotDirectory, 'src')
  const metadataPath = path.resolve(snapshotDirectory, 'metadata.json')

  if (!existsSync(snapshotDirectory)) {
    throw new Error(
      `Snapshot "${name}" not found. Use 'npm run snapshot -- list' to see available snapshots.`
    )
  }

  if (!existsSync(snapshotSourceDirectory)) {
    throw new Error(
      `Snapshot "${name}" does not contain source code (older snapshot). Save a new one first.`
    )
  }

  const metadata = existsSync(metadataPath)
    ? (JSON.parse(readFileSync(metadataPath, 'utf8')) as {
        date: string
        commit: string
        branch: string
        description: string
      })
    : { date: 'unknown', commit: 'unknown', branch: 'unknown', description: '' }

  console.log(`Comparing against snapshot: ${name}`)
  console.log(`  Saved: ${metadata.date.slice(0, 19).replace('T', ' ')}`)
  console.log(`  Commit: ${metadata.commit} (${metadata.branch})`)
  if (metadata.description) {
    console.log(`  Description: ${metadata.description}`)
  }
  if (runs > 1) {
    console.log(`  Averaging over ${runs} runs`)
  }
  console.log('')

  mkdirSync(path.resolve(resultsDirectory, 'baseline'), { recursive: true })
  mkdirSync(path.resolve(resultsDirectory, 'current'), { recursive: true })

  const baselineRuns = []
  const currentRuns = []

  for (let run = 1; run <= runs; run++) {
    if (runs > 1) {
      console.log(`── Run ${run}/${runs} ──`)
    }

    cleanup()

    try {
      console.log('Preparing isolated benchmark environments...')
      createIsolatedCopy(currentTemporaryDirectory)
      createIsolatedCopy(baselineTemporaryDirectory)

      // Replace baseline's src/ with the snapshot's saved source.
      rmSync(path.resolve(baselineTemporaryDirectory, 'src'), { recursive: true })
      execSync(
        `cp -r "${snapshotSourceDirectory}" "${path.resolve(baselineTemporaryDirectory, 'src')}"`,
        { stdio: 'pipe' }
      )

      // Run both benchmarks in parallel so they share the same system conditions.
      console.log('Running benchmarks in parallel (current + baseline)...\n')
      await Promise.all([
        runBenchIn(currentTemporaryDirectory, currentPath),
        runBenchIn(baselineTemporaryDirectory, baselinePath),
      ])
    } finally {
      cleanup()
    }

    baselineRuns.push(parseBenchmarkResults(readFileSync(baselinePath, 'utf8')))
    currentRuns.push(parseBenchmarkResults(readFileSync(currentPath, 'utf8')))
  }

  const baseline = averageBenchmarkResults(baselineRuns)
  const current = averageBenchmarkResults(currentRuns)

  const rows = buildComparison(baseline, current)
  printComparison(rows)

  const label = `snapshot "${name}" (${metadata.commit} on ${metadata.branch})`
  writeFileSync(reportPath, buildMarkdownReport(label, rows))

  console.log(`\nReport saved to ${reportPath}`)
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage: npx tsx performance/benchmarks/compare.ts [options]

Options:
  --tag              Compare against the latest release tag (default)
  --snapshot <name>  Compare against a saved snapshot
  --runs <n>         Run benchmarks n times and average results (default: 1)

Examples:
  npx tsx performance/benchmarks/compare.ts
  npx tsx performance/benchmarks/compare.ts --tag
  npx tsx performance/benchmarks/compare.ts --snapshot before-optimization
  npx tsx performance/benchmarks/compare.ts --snapshot before-optimization --runs 3
  npm run benchmark-compare
  npm run benchmark-compare -- --snapshot before-optimization --runs 3`

const arguments_ = process.argv.slice(2)
const snapshotIndex = arguments_.indexOf('--snapshot')
const runsIndex = arguments_.indexOf('--runs')

let runs = 1
if (runsIndex !== -1) {
  const runsValue = Number(arguments_[runsIndex + 1])
  if (!Number.isInteger(runsValue) || runsValue < 1) {
    console.error(`\n  Invalid value for '--runs'. Must be a positive integer.\n\n${USAGE}\n`)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
  runs = runsValue
}

if (snapshotIndex === -1) {
  void compareAgainstTag(runs)
} else {
  const snapshotName = arguments_[snapshotIndex + 1]
  if (!snapshotName) {
    console.error(`\n  Missing snapshot name for '--snapshot'.\n\n${USAGE}\n`)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
  void compareAgainstSnapshot(snapshotName, runs)
}
