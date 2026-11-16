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
npm run release -- brief  # What changed since the last release (see Releasing)
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

A release is made for the users of the package, with notes written for them.
[`release-notes-guidelines.md`](./release-notes-guidelines.md) says when a release is worth
making and what its notes say. The whole process can be run by an AI agent; two steps stay with
a maintainer: agreeing to the notes, and approving the version on npm.

```bash
# 1. What changed since the last release, and the guidelines.
npm run release -- brief

# 2. A dry run with the release notes: reports every step, changes nothing.
npm run release -- patch <<'NOTES'
### Bug Fixes

- …
NOTES

# 3. The release: the same command with --confirm, once a maintainer agrees to the notes.
npm run release -- patch --confirm <<'NOTES'
…
NOTES
```

The `- …` and `…` above stand for the notes: the command refuses them as they are.
`patch` can be `minor`, `major`, or an explicit version such as `5.1.0`. The pushed tag then
starts the release workflow, which stages the version on npm, and **the version becomes public
when a maintainer approves it there** (see [Approving a version](#approving-a-version)).

Three things about the command are there to prevent mistakes:

- **Only `--confirm` makes a release real**, so a mistyped command is a dry run. In particular,
  npm keeps for itself any option written without the `--` separator
  (`npm run release patch --confirm`): the script never sees it, and reports a dry run.
- **The notes are read from the standard input**, as a heredoc whose delimiter is quoted
  (`<<'NOTES'`). The shell then leaves the text alone, where backticks or a `$` inside a quoted
  argument would be run as commands, and no file is left behind to be committed by mistake.
  A line of the notes that is exactly `NOTES` would end them early: use another word then.
- **The form of the notes is checked**, in a dry run too, against the rules in
  [`release.config.json`](../release.config.json):
  - the only headings are those of its `sections`, at level 3, in that order, each at most
    once and with at least one item. A heading that is close to one of them, or has one of
    the names in `sectionAliases` (`Fixed`, `Added`…), is told which one to write;
  - everything else is a list item that starts with `- `, or the indented rest of one, a code
    block included; an item is not empty, a placeholder (`…`, `TODO`, `None`, `N/A`) or an item of the
    examples of the file;
  - the `breakingSection` goes with a major version, and only with one, and the
    `featureSection` does not go with a patch version. What a version is comes from the
    number it changes, before `1.0.0` too (`0.5.0` to `0.6.0` is a minor version);
  - nothing matches a `forbidden` pattern. The file is the reference for what they are; at
    the time of writing: a commit hash, a pull request or issue number, a link to one, a
    pointer to the full changelog, a mention of a GitHub user. Code blocks are never checked
    for these patterns, and inline code only for those that say `"inCode": true` (the commit
    hash). The patterns are guesses, made to catch the common slips and not every one: when
    one refuses ordinary text, reword the item, or put what it refused in backticks if it is
    code.

  Notes that do not follow the rules stop the command with each line at fault, what is wrong
  with it, and notes in the expected form (the `example` of the file, or its `majorExample`
  for a major version, which a file with a `breakingSection` has to give). The rules belong
  to the repository, not to the script: change that file to change them, and keep the
  guidelines in line with it. The file itself is checked when it is read: a key that is not
  known, a pattern that is not a regular expression or an example that does not follow the
  rules stops the command, and a test checks that the guidelines name the same headings in
  the same order. Only the form can be checked; what the notes say is for whoever writes
  them.

  Whatever the rules, and in a repository without that file, notes that would damage the
  rest of the changelog are refused, in a dry run too. The notes are read with a Markdown
  parser ([`marked`](https://github.com/markedjs/marked), a development dependency) for
  what a look at the lines cannot tell:
  - HTML is refused, in a block or in a line: Markdown copies it as it is, and a tag or a
    comment left open takes in or hides everything after it. Code goes in backticks,
    including a type such as `Promise<string>`, which is read as a tag;
  - so is a heading in the form of an entry heading (`## [1.2.3](…)`), however it is written;
  - a code block has to be closed, cannot have a line indented less than the line that opens
    it (Markdown ends the block there), cannot open on the line of its item, and cannot be
    in a quote. A line that closes a block for Markdown closes it for the checks, wherever
    it is indented: what follows is read as text;
  - a control character (one that does not show, such as a NUL from a copy and paste) is
    refused: with some of them GitHub and git stop reading the file as text;
  - a line that defines a link for the whole file (`[label]: url`) is refused: it would change
    every `[label]` of the older entries. Links are written where they are used. A footnote (`[^1]`) is refused too: GitHub numbers those of the whole changelog together. The text of a footnote is refused in code too, since GitHub decides what is code there: any line that has `[^` and, further on, `]:`, whatever is between them. (In a changelog that already had footnotes, GitHub would read a reference to them in more spellings than a check can list: there, notes with a `^` at all are refused.)
    Links by reference (`[text][label]`) are refused with the definitions they would need;
  - and with the entry added, the older entries of `CHANGELOG.md` have to be read by the
    parser exactly as they were, in the file as it is and as prettier formats it. A dry run
    formats it in memory to check this; a release checks it before its build, and again on
    the file it commits. This needs a `CHANGELOG.md` that prettier leaves as it is: the
    command says so when it is not, and what to run.

  The last word is how Markdown renders the changelog, by the rules GitHub follows: it is
  rendered with [`micromark`](https://github.com/micromark/micromark), another development
  dependency, before and after the entry is added, as the entry is written and as prettier
  formats it. What comes before the entries and the older entries have to render exactly as they did, the notes must not render differently when the HTML they hold is copied as it is, and the notes must not hold a link definition as that parser finds them (one can be written over several lines). The checks above say what is
  wrong and where; this one is there for what they would miss. (`micromark` is run by
  `node` in a process of its own, which is why `knip.json` lists it: no file imports it.)

### The brief

`npm run release -- brief` prints, for whoever writes the notes:

1. the commits made since the tag of the current version (merge commits left out): those that
   change the source of the package (`src/`, without `src/build-scripts/`), then the others;
2. the files of the package that differ from the version on npm, after building the package
   (`npm run build-artifacts`), and where both packages are kept so that a difference can be
   looked at. What says nothing to those who install the package is not compared: line
   endings, and in `package.json` the version, the development dependencies and the scripts
   that do not run at install;
3. the release notes guidelines.

It changes no tracked file. It builds the package from the working tree, and says so when
the working tree has uncommitted changes.

### The release

`npm run release -- <version>`, with the notes on its standard input:

1. Stops unless the checkout is on `main`, clean, and at the tip of `origin/main`; unless the
   current version's tag is in the history of `HEAD`; and unless the new version's tag exists
   neither locally nor on `origin` (which must have a single push URL). A dry run reports
   these as warnings and goes on, as long as the current version's tag exists locally.
2. Runs `npm run build`, and stops if the build fails or changes a file.
3. Stops if the files of the package are the same as in the version on npm (compared as in
   the brief): there is then nothing to release. If that version cannot be fetched, it says so
   and goes on.
4. Bumps the version in `package.json` and `package-lock.json`.
5. Adds the version's entry to `CHANGELOG.md`: a heading with the compare link and the date
   (UTC), then the notes as they were given. Prettier then formats the file, as it does for
   every other.
6. Commits the three files as `🔖 release v<version>`, creates the annotated `v<version>` tag,
   and pushes the branch and the tag together, and nothing else.

A dry run reports these steps without running the build or comparing the package (steps 2 and
3): it says so when it ends, with what to do next.

If a step fails before the commit, the three files are restored. If the tag or the push fails,
the error says how to retry or undo. When it succeeds, the command ends by saying what happens
next and who has to do it.

### The workflow

`.github/workflows/release.yml` has three jobs, all on the tagged commit:

- **Test** runs the whole test workflow (its Node.js versions, plus Node.js 0.4.0).
- **Build** checks that the tag is `v` + the `package.json` version and that its commit is part
  of `main`, runs `npm run build`, and packs the package (`npm pack`). It stops if the build
  changed a file, which the script already ruled out on the releasing machine. Only a rewritten
  `README.md` is tolerated (its size badge is measured again), and packed as it was tagged.
  This job cannot publish anything.
- **Publish** runs once both pass: it stages the packed archive on npm, then creates the
  GitHub release, with the version's `CHANGELOG.md` entry as its notes, followed by a "Full
  changelog" link made from the heading of the entry. It is the only job
  allowed to do so, and nothing from the repository or its dependencies runs in it.

### Approving a version

A staged version is on npm but not public: nobody can install it. The summary of the workflow
run says that it is waiting, gives its stage id and the shasum of the archive the run built. A
maintainer of the package:

1. **Checks that what is staged is what the run built**: the shasum npm shows for the staged
   version, on npmjs.com (the **Staged Packages** tab) or with `npm stage view <stage-id>`,
   must be the one in the summary of the Release run of the tag `v<version>`, whose Publish
   job succeeded. npm also says who staged the version, which should be the trusted
   publisher and not a person. Staging takes no two-factor authentication, so this check is
   what ties the approval to the release that was reviewed.
2. **Approves it** with two-factor authentication, on npmjs.com or with
   `npm stage approve <stage-id>`.

`npm stage list properties-file` lists what is staged. `npm view properties-file@<version>
version` prints the version once it is public. The GitHub release is created when the version
is staged, so it can be there a little before the version is public.

An agent that ran the release tells the maintainer when the version is waiting for them, and
checks afterwards that it is public.

A staged version that should not be published is rejected in the same two places
(`npm stage reject <stage-id>`). It is then neither staged nor public, and three things are
left to clean up:

1. delete the workflow run that staged it (its jobs could otherwise be re-run, and would stage
   it again);
2. delete the GitHub release the run created (`gh release delete v<version>`);
3. fix what was wrong on `main`, then move the version's tag to the fixed commit, as described
   below. The new run stages the version again and creates its GitHub release again.

### When a run fails

What to do depends on its cause and on whether the version reached npm
(`npm stage list properties-file` says whether it is staged, `npm view
properties-file@<version> version` whether it is public). In the Publish job, the version is
staged first, then the GitHub release is created.

- **The cause is outside the repository** (the trusted publisher is not set up, npm or GitHub
  is unavailable): fix it and re-run the failed jobs from the Actions tab, which GitHub allows
  for 30 days.
- **The cause is inside the repository** (a failing test, a mistake in the workflow), or
  outside of it but there to stay (a new Node.js version the build does not pass on): a re-run
  cannot fix it, because it runs the tagged commit again, workflow file included. If the
  version is neither staged nor public, publish it from a fixed commit, as described below.

A version can only be staged once. If the run staged the version and then failed (the GitHub
release could not be created), a re-run fails at the staging step. Leave the tag where it is,
and create the GitHub release by hand, from a checkout of the tag:

```bash
npm ci --legacy-peer-deps
npx tsx release/notes.ts <version> > /tmp/notes.md && gh release create v<version> --verify-tag --title "Release <version>" --notes-file /tmp/notes.md
```

If the staging step fails because the version is already staged, although no run of yours
staged it, something else did: do not approve what is staged before knowing what it is (see
[Approving a version](#approving-a-version)). If the step failed after npm staged the
version, so that its summary is missing, the shasum to expect is in the log of the step, on
the line `npm notice shasum:`.

To publish a version that failed from a fixed commit:

1. Delete the failed run, in the Actions tab. Its jobs could otherwise be re-run later and
   stage what that run had built.
2. Fix the problem on `main`. If the fix belongs in the release notes, add it to the version's
   `CHANGELOG.md` entry in the same way: the entry was written before the fix. Push.
3. Move the version's tag to the fixed commit, which starts a new run:

   ```bash
   git switch main && git pull --ff-only
   git tag --force --annotate v<version> --message "Release <version>"
   git push --force origin refs/tags/v<version>
   ```

Other clones keep the old tag until they run `git fetch --tags --force`.

Once a version is public it cannot be published again: a fix is then the next version. To edit
the notes of a release afterwards, edit its `CHANGELOG.md` entry and its GitHub release; the
workflow only writes them once.

Pre-release versions (`5.1.0-beta.1`) are not supported: the script and the workflow both
refuse anything but a plain `major.minor.patch` version.

### One-time setup

npm accepts a version from the workflow through
[trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub vouches for the
repository, the workflow file and the environment of the job it comes from, so no npm token is
stored anywhere. With [staged publishing](https://docs.npmjs.com/staged-publishing), what the
workflow sends is not public until a maintainer approves it with two-factor authentication.
Set up, in this order:

1. **The `npm` environment**, in the repository's **Settings** → **Environments**: create it,
   set its deployment branches and tags to "Selected branches and tags", and add a single
   rule, of ref type **Tag**, with the pattern `v*`. No branch rule: a workflow on a branch
   that matches one could stage a version from the environment. GitHub creates a missing
   environment without any rule the first time a workflow names it, hence doing this first.
2. **A tag ruleset**, in **Settings** → **Rules** → **Rulesets**: target the tags `v*`,
   enable "Restrict creations", "Restrict updates" and "Restrict deletions", put the
   repository admin role in the bypass list (and the organization admin role, if releases are
   pushed by an owner of the organization), and set the enforcement status to **Active**: a
   new ruleset is disabled until then. The rules that are already enabled in a new ruleset
   can stay. Only those who bypass the ruleset can then push, move or delete a release tag,
   which `npm run release` and moving a tag (see above) both need.
3. **The trusted publisher**, on npmjs.com, in the package's **Settings** → **Trusted
   Publisher** → **GitHub Actions**:
   - Organization or user: `properties-file`
   - Repository: `properties-file`
   - Workflow filename: `release.yml` (the file name only; it is case-sensitive)
   - Environment name: `npm`
   - Allowed actions: leave "Allow `npm publish`" unticked. Staging is always allowed, and it
     is all the workflow does.

   npm does not check the entry when it is saved: a mistake only shows as a failed staging
   step (often a `404` on the package; the log of the Publish job says why). A new entry also
   stops working if it is not used successfully within 2 days (a new one then has to be
   created), so create it when a release is about to be made.

4. **Publishing access**, on npmjs.com, in the package's **Settings**: require two-factor
   authentication and disallow tokens. npm then refuses a publish made with an npm token;
   trusted publishing and approving a staged version keep working.

With all four in place, nothing becomes public without a maintainer's two-factor approval,
and the workflow can only be made to stage a version by pushing a `v*` tag, or by re-running
a release run that was not deleted. That is not the
only way to stage one, though: staging takes no two-factor authentication, so an npm session
or token of a maintainer can do it too. This is why the shasum is checked before approving
(see [Approving a version](#approving-a-version)). Whatever is on `main` goes into the next
release, so write access to `main` is trusted as well: protect the branch if more people get
that access. Each release also shows as a deployment to `npm` on the repository's page.

## Pull Request Checklist

- [ ] `npm run build` passes (includes linting, unused-code and package checks, tests, 100% coverage, and size measurement)
- [ ] Performance-sensitive changes include `npm run benchmark` results
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
      (the release brief lists them for whoever writes the release notes)
