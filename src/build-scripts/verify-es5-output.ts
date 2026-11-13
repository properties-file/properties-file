/**
 * Authoritative artifact-level ES5 compatibility gate (invoked from `build.ts`): runs every
 * es-x `restrict-to-es5` rule, plus a ban on every post-ES5 built-in global derived from the
 * `globals` package (some of which no `restrict-to-es5` rule reports), against the downleveled
 * output before minification. Unlike the source-side ESLint config (which disables rules for
 * syntax TypeScript transpiles and for APIs the downlevel transform rewrites), this check has
 * no per-API exceptions — a rewritten API can no longer appear in the output, so any post-ES5
 * API or syntax found here is a build-pipeline bug (e.g. an emitted helper or a toolchain
 * emission relying on a modern API). Source linting can never see generated code; this can.
 * Every `.js` file is verified: a file ESLint does not lint, or does not parse, fails the build
 * rather than being skipped, and so does an entry that is neither a regular file nor a
 * directory (a symbolic link), whose target would otherwise go unverified.
 *
 * The es-x rules run in `aggressive` mode: without type information, es-x's prototype-method
 * rules only fire on receivers whose type its type tracer can infer (literals, built-in globals
 * and the results of built-in calls), so a non-aggressive pass would let
 * `variable.includes(...)` — the shape every real escape takes — sail through unreported.
 * Aggressive mode additionally matches by method name on every receiver of unknown type, which
 * is exactly right for built output that is supposed to contain no post-ES5 method call at all.
 * Receivers of known type are still checked by type in this mode, so an ES5 *static* call
 * whose method name collides with a post-ES5 prototype method (e.g. `Object.keys(...)` vs
 * `Array#keys`) is not reported, while a post-ES5 call on its result
 * (`Object.keys(o).includes(k)`, an array receiver) is. No es-x finding is filtered after the
 * fact: every one outside the SWC helpers below fails the build. The only finding not counted
 * is the global ban's report of an identifier an es-x rule already reports — the same
 * construct, counted once.
 *
 * The one allowed location is inside SWC's own emitted compatibility helpers: those reference
 * modern globals deliberately, behind `typeof` guards and try/catch feature detection, to use
 * them only where they exist. Helper regions are located by parsing each file and matching
 * top-level function declarations against the exact allowlist of SWC helper names — a new or
 * renamed helper after an SWC upgrade is NOT exempted until added here, so the failure
 * direction is a loud build error, never a silent exemption. Findings anywhere else —
 * including this repository's own emitted `downlevel*` helpers — fail the build. The Node.js
 * 0.4 functional replay test remains the behavioral backstop for the guarded-helper code this
 * gate skips.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { Linter } from 'eslint'
import esXPlugin from 'eslint-plugin-es-x'
import globals from 'globals'

import type { AST, SourceCode } from 'eslint'

/**
 * The exact names of SWC's emitted compatibility helper functions, as observed in this
 * repository's built output. Only top-level function declarations with these names are exempt
 * from the ES5 gate. The list is deliberately closed: if an SWC upgrade emits a new or renamed
 * helper, its findings fail the build until the name is reviewed and added here — a loud
 * failure, never a silent exemption (a name-prefix convention would exempt *any* code that
 * happens to start with an underscore).
 */
const SWC_HELPER_NAMES = new Set([
  '_array_like_to_array',
  '_array_without_holes',
  '_assert_this_initialized',
  '_call_super',
  '_class_call_check',
  '_create_class',
  '_defineProperties',
  '_export',
  '_get_prototype_of',
  '_inherits',
  '_instanceof',
  '_is_native_reflect_construct',
  '_iterable_to_array',
  '_non_iterable_spread',
  '_possible_constructor_return',
  '_set_prototype_of',
  '_to_consumable_array',
  '_type_of',
  '_unsupported_iterable_to_array',
])

/**
 * The ESLint core rule that reports every reference to a {@link POST_ES5_GLOBAL_NAMES} global.
 */
const POST_ES5_GLOBAL_RULE_ID = 'no-restricted-globals'

/**
 * Every ECMAScript built-in global that is not an ES5 global, derived rather than listed so it
 * follows the `globals` package across upgrades: each name `globals` declares for some
 * ECMAScript edition (`globals.builtin`, the union of all editions) but not for ES5. Most of
 * these also have an es-x rule in `restrict-to-es5` (`no-map`, `no-symbol`, ...), but not all:
 * no es-x rule reports a reference to `ArrayBuffer` or `Intl` itself, and the rules for
 * `DisposableStack`, `AsyncDisposableStack` and `SuppressedError` exist only in es-x's esnext
 * configuration. Only `Temporal` is named by hand: `globals` lists that TC39 global for host
 * environments (`browser`, `node`, ...) but not yet for any ECMAScript edition, so the
 * derivation alone misses it. Once a `globals` upgrade adds it to an edition, the explicit name
 * is a harmless duplicate in the set.
 */
const POST_ES5_GLOBAL_NAMES = new Set([
  ...Object.keys(globals.builtin).filter((name) => !Object.hasOwn(globals.es5, name)),
  'Temporal',
])

/**
 * Check whether a lint message is ESLint's notice that it ignored an inline directive because
 * of `noInlineConfig` (see the configuration in {@link verifyEs5Output}). Those notices are
 * expected — the directives belong to the source-level lint — not violations. A fatal message
 * is a parse error, which can quote any text of the file (including this notice's wording) and
 * leaves the file entirely unchecked: it is never a notice.
 *
 * @param message - The lint message to check.
 *
 * @returns `true` if the message is an ignored-directive notice.
 */
const isIgnoredDirectiveNotice = (message: Linter.LintMessage): boolean =>
  message.fatal !== true &&
  message.ruleId === null &&
  message.message.includes("'noInlineConfig' setting")

/**
 * Compute the `[start, end)` character ranges of SWC's emitted compatibility helpers in a built
 * file, by matching the top-level function declarations of the AST ESLint linted it from against
 * {@link SWC_HELPER_NAMES}. Using the parsed AST (rather than regex plus brace counting) is what
 * makes the ranges reliable: braces inside string literals, comments, or regular expressions
 * cannot corrupt a range. Using ESLint's own AST (rather than a second parser) is what makes
 * them comparable with the findings' positions: both come from the same parse.
 *
 * @param program - The AST of the linted file, from ESLint's `SourceCode`.
 *
 * @returns The character ranges of the recognized helper declarations.
 */
const getSwcHelperRanges = (program: AST.Program): [number, number][] => {
  const ranges: [number, number][] = []
  for (const statement of program.body) {
    // ESLint's JavaScript parser always sets `range` (the ESTree types declare it optional).
    if (
      statement.type === 'FunctionDeclaration' &&
      SWC_HELPER_NAMES.has(statement.id.name) &&
      statement.range !== undefined
    ) {
      ranges.push(statement.range)
    }
  }
  return ranges
}

/**
 * Lint every built JavaScript file in a directory against the full es-x ES5 restriction set
 * (see the module documentation for the aggressive-mode and SWC-helper-exemption design).
 *
 * @param buildDirectoryPath - The built output directory to verify (e.g. `dist/esm`).
 * @param sourceType - How to parse the files: `module` for the ESM build (its `import`/`export`
 *   statements are the one post-ES5 construct consumers' module loaders handle natively),
 *   `script` for the CJS build.
 *
 * @throws Error if any file uses post-ES5 syntax or a post-ES5 runtime API.
 */
export const verifyEs5Output = async (
  buildDirectoryPath: string,
  sourceType: 'module' | 'script'
): Promise<void> => {
  // ESLint requires an absolute path for the linter's anchor and the linted file names.
  const directoryPath = path.resolve(buildDirectoryPath)
  const directoryEntries = await readdir(directoryPath, { recursive: true, withFileTypes: true })
  // Only regular files are read and only directories are descended into. Anything else — a
  // symbolic link above all, to a file or a directory, whose target `readdir` neither reports
  // as a file nor descends into — would leave the code it leads to unverified, so its presence
  // fails the gate rather than being skipped, whatever its name.
  const unverifiableEntryPaths = directoryEntries
    .filter((entry) => !entry.isFile() && !entry.isDirectory())
    .map((entry) => path.join(entry.parentPath, entry.name))
  if (unverifiableEntryPaths.length > 0) {
    throw new Error(
      `🚨 ${buildDirectoryPath} contains entries that are neither regular files nor ` +
        'directories (e.g. symbolic links), which the ES5 gate cannot verify: ' +
        unverifiableEntryPaths.join(', ')
    )
  }
  const filePaths = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .toSorted((left, right) => left.localeCompare(right))
  // An empty (or mistyped) directory verifies nothing: never confirm it as ES5-only.
  if (filePaths.length === 0) {
    throw new Error(`🚨 ${buildDirectoryPath} contains no .js file to verify.`)
  }
  const config: Linter.Config[] = [
    {
      files: ['**/*.js'],
      // Source-level `eslint-disable` comments survive compilation into the built files.
      // They must never be honored here: one could otherwise switch this gate off for a line
      // or for a whole file.
      linterOptions: { noInlineConfig: true },
      languageOptions: {
        // `module` files need ES2015 parsing for the import/export statements themselves;
        // every other construct is still restricted to ES5 by the es-x rules below.
        ecmaVersion: sourceType === 'module' ? 2015 : 5,
        sourceType,
        // Declare every ECMAScript built-in global, of every edition. es-x's global rules
        // (`no-map`, `no-symbol`, `no-promise`, `no-global-this`, `no-bigint`, ...) only see
        // references that resolve to a declared global variable, and ESLint itself declares
        // only the globals of the parsing `ecmaVersion` above — without this, a bare
        // `new Map()` in the CJS build (ES5 globals only) or `globalThis` in either build is
        // an unresolved reference that no es-x rule reports. Declaring a global permits
        // nothing: every reference to a non-ES5 global, declared here or not, is reported by
        // the `no-restricted-globals` rule below, whether or not an es-x rule reports it too.
        globals: globals.builtin,
      },
      plugins: { 'es-x': esXPlugin },
      // Aggressive mode: prototype-method rules match by method name on every receiver of
      // unknown type — the only way an untyped lint of built output can see
      // `variable.includes(...)`-shaped calls (without it, only receivers of inferable type
      // are reported and real escapes pass silently). See the module documentation above.
      settings: { 'es-x': { aggressive: true } },
      rules: {
        // Every reference to a post-ES5 built-in global, including those no `restrict-to-es5`
        // es-x rule reports (see `POST_ES5_GLOBAL_NAMES`). Where an es-x rule reports the same
        // reference, both report the same identifier, and the finding is counted once below.
        [POST_ES5_GLOBAL_RULE_ID]: [
          'error',
          ...[...POST_ES5_GLOBAL_NAMES].map((name) => ({
            name,
            message: 'It is not an ES5 global.',
          })),
        ],
        ...esXPlugin.configs['flat/restrict-to-es5'].rules,
        // The ESM build's own import/export statements are the intended module format.
        ...(sourceType === 'module' && { 'es-x/no-modules': 'off' as const }),
        // Iterator-helper rules (ES2025) whose method names collide with ES5
        // `Array.prototype` methods are disabled: in output this gate has otherwise verified
        // as ES5, an iterator cannot exist in the first place — every iterator-*producing*
        // API (`Symbol.iterator`, generators, `.entries()`, ...) is itself post-ES5 and
        // caught by its own rule — so an aggressive-mode `.map(`/`.filter(`/... match here
        // can only be an ES5 array call. Iterator helpers with no ES5 name collision
        // (`take`, `drop`, `toArray`, `flatMap`) stay active.
        'es-x/no-iterator-prototype-every': 'off',
        'es-x/no-iterator-prototype-filter': 'off',
        'es-x/no-iterator-prototype-find': 'off',
        'es-x/no-iterator-prototype-foreach': 'off',
        'es-x/no-iterator-prototype-map': 'off',
        'es-x/no-iterator-prototype-reduce': 'off',
        'es-x/no-iterator-prototype-some': 'off',
        // es-x's esnext configuration is not enabled as a whole: in aggressive mode, its
        // `no-iterator-prototype-join` rule matches every ES5 `Array#join` call. Of its other
        // rules, these three report post-ES5 methods that nothing above reports and whose
        // names collide with no ES5 method. Every other one is redundant: its
        // global (`DisposableStack`, `Temporal`, `Iterator.zip`, `Atomics.pause`, ...) or the
        // global its member hangs off (`Symbol.dispose`) is reported by
        // `no-restricted-globals` above, esnext syntax (`using` declarations) is a parse
        // error at the `ecmaVersion` above, and `no-iterator-prototype-includes` duplicates
        // `no-array-prototype-includes` by name.
        'es-x/no-date-prototype-totemporalinstant': 'error',
        'es-x/no-iterator-prototype-chunks': 'error',
        'es-x/no-iterator-prototype-windows': 'error',
      },
    },
  ]
  const files = await Promise.all(
    filePaths.map(async (filePath) => ({ filePath, content: await readFile(filePath, 'utf8') }))
  )
  let violationCount = 0
  for (const { filePath, content } of files) {
    // The `Linter` API (rather than the file-oriented `ESLint` class) is used because it
    // exposes the `SourceCode` of each linted file — the AST and position mapping the findings
    // were produced from — and it never reads the repository's own ESLint configuration: this
    // check is exceptionless. Its anchor is the directory being verified, which is not
    // necessarily inside the process's own cwd (the gate's unit tests verify temporary
    // directories). A new `Linter` per file guarantees that the `SourceCode` it returns is this
    // file's or none: a `Linter` returns the `SourceCode` of the last file it linted, which is
    // a previous file's when this one was not linted.
    const linter = new Linter({ cwd: directoryPath })
    const messages = linter.verify(content, config, filePath)
    if (messages.length === 0) {
      continue
    }
    // Every message without a rule, other than an ignored-directive notice, means the file was
    // not linted, or not entirely: a fatal parse error (ESLint then reports it alone), or a
    // non-fatal notice such as "No matching configuration found" (line 0) for a file under a
    // directory ESLint ignores by default (`node_modules/`, `.git/`). ESLint creates no
    // `SourceCode` for such a file, and none is needed: nothing in it is exempted, every
    // message counts as a violation.
    const isFullyLinted = messages.every(
      (message) => message.ruleId !== null || isIgnoredDirectiveNotice(message)
    )
    // The declared type omits the `null` this returns when the linter has linted no file.
    const lintedSourceCode: SourceCode | null = isFullyLinted ? linter.getSourceCode() : null
    if (isFullyLinted && lintedSourceCode === null) {
      throw new Error(`🚨 ESLint produced findings but no SourceCode for ${filePath}.`)
    }
    const swcHelperRanges =
      lintedSourceCode === null ? [] : getSwcHelperRanges(lintedSourceCode.ast)
    // Where an es-x rule reports a post-ES5 global, `no-restricted-globals` reports the same
    // identifier: the second finding is the same construct, not another one.
    const otherRulePositions = new Set(
      messages
        .filter((message) => message.ruleId !== POST_ES5_GLOBAL_RULE_ID)
        .map((message) => `${message.line}:${message.column}`)
    )
    for (const message of messages) {
      if (isIgnoredDirectiveNotice(message)) {
        continue
      }
      if (
        message.ruleId === POST_ES5_GLOBAL_RULE_ID &&
        otherRulePositions.has(`${message.line}:${message.column}`)
      ) {
        continue
      }
      // A file that was not entirely linted (see above) is never exempted, wherever its
      // messages are located: a parse error leaves the whole file unchecked, not just the
      // helper its position happens to fall in. Every other finding's position is converted to
      // a character offset by the same `SourceCode` that numbered its line, so every line
      // terminator ESLint counts (`\r\n`, `\r`, `\n`, U+2028, U+2029) is counted here too
      // (ESLint columns are 1-based, `getIndexFromLoc` columns 0-based).
      if (lintedSourceCode !== null) {
        const offset = lintedSourceCode.getIndexFromLoc({
          line: message.line,
          column: message.column - 1,
        })
        const isInsideSwcHelper = swcHelperRanges.some(
          ([start, end]) => offset >= start && offset < end
        )
        if (isInsideSwcHelper) {
          continue
        }
      }

      violationCount++
      console.error(
        `   ✖ ${filePath}:${message.line}:${message.column} ${message.message} ` +
          `(${message.ruleId ?? (message.fatal === true ? 'parsing error' : 'not linted')})`
      )
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
