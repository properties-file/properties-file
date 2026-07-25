/**
 * Authoritative artifact-level ES5 compatibility gate (invoked from `build.ts`): runs every
 * es-x `restrict-to-es5` rule against the downleveled output before minification. Unlike the
 * source-side ESLint config (which disables rules for syntax TypeScript transpiles and for
 * APIs the downlevel transform rewrites), this check has no per-API exceptions — a rewritten
 * API can no longer appear in the output, so any post-ES5 API or syntax found here is a
 * build-pipeline bug (e.g. an emitted helper or a toolchain emission relying on a modern API).
 * Source linting can never see generated code; this can.
 *
 * The es-x rules run in `aggressive` mode: without type information, es-x's prototype-method
 * rules only fire on literal receivers (`"x".includes(...)`), so a non-aggressive pass would
 * let `variable.includes(...)` — the shape every real escape takes — sail through unreported.
 * Aggressive mode matches by method name on any receiver, which is exactly right for built
 * output that is supposed to contain no post-ES5 method call at all. The one class of
 * aggressive false positives — ES5 *static* namespace calls whose method name collides with a
 * post-ES5 prototype method (e.g. `Object.keys(...)` vs `Array#keys`) — is filtered by
 * checking the flagged receiver against the fixed set of ES5 global namespaces.
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
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { ESLint } from 'eslint'
import esXPlugin from 'eslint-plugin-es-x'
import {
  createSourceFile,
  isFunctionDeclaration,
  ScriptKind,
  ScriptTarget as TsScriptTarget,
} from 'typescript'

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
 * Compute the `[start, end)` character ranges of SWC's emitted compatibility helpers in a built
 * file, by parsing the file and matching top-level function declarations against
 * {@link SWC_HELPER_NAMES}. Parsing (rather than regex plus brace counting) is what makes the
 * ranges reliable: braces inside string literals, comments, or regular expressions cannot
 * corrupt a range.
 *
 * @param filePath - The built file's path (for the parser's source-file name only).
 * @param fileContent - The built file's source text.
 *
 * @returns The character ranges of the recognized helper declarations.
 */
const getSwcHelperRanges = (filePath: string, fileContent: string): [number, number][] => {
  const parsed = createSourceFile(
    filePath,
    fileContent,
    TsScriptTarget.Latest,
    false,
    ScriptKind.JS
  )
  const ranges: [number, number][] = []
  parsed.forEachChild((statement) => {
    if (
      isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      SWC_HELPER_NAMES.has(statement.name.text)
    ) {
      ranges.push([statement.getStart(parsed), statement.getEnd()])
    }
  })
  return ranges
}

/**
 * Matches a call whose receiver is one of the fixed ES5 global namespaces. Used to filter the
 * one class of aggressive-mode es-x false positives: a *static* ES5 call like `Object.keys(o)`
 * name-matches a post-ES5 *prototype* rule (`Array#keys`), but a static namespace call can
 * never be a prototype-method call. The receiver is checked from the flagged position's own
 * text, which is reliable because the gate runs before minification renames identifiers.
 *
 * The negative lookahead keeps `X.prototype.…` receivers OUT of the filter: a direct
 * `Array.prototype.includes(...)` call is a genuine post-ES5 prototype-method usage that
 * happens to start with a global's name, and must stay reported. (Indirected calls like
 * `Array.prototype.includes.call(arr, x)` are a known blind spot of es-x itself — a
 * property-access-then-`.call` shape is not a method call es-x can attribute — and are covered
 * only by the Node.js 0.4 behavioral replay.)
 */
const ES5_STATIC_GLOBAL_CALL_PATTERN =
  /^(?:Object|Math|JSON|Date|String|Number|Boolean|RegExp|Array|Function|Error)\s*\.(?!\s*prototype\s*[.[])/

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
  const eslintForOutput = new ESLint({
    // Anchor the instance to the directory being verified: ESLint refuses to lint files
    // outside its cwd, and the verified directory is not necessarily inside the process's own
    // cwd (the gate's unit tests verify temporary directories). ESLint requires the anchor to
    // be absolute.
    cwd: path.resolve(buildDirectoryPath),
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
        // Aggressive mode: prototype-method rules match by method name on ANY receiver — the
        // only way an untyped lint of built output can see `variable.includes(...)`-shaped
        // calls (without it, only literal receivers are reported and real escapes pass
        // silently). See the module documentation above.
        settings: { 'es-x': { aggressive: true } },
        rules: {
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
        },
      },
    ],
  })
  const results = await eslintForOutput.lintFiles(['**/*.js'])
  let violationCount = 0
  for (const result of results) {
    if (result.messages.length === 0) {
      continue
    }
    const fileContent = readFileSync(result.filePath, 'utf8')
    const swcHelperRanges = getSwcHelperRanges(result.filePath, fileContent)
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
      // Aggressive-mode false positive: a static call on an ES5 global namespace (e.g.
      // `Object.keys(...)`) name-matching a post-ES5 *prototype* rule — see
      // ES5_STATIC_GLOBAL_CALL_PATTERN. Restricted to prototype rules so genuine post-ES5
      // *static* APIs on the same namespaces (e.g. `Object.entries(...)`, flagged by a
      // non-prototype rule) are never skipped.
      if (
        message.ruleId !== null &&
        message.ruleId.includes('-prototype-') &&
        ES5_STATIC_GLOBAL_CALL_PATTERN.test(fileContent.slice(offset, offset + 24))
      ) {
        continue
      }
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
