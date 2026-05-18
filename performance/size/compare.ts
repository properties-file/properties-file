import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { resolveBaseline } from '../utilities'

const rootDirectory = path.resolve(import.meta.dirname, '..', '..')
const readmePath = path.resolve(rootDirectory, 'README.md')
const resultsDirectory = path.resolve(import.meta.dirname, '.results')
const currentDistributionEsmDirectory = path.resolve(rootDirectory, 'dist', 'esm')

/** Size regression threshold percentage. Entry points that grow beyond this are flagged. */
const SIZE_THRESHOLD_PERCENT = 10

// ─── Entry Points ──────────────────────────────────────────────────────────

/** An entry point to measure, with a factory that builds the import code for any dist path. */
type EntryPoint = {
  /** Human-readable name for the entry point. */
  name: string
  /** Relative import file within `dist/esm/`. */
  importPath: string
  /** Build the JavaScript import code given an absolute `dist/esm/` path. */
  code: (distributionEsmPath: string) => string
}

/**
 * Resolve the Properties import path for a given distribution.
 *
 * In v5+, Properties lives in `parser/index.js`. In v4 and earlier, it was
 * in the main `index.js`.
 *
 * @param distributionEsmPath - Absolute path to the `dist/esm/` directory.
 *
 * @returns The resolved import path for the Properties class.
 */
const resolvePropertiesImport = (distributionEsmPath: string): string => {
  const parserPath = path.resolve(distributionEsmPath, 'parser', 'index.js')
  return existsSync(parserPath)
    ? `${distributionEsmPath}/parser/index.js`
    : `${distributionEsmPath}/index.js`
}

/**
 * Entry points to measure. Each represents a common import pattern that users
 * would use in their applications. esbuild tree-shakes away unused code.
 */
const ENTRY_POINTS: EntryPoint[] = [
  {
    name: 'getProperties',
    importPath: 'index.js',
    code: (distributionEsmPath: string): string =>
      `import { getProperties } from "${distributionEsmPath}/index.js"; console.log(getProperties);`,
  },
  {
    name: 'Properties',
    importPath: 'index.js',
    code: (distributionEsmPath: string): string =>
      `import { Properties } from "${resolvePropertiesImport(distributionEsmPath)}"; console.log(Properties);`,
  },
  {
    name: 'PropertiesEditor',
    importPath: 'editor/index.js',
    code: (distributionEsmPath: string): string =>
      `import { PropertiesEditor } from "${distributionEsmPath}/editor/index.js"; console.log(PropertiesEditor);`,
  },
  {
    name: 'escapeKey + escapeValue',
    importPath: 'escape/index.js',
    code: (distributionEsmPath: string): string =>
      `import { escapeKey, escapeValue } from "${distributionEsmPath}/escape/index.js"; console.log(escapeKey, escapeValue);`,
  },
  {
    name: 'All exports (*)',
    importPath: 'index.js',
    code: (distributionEsmPath: string): string => {
      const propertiesImport = resolvePropertiesImport(distributionEsmPath)
      return [
        `import { getProperties } from "${distributionEsmPath}/index.js";`,
        `import { Properties } from "${propertiesImport}";`,
        `import { PropertiesEditor } from "${distributionEsmPath}/editor/index.js";`,
        `import { escapeKey, escapeValue } from "${distributionEsmPath}/escape/index.js";`,
        `import { unescapeContent } from "${distributionEsmPath}/unescape/index.js";`,
        `console.log(getProperties, Properties, PropertiesEditor, escapeKey, escapeValue, unescapeContent);`,
      ].join(' ')
    },
  },
]

// ─── Types ─────────────────────────────────────────────────────────────────

/** A single size measurement for one entry point. */
type SizeResult = {
  /** The entry point name. */
  name: string
  /** Raw bundled (unminified) size in bytes. */
  bundled: number
  /** Minified size in bytes. */
  minified: number
  /** Gzipped size of the minified output in bytes. */
  gzipped: number
}

/** Comparison status for a single entry point. */
type SizeComparisonStatus = 'BIGGER' | 'SMALLER' | 'OK' | ''

/** A single row in the size comparison table. */
type SizeComparisonRow = {
  /** The entry point name. */
  name: string
  /** Baseline gzipped size in bytes, or `null` if the entry point is new. */
  baselineGzipped: number | null
  /** Current gzipped size in bytes. */
  currentGzipped: number
  /** Percentage change from baseline, or `null` if the entry point is new. */
  changePercent: number | null
  /** Comparison status based on {@link SIZE_THRESHOLD_PERCENT}. */
  status: SizeComparisonStatus
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Format a byte count as a human-readable string (e.g. "1.9 kB").
 *
 * @param bytes - The byte count.
 *
 * @returns The formatted string.
 */
const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`

/**
 * Bundle an entry point with esbuild and return the bundled and minified output.
 *
 * @param code - The JavaScript import code to bundle.
 *
 * @returns An object containing the bundled and minified output strings.
 *
 * @throws Error if esbuild fails to bundle the code.
 */
const bundle = (code: string): { bundled: string; minified: string } => {
  try {
    const bundled = execSync('npx esbuild --bundle --format=esm --tree-shaking=true', {
      input: code,
      cwd: rootDirectory,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const minified = execSync('npx esbuild --bundle --format=esm --minify --tree-shaking=true', {
      input: code,
      cwd: rootDirectory,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { bundled, minified }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred during bundling.'
    throw new Error(`esbuild failed to bundle entry point.\n\nCode: ${code}\n\nDetails: ${message}`)
  }
}

/**
 * Measure the size of a single entry point using a specific `dist/esm/` path.
 *
 * @param entryPoint - The entry point definition.
 * @param distributionEsmPath - Absolute path to the `dist/esm/` directory to measure.
 *
 * @returns The size measurement.
 */
const measureEntryPoint = (
  entryPoint: EntryPoint,
  distributionEsmPath: string
): SizeResult | null => {
  const code = entryPoint.code(distributionEsmPath)
  try {
    const { bundled, minified } = bundle(code)
    const gzipped = gzipSync(minified)
    return {
      name: entryPoint.name,
      bundled: Buffer.byteLength(bundled),
      minified: Buffer.byteLength(minified),
      gzipped: gzipped.length,
    }
  } catch {
    // Entry point may not exist in this distribution (e.g. baseline vs current).
    return null
  }
}

/**
 * Measure all entry points against a given `dist/esm/` directory.
 *
 * @param distributionEsmPath - Absolute path to the `dist/esm/` directory.
 *
 * @returns An array of size results, one per entry point.
 */
const measureAll = (distributionEsmPath: string): SizeResult[] =>
  ENTRY_POINTS.map((entryPoint) => measureEntryPoint(entryPoint, distributionEsmPath)).filter(
    (result): result is SizeResult => result !== null
  )

// ─── Output Formatting ─────────────────────────────────────────────────────

/**
 * Print a size results table to stdout.
 *
 * @param results - The size results to print.
 * @param label - Optional label for the table header.
 */
const printTable = (results: SizeResult[], label?: string): void => {
  if (label) {
    console.log(`\n${label}`)
  }

  const nameWidth = Math.max(12, ...results.map((result) => result.name.length))
  const header = `${'Entry point'.padEnd(nameWidth)}  ${'bundled'.padStart(10)}  ${'minified'.padStart(10)}  ${'gzipped'.padStart(10)}`
  const separator = '-'.repeat(header.length)

  console.log(separator)
  console.log(header)
  console.log(separator)

  for (const result of results) {
    console.log(
      `${result.name.padEnd(nameWidth)}  ${formatBytes(result.bundled).padStart(10)}  ${formatBytes(result.minified).padStart(10)}  ${formatBytes(result.gzipped).padStart(10)}`
    )
  }

  console.log(separator)
}

/** Map a {@link SizeComparisonStatus} to a human-readable icon and label for terminal output. */
const STATUS_ICONS: Record<SizeComparisonStatus, string> = {
  BIGGER: '⚠️  BIGGER',
  SMALLER: '🔽 SMALLER',
  OK: '✅ OK',
  '': '',
}

/**
 * Build comparison rows from current and baseline size results.
 *
 * @param currentResults - The current size measurements.
 * @param baselineResults - The baseline size measurements.
 *
 * @returns An array of comparison rows, one per current entry point.
 */
const buildSizeComparison = (
  currentResults: SizeResult[],
  baselineResults: SizeResult[]
): SizeComparisonRow[] => {
  const baselineMap = new Map(baselineResults.map((result) => [result.name, result]))

  return currentResults.map((currentResult) => {
    const baselineResult = baselineMap.get(currentResult.name)
    if (!baselineResult) {
      return {
        name: currentResult.name,
        baselineGzipped: null,
        currentGzipped: currentResult.gzipped,
        changePercent: null,
        status: '' as const,
      }
    }
    const changePercent =
      ((currentResult.gzipped - baselineResult.gzipped) / baselineResult.gzipped) * 100
    const status: SizeComparisonStatus =
      changePercent > SIZE_THRESHOLD_PERCENT
        ? 'BIGGER'
        : changePercent < -SIZE_THRESHOLD_PERCENT
          ? 'SMALLER'
          : 'OK'
    return {
      name: currentResult.name,
      baselineGzipped: baselineResult.gzipped,
      currentGzipped: currentResult.gzipped,
      changePercent,
      status,
    }
  })
}

/**
 * Print a comparison table to stdout showing baseline vs current gzipped sizes.
 *
 * @param rows - The comparison rows to display.
 */
const printComparison = (rows: SizeComparisonRow[]): void => {
  const nameWidth = Math.max(12, ...rows.map((row) => row.name.length))
  const header = `${'Entry point'.padEnd(nameWidth)}  ${'baseline'.padStart(10)}  ${'current'.padStart(10)}  ${'change'.padStart(10)}  status`
  const separator = '-'.repeat(header.length)

  console.log('\nSize comparison (minified + gzipped):')
  console.log(separator)
  console.log(header)
  console.log(separator)

  for (const row of rows) {
    if (row.baselineGzipped === null) {
      console.log(
        `${row.name.padEnd(nameWidth)}  ${'(new)'.padStart(10)}  ${formatBytes(row.currentGzipped).padStart(10)}`
      )
      continue
    }
    const sign = row.changePercent !== null && row.changePercent >= 0 ? '+' : ''
    const changeLabel =
      row.changePercent === null ? 'N/A' : `${sign}${row.changePercent.toFixed(1)}%`
    console.log(
      `${row.name.padEnd(nameWidth)}  ${formatBytes(row.baselineGzipped).padStart(10)}  ${formatBytes(row.currentGzipped).padStart(10)}  ${changeLabel.padStart(10)}  ${STATUS_ICONS[row.status]}`
    )
  }

  console.log(separator)
}

/**
 * Build a Markdown report comparing current and baseline sizes.
 *
 * @param label - A label for the baseline (e.g. "v4.0.0" or "snapshot: approach-a").
 * @param rows - The comparison rows to include in the report.
 *
 * @returns The complete Markdown report content.
 */
const buildSizeMarkdownReport = (label: string, rows: SizeComparisonRow[]): string => {
  const markdownStatusIcons: Record<SizeComparisonStatus, string> = {
    BIGGER: '⚠️ BIGGER',
    SMALLER: '🔽 SMALLER',
    OK: '✅ OK',
    '': '',
  }

  const lines: string[] = [
    `# Bundle Size Comparison`,
    ``,
    `**Baseline:** ${label}`,
    `**Date:** ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    ``,
    `| Entry point | Baseline (gzip) | Current (gzip) | Change | Status |`,
    `|---|---:|---:|---:|---|`,
  ]

  for (const row of rows) {
    if (row.baselineGzipped === null) {
      lines.push(`| ${row.name} | (new) | ${formatBytes(row.currentGzipped)} | | |`)
      continue
    }
    const sign = row.changePercent !== null && row.changePercent >= 0 ? '+' : ''
    const changeLabel =
      row.changePercent === null ? 'N/A' : `${sign}${row.changePercent.toFixed(1)}%`
    lines.push(
      `| ${row.name} | ${formatBytes(row.baselineGzipped)} | ${formatBytes(row.currentGzipped)} | ${changeLabel} | ${markdownStatusIcons[row.status]} |`
    )
  }

  lines.push(
    ``,
    `> ⚠️ = grew >${SIZE_THRESHOLD_PERCENT}% · 🔽 = shrank >${SIZE_THRESHOLD_PERCENT}% · ✅ = within threshold`
  )

  return lines.join('\n')
}

// ─── README Update ─────────────────────────────────────────────────────────

/**
 * Update the package size badge and inline text in README.md.
 *
 * Replaces the shields.io badge URL and the inline text to reflect the current
 * `getProperties` gzipped size (the most common import for end users).
 *
 * @param results - The measured size results for the current build.
 */
const updateReadmeBadge = (results: SizeResult[]): void => {
  const getPropertiesResult = results.find((result) => result.name === 'getProperties')
  if (!getPropertiesResult) {
    return
  }

  const sizeLabel = formatBytes(getPropertiesResult.gzipped).replace(' ', '%20')
  const newBadge = `![Package Size](https://img.shields.io/badge/min%2Bgzip-${sizeLabel}-brightgreen)`

  const readme = readFileSync(readmePath, 'utf8')
  const badgePattern = /\[!\[Package Size\]\(.*?\)\]\(.*?\)|!\[Package Size\]\(.*?\)/
  if (!badgePattern.test(readme)) {
    console.log('Warning: Package Size badge not found in README.md, skipping update.')
    return
  }

  const sizeText = formatBytes(getPropertiesResult.gzipped)
  const inlinePattern = /`getProperties` is only [\d.]+ (?:kB|B) min\+gzip/
  const updatedReadme = readme
    .replace(badgePattern, newBadge)
    .replace(inlinePattern, `\`getProperties\` is only ${sizeText} min+gzip`)
  if (updatedReadme !== readme) {
    writeFileSync(readmePath, updatedReadme)
    console.log(`README.md updated: ${sizeText}`)
  }
}

// ─── Regression Check ──────────────────────────────────────────────────────

/**
 * Check whether any comparison row indicates a size regression beyond the threshold.
 *
 * @param rows - The comparison rows to evaluate.
 *
 * @returns `true` if at least one entry point grew more than {@link SIZE_THRESHOLD_PERCENT}.
 */
const hasSizeRegressions = (rows: SizeComparisonRow[]): boolean =>
  rows.some((row) => row.status === 'BIGGER')

// ─── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `Usage: npx tsx performance/size/compare.ts [options]

Options:
  --version <ver>    Compare against a specific published npm version
  --snapshot <name>  Compare against a saved snapshot
  --strict           Exit with code 1 if regressions exceed threshold

If no --version or --snapshot is given, compares against the latest published version.

Examples:
  npx tsx performance/size/compare.ts
  npx tsx performance/size/compare.ts --version 3.7.0
  npx tsx performance/size/compare.ts --snapshot before-optimization
  npm run size
  npm run size -- --version 3.7.0 --strict`

/**
 * Compare current bundle sizes against a resolved baseline.
 *
 * Steps:
 * 1. Resolve the baseline via CLI flags.
 * 2. Validate that the current `dist/esm/` exists.
 * 3. Measure current and baseline bundle sizes.
 * 4. Compare and print results.
 * 5. Update README badge with current `getProperties` gzipped size.
 * 6. Save results to `.results/`.
 * 7. Throw if `--strict` is set and any entry point grew more than the threshold.
 *
 * @throws Error if either `dist/esm/` directory is missing, or if `--strict` is set
 *   and a size regression exceeds {@link SIZE_THRESHOLD_PERCENT}.
 */
const main = (): void => {
  const arguments_ = process.argv.slice(2)

  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    console.log(USAGE)
    return
  }

  // 1. Resolve baseline.
  const baseline = resolveBaseline(arguments_)
  console.log(`Comparing bundle sizes against ${baseline.label}...\n`)

  // 2. Validate current dist/esm/ exists.
  if (!existsSync(currentDistributionEsmDirectory)) {
    throw new Error(
      `Current dist/esm/ directory not found at ${currentDistributionEsmDirectory}.\n` +
        `Run \`npm run build\` first.`
    )
  }

  // 3. Validate baseline dist/esm/ exists.
  if (!existsSync(baseline.distributionDirectory)) {
    throw new Error(
      `Baseline dist/esm/ directory not found at ${baseline.distributionDirectory}.\n` +
        `The baseline package may be corrupted. Try deleting the cache and retrying.`
    )
  }

  // 4. Measure current sizes.
  console.log('Measuring current sizes...')
  const currentResults = measureAll(currentDistributionEsmDirectory)
  printTable(currentResults, 'Current:')

  // 5. Measure baseline sizes.
  console.log(`\nMeasuring baseline sizes (${baseline.label})...`)
  const baselineResults = measureAll(baseline.distributionDirectory)
  printTable(baselineResults, `Baseline (${baseline.label}):`)

  // 6. Compare and print.
  const comparisonRows = buildSizeComparison(currentResults, baselineResults)
  printComparison(comparisonRows)

  // 7. Update README badge.
  updateReadmeBadge(currentResults)

  // 8. Save results to .results/.
  mkdirSync(resultsDirectory, { recursive: true })
  writeFileSync(
    path.resolve(resultsDirectory, 'current.json'),
    JSON.stringify(currentResults, null, 2)
  )
  writeFileSync(
    path.resolve(resultsDirectory, 'baseline.json'),
    JSON.stringify(baselineResults, null, 2)
  )
  writeFileSync(
    path.resolve(resultsDirectory, 'comparison.json'),
    JSON.stringify(
      {
        baseline: baseline.label,
        threshold: SIZE_THRESHOLD_PERCENT,
        rows: comparisonRows,
      },
      null,
      2
    )
  )
  const markdownReport = buildSizeMarkdownReport(baseline.label, comparisonRows)
  writeFileSync(path.resolve(resultsDirectory, 'comparison.md'), markdownReport)
  console.log(`\nResults saved to ${resultsDirectory}`)

  // 9. In strict mode, exit with code 1 if any entry point exceeds the threshold.
  // Strict mode is used by the pre-release gate; normal builds only report regressions.
  const isStrictMode = arguments_.includes('--strict')
  if (isStrictMode && hasSizeRegressions(comparisonRows)) {
    throw new Error(
      `Size regression detected: one or more entry points grew more than ${SIZE_THRESHOLD_PERCENT}%.`
    )
  }
}

main()
