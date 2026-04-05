import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { runEscapeUnescapeBenchmarks } from './suites/escape-unescape.bench'
import { runEditorBenchmarks } from './suites/properties-editor.bench'
import { runPropertiesBenchmarks } from './suites/properties.bench'

import type { BenchmarkResult } from '../shared/compare-utilities'
import type { Bench } from 'tinybench'

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
 * @param results - The benchmark results to display.
 */
const printTable = (results: BenchmarkResult[]): void => {
  const nameWidth = Math.max(12, ...results.map((result) => result.name.length))
  const header = `${'Benchmark'.padEnd(nameWidth)}  ${'ops/sec'.padStart(12)}  ${'median (ns)'.padStart(14)}  ${'±%'.padStart(8)}`
  const separator = '-'.repeat(header.length)

  console.log(separator)
  console.log(header)
  console.log(separator)

  for (const result of results) {
    console.log(
      `${result.name.padEnd(nameWidth)}  ${result.opsPerSecond.toLocaleString().padStart(12)}  ${result.medianNs.toLocaleString().padStart(14)}  ${`±${result.marginOfError}%`.padStart(8)}`
    )
  }

  console.log(separator)
}

/**
 * Run all benchmark suites, print results, and write them to a JSON file.
 *
 * An optional output path can be passed as the first CLI argument; otherwise
 * results are written to `performance/benchmarks/.results/results.json`.
 */
const main = async (): Promise<void> => {
  const outputPath = process.argv[2]

  console.log('Running Properties benchmarks...')
  const propertiesBench = await runPropertiesBenchmarks()

  console.log('Running PropertiesEditor benchmarks...')
  const editorBench = await runEditorBenchmarks()

  console.log('Running escape/unescape benchmarks...')
  const escapeUnescapeBench = await runEscapeUnescapeBenchmarks()

  const allResults = [
    ...extractResults(propertiesBench),
    ...extractResults(editorBench),
    ...extractResults(escapeUnescapeBench),
  ]

  console.log('\n')
  printTable(allResults)

  const resultsDirectory = path.resolve(import.meta.dirname, '.results')
  mkdirSync(resultsDirectory, { recursive: true })
  const jsonPath = outputPath || path.resolve(resultsDirectory, 'results.json')
  writeFileSync(jsonPath, JSON.stringify(allResults, null, 2))
  console.log(`\nResults written to ${jsonPath}`)
}

void main()
