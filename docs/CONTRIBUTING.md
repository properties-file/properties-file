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

Shipped artifacts must run on ES5 runtimes (down to Node.js 0.4), but shipped source may use
modern syntax and APIs. Syntax is transpiled by the compilers. Runtime APIs cannot be: the
downlevel transform (`src/build-scripts/downlevel/`) rewrites each supported API (e.g.
`String.prototype.includes`, `Object.entries`) into an exact ES5 equivalent before compilation.
The build then runs every `eslint-plugin-es-x` `restrict-to-es5` rule against the built output
(`src/build-scripts/verify-es5-output.ts`): an API the transform does not cover fails the build
there, and has to be added to the transform's catalog or written in ES5 (see its `README.md`).
The functional replay tests on Node.js 0.4 (`tests/node-compat/`) are the behavioral backstop.

Non-shipped code (tests, build scripts, performance tooling) only runs on the development
Node.js version and is exempt, with one exception: `tests/functional/run-cjs.js` also runs on
Node.js 0.4 and must stay strict ES5 (see `tests/functional/README.md`).

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

The library ships both ESM (`dist/esm/`) and CJS (`dist/cjs/`) from a single `tsc` pass
(`tsconfig.build.json`, over the downlevel transform's output) into `dist/esm/`. The custom
build script (`src/build-scripts/build.ts`) then adds the `.properties` type declarations,
bundles the main entry with esbuild, adds ESM file extensions, downlevels to ES5 with SWC, derives
`dist/cjs/` from `dist/esm/` with SWC, runs the ES5 output gate, and minifies.

Subpath entry points are declared in the `exports` map of `package.json`. For resolvers that
predate `exports` (Node.js before 12.7, webpack 4, TypeScript's legacy `node10` resolution),
the build also generates one stub `package.json` per subpath at the package root (e.g.
`editor/package.json`, whose `main` points to `../dist/cjs/editor/index.js`), derived from the
`exports` map (`src/build-scripts/generate-subpath-stubs.ts`). The stubs are git-ignored and
shipped through `files`, which the build checks contains exactly `dist` plus each stub directory.
The generator only accepts subpath keys whose segments are lowercase ASCII letters (`./editor`,
`./bundler/webpack`; no hyphens, dots, digits, `*` patterns or trailing slash), and entries of
exactly the
shape `{ "import": { "types", "default" }, "require": { "types", "default" } }` with every target
inside `./dist/`; any other key or condition fails the build. A new subpath needs:

- its `exports` entry;
- its top-level directory added to `files` and to the ignore lists (`.gitignore`,
  `.prettierignore`, `eslint/config.ts`), unless that directory is already there (e.g. a new
  `./bundler/…` subpath);
- for a new top-level subpath that runs outside bundlers, a `COPY` line for its stub directory
  in `tests/node-compat/Dockerfile.node-0.4` and a `loadEntryPoint` call in
  `tests/functional/run-cjs.js`, whose entry points are hard-coded, so the Node.js 0.4 check
  loads it.

### Parser design

There are two parsing paths:

- **`getProperties()`** — a fast, functional single-pass parser (`src/index.ts`) that returns a
  plain key-value object. This is the most common use case and is optimized for throughput. It
  only imports the shared character constants (`src/characters.ts`) and `unescapeContent`
  (`src/unescape/`), and is bundled into a single self-contained file.
- **`Properties` class** — a lossless object-oriented parser (`src/parser/`) that preserves
  every element (properties, comments, blank lines) as typed nodes. Supports normalization
  via `format()` options. Extended by `PropertiesEditor` (`src/editor/`) for editing operations.

These two paths must remain independent — `src/index.ts` must not import from `src/parser/` or
vice versa.

### Bundler integrations

Thin wrappers under `src/bundler/` for Webpack/Rspack, Rollup/Vite/Rolldown, esbuild, and Bun.
These are shipped and built like the rest of the library, but since they run inside Node.js-based
build tools they are exempt from the runtime-agnostic ban on Node.js APIs (`eslint/config.ts`).

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
`package.json` files described under [Dual output](#dual-output-esm--cjs), so a missing stub, or
a stub whose `types` cannot be resolved, fails the check (a `types` pointing to another existing
declaration file does not). Neither tool follows a stub's `main` or `module`; the
generator itself fails the build if any stub's `main`, `module` or `types` does not point to an
existing file, and the Node.js 0.4 check (`tests/node-compat/`) loads the non-bundler entry
points through their stubs' `main`.

## Pull Request Checklist

- [ ] `npm run build` passes (includes linting, unused-code and package checks, tests, 100% coverage, and size measurement)
- [ ] Performance-sensitive changes include `npm run benchmark` results
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
      (drives automated changelog via `release-it`)
