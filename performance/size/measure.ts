import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const rootDirectory = path.resolve(import.meta.dirname, '..', '..')
const readmePath = path.resolve(rootDirectory, 'README.md')
const resultsDirectory = path.resolve(import.meta.dirname, '.results')
const sizeResultsPath = path.resolve(resultsDirectory, 'size.json')

/**
 * Entry points to measure. Each represents a common import pattern that users
 * would use in their applications. esbuild tree-shakes away unused code.
 */
const ENTRY_POINTS: { name: string; code: string }[] = [
  {
    name: 'getProperties',
    code: 'import { getProperties } from "./dist/esm/index.js"; console.log(getProperties);',
  },
  {
    name: 'Properties',
    code: 'import { Properties } from "./dist/esm/index.js"; console.log(Properties);',
  },
  {
    name: 'PropertiesEditor',
    code: 'import { PropertiesEditor } from "./dist/esm/editor/index.js"; console.log(PropertiesEditor);',
  },
  {
    name: 'escapeKey + escapeValue',
    code: 'import { escapeKey, escapeValue } from "./dist/esm/escape/index.js"; console.log(escapeKey, escapeValue);',
  },
  {
    name: 'All exports (*)',
    code: [
      'import { getProperties, Properties } from "./dist/esm/index.js";',
      'import { PropertiesEditor } from "./dist/esm/editor/index.js";',
      'import { escapeKey, escapeValue } from "./dist/esm/escape/index.js";',
      'import { unescapeContent } from "./dist/esm/unescape/index.js";',
      'console.log(getProperties, Properties, PropertiesEditor, escapeKey, escapeValue, unescapeContent);',
    ].join(' '),
  },
]

/** A single size measurement for one entry point. */
type SizeResult = {
  /** The entry point name. */
  name: string
  /** Raw (unminified, unbundled) size from esbuild in bytes. */
  bundled: number
  /** Minified size in bytes. */
  minified: number
  /** Gzipped size of the minified output in bytes. */
  gzipped: number
}

/**
 * Bundle an entry point with esbuild and return the minified output.
 *
 * @param code - The JavaScript import code to bundle.
 *
 * @returns The minified bundle as a string.
 */
const bundle = (code: string): { bundled: string; minified: string } => {
  const bundled = execSync(
    `echo '${code}' | npx esbuild --bundle --format=esm --tree-shaking=true`,
    {
      cwd: rootDirectory,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  const minified = execSync(
    `echo '${code}' | npx esbuild --bundle --format=esm --minify --tree-shaking=true`,
    { cwd: rootDirectory, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  )
  return { bundled, minified }
}

/**
 * Measure the size of a single entry point.
 *
 * @param entryPoint - The entry point to measure.
 *
 * @returns The size measurement.
 */
const measure = (entryPoint: { name: string; code: string }): SizeResult => {
  const { bundled, minified } = bundle(entryPoint.code)
  const gzipped = gzipSync(minified)
  return {
    name: entryPoint.name,
    bundled: bundled.length,
    minified: minified.length,
    gzipped: gzipped.length,
  }
}

/**
 * Format a byte count as a human-readable string (e.g. "1.9 kB").
 *
 * @param bytes - The byte count.
 *
 * @returns The formatted string.
 */
const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * Measure all entry points and print results.
 *
 * @returns The array of size results.
 */
const measureAll = (): SizeResult[] => {
  const results: SizeResult[] = []

  for (const entryPoint of ENTRY_POINTS) {
    results.push(measure(entryPoint))
  }

  return results
}

/**
 * Print a size results table.
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

/**
 * Compare current sizes against a previously saved baseline.
 *
 * @param current - The current size results.
 * @param baseline - The baseline size results.
 */
const printComparison = (current: SizeResult[], baseline: SizeResult[]): void => {
  const baselineMap = new Map(baseline.map((result) => [result.name, result]))

  const nameWidth = Math.max(12, ...current.map((result) => result.name.length))
  const header = `${'Entry point'.padEnd(nameWidth)}  ${'baseline'.padStart(10)}  ${'current'.padStart(10)}  ${'change'.padStart(10)}  status`
  const separator = '-'.repeat(header.length)

  console.log('\nSize comparison (minified + gzipped):')
  console.log(separator)
  console.log(header)
  console.log(separator)

  for (const result of current) {
    const base = baselineMap.get(result.name)
    if (!base) {
      console.log(
        `${result.name.padEnd(nameWidth)}  ${'(new)'.padStart(10)}  ${formatBytes(result.gzipped).padStart(10)}`
      )
      continue
    }
    const change = ((result.gzipped - base.gzipped) / base.gzipped) * 100
    const status = change > 10 ? '⚠️  BIGGER' : change < -10 ? '🔽 SMALLER' : '✅ OK'
    const sign = change >= 0 ? '+' : ''
    console.log(
      `${result.name.padEnd(nameWidth)}  ${formatBytes(base.gzipped).padStart(10)}  ${formatBytes(result.gzipped).padStart(10)}  ${`${sign}${change.toFixed(1)}%`.padStart(10)}  ${status}`
    )
  }

  console.log(separator)
}

/**
 * Build a Markdown report comparing current and baseline sizes.
 *
 * @param label - A label for the baseline (e.g. a tag name).
 * @param current - The current size results.
 * @param baseline - The baseline size results.
 *
 * @returns The Markdown content.
 */
const buildSizeMarkdownReport = (
  label: string,
  current: SizeResult[],
  baseline: SizeResult[]
): string => {
  const baselineMap = new Map(baseline.map((result) => [result.name, result]))
  const markdownIcons: Record<string, string> = {
    BIGGER: '⚠️ BIGGER',
    SMALLER: '🔽 SMALLER',
    OK: '✅ OK',
    NEW: '',
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

  for (const result of current) {
    const base = baselineMap.get(result.name)
    if (!base) {
      lines.push(`| ${result.name} | (new) | ${formatBytes(result.gzipped)} | | |`)
      continue
    }
    const change = ((result.gzipped - base.gzipped) / base.gzipped) * 100
    const status = change > 10 ? 'BIGGER' : change < -10 ? 'SMALLER' : 'OK'
    const sign = change >= 0 ? '+' : ''
    lines.push(
      `| ${result.name} | ${formatBytes(base.gzipped)} | ${formatBytes(result.gzipped)} | ${sign}${change.toFixed(1)}% | ${markdownIcons[status]} |`
    )
  }

  lines.push(``, `> ⚠️ = grew >10% · 🔽 = shrank >10% · ✅ = within threshold`)

  return lines.join('\n')
}

/**
 * Update the package size badge in README.md with the measured gzipped size.
 *
 * Replaces the shields.io badge URL to reflect the current `getProperties`
 * gzipped size (the most common import for end users).
 *
 * @param results - The measured size results.
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
  const inlinePattern = /`getProperties` is only [\d.]+ [kB]+B min\+gzip/
  const updatedReadme = readme
    .replace(badgePattern, newBadge)
    .replace(inlinePattern, `\`getProperties\` is only ${sizeText} min+gzip`)
  if (updatedReadme !== readme) {
    writeFileSync(readmePath, updatedReadme)
    console.log(`README.md updated: ${sizeText}`)
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage: npx tsx performance/size/measure.ts [command]

Commands:
  (no command)   Measure current bundle sizes
  compare        Measure and compare against the latest release tag

Examples:
  npx tsx performance/size/measure.ts
  npx tsx performance/size/measure.ts compare
  npm run size
  npm run size-compare`

const [command] = process.argv.slice(2)

mkdirSync(resultsDirectory, { recursive: true })

switch (command) {
  case undefined: {
    console.log('Measuring bundle sizes...\n')
    const results = measureAll()
    printTable(results)
    writeFileSync(sizeResultsPath, JSON.stringify(results, null, 2))
    updateReadmeBadge(results)
    console.log(`\nResults saved to ${sizeResultsPath}`)
    break
  }
  case 'compare': {
    // Get the latest release tag.
    const tags = execSync('git tag --sort=-version:refname', {
      cwd: rootDirectory,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const tag = tags.split('\n').find((tagName) => /^v?\d+\.\d+\.\d+$/.test(tagName))

    if (!tag) {
      throw new Error('No release tag found.')
    }

    console.log(`Comparing bundle sizes against ${tag}...\n`)

    // Measure current.
    console.log('Measuring current sizes...')
    const current = measureAll()
    printTable(current, 'Current:')

    // Build baseline: extract tagged source and compile with a temporary tsconfig
    // that points at the extracted source and outputs to a temporary dist directory.
    console.log('\nBuilding baseline from release tag...')
    const temporaryDirectory = path.resolve(resultsDirectory, 'size-baseline')
    const temporarySourceDirectory = path.resolve(temporaryDirectory, 'src')
    const temporaryDistributionDirectory = path.resolve(temporaryDirectory, 'dist', 'esm')
    execSync(`rm -rf "${temporaryDirectory}" && mkdir -p "${temporaryDirectory}"`, {
      stdio: 'pipe',
    })
    execSync(`git archive ${tag} -- src/ | tar -x -C "${temporaryDirectory}"`, {
      cwd: rootDirectory,
      stdio: 'pipe',
    })
    // Create a minimal tsconfig that compiles the extracted source to ESM.
    const baselineTsconfig = {
      compilerOptions: {
        target: 'es5',
        module: 'ESNext',
        moduleResolution: 'node',
        declaration: false,
        strict: true,
        downlevelIteration: true,
        outDir: temporaryDistributionDirectory,
        rootDir: temporarySourceDirectory,
      },
      include: [`${temporarySourceDirectory}/**/*.ts`],
      exclude: [`${temporarySourceDirectory}/build-scripts/**`],
    }
    const baselineTsconfigPath = path.resolve(temporaryDirectory, 'tsconfig.json')
    writeFileSync(baselineTsconfigPath, JSON.stringify(baselineTsconfig))
    execSync(`npx tsc -p "${baselineTsconfigPath}"`, {
      cwd: rootDirectory,
      stdio: 'pipe',
    })

    // Measure baseline using the compiled output in the temp directory.
    const baselineEntryPoints = ENTRY_POINTS.map((entryPoint) => ({
      ...entryPoint,
      code: entryPoint.code.replaceAll('./dist/esm/', `${temporaryDistributionDirectory}/`),
    }))
    const baseline: SizeResult[] = []
    for (const entryPoint of baselineEntryPoints) {
      baseline.push(measure(entryPoint))
    }
    printTable(baseline, `Baseline (${tag}):`)

    // Compare.
    printComparison(current, baseline)

    // Write Markdown report.
    const sizeReportPath = path.resolve(resultsDirectory, 'size-comparison.md')
    writeFileSync(sizeReportPath, buildSizeMarkdownReport(tag, current, baseline))

    // Cleanup.
    execSync(`rm -rf "${temporaryDirectory}"`, { stdio: 'pipe' })

    // Save results.
    writeFileSync(sizeResultsPath, JSON.stringify({ tag, current, baseline }, null, 2))
    console.log(`\nReport saved to ${sizeReportPath}`)
    console.log(`Results saved to ${sizeResultsPath}`)
    break
  }
  default: {
    const error = new Error(`\n  Unknown command: ${command}\n\n${USAGE}\n`)
    error.stack = ''
    throw error
  }
}
