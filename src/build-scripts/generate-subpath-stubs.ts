/**
 * Legacy subpath resolution stubs (invoked from `build.ts`).
 *
 * The subpath entry points (`properties-file/editor`, `properties-file/bundler/webpack`, …) are
 * declared in the `exports` map of `package.json`, which only `exports`-aware resolvers read:
 * Node.js 12.7 and later, modern bundlers, and TypeScript's `node16`/`nodenext`/`bundler`
 * resolution. Everything older — Node.js before 12.7, webpack 4, TypeScript's legacy `node10`
 * resolution — resolves `properties-file/editor` as a plain path inside the package: a file
 * `editor.js`, or a folder `editor/` whose own `package.json` names its entry with `main` (and
 * `module`/`types` for the bundlers and TypeScript versions that read those fields).
 *
 * This step writes one such folder per subpath at the package root, e.g. `editor/package.json`:
 *
 * ```json
 * { "main": "../dist/cjs/editor/index.js", "module": "../dist/esm/editor/index.js", "types": "../dist/cjs/editor/index.d.ts" }
 * ```
 *
 * The stubs are derived from the `exports` map on every build (never hand-maintained), so the two
 * cannot drift: `main`/`types` come from the `require` condition (a legacy resolver loads the
 * CommonJS build, and its declarations must describe that build) and `module` from the `import`
 * condition. They are generated files: git-ignored, ESLint/Prettier-ignored, and shipped through
 * the `files` list of `package.json` — which this step verifies, since a stub directory missing
 * from `files` would silently not be published.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A subpath key the stubs can be generated for: `./` followed by one or more lowercase
 * slash-separated segments. Deliberately narrow — no `.`/`..` segments, no `*` patterns, no
 * trailing slash — because each key becomes a directory path at the package root.
 */
const REGEX_STUB_SUBPATH = /^\.\/[a-z]+(?:\/[a-z]+)*$/

/** The one directory every package ships besides the stubs (the compiled output). */
const DIST_DIRECTORY = 'dist'

/** The resolved files of one `exports` condition (`import` or `require`). */
type ConditionTarget = {
  /** The declaration file (`types` condition). */
  types: string
  /** The JavaScript file (`default` condition). */
  default: string
}

/** The fields of a stub `package.json`. */
type StubManifest = {
  /** The CommonJS entry, for `require()` and every resolver. */
  main: string
  /** The ESM entry, for bundlers that read the `module` field (e.g. webpack 4). */
  module: string
  /** The declarations, for TypeScript's legacy `node10` resolution. */
  types: string
}

/** A stub to write: where, and what. */
type SubpathStub = {
  /** The stub's directory, relative to the package root (e.g. `bundler/webpack`). */
  directoryPath: string
  /** The stub's `package.json` content. */
  manifest: StubManifest
}

/**
 * Compare two strings by UTF-16 code units (the order `Array#sort` uses by default), for a
 * deterministic, locale-independent sort.
 *
 * @param left - The first string.
 * @param right - The second string.
 *
 * @returns A negative number, zero, or a positive number, as `Array#sort` expects.
 */
const compareStrings = (left: unknown, right: unknown): number =>
  String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0

/**
 * Check whether a value is a plain (non-array) object.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value is a non-null, non-array object.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Read the `types`/`default` targets of one condition of an `exports` entry, failing loudly on
 * any other shape (a new shape needs a deliberate decision on what its stub should contain).
 *
 * @param subpath - The `exports` key, for error messages.
 * @param entry - The `exports` value for that key.
 * @param condition - The condition to read.
 *
 * @returns The condition's declaration and JavaScript files.
 */
const getConditionTarget = (
  subpath: string,
  entry: unknown,
  condition: 'import' | 'require'
): ConditionTarget => {
  const target = isRecord(entry) ? entry[condition] : undefined
  if (!isRecord(target) || typeof target.types !== 'string' || typeof target.default !== 'string') {
    throw new Error(
      `🚨 exports["${subpath}"].${condition} must be { "types": string, "default": string }`
    )
  }
  return { types: target.types, default: target.default }
}

/**
 * Compute the stub for one `exports` subpath.
 *
 * @param subpath - The `exports` key (e.g. `./bundler/webpack`).
 * @param entry - The `exports` value for that key.
 *
 * @returns The stub directory and the `package.json` content pointing back into `dist/`.
 */
const getSubpathStub = (subpath: string, entry: unknown): SubpathStub => {
  if (!REGEX_STUB_SUBPATH.test(subpath)) {
    throw new Error(`🚨 Unsupported exports key for a legacy resolution stub: "${subpath}"`)
  }
  const directoryPath = subpath.slice('./'.length)
  const requireTarget = getConditionTarget(subpath, entry, 'require')
  const importTarget = getConditionTarget(subpath, entry, 'import')

  /**
   * Rewrite a package-root-relative target (`./dist/…`) relative to the stub directory. POSIX
   * separators on every platform: these paths are published, not used locally.
   *
   * @param targetPath - The target as written in the `exports` map.
   *
   * @returns The same file, relative to the stub directory (e.g. `../dist/cjs/editor/index.js`).
   */
  const toStubRelativePath = (targetPath: string): string =>
    path.posix.relative(directoryPath, path.posix.normalize(targetPath))

  return {
    directoryPath,
    manifest: {
      main: toStubRelativePath(requireTarget.default),
      module: toStubRelativePath(importTarget.default),
      types: toStubRelativePath(requireTarget.types),
    },
  }
}

/**
 * Check that a directory holds nothing but (possibly nested) `package.json` files, i.e. that it
 * is a previously generated stub tree and is safe to delete.
 *
 * @param directoryPath - The directory to inspect.
 *
 * @returns `true` if every file under the directory is named `package.json`.
 */
const hasOnlyStubFiles = (directoryPath: string): boolean =>
  readdirSync(directoryPath, { withFileTypes: true }).every((entry) =>
    entry.isDirectory()
      ? hasOnlyStubFiles(path.join(directoryPath, entry.name))
      : entry.name === 'package.json'
  )

/**
 * Generate the legacy resolution stubs for every subpath of the `exports` map in
 * `package.json`, and verify that the `files` list ships exactly `dist` plus the stub
 * directories.
 *
 * @param packageJsonPath - The path to the package's `package.json`; the stubs are written
 * next to it.
 */
export const generateSubpathStubs = (packageJsonPath: string): void => {
  const packageRootPath = path.dirname(packageJsonPath)
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (!isRecord(packageJson) || !isRecord(packageJson.exports)) {
    throw new Error(`🚨 ${packageJsonPath} has no "exports" map`)
  }

  const stubs = Object.entries(packageJson.exports)
    .filter(([subpath]) => subpath !== '.')
    .map(([subpath, entry]) => getSubpathStub(subpath, entry))

  /**
   * The top-level stub directories (`bundler`, `editor`, …): what `files` must list, and what is
   * cleared before writing, so a stub whose subpath was removed from `exports` does not linger.
   */
  const stubRootDirectories = [
    ...new Set(stubs.map(({ directoryPath }) => directoryPath.split('/', 1)[0])),
  ].toSorted(compareStrings)

  // `files` drives what `npm pack`/`npm publish` ship: a stub left out would never be published,
  // and a stale entry would publish whatever else sits under that name.
  const expectedFiles = [DIST_DIRECTORY, ...stubRootDirectories].toSorted(compareStrings)
  const actualFiles = Array.isArray(packageJson.files)
    ? packageJson.files.toSorted(compareStrings)
    : []
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `🚨 ${packageJsonPath} "files" must list exactly ${JSON.stringify(expectedFiles)} ` +
        `(the build output plus one legacy resolution stub directory per top-level exports ` +
        `subpath), but lists ${JSON.stringify(actualFiles)}`
    )
  }

  const existingStubRootPaths = stubRootDirectories
    .map((stubRootDirectory) => path.join(packageRootPath, stubRootDirectory))
    .filter((stubRootPath) => existsSync(stubRootPath))

  // Never delete a directory this step did not create (e.g. an exports key colliding with a
  // source directory): a previously generated stub tree holds `package.json` files only. All
  // directories are checked before any is deleted, so a refusal leaves the tree untouched.
  for (const stubRootPath of existingStubRootPaths) {
    if (!hasOnlyStubFiles(stubRootPath)) {
      throw new Error(
        `🚨 ${stubRootPath} contains files other than generated stubs, refusing to replace it`
      )
    }
  }

  for (const stubRootPath of existingStubRootPaths) {
    console.log(`   🧹 Removing previous stubs: ${stubRootPath}`)
    rmSync(stubRootPath, { recursive: true })
  }

  for (const { directoryPath, manifest } of stubs) {
    const stubDirectoryPath = path.join(packageRootPath, directoryPath)
    const stubFilePath = path.join(stubDirectoryPath, 'package.json')
    mkdirSync(stubDirectoryPath, { recursive: true })
    console.log(`   📍 Writing legacy resolution stub: ${stubFilePath} → ${manifest.main}`)
    writeFileSync(stubFilePath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  }
}
