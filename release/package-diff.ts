/**
 * Compares the package a release would publish with the version that is already on npm, file
 * by file. This is what tells a real release from one that changes nothing for users: a
 * dependency update or a refactoring that leaves the published files as they were.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { isNormalizedError, noThrow } from '../utilities/no-throw'

import { runCommand } from './workspace'

import type { Workspace } from './workspace'

/** The size of a tar block: a header takes one, and a file's content is padded to whole ones. */
const TAR_BLOCK_SIZE = 512

/** The files of a package, by their path in the package. */
export type PackageFiles = Map<string, Buffer>

/** How the files of two versions of a package differ. */
export type PackageDifference = {
  /** The files only the new version has. */
  added: string[]
  /** The files only the published version has. */
  removed: string[]
  /** The files both have, with another content. */
  changed: string[]
}

/** The outcome of comparing a package with its published version. */
export type PackageComparison = {
  /** How they differ, or `undefined` when the published version could not be fetched. */
  difference: PackageDifference | undefined
  /** Why the published version could not be fetched, when it could not. */
  failure: string
}

/**
 * Read the files of a package archive (a `.tgz` file, as `npm pack` writes and as the registry
 * serves).
 *
 * @param archive - The content of the archive.
 *
 * @returns The content of each file, by its path without the directory every path of a package
 *   archive starts with (`package/`).
 */
export const readPackageArchive = (archive: Buffer): PackageFiles => {
  const tar = gunzipSync(archive)
  const files: PackageFiles = new Map()
  // The path given by an extended header, for the entry that follows it.
  let extendedPath: string | undefined

  for (let offset = 0; offset + TAR_BLOCK_SIZE <= tar.length;) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE)
    // The archive ends with empty blocks.
    if (header.every((byte) => byte === 0)) {
      break
    }
    /**
     * Read a text field of the header, which ends at its first NUL character.
     *
     * @param start - Where the field starts in the header.
     * @param length - The size of the field.
     *
     * @returns The text of the field.
     */
    const readField = (start: number, length: number): string =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .split('\0', 1)[0]
    const size = Number.parseInt(readField(124, 12).trim(), 8)
    const type = readField(156, 1)
    const content = tar.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE + size)

    if (type === 'x') {
      // An extended header: records of the form `<length> <key>=<value>`, of which only the
      // path of the next entry matters here (when it does not fit in the entry's own header).
      extendedPath = /^\d+ path=(?<path>.+)$/m.exec(content.toString('utf8'))?.groups?.path
    } else {
      // A regular file ('0', or nothing in the oldest form of the format).
      if (type === '0' || type === '') {
        const prefix = readField(345, 155)
        const name = readField(0, 100)
        const entryPath = extendedPath ?? (prefix === '' ? name : `${prefix}/${name}`)
        files.set(entryPath.replace(/^[^/]+\//, ''), content)
      }
      extendedPath = undefined
    }
    offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
  }
  return files
}

/**
 * The fields of a `package.json` that say nothing to those who install the package: every
 * release changes its version, and its development dependencies are not installed with it.
 */
const IGNORED_MANIFEST_FIELDS = new Set(['devDependencies', 'version'])

/**
 * Get what a `package.json` says to those who install the package (see
 * {@link IGNORED_MANIFEST_FIELDS}).
 *
 * @param content - The content of the `package.json`.
 *
 * @returns The manifest without the ignored fields, as JSON.
 */
const readComparableManifest = (content: Buffer): string => {
  const manifest: unknown = JSON.parse(content.toString('utf8'))
  return JSON.stringify(
    typeof manifest === 'object' && manifest !== null
      ? Object.fromEntries(
          Object.entries(manifest).filter(([name]) => !IGNORED_MANIFEST_FIELDS.has(name))
        )
      : manifest
  )
}

/**
 * Order two paths of a package, for a list that reads the same on every machine.
 *
 * @param first - The first path.
 * @param second - The second path.
 *
 * @returns A negative number, `0` or a positive number, as `Array.prototype.sort` expects.
 */
const comparePaths = (first: string, second: string): number => first.localeCompare(second, 'en')

/**
 * Compare the files of two versions of a package. Of their `package.json`, only what matters to
 * those who install the package is compared (see {@link IGNORED_MANIFEST_FIELDS}).
 *
 * @param publishedFiles - The files of the published version.
 * @param currentFiles - The files of the version about to be released.
 *
 * @returns The paths that were added, removed and changed, each list sorted.
 */
export const comparePackageFiles = (
  publishedFiles: PackageFiles,
  currentFiles: PackageFiles
): PackageDifference => {
  const added: string[] = []
  const changed: string[] = []
  for (const [filePath, content] of currentFiles) {
    const publishedContent = publishedFiles.get(filePath)
    if (publishedContent === undefined) {
      added.push(filePath)
    } else if (
      filePath === 'package.json'
        ? readComparableManifest(content) !== readComparableManifest(publishedContent)
        : !content.equals(publishedContent)
    ) {
      changed.push(filePath)
    }
  }
  const removed = publishedFiles
    .keys()
    .filter((filePath) => !currentFiles.has(filePath))
    .toArray()
  return {
    added: added.toSorted(comparePaths),
    removed: removed.toSorted(comparePaths),
    changed: changed.toSorted(comparePaths),
  }
}

/**
 * Check whether two versions of a package have the same files.
 *
 * @param difference - How the two versions differ.
 *
 * @returns `true` if nothing was added, removed or changed.
 */
export const isSamePackage = (difference: PackageDifference): boolean =>
  difference.added.length + difference.removed.length + difference.changed.length === 0

/**
 * List the files that differ between two versions of a package, one per line.
 *
 * @param difference - How the two versions differ.
 *
 * @returns The lines, each saying what happened to a file.
 */
export const describePackageDifference = (difference: PackageDifference): string[] => [
  ...difference.changed.map((filePath) => `changed  ${filePath}`),
  ...difference.added.map((filePath) => `added    ${filePath}`),
  ...difference.removed.map((filePath) => `removed  ${filePath}`),
]

/**
 * Compare the package in a repository, as `npm pack` packs it now, with a published version.
 * The package has to be built first: what is compared is what would be published.
 *
 * @param workspace - The repository of the package.
 * @param publishedPackageSpec - What `npm pack` fetches as the published version
 *   (`<name>@<version>`).
 *
 * @returns The comparison. A published version that cannot be fetched (it is not on npm, or
 *   npm cannot be reached) is not an error: the comparison then has no difference and says why.
 *
 * @throws If the package of the repository cannot be packed.
 */
export const compareWithPublishedPackage = (
  workspace: Workspace,
  publishedPackageSpec: string
): PackageComparison => {
  const temporaryPath = mkdtempSync(path.join(tmpdir(), 'release-package-'))
  /**
   * Pack a package into a directory of its own and read the archive.
   *
   * @param directoryName - The name of the directory, under the temporary one.
   * @param packageSpecs - What to pack: nothing for the package of the repository.
   *
   * @returns The files of the package, or why it could not be packed.
   */
  const pack = (directoryName: string, packageSpecs: string[]): PackageFiles | string => {
    const destinationPath = path.join(temporaryPath, directoryName)
    mkdirSync(destinationPath)
    // Without the package's own scripts: packing must not build, nor install git hooks.
    const result = runCommand(workspace, 'npm', [
      'pack',
      ...packageSpecs,
      '--ignore-scripts',
      '--pack-destination',
      destinationPath,
    ])
    if (!result.isSuccess) {
      return result.failure
    }
    const [archiveName] = readdirSync(destinationPath)
    return readPackageArchive(readFileSync(path.join(destinationPath, archiveName)))
  }

  const comparison = noThrow((): PackageComparison => {
    const currentFiles = pack('current', [])
    if (typeof currentFiles === 'string') {
      throw new Error(`🚨 ${currentFiles}`)
    }
    const publishedFiles = pack('published', [publishedPackageSpec])
    return typeof publishedFiles === 'string'
      ? { difference: undefined, failure: publishedFiles }
      : { difference: comparePackageFiles(publishedFiles, currentFiles), failure: '' }
  })
  rmSync(temporaryPath, { recursive: true, force: true })
  if (isNormalizedError(comparison)) {
    throw comparison
  }
  return comparison
}
