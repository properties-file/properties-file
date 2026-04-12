import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  averageBenchmarkResults,
  buildComparison,
  buildMarkdownReport,
  hasRegressions,
  printComparison,
  resolveBaseline,
} from '../utilities'

import { runEscapeUnescapeBenchmarks } from './suites/escape-unescape.bench'
import { runEditorBenchmarks } from './suites/properties-editor.bench'
import { runPropertiesBenchmarks } from './suites/properties.bench'

import type { BenchmarkResult } from '../utilities'
import type { EscapeModule, UnescapeModule } from './suites/escape-unescape.bench'
import type { PropertiesEditorModule } from './suites/properties-editor.bench'
import type { PropertiesModule } from './suites/properties.bench'
import type { Bench } from 'tinybench'

// ─── Paths ─────────────────────────────────────────────────────────────────

const rootDirectory = path.resolve(import.meta.dirname, '..', '..')
const currentDistributionEsmDirectory = path.resolve(rootDirectory, 'dist', 'esm')
const resultsDirectory = path.resolve(import.meta.dirname, '.results')

// ─── Module Loading ────────────────────────────────────────────────────────

/** All modules required to run every benchmark suite against a single build. */
type BenchmarkModules = {
  properties: PropertiesModule
  editor: PropertiesEditorModule
  escape: EscapeModule
  unescape: UnescapeModule
}

/**
 * Dynamically import all benchmark-relevant modules from a `dist/esm/` directory.
 *
 * Each import uses a cache-busting query parameter so that Node.js loads distinct
 * module instances for the current and baseline builds, even when called in
 * the same process.
 *
 * @param distEsmDirectory - Absolute path to a `dist/esm/` directory.
 * @param cacheBustSuffix - A unique suffix appended as a query parameter to prevent module caching.
 *
 * @returns All modules needed by the benchmark suites.
 */
const loadModules = async (
  distributionEsmDirectory: string,
  cacheBustSuffix: string
): Promise<BenchmarkModules> => {
  const indexPath = path.resolve(distributionEsmDirectory, 'index.js')
  const parserPath = path.resolve(distributionEsmDirectory, 'parser', 'index.js')
  const editorPath = path.resolve(distributionEsmDirectory, 'editor', 'index.js')
  const escapePath = path.resolve(distributionEsmDirectory, 'escape', 'index.js')
  const unescapePath = path.resolve(distributionEsmDirectory, 'unescape', 'index.js')

  // index.js and editor are always required; parser may not exist in older baselines.
  for (const filePath of [indexPath, editorPath, escapePath, unescapePath]) {
    if (!existsSync(filePath)) {
      throw new Error(
        `Required module not found: ${filePath}\n` +
          `Ensure the build has been compiled. Run \`npm run build\` first.`
      )
    }
  }

  const [indexModule, editorModule, escapeModule, unescapeModule] = await Promise.all([
    import(`${indexPath}?v=${cacheBustSuffix}`) as Promise<PropertiesModule>,
    import(`${editorPath}?v=${cacheBustSuffix}`) as Promise<PropertiesEditorModule>,
    import(`${escapePath}?v=${cacheBustSuffix}`) as Promise<EscapeModule>,
    import(`${unescapePath}?v=${cacheBustSuffix}`) as Promise<UnescapeModule>,
  ])

  // In v5+, Properties lives in parser/index.js instead of index.js.
  // Fall back to index.js for older baselines where Properties was in the main entry.
  const parserModule = existsSync(parserPath)
    ? ((await import(`${parserPath}?v=${cacheBustSuffix}`)) as PropertiesModule)
    : undefined

  return {
    properties: {
      getProperties: indexModule.getProperties,
      Properties: parserModule?.Properties ?? indexModule.Properties,
    },
    editor: editorModule,
    escape: escapeModule,
    unescape: unescapeModule,
  }
}

// ─── Benchmark Execution ───────────────────────────────────────────────────

/**
 * Extract results from a completed tinybench run.
 *
 * @param bench - A tinybench `Bench` instance that has already been run.
 *
 * @returns An array of benchmark results, one per task.
 *
 * @throws Error if any task did not complete successfully.
 */
const extractResults = (bench: Bench): BenchmarkResult[] =>
  bench.tasks.map((task) => {
    const { result } = task
    if (result.state !== 'completed') {
      throw new Error(`Benchmark "${task.name}" did not complete (state: ${result.state})`)
    }
    return {
      name: task.name,
      opsPerSecond: Math.round(result.throughput.mean),
      medianNs: Math.round(result.latency.p50 * 1_000_000),
      marginOfError: Number(result.latency.rme.toFixed(2)),
    }
  })

/**
 * Print a human-readable table of benchmark results to stdout.
 *
 * @param label - A label to display above the table (e.g. "Current" or "Baseline").
 * @param results - The benchmark results to display.
 */
const printResultsTable = (label: string, results: BenchmarkResult[]): void => {
  const nameWidth = Math.max(12, ...results.map((result) => result.name.length))
  const header = `${'Benchmark'.padEnd(nameWidth)}  ${'ops/sec'.padStart(12)}  ${'median (ns)'.padStart(14)}  ${'\u00B1%'.padStart(8)}`
  const separator = '-'.repeat(header.length)

  console.log(`\n${label}:`)
  console.log(separator)
  console.log(header)
  console.log(separator)

  for (const result of results) {
    console.log(
      `${result.name.padEnd(nameWidth)}  ${result.opsPerSecond.toLocaleString().padStart(12)}  ${result.medianNs.toLocaleString().padStart(14)}  ${`\u00B1${result.marginOfError}%`.padStart(8)}`
    )
  }

  console.log(separator)
}

/**
 * Run all benchmark suites against a set of dynamically loaded modules.
 *
 * Executes the Properties, PropertiesEditor, and escape/unescape suites sequentially
 * and aggregates their results into a single flat array.
 *
 * @param modules - The dynamically imported modules to benchmark.
 *
 * @returns A flat array of all benchmark results across all suites.
 */
const runAllSuites = async (
  modules: BenchmarkModules,
  suiteFilter?: string
): Promise<BenchmarkResult[]> => {
  const results: BenchmarkResult[] = []

  if (!suiteFilter || suiteFilter === 'properties') {
    const propertiesBench = await runPropertiesBenchmarks(modules.properties)
    results.push(...extractResults(propertiesBench))
  }
  if (!suiteFilter || suiteFilter === 'editor') {
    const editorBench = await runEditorBenchmarks(modules.editor)
    results.push(...extractResults(editorBench))
  }
  if (!suiteFilter || suiteFilter === 'escape') {
    const escapeUnescapeBench = await runEscapeUnescapeBenchmarks(modules.escape, modules.unescape)
    results.push(...extractResults(escapeUnescapeBench))
  }

  return results
}

// ─── CLI Parsing ───────────────────────────────────────────────────────────

const USAGE = `Usage: npx tsx performance/benchmarks/compare.ts [options]

Options:
  --version <ver>    Compare against a specific published npm version
  --snapshot <name>  Compare against a saved snapshot
  --runs <n>         Run benchmarks n times and average results (default: 1)
  --suite <name>     Run only a specific suite: properties, editor, or escape
  --strict           Exit with code 1 if regressions exceed threshold

If no --version or --snapshot is given, compares against the latest published version.

Examples:
  npx tsx performance/benchmarks/compare.ts
  npx tsx performance/benchmarks/compare.ts --version 3.7.0
  npx tsx performance/benchmarks/compare.ts --suite properties
  npx tsx performance/benchmarks/compare.ts --suite properties --runs 3
  npm run benchmark
  npm run benchmark -- --suite properties --runs 5`

/**
 * Parse the `--runs` flag from CLI arguments.
 *
 * @param arguments_ - The CLI arguments to parse.
 *
 * @returns The number of runs requested (defaults to 1).
 */
const parseRunsFlag = (arguments_: string[]): number => {
  const runsIndex = arguments_.indexOf('--runs')
  if (runsIndex === -1) {
    return 1
  }
  const runsValue = Number(arguments_[runsIndex + 1])
  if (!Number.isInteger(runsValue) || runsValue < 1) {
    console.error(`\n  Invalid value for '--runs'. Must be a positive integer.\n\n${USAGE}\n`)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
  return runsValue
}

// ─── Main ──────────────────────────────────────────────────────────────────

/**
 * Run the benchmark comparison: current build vs resolved baseline.
 *
 * Steps:
 * 1. Parse CLI arguments for `--version`, `--snapshot`, and `--runs`.
 * 2. Resolve the baseline `dist/esm/` path via `resolveBaseline()`.
 * 3. Validate the current `dist/esm/` exists.
 * 4. Dynamically import modules from both `dist/esm/` paths.
 * 5. Run benchmark suites in parallel (current vs baseline) for each run.
 * 6. Average results across runs if `--runs` \> 1.
 * 7. Print results tables and comparison, save outputs to `.results/`.
 * 8. Exit with code 1 if regressions are detected.
 */
const main = async (): Promise<void> => {
  const arguments_ = process.argv.slice(2)

  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    console.log(USAGE)
    return
  }

  // Validate the current build exists.
  if (!existsSync(currentDistributionEsmDirectory)) {
    console.error(
      'Error: ./dist/esm/ not found. Run `npm run build` first to compile the current code.'
    )
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }

  const runs = parseRunsFlag(arguments_)
  const suiteIndex = arguments_.indexOf('--suite')
  const suiteFilter =
    suiteIndex !== -1 && arguments_[suiteIndex + 1] ? arguments_[suiteIndex + 1] : undefined
  const baseline = resolveBaseline(arguments_)

  console.log(`Comparing current build against baseline: ${baseline.label}`)
  if (runs > 1) {
    console.log(`Averaging over ${runs} runs`)
  }
  console.log('')

  // Load modules from both dist/esm/ directories.
  // Use a shared timestamp to cache-bust, with unique suffixes for current vs baseline.
  const timestamp = Date.now()

  const baselineRunResults: BenchmarkResult[][] = []
  const currentRunResults: BenchmarkResult[][] = []

  for (let run = 1; run <= runs; run++) {
    if (runs > 1) {
      console.log(`\n── Run ${run}/${runs} ──`)
    }

    // Each run gets unique cache-bust suffixes so Node.js reloads modules fresh.
    const runSuffix = `${timestamp}-run${run}`
    const currentModules = await loadModules(
      currentDistributionEsmDirectory,
      `current-${runSuffix}`
    )
    const baselineModules = await loadModules(
      baseline.distributionDirectory,
      `baseline-${runSuffix}`
    )

    // Run both suites in parallel so they share the same system conditions.
    console.log('Running benchmarks in parallel (current + baseline)...')
    const [currentResults, baselineResults] = await Promise.all([
      runAllSuites(currentModules, suiteFilter),
      runAllSuites(baselineModules, suiteFilter),
    ])

    currentRunResults.push(currentResults)
    baselineRunResults.push(baselineResults)
  }

  // Average results across all runs.
  const averagedCurrentResults = averageBenchmarkResults(currentRunResults)
  const averagedBaselineResults = averageBenchmarkResults(baselineRunResults)

  // Print individual results tables.
  printResultsTable(`Baseline (${baseline.label})`, averagedBaselineResults)
  printResultsTable('Current', averagedCurrentResults)

  // Build and print comparison.
  const comparisonRows = buildComparison(averagedBaselineResults, averagedCurrentResults)
  printComparison(comparisonRows)

  // Save all results to .results/.
  mkdirSync(resultsDirectory, { recursive: true })

  const currentJsonPath = path.resolve(resultsDirectory, 'current.json')
  const baselineJsonPath = path.resolve(resultsDirectory, 'baseline.json')
  const comparisonJsonPath = path.resolve(resultsDirectory, 'comparison.json')
  const comparisonMarkdownPath = path.resolve(resultsDirectory, 'comparison.md')

  writeFileSync(currentJsonPath, JSON.stringify(averagedCurrentResults, null, 2))
  writeFileSync(baselineJsonPath, JSON.stringify(averagedBaselineResults, null, 2))
  writeFileSync(comparisonJsonPath, JSON.stringify(comparisonRows, null, 2))
  writeFileSync(comparisonMarkdownPath, buildMarkdownReport(baseline.label, comparisonRows))

  console.log(`\nResults saved to ${resultsDirectory}/`)
  console.log(`  current.json, baseline.json, comparison.json, comparison.md`)

  // In strict mode, exit with failure code if regressions detected.
  // Strict mode is used by the pre-release gate; normal runs only report regressions.
  const isStrictMode = arguments_.includes('--strict')
  if (isStrictMode && hasRegressions(comparisonRows)) {
    throw new Error('Performance regressions detected. See comparison above.')
  }
}

void main()
