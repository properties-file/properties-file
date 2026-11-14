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
 *
 * This step runs once `dist/` is complete (after minification in `build.ts`), so it also verifies
 * that every `main`, `module` and `types` path it is about to write names an existing file. That
 * is the only check on `main` and `module`: `attw` (`npm run check-package`) resolves the stubs'
 * `types` through TypeScript's `node10` resolution, but neither it nor `publint` follows a stub's
 * `main` or `module`.
 */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { isNormalizedError, noThrow } from '../../utilities/no-throw'

/**
 * A subpath key the stubs can be generated for: `./` followed by one or more lowercase
 * slash-separated segments. Deliberately narrow — no `.`/`..` segments, no `*` patterns, no
 * trailing slash — because each key becomes a directory path at the package root.
 */
const REGEX_STUB_SUBPATH = /^\.\/[a-z]+(?:\/[a-z]+)*$/

/** The one directory every package ships besides the stubs (the compiled output). */
const DIST_DIRECTORY = 'dist'

/** The keys an `exports` entry may have: one condition per module format, nothing else. */
const ENTRY_KEYS = ['import', 'require']

/** The keys an `import`/`require` condition may have. */
const CONDITION_KEYS = ['types', 'default']

/** The keys of a generated stub `package.json`, sorted (see {@link StubManifest}). */
const STUB_MANIFEST_KEYS = ['main', 'module', 'types']

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
 * Reject an object with any key outside an allowed set. An unknown key is a condition (`node`,
 * `browser`, a top-level `default`, …) or a field the stub would silently drop, so a new shape
 * needs a deliberate decision on what its stub should contain.
 *
 * @param value - The object to check.
 * @param allowedKeys - The keys the object may have.
 * @param location - Where the object sits in `package.json`, for the error message (e.g.
 * `exports["./editor"].require`).
 *
 * @throws An error naming the location and the first unexpected key.
 */
const rejectUnexpectedKeys = (
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  location: string
): void => {
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.includes(key))
  if (unexpectedKey !== undefined) {
    throw new Error(
      `🚨 ${location} has an unexpected key "${unexpectedKey}": a legacy resolution stub can ` +
        `only be derived from ${allowedKeys.map((key) => `"${key}"`).join(' and ')}`
    )
  }
}

/**
 * Check that an `exports` target is a file inside `dist/`: the stubs point back into the build
 * output, and a target outside it (e.g. `../outside.js`) would make a stub point outside the
 * package. Both the written form and the normalized one are checked, so a `./dist/../…` target
 * cannot escape either.
 *
 * @param target - The target as written in the `exports` map.
 *
 * @returns `true` if the target starts with `./dist/` and stays inside `dist/` once normalized.
 */
const isBuildOutputTarget = (target: string): boolean =>
  target.startsWith(`./${DIST_DIRECTORY}/`) &&
  path.posix.normalize(target).startsWith(`${DIST_DIRECTORY}/`)

/**
 * Read the `types`/`default` targets of one condition of an `exports` entry, failing loudly on
 * any other shape (a new shape needs a deliberate decision on what its stub should contain): the
 * condition must be an object with exactly the string keys `types` and `default`, each pointing
 * inside `./dist/`.
 *
 * @param subpath - The `exports` key, for error messages.
 * @param entry - The `exports` value for that key (already checked to have no key besides
 * `import` and `require`).
 * @param condition - The condition to read.
 *
 * @returns The condition's declaration and JavaScript files.
 *
 * @throws An error naming the subpath and condition if the condition has any other shape.
 */
const getConditionTarget = (
  subpath: string,
  entry: Record<string, unknown>,
  condition: 'import' | 'require'
): ConditionTarget => {
  const location = `exports["${subpath}"].${condition}`
  const target = entry[condition]
  if (!isRecord(target)) {
    throw new Error(`🚨 ${location} must be { "types": string, "default": string }`)
  }
  rejectUnexpectedKeys(target, CONDITION_KEYS, location)
  if (typeof target.types !== 'string' || typeof target.default !== 'string') {
    throw new Error(`🚨 ${location} must be { "types": string, "default": string }`)
  }
  for (const targetPath of [target.types, target.default]) {
    if (!isBuildOutputTarget(targetPath)) {
      throw new Error(
        `🚨 ${location} target "${targetPath}" must point inside "./${DIST_DIRECTORY}/"`
      )
    }
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
 *
 * @throws An error if the key or the entry has a shape the stub cannot be derived from.
 */
const getSubpathStub = (subpath: string, entry: unknown): SubpathStub => {
  if (!REGEX_STUB_SUBPATH.test(subpath)) {
    throw new Error(`🚨 Unsupported exports key for a legacy resolution stub: "${subpath}"`)
  }
  if (!isRecord(entry)) {
    throw new Error(
      `🚨 exports["${subpath}"] must be { "import": { … }, "require": { … } } for a legacy ` +
        `resolution stub`
    )
  }
  rejectUnexpectedKeys(entry, ENTRY_KEYS, `exports["${subpath}"]`)
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
 * Matches a path as a generated stub contains it: up from the stub's own directory to the
 * package root, then into the build output (`../dist/cjs/editor/index.js`, or `../../dist/…`
 * for a nested stub).
 */
const REGEX_STUB_TARGET = /^(?:\.\.\/)+dist\//

/**
 * Check whether a file has the shape of a stub this step generates: valid JSON for an object
 * with exactly the {@link StubManifest} keys, each a string of the form every generated stub
 * uses, one or more `../` followed by `dist/` (see {@link REGEX_STUB_TARGET}; the number of
 * `../` is not compared with the file's depth). Any other content, unparseable JSON included,
 * is someone else's file — a manifest that merely has the same three fields is not ours.
 *
 * @param filePath - The `package.json` file to inspect.
 *
 * @returns `true` if the file has the exact shape of a generated stub.
 */
const isStubManifestFile = (filePath: string): boolean => {
  const manifest = noThrow((): unknown => JSON.parse(readFileSync(filePath, 'utf8')))
  return (
    !isNormalizedError(manifest) &&
    isRecord(manifest) &&
    JSON.stringify(Object.keys(manifest).toSorted(compareStrings)) ===
      JSON.stringify(STUB_MANIFEST_KEYS) &&
    Object.values(manifest).every(
      (value) => typeof value === 'string' && REGEX_STUB_TARGET.test(value)
    )
  )
}

/**
 * Check that a directory holds nothing but (possibly nested) generated stubs, i.e. that it is a
 * previously generated stub tree and is safe to delete. Every entry must be either a directory
 * (checked recursively) or a regular file named `package.json` with the exact shape of a stub
 * (see {@link isStubManifestFile}), so an unrelated `package.json` (e.g. a test fixture), a
 * symbolic link or any other file makes the whole tree "not ours".
 *
 * @param directoryPath - The directory to inspect.
 *
 * @returns `true` if every entry under the directory is a directory or a generated stub.
 */
const hasOnlyStubFiles = (directoryPath: string): boolean =>
  readdirSync(directoryPath, { withFileTypes: true }).every((entry) => {
    const entryPath = path.join(directoryPath, entry.name)
    return entry.isDirectory()
      ? hasOnlyStubFiles(entryPath)
      : entry.isFile() && entry.name === 'package.json' && isStubManifestFile(entryPath)
  })

/**
 * Generate the legacy resolution stubs for every subpath of the `exports` map in
 * `package.json`, and verify that the `files` list ships exactly `dist` plus the stub
 * directories.
 *
 * @param packageJsonPath - The path to the package's `package.json`; the stubs are written
 * next to it.
 *
 * @throws An error, before anything is deleted or written, if an `exports` entry has a shape the
 * stubs cannot be derived from, `files` does not match, a stub would point to a missing file, or
 * an existing stub directory holds anything but previously generated stubs.
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
   * The top-level stub directories (`bundler`, `editor`, …) of the current `exports` map: what
   * `files` must list, and what is cleared before writing. Clearing them removes a stale nested
   * stub under a directory that is still exported (e.g. `bundler/x/` once `./bundler/x` is
   * removed). A whole top-level subpath removed from `exports` (e.g. `./escape`) is not in this
   * list, so its stub directory stays on disk until deleted by hand. It is not published (the
   * `files` check below forces its entry out of `files` too) and it is git-ignored, so it is
   * only a local leftover.
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

  // Every path a stub is about to point to must name an existing file now (`dist/` is complete
  // when this runs): nothing downstream checks a stub's `main` or `module` (see the header).
  // Each path is resolved from the stub directory, exactly as a resolver reads it.
  for (const { directoryPath, manifest } of stubs) {
    for (const [field, relativePath] of Object.entries(manifest)) {
      const targetPath = path.join(packageRootPath, directoryPath, relativePath)
      if (statSync(targetPath, { throwIfNoEntry: false })?.isFile() !== true) {
        throw new Error(
          `🚨 Legacy resolution stub ${directoryPath}/package.json: "${field}" ` +
            `(${relativePath}) is not a file: ${targetPath}`
        )
      }
    }
  }

  const existingStubRootPaths = stubRootDirectories
    .map((stubRootDirectory) => path.join(packageRootPath, stubRootDirectory))
    // `lstat`, not `exists`: a symbolic link counts as existing even when it is broken.
    .filter((stubRootPath) => lstatSync(stubRootPath, { throwIfNoEntry: false }) !== undefined)

  // Only clear what has the form of a previously generated stub tree, so that an exports key
  // colliding with a source directory deletes nothing: a real directory (not a file, and not a
  // symbolic link, which would be followed into someone else's directory) holding nothing but
  // stub-shaped manifests and directories (see `hasOnlyStubFiles`). The check goes by content,
  // not by origin: a directory of empty directories, or a hand-written manifest identical in
  // shape to a stub, is replaced too. All of them are checked before any is deleted, so a
  // refusal leaves the tree untouched.
  for (const stubRootPath of existingStubRootPaths) {
    if (!lstatSync(stubRootPath).isDirectory()) {
      throw new Error(
        `🚨 ${stubRootPath} is not a directory (a file or a symbolic link), refusing to replace it`
      )
    }
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
