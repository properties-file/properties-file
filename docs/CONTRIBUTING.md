# Contributing to properties-file

This guide covers the principles and constraints behind this project. It is intended for both
human contributors and AI coding assistants. Most conventions are enforced by ESLint, Prettier,
and Jest — this document focuses on what **cannot** be caught by tooling.

## Core Principles

### Java specification compliance

The library must exactly reproduce the behavior of Java's `java.util.Properties` class. All
parsing edge cases — Unicode escapes, multiline values, comment handling, key-value separators,
and whitespace rules — must match the Java reference implementation. Deviations from Java
behavior are bugs, not features.

When in doubt, verify against the Java [test sandbox](https://codehs.com/sandbox/id/java-main-FObePj).

### ES5 runtime compatibility

All shipped code must restrict runtime APIs to ES5. TypeScript handles syntax transpilation, but
ES2015+ runtime APIs (e.g., `String.prototype.includes`, `Array.from`, `Object.entries`) must
not appear in shipped code. The `eslint-plugin-es-x` `restrict-to-es5` ruleset enforces most of
this, but be aware of subtle cases like `String.prototype.codePointAt` that the linter may not
catch in all contexts.

Non-shipped code (tests, build scripts, performance tooling, bundler integrations) is exempt.

### Zero runtime dependencies

The library must have zero runtime dependencies. This keeps the package tiny, eliminates supply
chain risk, and ensures predictable behavior. Dev dependencies for tooling are acceptable but
must be justified.

### 100% test coverage

Every code path in shipped source must be exercised by tests. Test output must be validated
against the Java reference implementation to ensure specification compliance. Coverage regression
is a release blocker — `npm test` enforces this via Jest's coverage thresholds.

### Performance accountability

Changes must not introduce measurable performance regressions. The benchmark suite
(`performance/`) provides baseline measurements. Run `npm run benchmark` to compare
against the latest published version. Performance-sensitive changes must include benchmark
comparison results in the PR.

## Code Style

Most style rules are enforced by ESLint and Prettier. The following are conventions that tooling
does not fully enforce:

- **TSDoc** — every exported function, type, and class must have full TSDoc with `@param`,
  `@returns`, and `@throws` tags.
- **Descriptive names** — no single-letter or abbreviated variable names in shipped code
  (e.g., `character` not `c`, `position` not `pos`, `filePath` not `fp`).
- **No unsafe casts** — avoid `as` type assertions. Use type guards and `in` operator narrowing.
- **Functional style** — prefer arrow functions and functional patterns over imperative loops
  where readability permits.

## Architecture

### Dual output (ESM + CJS)

The library compiles to both ESM (`dist/esm/`) and CJS (`dist/cjs/`) via two separate
`tsconfig` files. The custom build script (`src/build-scripts/build.ts`) handles ESM file
extension rewriting, `.properties` type declarations, and minification.

Subpath entry points are declared in the `exports` map of `package.json`. For resolvers that
predate `exports` (Node.js before 12.7, webpack 4, TypeScript's legacy `node10` resolution),
the build also generates one stub `package.json` per subpath at the package root (e.g.
`editor/package.json`, whose `main` points to `../dist/cjs/editor/index.js`), derived from the
`exports` map (`src/build-scripts/generate-subpath-stubs.ts`). The stubs are git-ignored and
shipped through `files`, which the build checks contains exactly `dist` plus each stub directory:
a new subpath only needs its `exports` entry and its directory added to `files` and the ignore
lists (`.gitignore`, `.prettierignore`, `eslint/config.ts`).

### Parser design

There are two parsing paths:

- **`getProperties()`** — a fast, functional single-pass parser (`src/parse-properties.ts`) that
  returns a plain key-value object. This is the most common use case and is optimized for
  throughput. It has zero imports and is fully tree-shakeable.
- **`Properties` class** — a lossless object-oriented parser (`src/parser/`) that preserves
  every element (properties, comments, blank lines) as typed nodes. Supports normalization
  via `format()` options. Extended by `PropertiesEditor` (`src/editor/`) for editing operations.

These two paths must remain independent — `parse-properties.ts` must not import from
`src/parser/` or vice versa.

### Bundler integrations

Thin wrappers under `src/bundler/` for Webpack/Rspack, Rollup/Vite/Rolldown, esbuild, and Bun.
These are shipped but exempt from ES5 restrictions since they run in bundler contexts.

## Development Commands

```bash
npm test                  # Run tests with coverage (must be 100%)
npm run build             # Full build: lint, unused-code check, compile, package check, test, measure size
npm run knip              # Report unused files, exports and dependencies
npm run check-package     # Validate the built package's exports map and type resolution
npm run benchmark         # Compare benchmarks against latest published version
npm run size              # Compare bundle sizes against latest published version
```

`check-package` runs `publint` and `attw` against the packed tarball, in every resolution mode
`attw` knows, including TypeScript's legacy `node10`. That mode cannot read the `exports` map:
it resolves the subpath entry points (`properties-file/editor`, …) through the generated stub
`package.json` files described under [Dual output](#dual-output-esm--cjs), so a missing or
broken stub fails the check.

## Pull Request Checklist

- [ ] `npm run build` passes (includes linting, unused-code and package checks, tests, 100% coverage, and size measurement)
- [ ] Performance-sensitive changes include `npm run benchmark` results
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
      (drives automated changelog via `release-it`)
