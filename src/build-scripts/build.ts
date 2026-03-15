import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { EOL } from 'node:os'
import path from 'node:path'
import { minify_sync as minify } from 'terser'

/** Matches ESM/CJS build files (`.js` and `.d.ts`). */
const REGEX_ESM_BUILD_FILES = /\.(d\.ts|js)$/

/** Matches JavaScript files (`.js`). */
const REGEX_JS_FILES = /\.js$/

/** Matches import/require paths without file extensions that need ESM extensions added. */
const REGEX_EXTENSIONLESS_IMPORTS =
  /(?<importClause>from\s*|import\s*)(?<quote>["'])(?<modulePath>(?!.*\.(js|ts))(\.|\.?\.\/.*?)\.?)(\k<quote>)/gm

/**
 * +------------------------------------------------------------------+
 * |                    Add file type declarations                    |
 * +------------------------------------------------------------------+
 */

console.log(`${EOL}🏃 Running build step: add file type declarations.${EOL}`)

/**
 * Append a type declaration to another type file.
 *
 * @param targetTypeFilePath - The path of the target type file.
 * @param typeDeclarationFilePath - The path of the type declaration file.
 */
const appendFileTypeDeclaration = (
  targetTypeFilePath: string,
  typeDeclarationFilePath: string
): void => {
  console.log(
    `   🔗 Adding file type declaration (${typeDeclarationFilePath}) to ${targetTypeFilePath}`
  )
  writeFileSync(
    targetTypeFilePath,
    `${readFileSync(targetTypeFilePath, 'utf8')}${EOL}// Enables type recognition for direct \`.properties\` file imports.${EOL}import '${typeDeclarationFilePath}'${EOL}`
  )
}

// Since the package supports both CommonJS and ECMAScript modules, we need to add the type reference to both.
const declarationDirectoryPaths = ['dist/cjs', 'dist/esm']

/**
 * Since the type file to open `.properties` files is not a module and cannot be copied, we need to
 * copy it explicitly after the build.
 */
const declarationFilename = 'properties-file'
const declarationFileContent = readFileSync(`./src/${declarationFilename}.d.ts`, 'utf8')
for (const modulePath of declarationDirectoryPaths) {
  console.log(
    `   🧬 Copying ./src/${declarationFilename}.d.ts to ${modulePath}/${declarationFilename}.d.ts`
  )
  writeFileSync(`${modulePath}/${declarationFilename}.d.ts`, declarationFileContent)
}

/**
 * Now that the declaration file is copied, we can reference it in the main package's module types.
 */
for (const modulePath of declarationDirectoryPaths) {
  appendFileTypeDeclaration(`${modulePath}/index.d.ts`, `./${declarationFilename}.d.ts`)
}

/**
 * Since the most common use case to support to require the file type declaration is by configuring
 * a loader, we need to also add the reference in all available loaders.
 *
 * @see https://github.com/microsoft/TypeScript/issues/49124
 * @see https://stackoverflow.com/questions/72187763/how-to-include-a-global-file-type-declaration-in-a-typescript-node-js-package
 */

for (const modulePath of declarationDirectoryPaths) {
  const fileLoaderDirectoryPath = `${modulePath}/loader`
  for (const fileLoaderFilePath of readdirSync(fileLoaderDirectoryPath)) {
    if (fileLoaderFilePath.endsWith('d.ts')) {
      appendFileTypeDeclaration(
        `./${fileLoaderDirectoryPath}/${fileLoaderFilePath}`,
        `../${declarationFilename}.d.ts`
      )
    }
  }
}

/**
 * +-----------------------------------------------------------------+
 * |                     Add ESM file extensions                     |
 * +-----------------------------------------------------------------+
 */

/**
 * Get all file paths matching a pattern from a directory (recursively).
 *
 * @param directoryPath - The path to the directory to search.
 * @param filePattern - A regex pattern to match file names against.
 *
 * @returns An array of matching relative file paths.
 */
const getFilePaths = (directoryPath: string, filePattern: RegExp): string[] =>
  readdirSync(directoryPath, { withFileTypes: true }).reduce<string[]>((files, entry) => {
    const absoluteEntryPath = path.resolve(directoryPath, entry.name)
    const relativeEntryPath = path.relative(process.cwd(), absoluteEntryPath)
    if (entry.isDirectory()) {
      return [...files, ...getFilePaths(absoluteEntryPath, filePattern)]
    } else if (entry.isFile() && filePattern.test(absoluteEntryPath)) {
      return [...files, relativeEntryPath]
    }
    return files
  }, [])

console.log(`${EOL}🏃 Running build step: add ESM file extensions.${EOL}`)

for (const filePath of getFilePaths('dist/esm', REGEX_ESM_BUILD_FILES)) {
  const fileContent = readFileSync(filePath, 'utf8')
  REGEX_EXTENSIONLESS_IMPORTS.lastIndex = 0
  const newFileContent = fileContent.replaceAll(
    REGEX_EXTENSIONLESS_IMPORTS,
    (_match, importClause: string, quote: string, modulePath: string) => {
      const importPath = path.resolve(path.join(path.dirname(filePath), modulePath))

      // If the path exists without any extensions then it should be a directory.
      const importPathIsDirectory = existsSync(importPath)

      if (importPathIsDirectory && !statSync(importPath).isDirectory()) {
        throw new Error(`🚨 Expected ${importPathIsDirectory} to be a directory`)
      }

      // Add the missing extension or `/index` to the path to make it ESM compatible.
      const esmPath = importPathIsDirectory ? `${importPath}/index.js` : `${importPath}.js`

      if (!existsSync(esmPath)) {
        throw new Error(`🚨 File not found: ${esmPath}`)
      }

      if (!statSync(esmPath).isFile()) {
        throw new Error(`🚨 Expected ${importPathIsDirectory} to be a file`)
      }

      const newPath = `${modulePath}${importPathIsDirectory ? '/index' : ''}.js`
      console.log(`   ➕ ${filePath}: replacing "${modulePath}" by "${newPath}"`)
      return `${importClause}${quote}${newPath}${quote}`
    }
  )

  writeFileSync(filePath, newFileContent)
}

/**
 * +----------------------------------------------------------------+
 * |                          Minify build                          |
 * +----------------------------------------------------------------+
 */

const minifyBuildDirectoryPaths = ['dist/cjs', 'dist/esm']

console.log(`${EOL}🏃 Running build script: minify build.${EOL}`)

for (const buildDirectoryPath of minifyBuildDirectoryPaths) {
  for (const filePath of getFilePaths(buildDirectoryPath, REGEX_JS_FILES)) {
    const result = minify(readFileSync(filePath, 'utf8'))
    if (result?.code === undefined) {
      throw new Error('Minification failed')
    }
    console.log(`   📦 Minifying file: ${filePath}`)
    writeFileSync(filePath, result.code)
  }
}

/**
 * +------------------------------------------------------------------+
 * |                       Delete build scripts                       |
 * +------------------------------------------------------------------+
 */

console.log(`${EOL}🏃 Running build script: delete build scripts.${EOL}`)

rmSync('dist/build-scripts', { recursive: true, force: true })
