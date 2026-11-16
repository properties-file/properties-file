/**
 * Compares the package a release would publish with the version that is already on npm, file
 * by file. This is what tells a real release from one that changes nothing for users: a
 * dependency update or a refactoring that leaves the published files as they were.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { isNormalizedError, noThrow } from '../utilities/no-throw'

import { runCommand } from './workspace'

import type { Workspace } from './workspace'

/** The size of a tar block: a header takes one, and a file's content is padded to whole ones. */
const TAR_BLOCK_SIZE = 512

/**
 * The fields of a `package.json` that say nothing to those who install the package: every
 * release changes its version, and its development dependencies are not installed with it.
 */
const IGNORED_MANIFEST_FIELDS = new Set(['devDependencies', 'version'])

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
  /**
   * The fields of `package.json` that differ, when it is one of the changed files (see
   * {@link IGNORED_MANIFEST_FIELDS} for those that are not compared).
   */
  changedManifestFields: string[]
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
    if (Number.isNaN(size)) {
      // A size in another form than octal digits: not something `npm pack` writes.
      throw new Error('🚨 the package archive has an entry in a form that is not supported')
    }
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
 * Write the files of a package under a directory, to be looked at.
 *
 * @param files - What to write: the content of each file, by its path in the package.
 * @param directoryPath - Where the root of the package goes.
 */
const writePackageFiles = (files: PackageFiles, directoryPath: string): void => {
  for (const [filePath, content] of files) {
    const destinationPath = path.resolve(directoryPath, filePath)
    // An archive can name a file outside of its own directory (`../…`): such a file is not
    // written.
    if (!destinationPath.startsWith(`${path.resolve(directoryPath)}${path.sep}`)) {
      continue
    }
    mkdirSync(path.dirname(destinationPath), { recursive: true })
    writeFileSync(destinationPath, content)
  }
}

/**
 * Order two names (paths of a package, fields of its manifest), for a list that reads the same
 * on every machine.
 *
 * @param first - The first name.
 * @param second - The second name.
 *
 * @returns A negative number, `0` or a positive number, as `Array.prototype.sort` expects.
 */
const compareNames = (first: string, second: string): number => first.localeCompare(second, 'en')

/**
 * The scripts of a `package.json` that run when the package is installed. The other scripts
 * are for those who work on the package, and say nothing to those who install it.
 */
const INSTALL_SCRIPTS = new Set(['preinstall', 'install', 'postinstall'])

/**
 * Read the fields of a `package.json` that say something to those who install the package:
 * all but the {@link IGNORED_MANIFEST_FIELDS}, and of its scripts only the
 * {@link INSTALL_SCRIPTS}.
 *
 * @param content - The content of the `package.json`.
 *
 * @returns The value of each field as JSON, by its name.
 */
const readComparableFields = (content: Buffer): Map<string, string> => {
  const manifest: unknown = JSON.parse(content.toString('utf8'))
  const fields = new Map<string, string>()
  if (typeof manifest !== 'object' || manifest === null) {
    return fields
  }
  const entries: [string, unknown][] = Object.entries(manifest)
  for (const [name, value] of entries) {
    if (IGNORED_MANIFEST_FIELDS.has(name)) {
      continue
    }
    if (name === 'scripts' && typeof value === 'object' && value !== null) {
      const installScripts = Object.entries(value).filter(([script]) => INSTALL_SCRIPTS.has(script))
      // Scripts without an install script are the same as no scripts at all.
      if (installScripts.length > 0) {
        fields.set(name, JSON.stringify(Object.fromEntries(installScripts)))
      }
      continue
    }
    fields.set(name, JSON.stringify(value))
  }
  return fields
}

/**
 * Compare two `package.json`, whatever the order of their fields and their layout.
 *
 * @param publishedContent - The content of the published one.
 * @param currentContent - The content of the one about to be released.
 *
 * @returns The names of the fields that differ, sorted.
 */
const compareManifests = (publishedContent: Buffer, currentContent: Buffer): string[] => {
  const publishedFields = readComparableFields(publishedContent)
  const currentFields = readComparableFields(currentContent)
  return [...new Set([...publishedFields.keys(), ...currentFields.keys()])]
    .filter((name) => publishedFields.get(name) !== currentFields.get(name))
    .toSorted(compareNames)
}

/**
 * Check whether two versions of a file say the same thing: the same bytes, or the same text
 * with other line endings (a package published from a Windows checkout has `\r\n` where one
 * published from a Unix checkout has `\n`, which changes nothing for its users).
 *
 * @param first - The content of one version.
 * @param second - The content of the other.
 *
 * @returns `true` if the two only differ by their line endings, if at all.
 */
const isSameContent = (first: Buffer, second: Buffer): boolean => {
  if (first.equals(second)) {
    return true
  }
  // A NUL byte is what tells a binary file, in which `\r\n` is not a line ending.
  if (first.includes(0) || second.includes(0)) {
    return false
  }
  // One byte per character: the comparison is of bytes, whatever the encoding of the file.
  return (
    first.toString('latin1').replaceAll('\r\n', '\n') ===
    second.toString('latin1').replaceAll('\r\n', '\n')
  )
}

/**
 * Compare the files of two versions of a package. Line endings are not compared, and of
 * `package.json` only what matters to those who install the package is (see
 * {@link IGNORED_MANIFEST_FIELDS}).
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
  let changedManifestFields: string[] = []
  for (const [filePath, content] of currentFiles) {
    const publishedContent = publishedFiles.get(filePath)
    if (publishedContent === undefined) {
      added.push(filePath)
    } else if (filePath === 'package.json') {
      changedManifestFields = compareManifests(publishedContent, content)
      if (changedManifestFields.length > 0) {
        changed.push(filePath)
      }
    } else if (!isSameContent(publishedContent, content)) {
      changed.push(filePath)
    }
  }
  const removed = publishedFiles
    .keys()
    .filter((filePath) => !currentFiles.has(filePath))
    .toArray()
  return {
    added: added.toSorted(compareNames),
    removed: removed.toSorted(compareNames),
    changed: changed.toSorted(compareNames),
    changedManifestFields,
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
 * @returns The lines, each saying what happened to a file (and, for `package.json`, to which
 *   of its fields).
 */
export const describePackageDifference = (difference: PackageDifference): string[] => [
  ...difference.changed.map(
    (filePath) =>
      `changed  ${filePath}` +
      (filePath === 'package.json' ? ` (${difference.changedManifestFields.join(', ')})` : '')
  ),
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
 * @param keptPath - A directory to leave the files of the two packages in, under `published`
 *   and `current`, for whoever wants to look at a difference. Nothing is kept when left out.
 *
 * @returns The comparison. A published version that cannot be fetched (it is not on npm, or
 *   npm cannot be reached) is not an error: the comparison then has no difference and says why.
 *
 * @throws If the package of the repository cannot be packed.
 */
export const compareWithPublishedPackage = (
  workspace: Workspace,
  publishedPackageSpec: string,
  keptPath?: string
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
    const result = runCommand(workspace, 'npm', [
      'pack',
      ...packageSpecs,
      // Without the `prepack` and `postpack` scripts of the package: the package is packed as
      // it is. (npm runs its `prepare` script all the same.)
      '--ignore-scripts',
      // An archive is written even when npm itself was asked for a dry run.
      '--dry-run=false',
      // A registry that does not answer is given up on after half a minute per attempt,
      // not the five minutes npm waits by default.
      '--fetch-timeout=30000',
      '--pack-destination',
      destinationPath,
    ])
    if (!result.isSuccess) {
      return result.failure
    }
    const archiveNames = readdirSync(destinationPath)
    if (archiveNames.length !== 1) {
      return `\`npm pack\` wrote ${String(archiveNames.length)} files instead of one archive`
    }
    const [archiveName] = archiveNames
    const files = readPackageArchive(readFileSync(path.join(destinationPath, archiveName)))
    if (keptPath !== undefined) {
      writePackageFiles(files, path.join(keptPath, directoryName))
    }
    return files
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
