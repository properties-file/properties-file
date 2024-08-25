import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { EOL } from 'node:os'
import path from 'node:path'
import { minify_sync as minify } from 'terser'

/**
 * +------------------------------------------------------------------+
 * |                    Add file type declarations                    |
 * +------------------------------------------------------------------+
 */

console.log(`🏃 Running build step: add file type declarations.${EOL}`)

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
    `${readFileSync(targetTypeFilePath).toString()}${EOL}// Enables type recognition for direct \`.properties\` file imports.${EOL}import '${typeDeclarationFilePath}'${EOL}`
  )
}

// Since the package supports both CommonJS and ECMAScript modules, we need to add the type reference to both.
const declarationDirectoryPaths = ['lib/cjs', 'lib/esm']

/**
 * Since the type file to open `.properties` files is not a module and cannot be copied, we need to
 * copy it explicitly after the build.
 */
const declarationFilename = 'properties-file'
const declarationFileContent = readFileSync(`./src/${declarationFilename}.d.ts`).toString()
declarationDirectoryPaths.forEach((modulePath) => {
  console.log(
    `   🧬 Copying ./src/${declarationFilename}.d.ts to ${modulePath}/${declarationFilename}.d.ts`
  )
  writeFileSync(`${modulePath}/${declarationFilename}.d.ts`, declarationFileContent)
})

/**
 * Now that the declaration file is copied, we can reference it in the main package's module types.
 */
declarationDirectoryPaths.forEach((modulePath) => {
  appendFileTypeDeclaration(`${modulePath}/index.d.ts`, `./${declarationFilename}.d.ts`)
})

/**
 * Since the most common use case to support to require the file type declaration is by configuring
 * a loader, we need to also add the reference in all available loaders.
 *
 * @see https://github.com/microsoft/TypeScript/issues/49124
 * @see https://stackoverflow.com/questions/72187763/how-to-include-a-global-file-type-declaration-in-a-typescript-node-js-package
 */

declarationDirectoryPaths.forEach((modulePath) => {
  const fileLoaderDirectoryPath = `${modulePath}/loader`
  const fileLoaderFilePaths = readdirSync(fileLoaderDirectoryPath)
  fileLoaderFilePaths.forEach((fileLoaderFilePath) => {
    if (fileLoaderFilePath.endsWith('d.ts')) {
      appendFileTypeDeclaration(
        `./${fileLoaderDirectoryPath}/${fileLoaderFilePath}`,
        `../${declarationFilename}.d.ts`
      )
    }
  })
})

/**
 * +-----------------------------------------------------------------+
 * |                     Add ESM file extensions                     |
 * +-----------------------------------------------------------------+
 */

const esmFileExtensionRegExp =
  /(?<from>from\s*)(?<quote>["'])(?<modulePath>(?!.*\.js)(\.|\.?\.\/.*?)\.?)(\k<quote>)/gm

/**
 * Get all ESM file paths (`.js` and `.d.ts`) from a directory.
 *
 * @param esmBuildDirectoryPath - The path to the ESM build directory.
 *
 * @returns An array of ESM file paths.
 */
const getEsmFilePaths = (esmBuildDirectoryPath: string): string[] =>
  readdirSync(esmBuildDirectoryPath, { withFileTypes: true }).reduce<string[]>((files, entry) => {
    const absoluteEntryPath = path.resolve(esmBuildDirectoryPath, entry.name)
    const relativeEntryPath = path.relative(process.cwd(), absoluteEntryPath)
    if (entry.isDirectory()) {
      return [...files, ...getEsmFilePaths(absoluteEntryPath)]
    } else if (entry.isFile() && /\.(d\.ts|js)$/.test(absoluteEntryPath)) {
      return [...files, relativeEntryPath]
    }
    return files
  }, [])

console.log(`${EOL}🏃 Running build step: add ESM file extensions.${EOL}`)

getEsmFilePaths('lib/esm').forEach((filePath) => {
  const fileContent = readFileSync(filePath).toString()
  const newFileContent = fileContent.replace(
    esmFileExtensionRegExp,
    (_match, from: string, quote: string, modulePath: string) => {
      const fromPath = path.resolve(path.join(path.dirname(filePath), modulePath))

      // If the path exists without any extensions then it should be a directory.
      const fromPathIsDirectory = existsSync(fromPath)

      if (fromPathIsDirectory && !statSync(fromPath).isDirectory()) {
        throw new Error(`🚨 Expected ${fromPathIsDirectory} to be a directory`)
      }

      // Add the missing extension or `/index` to the path to make it ESM compatible.
      const esmPath = fromPathIsDirectory ? `${fromPath}/index.js` : `${fromPath}.js`

      if (!existsSync(esmPath)) {
        throw new Error(`🚨 File not found: ${esmPath}`)
      }

      if (!statSync(esmPath).isFile()) {
        throw new Error(`🚨 Expected ${fromPathIsDirectory} to be a file`)
      }

      const newPath = `${modulePath}${fromPathIsDirectory ? '/index' : ''}.js`
      console.log(`   ➕ ${filePath}: replacing "${modulePath}" by "${newPath}"`)
      return `${from}${quote}${newPath}${quote}`
    }
  )

  writeFileSync(filePath, newFileContent)
})

/**
 * +----------------------------------------------------------------+
 * |                          Minify build                          |
 * +----------------------------------------------------------------+
 */

/**
 * Get all JavaScript file paths (`.js`) from a build directory.
 *
 * @param esmBuildDirectoryPath - The path to the build directory.
 *
 * @returns An array of JavaScript file paths.
 */
const getJsFilePaths = (buildDirectoryPath: string): string[] =>
  readdirSync(buildDirectoryPath, { withFileTypes: true }).reduce<string[]>((files, entry) => {
    const absoluteEntryPath = path.resolve(buildDirectoryPath, entry.name)
    const relativeEntryPath = path.relative(process.cwd(), absoluteEntryPath)
    if (entry.isDirectory()) {
      return [...files, ...getJsFilePaths(absoluteEntryPath)]
    } else if (entry.isFile() && /\.js$/.test(absoluteEntryPath)) {
      return [...files, relativeEntryPath]
    }
    return files
  }, [])

const minifyBuildDirectoryPaths = ['lib/cjs', 'lib/esm']

console.log(`${EOL}🏃 Running build script: minify build.${EOL}`)

minifyBuildDirectoryPaths.forEach((buildDirectoryPath) => {
  getJsFilePaths(buildDirectoryPath).forEach((filePath) => {
    const result = minify(readFileSync(filePath).toString())
    if (result?.code === undefined) {
      throw new Error('Minification failed')
    }
    console.log(`   📦 Minifying file: ${filePath}`)
    writeFileSync(filePath, result.code)
  })
})

/**
 * +------------------------------------------------------------------+
 * |                       Delete build scripts                       |
 * +------------------------------------------------------------------+
 */

console.log(`${EOL}🏃 Running build script: delete build scripts.${EOL}`)

rmSync('lib/build-scripts', { recursive: true, force: true })
