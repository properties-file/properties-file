import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { isNormalizedError, noThrow } from '../../utilities/no-throw'

const rootDirectory = path.resolve(import.meta.dirname, '..', '..')
const cacheDirectory = path.resolve(import.meta.dirname, '.cache')

/**
 * Read the package name from the project's own `package.json`.
 *
 * @returns The package name (e.g. "properties-file").
 *
 * @throws Error if `package.json` does not contain a string `name` field.
 */
const getPackageName = (): string => {
  const packageJsonPath = path.resolve(rootDirectory, 'package.json')
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('name' in parsed) ||
    typeof parsed.name !== 'string'
  ) {
    throw new Error(`Expected ${packageJsonPath} to contain a string "name" field.`)
  }
  return parsed.name
}

/**
 * Get the latest published version string from the npm registry.
 * Always queries npm (not cached) to detect new releases.
 *
 * @returns The version string (e.g. "4.0.0").
 */
export const getLatestPublishedVersion = (): string => {
  const packageName = getPackageName()
  // Use `npm view` to get the latest version from the registry.
  // During a release, npm may return the just-published version that hasn't
  // fully propagated yet. In that case, the download will fail and we fall
  // back to the previous version in `getPublishedPackageDirectory`.
  const version = noThrow(() =>
    execSync(`npm view ${packageName} version`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  )
  if (isNormalizedError(version)) {
    throw new Error(
      `Failed to get the latest published version of "${packageName}" from npm.\n` +
        `This may be caused by a network issue or the package not being published yet.\n\n` +
        `Details: ${version.message}`
    )
  }
  return version
}

/**
 * Get the directory path for a cached published version.
 * Downloads and extracts from npm on first access, returns the cached
 * path on subsequent calls.
 *
 * A specific version is immutable on npm — once cached, it never needs
 * updating.
 *
 * @param version - The npm version to fetch (e.g. "4.0.0").
 *
 * @returns The path to the cached package root (contains dist/, package.json, etc.).
 */
export const getPublishedPackageDirectory = (version: string): string => {
  const versionCacheDirectory = path.resolve(cacheDirectory, version)
  const distributionDirectory = path.resolve(versionCacheDirectory, 'dist')

  // If the cache already has dist/, the package is fully extracted — return immediately.
  if (existsSync(distributionDirectory)) {
    return versionCacheDirectory
  }

  const packageName = getPackageName()

  console.log(`Downloading ${packageName}@${version} from npm...`)
  mkdirSync(versionCacheDirectory, { recursive: true })

  // Download the tarball from npm. Retry once after a short delay to handle
  // npm CDN propagation delays during releases.
  const maxAttempts = 2
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const download = noThrow(() =>
      execSync(`npm pack ${packageName}@${version} --pack-destination "${versionCacheDirectory}"`, {
        cwd: rootDirectory,
        stdio: 'pipe',
      })
    )
    if (!isNormalizedError(download)) {
      break
    }
    if (attempt < maxAttempts) {
      console.log(`Download failed, retrying in 10 seconds (npm CDN propagation delay)...`)
      execSync('sleep 10')
      continue
    }
    // Clean up the empty cache directory on final failure.
    rmSync(versionCacheDirectory, { recursive: true, force: true })
    throw new Error(
      `Failed to download ${packageName}@${version} from npm.\n` +
        `Verify the version exists: npm view ${packageName} versions\n\n` +
        `Details: ${download.message}`
    )
  }

  // Extract the tarball.
  const extraction = noThrow(() =>
    execSync(
      `tar -xzf "${versionCacheDirectory}"/*.tgz -C "${versionCacheDirectory}" --strip-components=1`,
      { stdio: 'pipe' }
    )
  )
  if (isNormalizedError(extraction)) {
    rmSync(versionCacheDirectory, { recursive: true, force: true })
    throw new Error(
      `Failed to extract the downloaded tarball for ${packageName}@${version}.\n\n` +
        `Details: ${extraction.message}`
    )
  }

  // Remove the tarball after successful extraction.
  for (const file of readdirSync(versionCacheDirectory)) {
    if (file.endsWith('.tgz')) {
      rmSync(path.resolve(versionCacheDirectory, file))
    }
  }

  console.log(`Cached ${packageName}@${version} at ${versionCacheDirectory}`)
  return versionCacheDirectory
}
