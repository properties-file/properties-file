/**
 * Type-aware ES5 "API downlevel" build step.
 *
 * Loads the repository's real TypeScript source (via the root `tsconfig.json`, so the exact
 * same file set `tsc` would compile — see `npm run typecheck` and its `include`/`exclude`),
 * applies the {@link applyCatalogToSourceFile | downlevel rewrite catalog} to every source file,
 * and writes the result to a shadow tree at `./.transformed-src/` (mirroring `src/`'s internal
 * structure, so `tsconfig.build.json` — which points `rootDir`/`include` at that tree with the
 * same `outDir` as the root config — compiles it exactly like `tsc` would compile `src/`
 * directly).
 *
 * This lets shipped source use modern JS runtime APIs (`Array#includes`, `String#at`, etc. —
 * see `eslint/config.ts`, which enforces the modern form for the catalog's APIs in shipped
 * code) while the published artifacts stay ES5/Node 0.4 compatible: every catalog usage is
 * rewritten to an ES5-safe equivalent before `tsc` ever sees it.
 *
 * Usage (see `package.json`'s `build` script):
 *
 *   npx tsx src/build-scripts/downlevel/transform.ts && tsc -p tsconfig.build.json
 *
 * `.transformed-src/` is deleted at the end of `src/build-scripts/build.ts`, once the rest of
 * the build (esbuild bundling, SWC downlevel, CJS conversion, minification) has consumed the
 * `tsc` output it produced.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Project } from 'ts-morph'

import { applyCatalogToSourceFile, verifyNoRemainingCatalogUsage } from './catalog'

/** The repository root (two levels up from `src/build-scripts/downlevel/`). */
const ROOT_DIRECTORY = path.resolve(import.meta.dirname, '..', '..', '..')

/** The real TypeScript source directory that the root `tsconfig.json` compiles from. */
const SOURCE_DIRECTORY = path.join(ROOT_DIRECTORY, 'src')

/** The shadow tree the downleveled copies are written to. */
const TRANSFORMED_SOURCE_DIRECTORY = path.join(ROOT_DIRECTORY, '.transformed-src')

console.log('🏃 Running downlevel transform: src/ → .transformed-src/ (ES5 API rewrite).\n')

// Start from a clean shadow tree so the output is deterministic and never mixes with a stale
// tree from a previous run.
rmSync(TRANSFORMED_SOURCE_DIRECTORY, { recursive: true, force: true })
mkdirSync(TRANSFORMED_SOURCE_DIRECTORY, { recursive: true })

// Load the exact same file set the root tsconfig.json compiles (src/**/*.ts, excluding
// src/build-scripts — build scripts are never part of dist output, so they have no place in
// the shadow tree; verified by the `sourceFile.getFilePath()` prefix check below, which is a
// belt-and-suspenders guard against ever writing a file that isn't really under src/, e.g. a
// declaration file ts-morph pulled in from a library or node_modules).
const project = new Project({ tsConfigFilePath: path.join(ROOT_DIRECTORY, 'tsconfig.json') })

const sourceDirectoryWithTrailingSeparator = `${SOURCE_DIRECTORY}${path.sep}`
const sourceFiles = project
  .getSourceFiles()
  .filter((sourceFile) => sourceFile.getFilePath().startsWith(sourceDirectoryWithTrailingSeparator))

if (sourceFiles.length === 0) {
  throw new Error(
    `No source files found under ${SOURCE_DIRECTORY} via tsconfig.json — the downlevel ` +
      'transform has nothing to copy. This usually means tsconfig.json include/exclude changed.'
  )
}

for (const sourceFile of sourceFiles) {
  const relativePath = path.relative(SOURCE_DIRECTORY, sourceFile.getFilePath())
  console.log(`   🔍 Scanning ${relativePath}`)

  applyCatalogToSourceFile(sourceFile)
  verifyNoRemainingCatalogUsage(sourceFile)

  const destinationPath = path.join(TRANSFORMED_SOURCE_DIRECTORY, relativePath)
  mkdirSync(path.dirname(destinationPath), { recursive: true })
  writeFileSync(destinationPath, sourceFile.getFullText())
}

console.log(
  `\n✅ Downlevel transform complete: ${sourceFiles.length} file(s) written to ` +
    `${path.relative(ROOT_DIRECTORY, TRANSFORMED_SOURCE_DIRECTORY)}/.\n`
)
