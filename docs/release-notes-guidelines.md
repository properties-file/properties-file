# Release notes guidelines

For whoever prepares a release, person or AI agent. `npm run release -- brief` prints this
file together with what changed since the last release; read both before writing anything.

## 1. Decide whether to release

A release is for users of the package. Release when the published files changed in a way a
user can observe:

- a bug is fixed, a feature is added, behaviour or an error message changes;
- the types change;
- where or how the package can be used changes (runtimes, bundlers, module resolution);
- a size or speed change is large enough to mention with a number;
- a security problem in the published code is fixed.

Do not release for changes that never reach users: development dependency updates, CI, tests,
lint rules, internal refactoring, documentation that is not shipped. They ride along with the
next release that has something to say.

Check the published files, not the commit messages:

- The brief lists the files of the package that differ from the version on npm, and where to
  look at each difference. **No difference means there is nothing to release.** The release
  itself refuses in that case, but only at the `--confirm` step: a dry run does not check it.
- A toolchain update (compiler, minifier) can change the built files without changing what
  they do. That alone is not a release: mention it only if the behaviour, the types, the
  supported environments or the size changed.
- A commit's type is not evidence either way: a `build:` or `docs:` commit can change the
  source of the package, and a `fix:` commit can change nothing users see.
- If you cannot write one sentence that matters to a user, stop and say so instead of
  releasing.

## 2. Choose the version

- `patch`: bug fixes and anything else that changes no documented behaviour. Making something
  work that the documentation already promised (a runtime, a way to import the package) is a
  bug fix. So is a change to behaviour that was never documented, such as an ordering: mention
  it if someone could have relied on it.
- `minor`: new features that leave existing code working.
- `major`: anything that can break existing code, including code that only compiles: a public
  type that becomes narrower, declarations that need a newer TypeScript, a runtime that is no
  longer supported. It needs a `### BREAKING CHANGES` section and, when code has to be
  changed, a migration guide under `docs/migration/`.

## 3. Write the notes

The notes are written once and used twice: as the version's entry in `CHANGELOG.md` and as the
description of its GitHub release.

- **Write for a user of the package**, who has not read the code or the commits. Say what
  changed for them, then why it matters if that is not obvious. Leave out how it was done.
- **Verify every statement against the code and the tests**, not against a commit message:
  commit messages are raw material and are sometimes wrong. When you can, run the published
  version and the new build side by side (the brief says where both are).
- **One item per change a user can notice.** Several commits for one change are one item; a
  commit that changes nothing for users is no item.
- **Be specific.** Name the function or option in backticks, give the input that failed and
  what happens now, and give numbers with their unit for size and speed. `npm run size`
  measures the sizes against the published version; if you report one, do not leave out a
  larger change in the other direction.
- **Leave out** commit hashes, pull request numbers, internal names, and anything about
  tests, tooling or dependencies that does not change the package.

Format:

- Markdown, as a list under one or more of these headings, in this order, each only if it has
  items: `### BREAKING CHANGES`, `### Features`, `### Bug Fixes`, `### Performance`.
- No heading above level 3 (`#` and `##` belong to the changelog itself) and no "Full
  changelog" link: the GitHub release gets one by itself.
- A sentence or two per item. Bold the few words that name the change when an item is long.

For the form only, here is an entry adapted from an earlier release (5.0.6):

```markdown
### Bug Fixes

- **ES5 runtime compatibility restored for the full API.** The compiled output of every
  previous 5.x release contained unguarded `Symbol.iterator` lookups, so on ES5-only engines
  `PropertiesEditor`, `Properties#toObject` and `Properties#format` crashed with `Symbol is not
defined`. The full API now works on every supported runtime, back to Node.js 0.4.0.

### Performance

- Smaller bundles: `Properties` 3.1 kB → 2.9 kB, `PropertiesEditor` 5.1 kB → 4.8 kB (min+gzip).
```

## 4. Release

1. Run `npm run release -- brief` and read the changes and these guidelines.
2. Write the notes and preview the release with them (the command is below). A preview changes
   nothing; it does not run the build either, so run `npm run build` yourself if you want to
   know now that the release will get past it.
3. **Show a maintainer the version and the notes, and wait for their go-ahead.** An agent
   never confirms a release on its own.
4. Run the same command with `--confirm` after the version. It commits, tags and pushes; the
   release workflow then tests, builds and stages the version on npm.
5. **Tell the maintainer that the version is waiting for them.** It is not public until a
   maintainer of the package approves it on npm with two-factor authentication, after checking
   that its shasum is the one the workflow run gives. `docs/CONTRIBUTING.md` ("Approving a
   version") says how, and what to do when something fails.

The command, with the notes between the two `NOTES` lines. The second one must start its line,
and no line of the notes can be exactly `NOTES` (use another word if one is):

```bash
npm run release -- patch <<'NOTES'
### Bug Fixes

- …
NOTES
```
