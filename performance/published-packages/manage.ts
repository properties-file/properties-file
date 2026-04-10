import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const rootDirectory = path.resolve(import.meta.dirname, '..', '..')
const cacheDirectory = path.resolve(import.meta.dirname, '.cache')

/**
 * Read the package name from the project's own `package.json`.
 *
 * @returns The package name (e.g. "properties-file").
 */
const getPackageName = (): string => {
  const packageJsonPath = path.resolve(rootDirectory, 'package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name: string }
  return packageJson.name
}

/**
 * Get the latest published version string from the npm registry.
 * Always queries npm (not cached) to detect new releases.
 *
 * @returns The version string (e.g. "4.0.0").
 */
export const getLatestPublishedVersion = (): string => {
  const packageName = getPackageName()
  try {
    return execSync(`npm view ${packageName} version`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred while querying npm.'
    throw new Error(
      `Failed to get the latest published version of "${packageName}" from npm.\n` +
        `This may be caused by a network issue or the package not being published yet.\n\n` +
        `Details: ${message}`
    )
  }
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

  // Download the tarball from npm.
  try {
    execSync(`npm pack ${packageName}@${version} --pack-destination "${versionCacheDirectory}"`, {
      cwd: rootDirectory,
      stdio: 'pipe',
    })
  } catch (error) {
    // Clean up the empty cache directory on failure.
    rmSync(versionCacheDirectory, { recursive: true, force: true })
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred while downloading.'
    throw new Error(
      `Failed to download ${packageName}@${version} from npm.\n` +
        `Verify the version exists: npm view ${packageName} versions\n\n` +
        `Details: ${message}`
    )
  }

  // Extract the tarball.
  try {
    execSync(
      `tar -xzf "${versionCacheDirectory}"/*.tgz -C "${versionCacheDirectory}" --strip-components=1`,
      { stdio: 'pipe' }
    )
  } catch (error) {
    rmSync(versionCacheDirectory, { recursive: true, force: true })
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred while extracting.'
    throw new Error(
      `Failed to extract the downloaded tarball for ${packageName}@${version}.\n\n` +
        `Details: ${message}`
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
