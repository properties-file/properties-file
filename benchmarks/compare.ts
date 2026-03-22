import { exec, execSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BenchmarkResult } from './run'

/** Regression threshold percentage. Changes beyond ±20% are flagged. */
const THRESHOLD_PERCENT = 20

const rootDirectory = path.resolve(import.meta.dirname, '..')
const resultsDirectory = path.resolve(import.meta.dirname, '.results')
const temporaryDirectory = path.resolve(resultsDirectory, '.tmp')
const baselineTemporaryDirectory = path.resolve(temporaryDirectory, 'baseline')
const currentTemporaryDirectory = path.resolve(temporaryDirectory, 'current')
const baselinePath = path.resolve(resultsDirectory, 'baseline', 'results.json')
const currentPath = path.resolve(resultsDirectory, 'current', 'results.json')
const reportPath = path.resolve(resultsDirectory, 'comparison.md')

/** Directories copied into each isolated benchmark environment. */
const PROJECT_DIRECTORIES = ['src', 'benchmarks', 'node_modules', 'assets']

// ─── Type guard ──────────────────────────────────────────────────────────────

/**
 * Check if a value conforms to the {@link BenchmarkResult} shape.
 *
 * @param value - The value to validate.
 *
 * @returns `true` if the value is a valid benchmark result.
 */
const isBenchmarkResult = (value: unknown): value is BenchmarkResult =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'opsPerSecond' in value &&
  typeof value.opsPerSecond === 'number' &&
  'medianNs' in value &&
  typeof value.medianNs === 'number' &&
  'marginOfError' in value &&
  typeof value.marginOfError === 'number'

/**
 * Parse and validate a JSON string as an array of benchmark results.
 *
 * @param json - Raw JSON string (expected to be a `BenchmarkResult[]`).
 *
 * @returns The parsed and validated benchmark results.
 *
 * @throws Error if the JSON does not match the expected shape.
 */
const parseBenchmarkResults = (json: string): BenchmarkResult[] => {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || !parsed.every((item) => isBenchmarkResult(item))) {
    throw new Error('Invalid benchmark results JSON')
  }
  return parsed
}

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
    const child = exec(`npx tsx benchmarks/run.ts "${outputPath}"`, { cwd: directory }, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
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

// ─── Comparison logic ────────────────────────────────────────────────────────

/** Status label for a benchmark comparison row. Empty string indicates a new benchmark with no baseline. */
type ComparisonStatus = 'REGR' | 'FAST' | 'OK' | ''

/** A single row in the benchmark comparison table. */
type ComparisonRow = {
  /** The benchmark name. */
  name: string
  /** Baseline ops/sec, or `null` if the benchmark is new. */
  baselineOps: number | null
  /** Current ops/sec. */
  currentOps: number | null
  /** Percentage change from baseline, or `null` if the benchmark is new. */
  changePercent: number | null
  /** Comparison status based on {@link THRESHOLD_PERCENT}. */
  status: ComparisonStatus
}

/**
 * Build a comparison between baseline and current benchmark results.
 *
 * @param baseline - Results from the latest release tag.
 * @param current - Results from the current working tree.
 *
 * @returns An array of comparison rows, one per benchmark.
 */
const buildComparison = (
  baseline: BenchmarkResult[],
  current: BenchmarkResult[]
): ComparisonRow[] => {
  const baselineMap = new Map(baseline.map((result) => [result.name, result]))
  return current.map((currentResult) => {
    const base = baselineMap.get(currentResult.name)
    if (!base) {
      return {
        name: currentResult.name,
        baselineOps: null,
        currentOps: currentResult.opsPerSecond,
        changePercent: null,
        status: '',
      }
    }
    const changePercent =
      ((currentResult.opsPerSecond - base.opsPerSecond) / base.opsPerSecond) * 100
    const status =
      changePercent <= -THRESHOLD_PERCENT
        ? 'REGR'
        : changePercent >= THRESHOLD_PERCENT
          ? 'FAST'
          : 'OK'
    return {
      name: currentResult.name,
      baselineOps: base.opsPerSecond,
      currentOps: currentResult.opsPerSecond,
      changePercent,
      status,
    }
  })
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

/** Map a {@link ComparisonStatus} to a human-readable icon + label. */
const STATUS_ICONS: Record<ComparisonStatus, string> = {
  REGR: '⚠️  REGR',
  FAST: '🚀 FAST',
  OK: '✅ OK',
  '': '',
}

/**
 * Format a percentage change as a signed string (e.g. `+1.2%` or `-3.4%`).
 *
 * @param changePercent - The percentage change, or `null` for new benchmarks.
 *
 * @returns The formatted string.
 */
const formatChange = (changePercent: number | null): string =>
  changePercent === null ? 'N/A' : `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(1)}%`

/**
 * Format an ops/sec value with locale-aware thousand separators.
 *
 * @param ops - The ops/sec value, or `null` for new benchmarks.
 *
 * @returns The formatted string.
 */
const formatOps = (ops: number | null): string => (ops === null ? '(new)' : ops.toLocaleString())

/**
 * Print a comparison table to stdout.
 *
 * @param rows - The comparison rows to display.
 */
const printComparison = (rows: ComparisonRow[]): void => {
  const nameWidth = Math.max(12, ...rows.map((row) => row.name.length))
  const header = `${'Benchmark'.padEnd(nameWidth)}  ${'baseline'.padStart(12)}  ${'current'.padStart(12)}  ${'change'.padStart(10)}  ${'status'.padStart(8)}`
  const separator = '-'.repeat(header.length)

  console.log('\n' + separator)
  console.log(header)
  console.log(separator)

  for (const row of rows) {
    console.log(
      `${row.name.padEnd(nameWidth)}  ${formatOps(row.baselineOps).padStart(12)}  ${formatOps(row.currentOps).padStart(12)}  ${formatChange(row.changePercent).padStart(10)}  ${STATUS_ICONS[row.status].padStart(8)}`
    )
  }

  console.log(separator)
}

/**
 * Write a Markdown comparison report to disk.
 *
 * @param tag - The baseline release tag (e.g. `v3.7.0`).
 * @param rows - The comparison rows to include.
 */
const writeMarkdownReport = (tag: string, rows: ComparisonRow[]): void => {
  /** Map a {@link ComparisonStatus} to a compact Markdown icon. */
  const markdownIcons: Record<ComparisonStatus, string> = {
    REGR: '⚠️ REGR',
    FAST: '🚀 FAST',
    OK: '✅ OK',
    '': '',
  }

  const lines: string[] = [
    `# Benchmark Comparison`,
    ``,
    `**Baseline:** ${tag}`,
    `**Date:** ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    ``,
    `| Benchmark | Baseline (ops/sec) | Current (ops/sec) | Change | Status |`,
    `|---|---:|---:|---:|---|`,
  ]

  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${formatOps(row.baselineOps)} | ${formatOps(row.currentOps)} | ${formatChange(row.changePercent)} | ${markdownIcons[row.status]} |`
    )
  }

  lines.push(
    ``,
    `> ⚠️ = regression >${THRESHOLD_PERCENT}% · 🚀 = improvement >${THRESHOLD_PERCENT}% · ✅ = within threshold`
  )

  writeFileSync(reportPath, lines.join('\n'))
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Compare current benchmarks against the latest release tag.
 *
 * Creates two isolated project copies, replaces the baseline's `src/` with the
 * tagged version, runs both in parallel for fair comparison, then produces a
 * terminal table and a Markdown report.
 */
const main = async (): Promise<void> => {
  mkdirSync(path.resolve(resultsDirectory, 'baseline'), { recursive: true })
  mkdirSync(path.resolve(resultsDirectory, 'current'), { recursive: true })

  const tag = getLatestReleaseTag()
  console.log(`Comparing against latest release: ${tag}\n`)

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

  const baseline = parseBenchmarkResults(readFileSync(baselinePath, 'utf8'))
  const current = parseBenchmarkResults(readFileSync(currentPath, 'utf8'))

  const rows = buildComparison(baseline, current)
  printComparison(rows)
  writeMarkdownReport(tag, rows)

  console.log(`\nReport saved to ${reportPath}`)
  console.log(`JSON results: ${baselinePath}, ${currentPath}`)
}

void main()
