import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { EOL } from 'node:os'
import path from 'node:path'

import { transformSync } from '@swc/core'
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

// Copy the .properties file type declaration (not a module, so TSC doesn't emit it).
// Only needed in dist/esm — CJS gets it automatically when we copy ESM → CJS later.
const declarationSource = './src/properties-file.d.ts'
const declarationTarget = 'dist/esm/properties-file.d.ts'
console.log(`   🧬 Copying ${declarationSource} to ${declarationTarget}`)
writeFileSync(declarationTarget, readFileSync(declarationSource, 'utf8'))

// Reference the declaration in the main index types.
appendFileTypeDeclaration('dist/esm/index.d.ts', './properties-file.d.ts')

// Reference the declaration in all bundler integration types.
for (const bundlerFile of readdirSync('dist/esm/bundler')) {
  if (bundlerFile.endsWith('d.ts')) {
    appendFileTypeDeclaration(`./dist/esm/bundler/${bundlerFile}`, '../properties-file.d.ts')
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

/**
 * +-----------------------------------------------------------------+
 * |         Bundle getProperties entry with esbuild                 |
 * +-----------------------------------------------------------------+
 *
 * The main entry (src/index.ts) imports unescapeContent and character
 * constants from shared modules. This step uses esbuild to bundle it
 * from TypeScript source into a single self-contained file with
 * optimal minification. The existing SWC + terser pipeline then
 * processes this output for ES5 downleveling and final minification,
 * benefiting both ESM and CJS builds.
 */

console.log(`${EOL}🏃 Running build step: bundle getProperties entry with esbuild.${EOL}`)

{
  const indexPath = path.resolve('dist/esm/index.js')
  const sourcePath = path.resolve('src/index.ts')
  const { execSync } = await import('node:child_process')
  const bundled = execSync(
    `npx esbuild ${sourcePath} --bundle --format=esm --platform=neutral --target=es2015 --minify --outfile=/dev/stdout`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  )
  writeFileSync(indexPath, bundled)
  console.log(`   📦 Bundled dist/esm/index.js (${bundled.length} bytes)`)
}

/**
 * +-----------------------------------------------------------------+
 * |                     Add ESM file extensions                     |
 * +-----------------------------------------------------------------+
 */

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
 * +------------------------------------------------------------------+
 * |                   Downlevel ES2015 to ES5 (SWC)                  |
 * +------------------------------------------------------------------+
 */

console.log(`${EOL}🏃 Running build step: downlevel ESM ES2015 → ES5 via SWC.${EOL}`)

for (const filePath of getFilePaths('dist/esm', REGEX_JS_FILES)) {
  const result = transformSync(readFileSync(filePath, 'utf8'), {
    jsc: { target: 'es5', parser: { syntax: 'ecmascript' } },
    module: { type: 'es6' },
  })
  console.log(`   ⬇️  Downleveling: ${filePath}`)
  writeFileSync(filePath, result.code)
}

/**
 * +------------------------------------------------------------------+
 * |                  Generate CJS build from ESM (SWC)               |
 * +------------------------------------------------------------------+
 */

console.log(`${EOL}🏃 Running build step: generate CJS from ESM via SWC.${EOL}`)

// Copy the entire ESM output (JS + declarations) to dist/cjs.
mkdirSync('dist/cjs', { recursive: true })
cpSync('dist/esm', 'dist/cjs', { recursive: true })

// Convert ESM JavaScript to CommonJS via SWC.
for (const filePath of getFilePaths('dist/cjs', REGEX_JS_FILES)) {
  const result = transformSync(readFileSync(filePath, 'utf8'), {
    jsc: { parser: { syntax: 'ecmascript' } },
    module: { type: 'commonjs' },
  })
  console.log(`   🔄 Converting to CJS: ${filePath}`)
  writeFileSync(filePath, result.code)
}

// Mark the CJS directory so Node.js treats .js files as CommonJS.
writeFileSync('dist/cjs/package.json', '{ "type": "commonjs" }')

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
