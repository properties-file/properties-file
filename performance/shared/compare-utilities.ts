/** A single benchmark measurement (must match the shape written by `run.ts`). */
export type BenchmarkResult = {
  /** The benchmark name (e.g. "Properties constructor (Pure key/value)"). */
  name: string
  /** Operations per second (higher is better). */
  opsPerSecond: number
  /** Median latency in nanoseconds (lower is better). */
  medianNs: number
  /** Relative margin of error as a percentage (e.g. 1.23 means ±1.23%). */
  marginOfError: number
}

/** Regression threshold percentage. Changes beyond this value are flagged. */
export const THRESHOLD_PERCENT = 20

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
export const parseBenchmarkResults = (json: string): BenchmarkResult[] => {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || !parsed.every((item) => isBenchmarkResult(item))) {
    throw new Error('Invalid benchmark results JSON')
  }
  return parsed
}

// ─── Averaging logic ────────────────────────────────────────────────────────

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
  const grouped = new Map<string, { ops: number[]; median: number[]; moe: number[] }>()
  for (const run of runs) {
    for (const result of run) {
      let entry = grouped.get(result.name)
      if (!entry) {
        entry = { ops: [], median: [], moe: [] }
        grouped.set(result.name, entry)
      }
      entry.ops.push(result.opsPerSecond)
      entry.median.push(result.medianNs)
      entry.moe.push(result.marginOfError)
    }
  }

  const averaged: BenchmarkResult[] = []
  for (const [name, { ops, median, moe }] of grouped) {
    const count = ops.length
    averaged.push({
      name,
      opsPerSecond: Math.round(ops.reduce((a, b) => a + b, 0) / count),
      medianNs: Math.round(median.reduce((a, b) => a + b, 0) / count),
      marginOfError: Number(Math.sqrt(moe.reduce((a, b) => a + b * b, 0) / count).toFixed(2)),
    })
  }

  return averaged
}

// ─── Comparison logic ────────────────────────────────────────────────────────

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
 * Build a comparison between baseline and current benchmark results.
 *
 * @param baseline - Results from the baseline.
 * @param current - Results from the current run.
 *
 * @returns An array of comparison rows, one per benchmark.
 */
export const buildComparison = (
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
 * @returns The formatted string.
 */
export const formatChange = (changePercent: number | null): string =>
  changePercent === null ? 'N/A' : `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(1)}%`

/**
 * Format an ops/sec value with locale-aware thousand separators.
 *
 * @param ops - The ops/sec value, or `null` for new benchmarks.
 *
 * @returns The formatted string.
 */
export const formatOps = (ops: number | null): string =>
  ops === null ? '(new)' : ops.toLocaleString()

/**
 * Print a comparison table to stdout.
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
 * @param label - A label for the baseline (e.g. a tag name or snapshot name).
 * @param rows - The comparison rows to include.
 *
 * @returns The Markdown content.
 */
export const buildMarkdownReport = (label: string, rows: ComparisonRow[]): string => {
  const markdownIcons: Record<ComparisonStatus, string> = {
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
      `| ${row.name} | ${formatOps(row.baselineOps)} | ${formatOps(row.currentOps)} | ${formatChange(row.changePercent)} | ${markdownIcons[row.status]} |`
    )
  }

  lines.push(
    ``,
    `> ⚠️ = regression >${THRESHOLD_PERCENT}% · 🚀 = improvement >${THRESHOLD_PERCENT}% · ✅ = within threshold`
  )

  return lines.join('\n')
}
