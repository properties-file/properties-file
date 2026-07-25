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
import { ESLint } from 'eslint'
import esXPlugin from 'eslint-plugin-es-x'
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
    }
    if (entry.isFile() && filePattern.test(absoluteEntryPath)) {
      return [...files, relativeEntryPath]
    }
    return files
  }, [])

/**
 * +-----------------------------------------------------------------+
 * |         Bundle getProperties entry with esbuild                 |
 * +-----------------------------------------------------------------+
 *
 * The main entry (src/index.ts, downleveled to .transformed-src/index.ts by
 * src/build-scripts/downlevel/transform.ts) imports unescapeContent and character
 * constants from shared modules. This step uses esbuild to bundle it
 * from TypeScript source into a single self-contained file with
 * optimal minification. The existing SWC + terser pipeline then
 * processes this output for ES5 downleveling and final minification,
 * benefiting both ESM and CJS builds.
 */

console.log(`${EOL}🏃 Running build step: bundle getProperties entry with esbuild.${EOL}`)

{
  const indexPath = path.resolve('dist/esm/index.js')
  const sourcePath = path.resolve('.transformed-src/index.ts')
  const { execSync } = await import('node:child_process')
  execSync(
    `npx esbuild ${sourcePath} --bundle --format=esm --platform=neutral --target=es2015 --minify --outfile=${indexPath}`,
    { stdio: 'pipe' }
  )
  console.log(`   📦 Bundled dist/esm/index.js (${readFileSync(indexPath, 'utf8').length} bytes)`)
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
      const isImportPathDirectory = existsSync(importPath)

      if (isImportPathDirectory && !statSync(importPath).isDirectory()) {
        throw new Error(`🚨 Expected ${isImportPathDirectory} to be a directory`)
      }

      // Add the missing extension or `/index` to the path to make it ESM compatible.
      const esmPath = isImportPathDirectory ? `${importPath}/index.js` : `${importPath}.js`

      if (!existsSync(esmPath)) {
        throw new Error(`🚨 File not found: ${esmPath}`)
      }

      if (!statSync(esmPath).isFile()) {
        throw new Error(`🚨 Expected ${isImportPathDirectory} to be a file`)
      }

      const newPath = `${modulePath}${isImportPathDirectory ? '/index' : ''}.js`
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
    jsc: {
      target: 'es5',
      parser: { syntax: 'ecmascript' },
      /**
       * Lower `for...of` to plain index loops instead of the iterator protocol. Without this,
       * SWC emits an unguarded `Symbol.iterator` call that throws on pre-ES2015 runtimes
       * (caught by the Node.js 0.4 functional replay test). Safe because shipped code only
       * iterates arrays — enforced by the local `array-iteration-only` ESLint rule.
       */
      assumptions: { iterableIsArray: true },
    },
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
 * +------------------------------------------------------------------+
 * |             Verify ES5 output (es-x on the built files)          |
 * +------------------------------------------------------------------+
 *
 * Authoritative artifact-level compatibility gate: runs every es-x `restrict-to-es5` rule
 * against the downleveled output before minification. Unlike the source-side ESLint config
 * (which disables rules for syntax TypeScript transpiles and for APIs the downlevel transform
 * rewrites), this check has no per-API exceptions — a rewritten API can no longer appear in the
 * output, so any post-ES5 API or syntax found here is a build-pipeline bug (e.g. an emitted
 * helper or a toolchain emission relying on a modern API). Source linting can never see
 * generated code; this can.
 *
 * The one allowed location is inside SWC's own emitted compatibility helpers (underscore-
 * prefixed functions like `_instanceof` and `_iterable_to_array`): those reference modern
 * globals deliberately, behind `typeof` guards and try/catch feature detection, to use them
 * only where they exist. Findings anywhere else — including this repository's own emitted
 * `downlevel*` helpers — fail the build. The Node.js 0.4 functional replay test remains the
 * behavioral backstop for the guarded-helper code this gate skips.
 */

console.log(`${EOL}🏃 Running build step: verify ES5 output via es-x.${EOL}`)

/**
 * Compute the `[start, end)` character ranges of SWC's emitted compatibility helpers in a built
 * file: top-level `function _name(...) { ... }` declarations whose names start with an
 * underscore (a naming convention no other code in the output uses — this repository's own
 * emitted helpers are `downlevel`-prefixed and deliberately not exempted).
 *
 * @param fileContent - The built file's source text.
 *
 * @returns The character ranges of underscore-prefixed function declarations.
 */
const getSwcHelperRanges = (fileContent: string): [number, number][] => {
  const ranges: [number, number][] = []
  const declarationPattern = /function\s+_[A-Za-z0-9_$]*\s*\(/g
  let declarationMatch: RegExpExecArray | null
  while ((declarationMatch = declarationPattern.exec(fileContent)) !== null) {
    // Find the helper's body range by matching braces from its opening `{`.
    const bodyStart = fileContent.indexOf('{', declarationMatch.index)
    if (bodyStart === -1) {
      continue
    }
    let depth = 0
    for (let position = bodyStart; position < fileContent.length; position++) {
      const character = fileContent.charAt(position)
      if (character === '{') {
        depth++
      } else if (character === '}') {
        depth--
        if (depth === 0) {
          ranges.push([declarationMatch.index, position + 1])
          break
        }
      }
    }
  }
  return ranges
}

/**
 * Lint every built JavaScript file in a directory against the full es-x ES5 restriction set.
 *
 * @param buildDirectoryPath - The built output directory to verify (e.g. `dist/esm`).
 * @param sourceType - How to parse the files: `module` for the ESM build (its `import`/`export`
 *   statements are the one post-ES5 construct consumers' module loaders handle natively),
 *   `script` for the CJS build.
 *
 * @throws Error if any file uses post-ES5 syntax or a post-ES5 runtime API.
 */
const verifyEs5Output = async (
  buildDirectoryPath: string,
  sourceType: 'module' | 'script'
): Promise<void> => {
  const eslintForOutput = new ESLint({
    // Ignore the repository's own ESLint configuration entirely — this check is exceptionless.
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.js'],
        languageOptions: {
          // `module` files need ES2015 parsing for the import/export statements themselves;
          // every other construct is still restricted to ES5 by the es-x rules below.
          ecmaVersion: sourceType === 'module' ? 2015 : 5,
          sourceType,
        },
        plugins: { 'es-x': esXPlugin },
        rules: {
          ...esXPlugin.configs['flat/restrict-to-es5'].rules,
          // The ESM build's own import/export statements are the intended module format.
          ...(sourceType === 'module' && { 'es-x/no-modules': 'off' as const }),
        },
      },
    ],
  })
  const results = await eslintForOutput.lintFiles([`${buildDirectoryPath}/**/*.js`])
  let violationCount = 0
  for (const result of results) {
    if (result.messages.length === 0) {
      continue
    }
    const fileContent = readFileSync(result.filePath, 'utf8')
    const swcHelperRanges = getSwcHelperRanges(fileContent)
    const lineStartOffsets = [0]
    for (let position = 0; position < fileContent.length; position++) {
      if (fileContent.charAt(position) === '\n') {
        lineStartOffsets.push(position + 1)
      }
    }
    for (const message of result.messages) {
      // Source-level `eslint-disable` comments survive compilation into the built files, and
      // this isolated ESLint instance deliberately loads only the es-x plugin — directives
      // naming other plugins' rules are inert here, not violations.
      if (/Definition for rule '[^']*' was not found/.test(message.message)) {
        continue
      }
      const offset = (lineStartOffsets[message.line - 1] ?? 0) + message.column - 1
      const isInsideSwcHelper = swcHelperRanges.some(
        ([start, end]) => offset >= start && offset < end
      )
      if (!isInsideSwcHelper) {
        violationCount++
        console.error(
          `   ✖ ${result.filePath}:${message.line}:${message.column} ${message.message} ` +
            `(${message.ruleId ?? 'parsing error'})`
        )
      }
    }
  }
  if (violationCount > 0) {
    throw new Error(
      `🚨 ${buildDirectoryPath} contains ${violationCount} post-ES5 construct(s) outside SWC's ` +
        'guarded compatibility helpers — see the report above. This is a build-pipeline bug ' +
        '(an emitted helper, a toolchain emission, or a missing downlevel rewrite), not a ' +
        'source-code error.'
    )
  }
  console.log(`   🛡️  ${buildDirectoryPath}: ES5-only output confirmed`)
}

await verifyEs5Output('dist/esm', 'module')
await verifyEs5Output('dist/cjs', 'script')

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
    if (result.code === undefined) {
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

/**
 * +------------------------------------------------------------------+
 * |               Delete the downlevel transform shadow tree          |
 * +------------------------------------------------------------------+
 */

console.log(`${EOL}🏃 Running build script: delete .transformed-src/.${EOL}`)

rmSync('.transformed-src', { recursive: true, force: true })
