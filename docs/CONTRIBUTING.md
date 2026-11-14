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
npm run release -- patch  # Preview the release of a new version (see Releasing)
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

## Releasing

A release has two halves: a script run locally (`release/`), and a GitHub Actions workflow
(`.github/workflows/release.yml`) started by the tag the script pushes. Neither needs an npm
token or a one-time password, and the script asks no question (git itself may still ask for
credentials or a signing passphrase, as it does for any commit or push).

```bash
npm run release -- patch             # Dry run: reports every step and the changelog entry, changes nothing
npm run release -- patch --confirm   # The release. Or `minor`, `major`, or an explicit version such as `5.1.0`
```

Only `--confirm` makes a release real, so a mistyped command is a dry run. In particular, npm
keeps for itself any option written without the `--` separator
(`npm run release patch --confirm`): the script never sees it, and reports a dry run.

The script:

1. Stops unless the checkout is on `main`, clean, and at the tip of `origin/main`; unless the
   current version's tag is in the history of `HEAD`; and unless the new version's tag exists
   neither locally nor on `origin` (which must have a single push URL). A dry run reports
   these as warnings and goes on.
2. Runs `npm run build`, and stops if the build fails or changes a file.
3. Bumps the version in `package.json` and `package-lock.json`.
4. Adds the version's entry to `CHANGELOG.md`: a heading with the compare link and the date
   (UTC), then the `fix`, `feat` and `perf` commits and the reverts made since the current
   version's tag, and the commits marked as breaking changes. Other commit types and merge
   commits are not listed, so an entry can be its heading alone. A commit and the revert that
   names it are both left out when both are in the release (the revert of a merge commit is
   listed as a revert instead, next to the commits of the merge).
5. Commits the three files as `🔖 release v<version>`, creates the annotated `v<version>` tag,
   and pushes the branch and the tag together, and nothing else.

If a step fails before the commit, the three files are restored. If the tag or the push fails,
the error says how to retry or undo.

The workflow then has three jobs, all on the tagged commit:

- **Test** runs the whole test workflow (its Node.js versions, plus Node.js 0.4.0).
- **Build** checks that the tag is `v` + the `package.json` version and that its commit is part
  of `main`, runs `npm run build`, and packs the package (`npm pack`). It stops if the build
  changed a file, which the script already ruled out on the releasing machine. Only a rewritten
  `README.md` is tolerated (its size badge is measured again), and packed as it was tagged.
  This job cannot publish anything.
- **Publish** runs once both pass: it publishes the packed archive to npm and creates the
  GitHub release, with the version's `CHANGELOG.md` entry as its notes. It is the only job
  allowed to publish, and nothing from the repository or its dependencies runs in it.

Nothing is published before the last job, so a failed run leaves npm untouched. What it leaves
is the release commit on `main` and the `v<version>` tag:

- **The cause is outside the repository** (the trusted publisher is not set up, npm or GitHub
  is unavailable): fix it and re-run the failed jobs from the Actions tab, which GitHub allows
  for 30 days. Publishing is skipped when the version is already on npm, and so is creating a
  GitHub release that already exists, so re-running is safe wherever the run stopped.
- **The cause is inside the repository** (a failing test, a mistake in the workflow), or
  outside of it but there to stay (a new Node.js version the build does not pass on): a re-run
  cannot fix it, because it runs the tagged commit again, workflow file included. Fix the
  problem on `main`, then publish the version from the fixed commit, as follows.

Delete the failed run (in the Actions tab), then move the version's tag to the fixed commit:

```bash
git switch main && git pull --ff-only
git tag --force --annotate v<version> --message "Release <version>"
git push --force origin v<version>
```

The pushed tag starts a new run. The failed run is deleted first because its Publish job, if
it is the one that failed, could otherwise be re-run later and publish what that run had
built. The fix was committed after the version's `CHANGELOG.md` entry was written: add it to
the entry by hand if it belongs there. Other clones keep the old tag until they run
`git fetch --tags --force`; a release made from one of them before that would list the fix
again.

The other way out is to leave the failed version unpublished and release the next one
(`npm run release -- patch --confirm`). Its entry only lists what was committed since the
failed version's tag, so move the items of the failed version's entry into it first.

Once a version is on npm it cannot be published again: from then on a fix is always the next
version.

To edit the notes of a release, edit its `CHANGELOG.md` entry and its GitHub release; the
workflow only writes them once.

Pre-release versions (`5.1.0-beta.1`) are not supported: the script and the workflow both
refuse anything but a plain `major.minor.patch` version.

### One-time setup

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): npm
accepts a publish because GitHub vouches for the repository, the workflow file and the
environment of the job it comes from, instead of asking for a token or a one-time password.
The GitHub settings below are therefore part of what protects the package. Set everything up
in this order, so that the package is never publishable from an unprotected environment:

1. **The `npm` environment**, in the repository's **Settings** → **Environments**: create it,
   set its deployment branches and tags to "Selected branches and tags", and add a single
   rule, of ref type **Tag**, with the pattern `v*`. No branch rule: a workflow on a branch
   that matches one could publish from the environment. GitHub creates a missing environment
   without any rule the first time a workflow names it, hence doing this first. A required
   reviewer can be added there too, to approve each publish by hand.
2. **A tag ruleset**, in **Settings** → **Rules** → **Rulesets**: target the tags `v*`,
   enable "Restrict creations", "Restrict updates" and "Restrict deletions", put the
   repository admin role in the bypass list (and the organization admin role, if releases are
   pushed by an owner of the organization), and set the enforcement status to **Active**: a
   new ruleset is disabled until then. Only those who bypass the ruleset can then push, move
   or delete a release tag, which `npm run release` and moving a tag (see above) both need.
3. **The trusted publisher**, on npmjs.com, in the package's **Settings** → **Trusted
   Publisher** → **GitHub Actions**:
   - Organization or user: `properties-file`
   - Repository: `properties-file`
   - Workflow filename: `release.yml` (the file name only; it is case-sensitive)
   - Environment name: `npm`
   - Allowed actions: publishing with `npm publish`

   npm does not check the entry when it is saved: a mistake only shows as a failed publish
   (often a `404` on the package; the log of the Publish job says why). A new entry also stops
   working if it is not used for a successful publish within 2 days (a new one then has to be
   created), so create it when a release is about to be made.

4. **Publishing access**, on npmjs.com, in the package's **Settings**: require two-factor
   authentication and disallow tokens. npm then refuses a publish made with an npm token;
   trusted publishing keeps working, and so does a maintainer publishing by hand with
   two-factor authentication.

With all four in place, publishing takes the right to push a `v*` tag. Whatever is on `main`
goes into the next release, so write access to `main` is trusted as well: protect the branch
if more people get that access. Each release also shows as a deployment to `npm` on the
repository's page.

## Pull Request Checklist

- [ ] `npm run build` passes (includes linting, unused-code and package checks, tests, 100% coverage, and size measurement)
- [ ] Performance-sensitive changes include `npm run benchmark` results
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
      (`fix`, `feat` and `perf` commits are listed in the changelog by `npm run release`)
