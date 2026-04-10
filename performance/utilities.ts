import { existsSync } from 'node:fs'
import path from 'node:path'

import {
  getLatestPublishedVersion,
  getPublishedPackageDirectory,
} from './published-packages/manage'

// ─── Baseline Resolution ────────────────────────────────────────────────────

/** A resolved baseline containing the label and absolute path to its distribution directory. */
export type ResolvedBaseline = {
  /** Human-readable label for the baseline (e.g. "v4.0.0", "snapshot: approach-a"). */
  label: string
  /** Absolute path to the baseline's `dist/` directory. */
  distributionDirectory: string
}

/**
 * Parse `--version` and `--snapshot` CLI flags from the given arguments and resolve a baseline.
 *
 * Resolution rules:
 * - No flags: resolves to the latest published npm version (fetched and cached automatically).
 * - `--version <version>`: resolves to the specified published npm version (fetched and cached automatically).
 * - `--snapshot <name>`: resolves to the named local snapshot's `dist/` directory.
 *
 * The `--version` and `--snapshot` flags are mutually exclusive.
 *
 * @param arguments_ - The CLI arguments to parse (typically `process.argv.slice(2)`).
 *
 * @returns The resolved baseline with a label and absolute distribution directory path.
 *
 * @throws Error if both `--version` and `--snapshot` are provided.
 * @throws Error if a `--version` or `--snapshot` flag is provided without a value.
 * @throws Error if the resolved snapshot directory does not exist.
 */
export const resolveBaseline = (arguments_: string[]): ResolvedBaseline => {
  const versionFlagIndex = arguments_.indexOf('--version')
  const snapshotFlagIndex = arguments_.indexOf('--snapshot')

  const hasVersionFlag = versionFlagIndex !== -1
  const hasSnapshotFlag = snapshotFlagIndex !== -1

  if (hasVersionFlag && hasSnapshotFlag) {
    throw new Error('The --version and --snapshot flags are mutually exclusive. Provide only one.')
  }

  if (hasSnapshotFlag) {
    const snapshotName = arguments_[snapshotFlagIndex + 1]
    if (!snapshotName || snapshotName.startsWith('--')) {
      throw new Error('The --snapshot flag requires a snapshot name (e.g. --snapshot approach-a).')
    }
    return resolveSnapshotBaseline(snapshotName)
  }

  if (hasVersionFlag) {
    const version = arguments_[versionFlagIndex + 1]
    if (!version || version.startsWith('--')) {
      throw new Error('The --version flag requires a version number (e.g. --version 3.7.0).')
    }
    return resolvePublishedVersionBaseline(version)
  }

  return resolveLatestPublishedBaseline()
}

/**
 * Resolve a baseline from a named local snapshot.
 *
 * @param snapshotName - The snapshot name to resolve.
 *
 * @returns The resolved baseline pointing to the snapshot's distribution directory.
 *
 * @throws Error if the snapshot directory or its `dist/` subdirectory does not exist.
 */
const resolveSnapshotBaseline = (snapshotName: string): ResolvedBaseline => {
  const snapshotsDirectory = path.resolve(import.meta.dirname, 'snapshots', '.snapshots')
  const snapshotDistributionDirectory = path.resolve(
    snapshotsDirectory,
    snapshotName,
    'dist',
    'esm'
  )

  if (!existsSync(snapshotDistributionDirectory)) {
    const snapshotBaseDirectory = path.resolve(snapshotsDirectory, snapshotName)
    if (!existsSync(snapshotBaseDirectory)) {
      throw new Error(
        `Snapshot "${snapshotName}" not found. Run \`npm run snapshot -- list\` to see available snapshots.`
      )
    }
    throw new Error(
      `Snapshot "${snapshotName}" does not contain a dist/esm/ directory. Save a new snapshot after running \`npm run build\`.`
    )
  }

  return {
    label: `snapshot: ${snapshotName}`,
    distributionDirectory: snapshotDistributionDirectory,
  }
}

/**
 * Resolve a baseline from a specific published npm version.
 *
 * Delegates to `published-packages/manage.ts` to fetch and cache the package if needed.
 *
 * @param version - The npm version string (e.g. "3.7.0").
 *
 * @returns The resolved baseline pointing to the published package's distribution directory.
 */
const resolvePublishedVersionBaseline = (version: string): ResolvedBaseline => {
  const packageDirectory = getPublishedPackageDirectory(version)
  const distributionDirectory = path.resolve(packageDirectory, 'dist', 'esm')

  if (!existsSync(distributionDirectory)) {
    throw new Error(
      `Published package v${version} does not contain a dist/esm/ directory. The package may be too old or corrupted. Try deleting the cache and retrying.`
    )
  }

  return {
    label: `v${version}`,
    distributionDirectory,
  }
}

/**
 * Resolve a baseline from the latest published npm version.
 *
 * Delegates to `published-packages/manage.ts` to determine the latest version and cache it.
 *
 * @returns The resolved baseline pointing to the latest published package's distribution directory.
 */
const resolveLatestPublishedBaseline = (): ResolvedBaseline => {
  const latestVersion = getLatestPublishedVersion()
  const packageDirectory = getPublishedPackageDirectory(latestVersion)
  const distributionDirectory = path.resolve(packageDirectory, 'dist', 'esm')

  if (!existsSync(distributionDirectory)) {
    throw new Error(
      `Published package v${latestVersion} does not contain a dist/esm/ directory. The package may be corrupted. Try deleting the cache and retrying.`
    )
  }

  return {
    label: `v${latestVersion}`,
    distributionDirectory,
  }
}

// ─── Benchmark Types ────────────────────────────────────────────────────────

/** A single benchmark measurement (must match the shape written by the benchmark runner). */
export type BenchmarkResult = {
  /** The benchmark name (e.g. "Properties constructor (Pure key/value)"). */
  name: string
  /** Operations per second (higher is better). */
  opsPerSecond: number
  /** Median latency in nanoseconds (lower is better). */
  medianNs: number
  /** Relative margin of error as a percentage (e.g. 1.23 means +/-1.23%). */
  marginOfError: number
}

// ─── Type Guard ─────────────────────────────────────────────────────────────

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
 * @throws Error if the JSON is not a valid array of {@link BenchmarkResult} objects.
 */
export const parseBenchmarkResults = (json: string): BenchmarkResult[] => {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || !parsed.every((item) => isBenchmarkResult(item))) {
    throw new Error('Invalid benchmark results JSON')
  }
  return parsed
}

// ─── Averaging Logic ────────────────────────────────────────────────────────

/**
 * Average multiple benchmark runs into a single set of results.
 *
 * For each benchmark name, the averaged result uses the arithmetic mean of
 * `opsPerSecond` and `medianNs`, and the root-mean-square of `marginOfError`.
 *
 * @param runs - An array of benchmark result arrays (one per run).
 *
 * @returns A single array of averaged benchmark results.
 */
export const averageBenchmarkResults = (runs: BenchmarkResult[][]): BenchmarkResult[] => {
  if (runs.length === 1) {
    return runs[0]
  }

  // Collect all values per benchmark name.
  const grouped = new Map<
    string,
    {
      opsPerSecondValues: number[]
      medianNanosecondValues: number[]
      marginOfErrorValues: number[]
    }
  >()
  for (const run of runs) {
    for (const result of run) {
      let entry = grouped.get(result.name)
      if (!entry) {
        entry = { opsPerSecondValues: [], medianNanosecondValues: [], marginOfErrorValues: [] }
        grouped.set(result.name, entry)
      }
      entry.opsPerSecondValues.push(result.opsPerSecond)
      entry.medianNanosecondValues.push(result.medianNs)
      entry.marginOfErrorValues.push(result.marginOfError)
    }
  }

  const averaged: BenchmarkResult[] = []
  for (const [
    name,
    { opsPerSecondValues, medianNanosecondValues, marginOfErrorValues },
  ] of grouped) {
    const count = opsPerSecondValues.length
    averaged.push({
      name,
      opsPerSecond: Math.round(opsPerSecondValues.reduce((sum, value) => sum + value, 0) / count),
      medianNs: Math.round(medianNanosecondValues.reduce((sum, value) => sum + value, 0) / count),
      marginOfError: Number(
        Math.sqrt(
          marginOfErrorValues.reduce((sum, value) => sum + value * value, 0) / count
        ).toFixed(2)
      ),
    })
  }

  return averaged
}

// ─── Threshold Logic ────────────────────────────────────────────────────────

/** Regression threshold percentage. Changes beyond this value are flagged. */
export const THRESHOLD_PERCENT = 20

/**
 * Determine whether a percentage change exceeds the regression threshold.
 *
 * A regression is detected when the change is a negative value whose absolute
 * magnitude exceeds {@link THRESHOLD_PERCENT}.
 *
 * @param changePercent - The percentage change (negative means slower / larger).
 *
 * @returns `true` if the change represents a regression beyond the threshold.
 */
export const exceedsRegressionThreshold = (changePercent: number): boolean =>
  changePercent <= -THRESHOLD_PERCENT

// ─── Comparison Types ───────────────────────────────────────────────────────

/** Status label for a benchmark comparison row. Empty string indicates a new benchmark with no baseline. */
export type ComparisonStatus = 'REGR' | 'FAST' | 'OK' | ''

/** A single row in the benchmark comparison table. */
export type ComparisonRow = {
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
 * Check whether any row in a comparison set has a regression that exceeds the threshold.
 *
 * This is the gate check used by pre-release validation: if any benchmark regressed beyond
 * {@link THRESHOLD_PERCENT}, the tool should exit with a non-zero code.
 *
 * @param rows - The comparison rows to evaluate.
 *
 * @returns `true` if at least one row has a regression exceeding the threshold.
 */
export const hasRegressions = (rows: ComparisonRow[]): boolean =>
  rows.some((row) => row.status === 'REGR')

// ─── Comparison Logic ───────────────────────────────────────────────────────

/**
 * Build a comparison between baseline and current benchmark results.
 *
 * Each current result is matched against the baseline by name. If a current benchmark
 * has no baseline counterpart, its status is empty and `changePercent` is `null`.
 *
 * @param baseline - Results from the baseline measurement.
 * @param current - Results from the current measurement.
 *
 * @returns An array of comparison rows, one per current benchmark.
 */
export const buildComparison = (
  baseline: BenchmarkResult[],
  current: BenchmarkResult[]
): ComparisonRow[] => {
  const baselineMap = new Map(baseline.map((result) => [result.name, result]))
  return current.map((currentResult) => {
    const baselineResult = baselineMap.get(currentResult.name)
    if (!baselineResult) {
      return {
        name: currentResult.name,
        baselineOps: null,
        currentOps: currentResult.opsPerSecond,
        changePercent: null,
        status: '',
      }
    }
    const changePercent =
      ((currentResult.opsPerSecond - baselineResult.opsPerSecond) / baselineResult.opsPerSecond) *
      100
    const status: ComparisonStatus =
      changePercent <= -THRESHOLD_PERCENT
        ? 'REGR'
        : changePercent >= THRESHOLD_PERCENT
          ? 'FAST'
          : 'OK'
    return {
      name: currentResult.name,
      baselineOps: baselineResult.opsPerSecond,
      currentOps: currentResult.opsPerSecond,
      changePercent,
      status,
    }
  })
}

// ─── Formatting Helpers ─────────────────────────────────────────────────────

/** Map a {@link ComparisonStatus} to a human-readable icon and label for terminal output. */
export const STATUS_ICONS: Record<ComparisonStatus, string> = {
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
 * @returns The formatted percentage string, or `"N/A"` for null values.
 */
export const formatChange = (changePercent: number | null): string =>
  changePercent === null ? 'N/A' : `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(1)}%`

/**
 * Format an ops/sec value with locale-aware thousand separators.
 *
 * @param ops - The ops/sec value, or `null` for missing benchmarks.
 *
 * @returns The formatted ops/sec string, or `"(new)"` for null values.
 */
export const formatOps = (ops: number | null): string =>
  ops === null ? '(new)' : ops.toLocaleString()

/**
 * Print a comparison table to stdout.
 *
 * Outputs a fixed-width text table with columns for benchmark name, baseline ops/sec,
 * current ops/sec, percentage change, and status.
 *
 * @param rows - The comparison rows to display.
 */
export const printComparison = (rows: ComparisonRow[]): void => {
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
 * Build a Markdown comparison report as a string.
 *
 * Generates a Markdown table suitable for writing to a file or posting as a PR comment.
 *
 * @param label - A label for the baseline (e.g. a version tag or snapshot name).
 * @param rows - The comparison rows to include in the report.
 *
 * @returns The complete Markdown report content.
 */
export const buildMarkdownReport = (label: string, rows: ComparisonRow[]): string => {
  const markdownStatusIcons: Record<ComparisonStatus, string> = {
    REGR: '⚠️ REGR',
    FAST: '🚀 FAST',
    OK: '✅ OK',
    '': '',
  }

  const lines: string[] = [
    `# Benchmark Comparison`,
    ``,
    `**Baseline:** ${label}`,
    `**Date:** ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    ``,
    `| Benchmark | Baseline (ops/sec) | Current (ops/sec) | Change | Status |`,
    `|---|---:|---:|---:|---|`,
  ]

  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${formatOps(row.baselineOps)} | ${formatOps(row.currentOps)} | ${formatChange(row.changePercent)} | ${markdownStatusIcons[row.status]} |`
    )
  }

  lines.push(
    ``,
    `> ⚠️ = regression >${THRESHOLD_PERCENT}% · 🚀 = improvement >${THRESHOLD_PERCENT}% · ✅ = within threshold`
  )

  return lines.join('\n')
}
