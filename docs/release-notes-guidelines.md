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

- The brief lists the files of the package that differ from the version on npm. **No
  difference means there is nothing to release**, and `npm run release` refuses.
- A toolchain update (compiler, minifier) can change the built files without changing what
  they do. That alone is not a release: mention it only if the behaviour, the supported
  environments or the size changed.
- If you cannot write one sentence that matters to a user, stop and say so instead of
  releasing.

## 2. Choose the version

- `patch`: bug fixes and anything else that changes no documented behaviour.
- `minor`: new features that leave existing code working.
- `major`: anything that can break existing code. It needs a `### BREAKING CHANGES` section
  and, when code has to be changed, a migration guide under `docs/migration/`.

## 3. Write the notes

The notes are written once and used twice: as the version's entry in `CHANGELOG.md` and as the
description of its GitHub release.

- **Write for a user of the package**, who has not read the code or the commits. Say what
  changed for them, then why it matters if that is not obvious. Leave out how it was done.
- **Verify every statement against the code and the tests**, not against a commit message:
  commit messages are raw material and are sometimes wrong.
- **One item per change a user can notice.** Several commits for one change are one item; a
  commit that changes nothing for users is no item.
- **Be specific.** Name the function or option in backticks, give the input that failed and
  what happens now, give numbers with their unit for size and speed (`970 B → 954 B`).
- **Leave out** commit hashes, pull request numbers, internal names, and anything about
  tests, tooling or dependencies that does not change the package.

Format:

- Markdown, as a list under one or more of these headings, in this order, each only if it has
  items: `### BREAKING CHANGES`, `### Features`, `### Bug Fixes`, `### Performance`.
- No heading above level 3 (`#` and `##` belong to the changelog itself) and no "Full
  changelog" link: both are added for you.
- A sentence or two per item. Bold the few words that name the change when an item is long.

Example:

```markdown
### Bug Fixes

- **Keys named like `Object.prototype` members are kept.** `getProperties()` and
  `Properties#toObject()` dropped a `__proto__` key, and `format({ deduplicateKeys: true })`
  removed keys such as `constructor` or `toString`. All of them are now ordinary keys.

### Performance

- `getProperties` is smaller: 970 B → 954 B (min+gzip).
```

## 4. Release

1. `npm run release -- brief` — read the changes and these guidelines.
2. Write the notes, then preview the release (nothing is changed):

   ```bash
   npm run release -- patch <<'NOTES'
   ### Bug Fixes

   - …
   NOTES
   ```

3. **Show the preview to a maintainer and wait for their go-ahead.** An agent never confirms
   a release on its own.
4. Run the same command with `--confirm`. It commits, tags and pushes; the release workflow
   then tests, builds and stages the version on npm.
5. **A maintainer approves the staged version** with two-factor authentication, on npmjs.com
   (the package's Staged Packages tab) or with `npm stage approve <stage-id>`. Until then the
   version is not public. The workflow run shows the stage id; tell the maintainer when it is
   waiting for them.
