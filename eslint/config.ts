import path from 'node:path'

import { defineConfig } from 'eslint/config'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import { flatConfigs as importXPluginFlatConfigs } from 'eslint-plugin-import-x'
import jestPlugin from 'eslint-plugin-jest'
import jsdocPlugin from 'eslint-plugin-jsdoc'
import { configs as packageJsonConfigs } from 'eslint-plugin-package-json'
import preferArrowFunctionsPlugin from 'eslint-plugin-prefer-arrow-functions'
import prettierRecommendedConfig from 'eslint-plugin-prettier/recommended'
import tsdocPlugin from 'eslint-plugin-tsdoc'
import unicornPlugin from 'eslint-plugin-unicorn'
import * as jsoncParser from 'jsonc-eslint-parser'
import { configs as tsEslintConfigs } from 'typescript-eslint'

import { arrayIterationOnlyRule } from './rules/array-iteration-only'

/** Project root directory (one level up from eslint/). */
const ROOT_DIR = path.resolve(import.meta.dirname, '..')

const TYPESCRIPT_FILES = ['**/*.ts', '**/*.mts', '**/*.cts']

/**
 * Unicorn rules that push modern APIs, disabled in shipped code (and re-enabled for non-shipped
 * files, which run on modern Node.js).
 *
 * This list is deliberately minimal. The general policy for modern-API rules is *lazy*: rules
 * whose suggestions the downlevel catalog does not (yet) cover stay ACTIVE. If one ever fires —
 * new code, or a unicorn upgrade adding rules — the build makes it impossible to miss: the
 * `eslint --fix` step may modernize the source, and the build's ES5 output gate then rejects
 * the uncovered API. That failure is the decision point, made when a real use case exists:
 *
 * 1. Cover the API in the downlevel catalog (see src/build-scripts/downlevel/README.md), or
 * 2. add the rule here with the decision documented (reverting any autofix), or
 * 3. keep the ES5-expressible form and suppress the single site with a justification.
 *
 * Nothing is parked here preemptively. Every push a rule can make is immediately checked by a
 * precise counterpart: uncovered ES APIs fail the build's ES5 output gate; runtime-specific
 * host APIs (which that gate cannot see — es-x only knows ECMAScript) fail the
 * `no-restricted-globals` runtime-agnostic ban (see {@link RESTRICTED_RUNTIME_GLOBALS}); and
 * non-array iteration (e.g. a `prefer-direct-iteration` suggestion targeting a non-array
 * iterable) fails `local/array-iteration-only`, in the same lint pass.
 *
 * Rules disabled for project-wide *domain* reasons (rather than ES5 compatibility) do not
 * belong here either — this list is re-enabled as errors for non-shipped files, which only
 * makes sense for compatibility-driven exclusions. Domain preferences live with the other
 * unicorn overrides below (e.g. `unicorn/prefer-code-point`).
 */
const UNICORN_MODERN_API_RULES: string[] = []

/**
 * Set a list of ESLint rules to a given severity level.
 *
 * @param rules - The rule names to configure.
 * @param level - The severity level to apply ('off' to disable, 'error' to enforce).
 *
 * @returns An object mapping each rule name to the specified severity level.
 */
const setRules = (rules: string[], level: 'off' | 'error'): Record<string, 'off' | 'error'> =>
  Object.fromEntries(rules.map((rule) => [rule, level]))

/**
 * typescript-eslint rules from `stylisticTypeChecked` that suggest ES2015+ runtime APIs
 * (not transpilable by TypeScript or SWC). Mirrors {@link UNICORN_MODERN_API_RULES}:
 * disabled in shipped code to maintain backward compatibility, re-enabled for non-shipped files.
 *
 * Intentionally empty: `@typescript-eslint/prefer-find` (ES2015 - Array.prototype.find) was the
 * only entry, and the downlevel catalog's find-family coverage (`find`/`findIndex`/`findLast`/
 * `findLastIndex`) now covers its entire suggestion surface, so it was removed. A future entry
 * belongs here only if it suggests a runtime API the downlevel catalog does not (yet) rewrite.
 */
const TS_ESLINT_MODERN_API_RULES: string[] = []

/**
 * Globals whose presence marks runtime-specific code. The core library is runtime-agnostic —
 * usable from browsers, Node.js, and every bundler — so shipped code may only use the
 * ECMAScript language itself plus explicitly-passed inputs. Node.js-only, browser-only, and
 * host-environment APIs are all banned (bundler integration plugins are exempted below — they
 * run inside Node.js-based build tools by nature).
 *
 * This is also what makes the lazy modern-API-rule policy (see UNICORN_MODERN_API_RULES) safe
 * for host APIs: the build's ES5 output gate only understands ECMAScript, so a lint autofix
 * pushing a host API (e.g. `queueMicrotask`) would otherwise ship undetected by every static
 * layer. With this ban, any such push fails source linting immediately.
 */
const RESTRICTED_RUNTIME_GLOBALS = [
  // Node.js / host APIs.
  'process',
  'Buffer',
  'setImmediate',
  'queueMicrotask',
  'structuredClone',
  'fetch',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'TextEncoder',
  'TextDecoder',
  'performance',
  'crypto',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  // Browser-only APIs.
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
].map((name) => ({
  name,
  message:
    'Shipped code must stay runtime-agnostic (ECMAScript only) — this API is unavailable on ' +
    'some supported runtimes.',
}))

export default defineConfig(
  // Files to ignore (replaces `.eslintignore`).
  {
    // ESLint ignores `node_modules` and dot-files by default.
    // @see https://eslint.org/docs/latest/user-guide/configuring/ignoring-code
    ignores: [
      // Distribution (compiled code).
      'dist/',
      // Downlevel transform shadow tree (see src/build-scripts/downlevel/), regenerated per build.
      '.transformed-src/',
      // Jest files.
      'coverage/',
      // Asset (static) files.
      'assets/',
      // Performance generated files (results, caches, snapshots).
      'performance/**/.*/',
      // Type declarations don't need linting.
      '**/*.d.ts',
      // Intentionally ES5 (must execute on Node.js 0.4 via the compat Docker image).
      'tests/functional/run-cjs.js',
      // Generated file (golden.json scenario fixtures produced by generate.ts).
      'tests/functional/golden.json',
      // Minimal CommonJS marker (mirrors dist/cjs/package.json), not a publishable package.
      'tests/functional/package.json',
    ],
  },
  // Prettier recommended configs.
  // @see https://github.com/prettier/eslint-plugin-prettier
  prettierRecommendedConfig,
  // Unicorn recommended configs.
  // @see https://github.com/sindresorhus/eslint-plugin-unicorn
  unicornPlugin.configs.recommended,
  // Local project-specific rules (see eslint/rules/).
  { plugins: { local: { rules: { 'array-iteration-only': arrayIterationOnlyRule } } } },
  // TypeScript configuration. Applies to eslint/ files too (their tsconfig project is
  // overridden by the dedicated block below, mirroring the performance/ and build-scripts/ dirs).
  {
    files: [...TYPESCRIPT_FILES],
    extends: [
      // TypeScript ESLint recommended configs.
      // @see https://typescript-eslint.io/getting-started/
      tsEslintConfigs.strictTypeChecked,
      tsEslintConfigs.stylisticTypeChecked,
      // Make sure that imports are valid.
      // @see https://github.com/un-ts/eslint-plugin-import-x
      importXPluginFlatConfigs.recommended,
      importXPluginFlatConfigs.typescript,
    ],
    plugins: {
      'prefer-arrow-functions': preferArrowFunctionsPlugin,
      tsdoc: tsdocPlugin,
      jsdoc: jsdocPlugin,
    },
    languageOptions: { parserOptions: { project: ['tsconfig.json'], tsconfigRootDir: ROOT_DIR } },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()],
      jsdoc: { mode: 'typescript' },
    },
    rules: {
      /**
       * ES5 runtime compatibility is deliberately NOT linted at source level: the downlevel
       * transform (src/build-scripts/downlevel/) rewrites modern APIs before compilation, and
       * the authoritative, exceptionless check runs against the BUILT output (the es-x
       * "verify ES5 output" step in src/build-scripts/build.ts). An uncovered modern API is
       * therefore caught by the build, not the editor — see the lazy policy documented on
       * {@link UNICORN_MODERN_API_RULES}.
       */
      // The core library is runtime-agnostic: no Node.js-only or browser-only APIs in shipped
      // code (see RESTRICTED_RUNTIME_GLOBALS; bundler plugins and non-shipped files are
      // exempted in their own blocks below).
      'no-restricted-globals': ['error', ...RESTRICTED_RUNTIME_GLOBALS],
      // Error handling uses the shared noThrow()/NormalizedError pattern instead of try/catch:
      // caught values are typed (never an ad-hoc `unknown` narrowing dance) and results stay in
      // the enclosing scope. The helper file itself hosts the only permitted try/catch (see its
      // exemption block below). Shipped code under src/ currently needs no error handling at
      // all — if it ever does, this rule firing there is the decision point (the helper would
      // add bundle bytes, so shipped code must not silently import it).
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TryStatement',
          message:
            'Use noThrow()/isNormalizedError() from utilities/no-throw.ts instead of ' +
            'try/catch for typed, consistent error handling.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                'Shipped code must stay runtime-agnostic (ECMAScript only) — Node.js modules ' +
                'are unavailable on other supported runtimes.',
            },
          ],
        },
      ],
      // Prove `for...of`/spread/array destructuring only target arrays, so the ES5 downlevel's
      // `iterableIsArray` assumption is safe (see src/build-scripts/build.ts). Disabled for
      // non-shipped files below, which never pass through the ES5 downlevel.
      'local/array-iteration-only': 'error',
      // Sort import declarations by group (builtin → external → internal → parent → sibling → index).
      // @see https://github.com/un-ts/eslint-plugin-import-x/blob/master/docs/rules/order.md
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
            'object',
            'type',
          ],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      // Sort named specifiers within a single import statement (e.g., { b, a } → { a, b }).
      // Declaration sorting is handled by import-x/order above, so it is disabled here.
      // @see https://eslint.org/docs/latest/rules/sort-imports
      'sort-imports': [
        'error',
        {
          ignoreCase: true,
          ignoreDeclarationSort: true,
          ignoreMemberSort: false,
        },
      ],
      // Flag usage of APIs marked with the `@deprecated` JSDoc tag.
      // @see https://typescript-eslint.io/rules/no-deprecated/
      '@typescript-eslint/no-deprecated': 'error',
      // Make sure there is always a space before comments.
      // @see https://eslint.org/docs/latest/rules/spaced-comment
      'spaced-comment': ['error'],
      // Prevent omission of curly brace (e.g. same-line if/return).
      // @see https://eslint.org/docs/latest/rules/curly
      curly: ['error'],
      // Forbid `console.log` in shipped code; allow `warn`/`error` for legitimate diagnostics.
      // Disabled in the "Non-shipped files" block below for build scripts, tests, and performance scripts.
      // @see https://eslint.org/docs/latest/rules/no-console
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Validates that TypeScript doc comments conform to the TSDoc specification.
      // @see https://tsdoc.org/pages/packages/eslint-plugin-tsdoc/
      'tsdoc/syntax': 'warn',
      // TSDoc completeness: `tsdoc/syntax` above only validates syntax of comments that exist;
      // the jsdoc rules below make documentation mandatory (presence, one @param per parameter
      // with matching names, @returns on value-returning functions, non-empty descriptions).
      // Type annotations in braces are deliberately NOT required (`require-param-type`/
      // `require-returns-type` stay off): types live in TypeScript, which is TSDoc style.
      // @see https://github.com/gajus/eslint-plugin-jsdoc
      'jsdoc/require-jsdoc': [
        'error',
        {
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
          },
          contexts: [
            'VariableDeclarator > ArrowFunctionExpression',
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSEnumDeclaration',
            'PropertyDefinition',
            'TSInterfaceDeclaration TSPropertySignature',
            'TSInterfaceDeclaration TSMethodSignature',
          ],
        },
      ],
      'jsdoc/require-description': 'error',
      'jsdoc/require-param': 'error',
      'jsdoc/require-param-description': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/require-returns': 'error',
      'jsdoc/require-returns-description': 'error',
      // Enforces explicit return types on functions and class methods to avoid unintentionally breaking contracts.
      // @see https://typescript-eslint.io/rules/explicit-module-boundary-types/
      '@typescript-eslint/explicit-function-return-type': 'error',
      // Enforces consistent type imports.
      // @see https://typescript-eslint.io/rules/consistent-type-imports/
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // Prefer `type` over `interface` for object shapes.
      // @see https://typescript-eslint.io/rules/consistent-type-definitions/
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      // Ban `as X` and `<X>foo` casts entirely.
      // @see https://typescript-eslint.io/rules/consistent-type-assertions/
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      // Allow numbers in template literals (predictable coercion); still catches objects/null/undefined.
      // @see https://typescript-eslint.io/rules/restrict-template-expressions/
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Checks members (classes, interfaces, types) and applies consistent ordering.
      // @see https://typescript-eslint.io/rules/member-ordering/
      '@typescript-eslint/member-ordering': [
        'error',
        { default: { memberTypes: ['field', 'constructor', 'method'] } },
      ],
      'prefer-arrow-functions/prefer-arrow-functions': [
        // There is no recommended configuration to extend so we have to set it here to enforce arrow functions.
        // @see https://github.com/JamieMason/eslint-plugin-prefer-arrow-functions
        'warn',
        {
          classPropertiesAllowed: false,
          disallowPrototype: false,
          returnStyle: 'unchanged',
          singleReturnOnly: false,
        },
      ],
      /**
       * Unicorn-specific configuration.
       *
       * The Unicorn plugin comes with opinionated checks, including some that we prefer disabling.
       */
      'unicorn/no-array-reduce': [
        // 'reduce' is a powerful method for functional programming patterns, use it when appropriate.
        'off',
      ],
      /**
       * Avoids circular conflict between `unicorn/no-nested-ternary` and `prettier`.
       *
       * @see https://github.com/sindresorhus/eslint-plugin-unicorn/issues/2604
       */
      'unicorn/no-nested-ternary': 'off',
      // Prefer `forEach` over `for...of` loops for readability on modern engines.
      'unicorn/no-for-each': 'off',
      // Doesn't add a lot of value and makes numbers look odd.
      'unicorn/numeric-separators-style': 'off',
      // Not really applicable when using TypeScript (mostly triggers false positives).
      'unicorn/prefer-type-error': 'off',
      /**
       * `undefined` and `null` have distinct semantics (i.e. `undefined` means absent, while
       * `null` means explicitly set to empty). We prefer to keep both in our codebase.
       */
      'unicorn/no-null': 'off',
      /**
       * Negated conditions with an explicit else branch are sometimes the clearer reading
       * order (e.g. handling the exceptional case first); left to author judgment.
       */
      'unicorn/no-negated-condition': 'off',
      /**
       * Code-unit (`charCodeAt`/`fromCharCode`) string handling is the domain-correct form
       * for this project, everywhere: the `.properties` format is defined over UTF-16 code
       * units (a Java `\uXXXX` escape is one code unit; an astral character is two escapes
       * forming a surrogate pair), so code-point APIs would produce spec-invalid escapes.
       * This is a domain preference, not an ES5-compatibility exclusion —
       * `codePointAt`/`fromCodePoint` are downlevel-catalog-coverable if a genuine
       * code-point use case ever appears (see src/build-scripts/downlevel/README.md).
       */
      'unicorn/prefer-code-point': 'off',
      /**
       * Extracting nested-loop `break`/`continue` into functions adds call overhead and hurts
       * readability in the character-scanning parser hot paths (guarded by the benchmark suite).
       */
      'unicorn/no-break-in-nested-loop': 'off',
      /**
       * Enforce `is`/`has`/`should`-style prefixes on boolean names.
       *
       * The `ignore` list is a deliberate vocabulary decision, not (only) breaking-change
       * avoidance — this codebase intentionally uses two boolean naming conventions:
       *
       * - State-describing booleans (locals, predicates, results) use `is`/`has`/`should`
       *   prefixes, enforced by this rule (e.g. `shouldEscapeUnicode`, `hasDanglingContinuation`).
       * - Boolean option keys in the public API use imperative verb phrases describing the
       *   action to perform (`escapeUnicode`, `removeComments`, `collapseMultiline`,
       *   `deduplicateKeys`), matching the broader ecosystem convention for boolean options
       *   (e.g. TypeScript's `removeComments`, terser's `compress`).
       *
       * The `escapeKey`/`escapeValue` parameters named `escapeUnicode` mirror the option key of
       * the same name, so prefixing them would break vocabulary consistency with the options
       * they feed. The rule only checks variables and parameters (`checkProperties` defaults to
       * `false`), so renaming the parameters would not make the option keys lint-enforced anyway.
       */
      'unicorn/consistent-boolean-name': ['error', { ignore: ['^escape(Unicode|Space)$'] }],
      /**
       * This rule conflicts with `prettier/prettier` and there is no way to disable the Prettier rule.
       *
       * @see https://github.com/sindresorhus/eslint-plugin-unicorn/issues/2285
       */
      'unicorn/number-literal-case': 'off',
      // Disable modern API rules for backward compatibility (see UNICORN_MODERN_API_RULES).
      ...setRules(UNICORN_MODERN_API_RULES, 'off'),
      // Disable typescript-eslint stylistic rules that suggest ES2015+ runtime APIs
      // (see TS_ESLINT_MODERN_API_RULES). Re-enabled in non-shipped files block below.
      ...setRules(TS_ESLINT_MODERN_API_RULES, 'off'),
    },
  },
  // Special configuration for the ESLint configuration file.
  {
    files: ['eslint.config.ts', 'eslint/**/*.ts'],
    ignores: ['**/*.d.ts'],
    languageOptions: {
      parserOptions: { project: ['eslint/tsconfig.json'], tsconfigRootDir: ROOT_DIR },
    },
  },
  // Non-shipped files (build scripts, tests, config) run in Node 20+ and should use modern APIs.
  {
    files: [
      ...TYPESCRIPT_FILES.map((pattern) => `src/build-scripts/${pattern}`),
      ...TYPESCRIPT_FILES.map((pattern) => `tests/${pattern}`),
      'eslint.config.ts',
      ...TYPESCRIPT_FILES.map((pattern) => `eslint/${pattern}`),
      ...TYPESCRIPT_FILES.map((pattern) => `performance/${pattern}`),
      ...TYPESCRIPT_FILES.map((pattern) => `utilities/${pattern}`),
    ],
    rules: {
      // Non-shipped files run on modern Node.js: runtime-specific APIs and Node module imports
      // are fine here.
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
      // Re-enable modern unicorn rules that are disabled for backward compatibility in shipped code.
      ...setRules(UNICORN_MODERN_API_RULES, 'error'),
      // Re-enable typescript-eslint stylistic modern-API rules.
      ...setRules(TS_ESLINT_MODERN_API_RULES, 'error'),
      // Non-shipped files never pass through the ES5 downlevel; iterating any iterable is fine.
      'local/array-iteration-only': 'off',
      // Allow `console.log` for status output, benchmark results, and test diagnostics.
      // @see https://eslint.org/docs/latest/rules/no-console
      'no-console': 'off',
    },
  },
  // Build script TypeScript files.
  {
    files: TYPESCRIPT_FILES.map((pattern) => `src/build-scripts/${pattern}`),
    languageOptions: {
      parserOptions: { project: ['src/build-scripts/tsconfig.json'], tsconfigRootDir: ROOT_DIR },
    },
  },
  // Bundler integration plugins (shipped, but Node.js-context by nature: they run inside
  // Node.js-based build tools and legitimately read files). The runtime-agnostic restriction
  // applies to the core library only.
  {
    files: TYPESCRIPT_FILES.map((pattern) => `src/bundler/${pattern}`),
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  },
  // Performance TypeScript files.
  {
    files: TYPESCRIPT_FILES.map((pattern) => `performance/${pattern}`),
    languageOptions: {
      parserOptions: { project: ['performance/tsconfig.json'], tsconfigRootDir: ROOT_DIR },
    },
  },
  // Shared internal utilities (dev tooling only, never shipped).
  {
    files: TYPESCRIPT_FILES.map((pattern) => `utilities/${pattern}`),
    languageOptions: {
      parserOptions: { project: ['utilities/tsconfig.json'], tsconfigRootDir: ROOT_DIR },
    },
  },
  // The noThrow error-handling module: the one place allowed to contain try/catch (it is the
  // replacement the TryStatement restriction points everyone else to), and its promise
  // handling must chain `.catch()` rather than await (awaiting would change its sync/async
  // dual return contract).
  {
    files: ['utilities/no-throw.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      'unicorn/prefer-await': 'off',
      'unicorn/prefer-top-level-await': 'off',
    },
  },
  // Functional test harness (scenarios.ts, execute-scenario.ts, generate.ts are non-test .ts
  // files under tests/, so they fall outside the Jest-only `tests/**/*.test.ts` project block
  // below) — needs its own typed-lint project coverage, mirrored from how performance/**/*.ts
  // is handled above. functional.test.ts matches both this block and the Jest block; the Jest
  // block below applies last and adds jest-specific plugin rules on top.
  {
    files: TYPESCRIPT_FILES.map((pattern) => `tests/functional/${pattern}`),
    languageOptions: {
      parserOptions: { project: ['tests/tsconfig.json'], tsconfigRootDir: ROOT_DIR },
    },
  },
  // JSON files.
  { files: ['*.json'], ignores: ['**/package.json'], languageOptions: { parser: jsoncParser } },
  // package.json files.
  // @see https://github.com/JoshuaKGoldberg/eslint-plugin-package-json
  {
    ...packageJsonConfigs.recommended,
    rules: {
      ...packageJsonConfigs.recommended.rules,
      // Keep package.json keys in a predictable order.
      // @see https://github.com/JoshuaKGoldberg/eslint-plugin-package-json/blob/main/docs/rules/order-properties.md
      'package-json/order-properties': ['error'],
    },
  },
  // Jest.
  {
    files: ['tests/**/*.test.ts'],
    plugins: jestPlugin.configs['flat/recommended'].plugins,
    languageOptions: {
      ...jestPlugin.configs['flat/recommended'].languageOptions,
      parserOptions: { project: ['tests/tsconfig.json'], tsconfigRootDir: ROOT_DIR },
    },
    rules: {
      ...jestPlugin.configs['flat/recommended'].rules,
      // Recognize custom assertion helpers prefixed with `expect` (e.g. expectRoundTrip).
      'jest/expect-expect': ['warn', { assertFunctionNames: ['expect', 'expect*'] }],
      // Jest's `it`/`test` callbacks accept `void | Promise<void>`, so the rule's concern about
      // silently leaking a returned value through an arrow shorthand doesn't apply in tests.
      // @see https://typescript-eslint.io/rules/no-confusing-void-expression/
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  // Rules applying to all files.
  {
    rules: {
      'unicorn/name-replacements': [
        'error',
        {
          ignore: [
            // Commonly used "environment" abbreviation in Node.js.
            'env',
          ],
        },
      ],
      // Suggests `Map.prototype.getOrInsertComputed` (TC39 proposal, not available in any Node.js release).
      'unicorn/prefer-get-or-insert-computed': 'off',
      // Suggests `Promise.try` (ES2025, Node.js 23+) which is not available in the Node.js version used by this project.
      'unicorn/prefer-promise-try': 'off',
    },
  }
)
