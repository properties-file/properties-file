/**
 * Tests for the release flow (`release/`).
 *
 * The pure logic (`release/changelog.ts`) is tested directly. The release itself
 * (`release/release.ts`) runs real `git` and `npm` commands, so each of its tests works on a
 * scratch repository in a temporary directory: a work tree with a `package.json`, a
 * `package-lock.json` and a `CHANGELOG.md`, and a bare repository next to it standing in for
 * the `origin` remote. Nothing here changes this repository or uses the network. `release/` is
 * outside of `src/`, so it is not part of the coverage threshold: these tests are what
 * exercises its error branches.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  compareVersions,
  countBreakingCommits,
  extractReleaseNotes,
  getRepositoryUrl,
  insertChangelogEntry,
  isReleaseVersion,
  renderChangelogEntry,
  resolveNextVersion,
} from '../release/changelog'
import { explainDryRun, parseReleaseArguments, release } from '../release/release'

import type { GitCommit } from '../release/changelog'

/** The repository URL used by the changelog fixtures. */
const REPOSITORY_URL = 'https://github.com/scratch/scratch'

/** A full commit hash for the changelog fixtures. */
const HASH = '1234567890abcdef1234567890abcdef12345678'

/** When the test releases are made, unless a test says otherwise: March 4, 2026 in UTC. */
const RELEASE_DATE = new Date('2026-03-04T12:00:00Z')

/** The changelog a scratch repository starts with: the title and the entry of version 1.2.3. */
const INITIAL_CHANGELOG = `# Changelog

## [1.2.3](${REPOSITORY_URL}/compare/v1.2.2...v1.2.3) (2026-01-01)
`

/** How long a test that runs real `npm` commands may take. */
const COMMAND_TIMEOUT = 60_000

/**
 * The environment of every command the tests run. Two things are taken out of this process's
 * own: every `GIT_*` variable (these tests run in the pre-commit hook of this repository, for
 * which git sets variables pointing at the index of the commit being made), and the git
 * configuration of the machine (identity, signing, hooks, push settings), so that only what a
 * scratch repository sets itself plays a part.
 */
const ENVIRONMENT = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

/**
 * Build a commit for the changelog fixtures.
 *
 * @param subject - The first line of the commit message.
 * @param body - The rest of the commit message.
 *
 * @returns The commit, with the fixture hash.
 */
const toCommit = (subject: string, body = ''): GitCommit => ({ hash: HASH, subject, body })

/**
 * Render the changelog entry of version 1.2.4 for a list of commits.
 *
 * @param commits - The commits made since version 1.2.3.
 *
 * @returns The rendered entry, ending with a line break.
 */
const renderEntry = (commits: GitCommit[]): string =>
  renderChangelogEntry({
    version: '1.2.4',
    previousVersion: '1.2.3',
    date: '2026-03-04',
    repositoryUrl: REPOSITORY_URL,
    commits,
  })

/** The heading of the entry {@link renderEntry} renders. */
const ENTRY_HEADING = `## [1.2.4](${REPOSITORY_URL}/compare/v1.2.3...v1.2.4) (2026-03-04)`

/** The link to the fixture commit that ends every changelog item. */
const COMMIT_LINK = `([1234567](${REPOSITORY_URL}/commit/${HASH}))`

describe('release versions', () => {
  it('accepts plain major.minor.patch versions only', () => {
    expect(
      ['0.0.0', '1.2.3', '10.20.30'].filter((version) => !isReleaseVersion(version))
    ).toStrictEqual([])
    expect(
      [
        '',
        '1.2',
        '1.2.3.4',
        'v1.2.3',
        '01.2.3',
        '1.02.3',
        '1.2.3-beta.1',
        '1.2.3+build',
        ' 1.2.3',
      ].filter((version) => isReleaseVersion(version))
    ).toStrictEqual([])
  })

  it('compares versions numerically, part by part', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.10')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '2.0.0')).toBeLessThan(0)
  })

  it('bumps the requested part and resets the lower ones', () => {
    expect(resolveNextVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(resolveNextVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(resolveNextVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(resolveNextVersion('1.9.9', 'patch')).toBe('1.9.10')
  })

  it('accepts an explicit version that is higher than the current one', () => {
    expect(resolveNextVersion('1.2.3', '1.2.4')).toBe('1.2.4')
    expect(resolveNextVersion('1.2.3', '3.0.0')).toBe('3.0.0')
  })

  it('rejects an explicit version that is not higher than the current one', () => {
    expect(() => resolveNextVersion('1.2.3', '1.2.3')).toThrow(
      '1.2.3 is not higher than the current version (1.2.3)'
    )
    expect(() => resolveNextVersion('1.10.0', '1.9.0')).toThrow('1.9.0 is not higher')
  })

  it('rejects a request that is neither a bump type nor a plain version', () => {
    for (const request of ['', 'Patch', 'prerelease', 'v1.2.4', '1.2.4-beta.1', '1.3']) {
      expect(() => resolveNextVersion('1.2.3', request)).toThrow(
        `"${request}" is not "major", "minor", "patch" or a plain major.minor.patch version`
      )
    }
  })

  it('rejects a current version that is not a plain version', () => {
    expect(() => resolveNextVersion('1.2.3-beta.1', 'patch')).toThrow(
      'the current version (1.2.3-beta.1) is not a plain major.minor.patch version'
    )
  })
})

describe('repository URL', () => {
  it('removes the git+ prefix and the .git suffix', () => {
    expect(getRepositoryUrl(`git+${REPOSITORY_URL}.git`)).toBe(REPOSITORY_URL)
    expect(getRepositoryUrl(REPOSITORY_URL)).toBe(REPOSITORY_URL)
  })

  it('rejects anything that is not an https://github.com/ repository URL', () => {
    for (const url of [
      'git@github.com:scratch/scratch.git',
      'https://gitlab.com/scratch/scratch.git',
      'https://github.com/scratch',
      'https://github.com/scratch/scratch/tree/main',
    ]) {
      expect(() => getRepositoryUrl(url)).toThrow('is not an https://github.com/ repository URL')
    }
  })
})

describe('changelog entry', () => {
  it('is the heading alone when no commit is listed', () => {
    expect(renderEntry([])).toBe(`${ENTRY_HEADING}\n`)
    expect(
      renderEntry([
        toCommit('docs: explain a thing'),
        toCommit('build(deps-dev): bump a thing'),
        toCommit('Merge pull request #1 from scratch/branch'),
        toCommit('🔖 release v1.2.3'),
        toCommit('feat:missing space'),
        toCommit('Feat: upper case type'),
      ])
    ).toBe(`${ENTRY_HEADING}\n`)
  })

  it('lists fixes, features and performance improvements in that order', () => {
    expect(
      renderEntry([
        toCommit('perf: parse faster'),
        toCommit('feat: add a thing'),
        toCommit('fix: correct a thing'),
        toCommit('docs: explain a thing'),
      ])
    ).toBe(
      [
        ENTRY_HEADING,
        '### Bug Fixes',
        `- correct a thing ${COMMIT_LINK}`,
        '### Features',
        `- add a thing ${COMMIT_LINK}`,
        '### Performance Improvements',
        `- parse faster ${COMMIT_LINK}\n`,
      ].join('\n\n')
    )
  })

  it('orders the commits of a section by scope, then by description', () => {
    expect(
      renderEntry([
        toCommit('feat(parser): b'),
        toCommit('feat: z'),
        toCommit('feat(editor): c'),
        toCommit('feat(parser): a'),
        toCommit('feat: y'),
      ])
    ).toBe(
      [
        ENTRY_HEADING,
        '### Features',
        [
          `- y ${COMMIT_LINK}`,
          `- z ${COMMIT_LINK}`,
          `- **editor:** c ${COMMIT_LINK}`,
          `- **parser:** a ${COMMIT_LINK}`,
          `- **parser:** b ${COMMIT_LINK}\n`,
        ].join('\n'),
      ].join('\n\n')
    )
  })

  it('lists breaking changes last, from the ! mark or from the footer', () => {
    const commits = [
      toCommit('feat(editor)!: rename a method'),
      toCommit('refactor!: drop an option'),
      toCommit(
        'fix: correct a thing',
        'Details.\n\nBREAKING CHANGE: the thing now\n  throws.\n\nRefs: #1'
      ),
      toCommit('feat: add a thing', 'BREAKING-CHANGE: needs a new call'),
      toCommit('fix: mention BREAKING CHANGE: in passing', 'Not a BREAKING CHANGE: footer'),
    ]

    expect(countBreakingCommits(commits)).toBe(4)
    expect(renderEntry(commits)).toBe(
      [
        ENTRY_HEADING,
        '### Bug Fixes',
        [
          `- correct a thing ${COMMIT_LINK}`,
          `- mention BREAKING CHANGE: in passing ${COMMIT_LINK}`,
        ].join('\n'),
        '### Features',
        [`- add a thing ${COMMIT_LINK}`, `- **editor:** rename a method ${COMMIT_LINK}`].join('\n'),
        '### BREAKING CHANGES',
        [
          `- needs a new call ${COMMIT_LINK}`,
          `- the thing now throws. ${COMMIT_LINK}`,
          `- drop an option ${COMMIT_LINK}`,
          `- **editor:** rename a method ${COMMIT_LINK}\n`,
        ].join('\n'),
      ].join('\n\n')
    )
  })

  it('takes the breaking change note over the description when a commit has both', () => {
    expect(
      renderEntry([toCommit('feat!: change a thing', 'BREAKING CHANGE: call it differently')])
    ).toBe(
      [
        ENTRY_HEADING,
        '### Features',
        `- change a thing ${COMMIT_LINK}`,
        '### BREAKING CHANGES',
        `- call it differently ${COMMIT_LINK}\n`,
      ].join('\n\n')
    )
  })

  it('reads a breaking change note from a body with Windows line endings', () => {
    expect(
      renderEntry([
        toCommit('fix: correct a thing', 'BREAKING CHANGE: it now\r\nthrows.\r\n\r\nRefs: #1'),
      ])
    ).toContain(`### BREAKING CHANGES\n\n- it now throws. ${COMMIT_LINK}`)
  })

  it('does not list a subject whose scope or spacing is not conventional', () => {
    expect(
      renderEntry([toCommit('feat(a(b)): nested scope'), toCommit('feat(): empty scope')])
    ).toBe(`${ENTRY_HEADING}\n`)
    expect(renderEntry([toCommit('feat:  two spaces')])).toContain(`- two spaces ${COMMIT_LINK}`)
  })

  it('escapes what Markdown would read as emphasis, except in code spans', () => {
    expect(
      renderEntry([
        toCommit('fix: keep __proto__ keys and *stars*'),
        toCommit('fix(snake_case): keep `__proto__` and a_b'),
        toCommit('feat!: rename', 'BREAKING CHANGE: use new_name, not `old_name`'),
      ])
    ).toBe(
      [
        ENTRY_HEADING,
        '### Bug Fixes',
        [
          String.raw`- keep \_\_proto\_\_ keys and \*stars\* ${COMMIT_LINK}`,
          String.raw`- **snake\_case:** keep ${'`__proto__`'} and a\_b ${COMMIT_LINK}`,
        ].join('\n'),
        '### Features',
        `- rename ${COMMIT_LINK}`,
        '### BREAKING CHANGES',
        String.raw`- use new\_name, not ${'`old_name`'} ${COMMIT_LINK}` + '\n',
      ].join('\n\n')
    )
  })

  it('leaves out a commit and its revert when both are in the release', () => {
    const featureHash = 'a'.repeat(40)
    const revertHash = 'b'.repeat(40)

    // Newest first, as `git log` lists them.
    expect(
      renderEntry([
        toCommit('fix: correct a thing'),
        {
          hash: revertHash,
          subject: 'Revert "feat!: add a thing"',
          body: `This reverts commit ${featureHash}.`,
        },
        { hash: featureHash, subject: 'feat!: add a thing', body: '' },
      ])
    ).toBe([ENTRY_HEADING, '### Bug Fixes', `- correct a thing ${COMMIT_LINK}\n`].join('\n\n'))
    expect(
      countBreakingCommits([
        {
          hash: revertHash,
          subject: 'Revert "feat!: add a thing"',
          body: `This reverts commit ${featureHash}.`,
        },
        { hash: featureHash, subject: 'feat!: add a thing', body: '' },
      ])
    ).toBe(0)
  })

  it('lists a commit again when its revert was itself reverted', () => {
    const featureHash = 'a'.repeat(40)
    const revertHash = 'b'.repeat(40)
    const reapplyHash = 'c'.repeat(40)

    expect(
      renderEntry([
        {
          hash: reapplyHash,
          subject: 'Revert "Revert "feat: add a thing""',
          body: `This reverts commit ${revertHash.slice(0, 12)}.`,
        },
        {
          hash: revertHash,
          subject: 'Revert "feat: add a thing"',
          body: `This reverts commit ${featureHash}.`,
        },
        { hash: featureHash, subject: 'feat: add a thing', body: '' },
      ])
    ).toBe(
      [
        ENTRY_HEADING,
        '### Features',
        `- add a thing ([aaaaaaa](${REPOSITORY_URL}/commit/${featureHash}))\n`,
      ].join('\n\n')
    )
  })

  it('lists the revert of a commit that was released before', () => {
    const releasedHash = 'd'.repeat(40)

    expect(
      renderEntry([
        toCommit('Revert "feat(parser): add a thing"', `This reverts commit ${releasedHash}.`),
        toCommit('revert: the other thing'),
      ])
    ).toBe(
      [
        ENTRY_HEADING,
        '### Reverts',
        [`- feat(parser): add a thing ${COMMIT_LINK}`, `- the other thing ${COMMIT_LINK}\n`].join(
          '\n'
        ),
      ].join('\n\n')
    )
  })

  it('lists reverts after the other sections and before the breaking changes', () => {
    const entry = renderEntry([
      toCommit('Revert "feat: add a thing"'),
      toCommit('perf!: parse faster'),
      toCommit('fix: correct a thing'),
    ])

    expect(entry.match(/^### .+$/gm)).toStrictEqual([
      '### Bug Fixes',
      '### Performance Improvements',
      '### Reverts',
      '### BREAKING CHANGES',
    ])
  })

  it('lists a reapplied commit as the commit it brings back', () => {
    const revertHash = 'b'.repeat(40)
    const reapply = {
      hash: 'c'.repeat(40),
      subject: 'Reapply "feat(parser): add a thing"',
      body: `This reverts commit ${revertHash}.`,
    }
    const item = `- **parser:** add a thing ([ccccccc](${REPOSITORY_URL}/commit/${reapply.hash}))\n`

    // The revert it undoes was released before: the feature is back in this release.
    expect(renderEntry([reapply])).toBe([ENTRY_HEADING, '### Features', item].join('\n\n'))
    // The revert it undoes is in this release: both are left out.
    expect(
      renderEntry([
        reapply,
        { hash: revertHash, subject: 'Revert "feat(parser): add a thing"', body: '' },
      ])
    ).toBe(`${ENTRY_HEADING}\n`)
  })

  it('only takes a commit for a revert when its subject says so', () => {
    const featureHash = 'a'.repeat(40)
    const feature = { hash: featureHash, subject: 'feat: add a thing', body: '' }
    const links = {
      feature: `([aaaaaaa](${REPOSITORY_URL}/commit/${featureHash}))`,
      other: COMMIT_LINK,
    }

    // A commit that quotes the message of a revert, as a squashed pull request can.
    expect(
      renderEntry([
        toCommit('fix: correct a thing', `Details.\n\nThis reverts commit ${featureHash}.`),
        feature,
      ])
    ).toBe(
      [
        ENTRY_HEADING,
        '### Bug Fixes',
        `- correct a thing ${links.other}`,
        '### Features',
        `- add a thing ${links.feature}\n`,
      ].join('\n\n')
    )
    // A revert that mentions the hash elsewhere than at the start of a line of its body.
    expect(
      renderEntry([
        toCommit('Revert "feat: add a thing"', `Not needed. This reverts commit ${featureHash}.`),
        feature,
      ])
    ).toContain(`### Features\n\n- add a thing ${links.feature}\n\n### Reverts`)
    // A revert whose message was edited: the line is not the first one of its body.
    expect(
      renderEntry([
        toCommit(
          'revert: the thing',
          `Not needed after all.\n\nThis reverts commit ${featureHash}.`
        ),
        feature,
      ])
    ).toBe(`${ENTRY_HEADING}\n`)
  })

  it('leaves code spans, URLs and existing escapes as they are when escaping', () => {
    expect(
      renderEntry([
        toCommit('fix: keep ``a_b`` and ```c_`_d``` but not e_f'),
        toCommit(String.raw`fix: leave \_escaped\_ and \*these\* alone`),
        toCommit('fix: link <https://example.com/a_b> and https://example.com/c_d*e but not g_h'),
        toCommit('fix: mail first_last@example.com or see www.example.com/some_page'),
        toCommit('fix: not a URL https://*.a.com and https://__b__ nor a span ```c_d``e'),
        toCommit('fix: operators <__proto__> and Map<K_T, V>'),
        toCommit('fix: unbalanced ` backtick_here'),
      ])
    ).toBe(
      [
        ENTRY_HEADING,
        '### Bug Fixes',
        [
          String.raw`- keep ${'``a_b``'} and ${'```c_`_d```'} but not e\_f ${COMMIT_LINK}`,
          String.raw`- leave \_escaped\_ and \*these\* alone ${COMMIT_LINK}`,
          String.raw`- link <https://example.com/a_b> and https://example.com/c_d\*e but not g\_h ${COMMIT_LINK}`,
          `- mail first_last@example.com or see www.example.com/some_page ${COMMIT_LINK}`,
          String.raw`- not a URL https://\*.a.com and https://\_\_b\_\_ nor a span ${'```'}c\_d${'``'}e ${COMMIT_LINK}`,
          String.raw`- operators <\_\_proto\_\_> and Map<K\_T, V> ${COMMIT_LINK}`,
          String.raw`- unbalanced ${'`'} backtick\_here ${COMMIT_LINK}`,
        ].join('\n') + '\n',
      ].join('\n\n')
    )
  })

  it('ends a breaking change note at a line that only has whitespace', () => {
    expect(
      renderEntry([
        toCommit('fix: correct a thing', 'BREAKING CHANGE: it now\nthrows.\n  \nRefs: #1'),
      ])
    ).toContain(`### BREAKING CHANGES\n\n- it now throws. ${COMMIT_LINK}\n`)
  })

  it('counts no breaking commit when none is marked', () => {
    expect(
      countBreakingCommits([toCommit('feat: add a thing'), toCommit('not conventional')])
    ).toBe(0)
  })
})

describe('changelog file', () => {
  it('adds an entry above the existing ones', () => {
    expect(insertChangelogEntry(INITIAL_CHANGELOG, '1.2.4', `${ENTRY_HEADING}\n`)).toBe(
      `# Changelog\n\n${ENTRY_HEADING}\n\n## [1.2.3](${REPOSITORY_URL}/compare/v1.2.2...v1.2.3) (2026-01-01)\n`
    )
  })

  it('adds an entry above a first entry that uses a level 1 heading', () => {
    expect(
      insertChangelogEntry('# Changelog\n\n# [2.0.0](url) (date)\n', '2.0.1', '## [2.0.1](url)\n')
    ).toBe('# Changelog\n\n## [2.0.1](url)\n\n# [2.0.0](url) (date)\n')
  })

  it('adds the first entry of a changelog that only has its title', () => {
    expect(insertChangelogEntry('# Changelog\n', '1.0.0', '## [1.0.0](url)\n')).toBe(
      '# Changelog\n\n## [1.0.0](url)\n'
    )
  })

  it('refuses to add a second entry for a version', () => {
    for (const changelog of [
      INITIAL_CHANGELOG,
      INITIAL_CHANGELOG.replaceAll('\n', '\r\n'),
      '# Changelog\n\n# [1.2.3](url) (date)\n',
    ]) {
      expect(() => insertChangelogEntry(changelog, '1.2.3', 'entry\n')).toThrow(
        'CHANGELOG.md already has an entry for version 1.2.3'
      )
    }
  })

  it('keeps the Windows line endings of the existing content', () => {
    const changelog = INITIAL_CHANGELOG.replaceAll('\n', '\r\n')

    expect(insertChangelogEntry(changelog, '1.2.4', `${ENTRY_HEADING}\n`)).toBe(
      `# Changelog\r\n\r\n${ENTRY_HEADING}\n\n${changelog.slice('# Changelog\r\n\r\n'.length)}`
    )
  })

  it('only takes a level 1 or 2 heading that starts with a linked version for an entry', () => {
    const changelog = [
      '# Changelog',
      'An example, whose comments are not entries:',
      '```properties\n# [1.2.4] is a comment here\n## [section]\n```',
      '## [Unreleased]',
      '## [1.2.3](url) (date)',
      '### [1.2.2](url) is a deeper heading',
      '## 1.2.1 has no link',
      '',
    ].join('\n\n')

    // Neither a duplicate of 1.2.4, nor the place to add the entry at.
    expect(insertChangelogEntry(changelog, '1.2.4', 'entry\n')).toBe(
      changelog.replace('## [1.2.3]', 'entry\n\n## [1.2.3]')
    )
    expect(extractReleaseNotes(changelog, '1.2.3')).toBe(
      '### [1.2.2](url) is a deeper heading\n\n## 1.2.1 has no link\n'
    )

    for (const version of ['1.2.4', '1.2.2', '1.2.1', 'Unreleased', 'section']) {
      expect(() => extractReleaseNotes(changelog, version)).toThrow('has no entry for version')
    }
  })

  it('ends an entry at the heading of a range of versions', () => {
    const changelog = `# Changelog\n\n## [1.2.3](url) (date)\n\nNotes.\n\n## [1.2.0 — 1.2.2](url) (dates)\n\nOlder.\n`

    expect(extractReleaseNotes(changelog, '1.2.3')).toBe('Notes.\n')
  })

  it('does not mistake a version for another one that starts with it', () => {
    expect(insertChangelogEntry(INITIAL_CHANGELOG, '1.2', 'entry\n')).toContain('entry')
    expect(() => extractReleaseNotes(INITIAL_CHANGELOG, '1.2')).toThrow(
      'CHANGELOG.md has no entry for version 1.2'
    )
  })
})

describe('release notes', () => {
  const changelog = [
    '# Changelog',
    `## [1.2.4](${REPOSITORY_URL}/compare/v1.2.3...v1.2.4) (2026-03-04)`,
    '### Bug Fixes',
    '- correct a thing',
    '### Features',
    '- add a thing',
    `## [1.2.3](${REPOSITORY_URL}/compare/v1.2.2...v1.2.3) (2026-01-01)`,
    `# [1.2.0](${REPOSITORY_URL}/compare/v1.1.0...v1.2.0) (2025-12-01)`,
    'Notes of 1.2.0.',
    `## [1.0.0](${REPOSITORY_URL}/releases/tag/1.0.0) (2025-01-01)`,
    'The first release.',
    '',
  ].join('\n\n')

  it('are the content of the entry followed by the full changelog link', () => {
    expect(extractReleaseNotes(changelog, '1.2.4')).toBe(
      [
        '### Bug Fixes',
        '- correct a thing',
        '### Features',
        '- add a thing',
        `**Full changelog**: [v1.2.3...v1.2.4](${REPOSITORY_URL}/compare/v1.2.3...v1.2.4)\n`,
      ].join('\n\n')
    )
  })

  it('are the full changelog link alone for an entry without content', () => {
    expect(extractReleaseNotes(changelog, '1.2.3')).toBe(
      `**Full changelog**: [v1.2.2...v1.2.3](${REPOSITORY_URL}/compare/v1.2.2...v1.2.3)\n`
    )
  })

  it('are found under a level 1 heading', () => {
    expect(extractReleaseNotes(changelog, '1.2.0')).toBe(
      `Notes of 1.2.0.\n\n**Full changelog**: [v1.1.0...v1.2.0](${REPOSITORY_URL}/compare/v1.1.0...v1.2.0)\n`
    )
  })

  it('include the deeper headings of the entry, whatever they look like', () => {
    expect(
      extractReleaseNotes(
        '# Changelog\n\n## [2.0.0](url) (date)\n\n### [Renamed] options\n\nText.\n',
        '2.0.0'
      )
    ).toBe('### [Renamed] options\n\nText.\n')
  })

  it('have no full changelog link when the heading has no compare link', () => {
    expect(extractReleaseNotes(changelog, '1.0.0')).toBe('The first release.\n')
  })

  it('are read from a changelog with Windows line endings', () => {
    expect(extractReleaseNotes(changelog.replaceAll('\n', '\r\n'), '1.2.0')).toBe(
      `Notes of 1.2.0.\n\n**Full changelog**: [v1.1.0...v1.2.0](${REPOSITORY_URL}/compare/v1.1.0...v1.2.0)\n`
    )
  })

  it('cannot be read for a version without an entry', () => {
    expect(() => extractReleaseNotes(changelog, '1.2.5')).toThrow(
      'CHANGELOG.md has no entry for version 1.2.5'
    )
  })

  it('match what an inserted entry was rendered from', () => {
    const entry = renderEntry([toCommit('fix: correct a thing')])

    expect(
      extractReleaseNotes(insertChangelogEntry(INITIAL_CHANGELOG, '1.2.4', entry), '1.2.4')
    ).toBe(
      [
        '### Bug Fixes',
        `- correct a thing ${COMMIT_LINK}`,
        `**Full changelog**: [v1.2.3...v1.2.4](${REPOSITORY_URL}/compare/v1.2.3...v1.2.4)\n`,
      ].join('\n\n')
    )
  })

  it("reproduce this repository's existing GitHub release notes", () => {
    const notes = extractReleaseNotes(readFileSync('CHANGELOG.md', 'utf8'), '5.0.6')

    expect(notes.startsWith('### Bug Fixes\n\n- **ES5 runtime compatibility restored')).toBe(true)
    expect(
      notes.endsWith(
        '`getProperties` stays at 970 B.\n\n**Full changelog**: [v5.0.5...v5.0.6](https://github.com/properties-file/properties-file/compare/v5.0.5...v5.0.6)\n'
      )
    ).toBe(true)
  })
})

describe('release arguments', () => {
  it('are a dry run unless --confirm is given', () => {
    expect(parseReleaseArguments(['patch'], {})).toStrictEqual({ request: 'patch', isDryRun: true })
    expect(parseReleaseArguments(['--dry-run', '1.2.4'], {})).toStrictEqual({
      request: '1.2.4',
      isDryRun: true,
    })
    expect(parseReleaseArguments(['minor', '--confirm'], {})).toStrictEqual({
      request: 'minor',
      isDryRun: false,
    })
    expect(parseReleaseArguments(['--confirm', '1.2.4'], {})).toStrictEqual({
      request: '1.2.4',
      isDryRun: false,
    })
  })

  it('are a dry run when npm was asked for one, even with --confirm', () => {
    // `npm run --dry-run release -- patch --confirm`, or a `dry-run=true` line in an `.npmrc`.
    for (const environment of [
      { npm_config_dry_run: 'true' },
      { npm_config_dry_run: '1' },
      { npm_config_dry_run: 'TRUE' },
      { npm_config_dryrun: 'true' },
    ]) {
      expect(parseReleaseArguments(['patch', '--confirm'], environment)).toStrictEqual({
        request: 'patch',
        isDryRun: true,
      })
    }

    for (const environment of [{ npm_config_dry_run: '' }, { npm_config_dry_run: 'false' }]) {
      expect(parseReleaseArguments(['patch', '--confirm'], environment)).toStrictEqual({
        request: 'patch',
        isDryRun: false,
      })
    }
  })

  it('are explained when the dry run they give may not be meant', () => {
    // `npm run release patch --confirm`: npm keeps the option and sets this variable.
    expect(explainDryRun(['patch'], { npm_config_confirm: 'true' })).toBe(
      '⚠️  npm kept --confirm for itself: write it after a `--` (npm run release -- <major | minor | patch | x.y.z> [--confirm]).'
    )
    expect(explainDryRun(['patch', '--confirm'], { npm_config_dry_run: 'true' })).toBe(
      '⚠️  --confirm was given, but npm was asked for a dry run (npm_config_dry_run).'
    )
    // Nothing to explain: a dry run that was asked for, and a release.
    expect(explainDryRun(['patch'], {})).toBeUndefined()
    expect(explainDryRun(['patch', '--dry-run'], { npm_config_dry_run: 'true' })).toBeUndefined()
    expect(explainDryRun(['patch', '--confirm'], { npm_config_dry_run: 'false' })).toBeUndefined()
    expect(explainDryRun(['patch', '--confirm'], { npm_config_confirm: 'true' })).toBeUndefined()
  })

  it('cannot ask for a release and for a dry run at once', () => {
    expect(() => parseReleaseArguments(['patch', '--confirm', '--dry-run'], {})).toThrow(
      '--confirm and --dry-run cannot be used together'
    )
  })

  it('must have exactly one version argument', () => {
    expect(() => parseReleaseArguments([], {})).toThrow('expected exactly one version argument')
    expect(() => parseReleaseArguments(['--dry-run'], {})).toThrow(
      'expected exactly one version argument'
    )
    expect(() => parseReleaseArguments(['patch', 'minor'], {})).toThrow(
      'expected exactly one version argument'
    )
  })

  it('must not have an unknown option', () => {
    expect(() => parseReleaseArguments(['patch', '--force'], {})).toThrow(
      'unknown option "--force"'
    )
    expect(() => parseReleaseArguments(['patch', '-n'], {})).toThrow('unknown option "-n"')
  })
})

/** A scratch repository a release is run on. */
type Repository = {
  /** The work tree the release runs in. */
  workPath: string
  /** The bare repository the work tree knows as `origin`. */
  originPath: string
  /** Where the work tree looks for its git hooks (it has none unless a test writes one). */
  hooksPath: string
  /** Every line the releases run on this repository reported. */
  logs: string[]
}

/** What a release may change, captured to compare before and after. */
type RepositoryState = {
  /** The commit `HEAD` points to. */
  head: string
  /** The checked out branch. */
  branch: string
  /** The output of `git status --porcelain`. */
  status: string
  /** Every local reference with the object it points to. */
  references: string
  /** Every reference of `origin` with the object it points to. */
  originReferences: string
  /** The content of `package.json`. */
  manifest: string
  /** The content of `package-lock.json`. */
  lockfile: string
  /** The content of `CHANGELOG.md`. */
  changelog: string
}

/** The root of every scratch repository created by the tests, removed in `afterAll`. */
const temporaryDirectories: string[] = []

/**
 * Run a git command.
 *
 * @param directoryPath - The repository to run it in.
 * @param gitArguments - What to pass to `git` (subcommand, options, …).
 *
 * @returns What the command printed, without trailing whitespace.
 */
const git = (directoryPath: string, ...gitArguments: string[]): string =>
  execFileSync('git', gitArguments, {
    cwd: directoryPath,
    env: ENVIRONMENT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()

/**
 * Write a file in a scratch repository and commit it.
 *
 * @param repository - The scratch repository.
 * @param fileName - The file to write, relative to the work tree.
 * @param messageParagraphs - The commit message: its subject, then the paragraphs of its body.
 *
 * @returns The hash of the new commit.
 */
const commitFile = (
  repository: Repository,
  fileName: string,
  ...messageParagraphs: string[]
): string => {
  writeFileSync(path.join(repository.workPath, fileName), messageParagraphs.join('\n'))
  git(repository.workPath, 'add', fileName)
  git(
    repository.workPath,
    'commit',
    ...messageParagraphs.flatMap((paragraph) => ['--message', paragraph])
  )
  return git(repository.workPath, 'rev-parse', 'HEAD')
}

/**
 * Create a scratch repository at version 1.2.3: one commit tagged `v1.2.3`, checked out on
 * `main` and pushed to its `origin`.
 *
 * `node_modules` is a (git-ignored) link to this repository's own, so that the `prettier` the
 * release runs resolves as it does in a real checkout.
 *
 * @param buildScript - The `build` script of the scratch package (succeeds by default).
 *
 * @returns The scratch repository.
 */
const createRepository = (buildScript = 'node --version'): Repository => {
  const rootPath = mkdtempSync(path.join(tmpdir(), 'properties-file-release-'))
  temporaryDirectories.push(rootPath)
  const repository = {
    workPath: path.join(rootPath, 'work'),
    originPath: path.join(rootPath, 'origin.git'),
    hooksPath: path.join(rootPath, 'hooks'),
    logs: [],
  }
  git(rootPath, 'init', '--quiet', '--bare', '--initial-branch=main', repository.originPath)
  git(rootPath, 'init', '--quiet', '--initial-branch=main', repository.workPath)
  for (const [name, value] of [
    ['user.name', 'Release Test'],
    ['user.email', 'release-test@example.com'],
    ['core.hooksPath', repository.hooksPath],
  ]) {
    git(repository.workPath, 'config', name, value)
  }
  git(repository.workPath, 'remote', 'add', 'origin', repository.originPath)

  const manifest = {
    name: 'scratch',
    version: '1.2.3',
    repository: { type: 'git', url: `git+${REPOSITORY_URL}.git` },
    scripts: { build: buildScript },
  }
  const lockfile = {
    name: 'scratch',
    version: '1.2.3',
    lockfileVersion: 2,
    requires: true,
    packages: { '': { name: 'scratch', version: '1.2.3' } },
  }
  for (const [fileName, content] of [
    ['.gitignore', 'node_modules\n'],
    ['package.json', `${JSON.stringify(manifest, undefined, 2)}\n`],
    ['package-lock.json', `${JSON.stringify(lockfile, undefined, 2)}\n`],
    ['CHANGELOG.md', INITIAL_CHANGELOG],
  ]) {
    writeFileSync(path.join(repository.workPath, fileName), content)
  }
  symlinkSync(path.resolve('node_modules'), path.join(repository.workPath, 'node_modules'))

  git(repository.workPath, 'add', '--all')
  git(repository.workPath, 'commit', '--message', 'chore: initial commit')
  git(repository.workPath, 'tag', '--annotate', 'v1.2.3', '--message', 'Release 1.2.3')
  git(repository.workPath, 'push', '--quiet', 'origin', 'main', 'v1.2.3')
  return repository
}

/**
 * Write an executable git hook.
 *
 * @param hooksPath - The hooks directory of the repository the hook is for.
 * @param name - The hook's name (`pre-commit`, `update`, …).
 * @param script - The shell commands of the hook.
 */
const writeHook = (hooksPath: string, name: string, script: string): void => {
  mkdirSync(hooksPath, { recursive: true })
  writeFileSync(path.join(hooksPath, name), `#!/bin/sh\n${script}\n`)
  chmodSync(path.join(hooksPath, name), 0o755)
}

/**
 * Push the `main` branch of a scratch repository to its `origin`.
 *
 * @param repository - The scratch repository.
 */
const pushMain = (repository: Repository): void => {
  git(repository.workPath, 'push', '--quiet', 'origin', 'main')
}

/**
 * Capture everything a release may change in a scratch repository.
 *
 * @param repository - The scratch repository.
 *
 * @returns Its current state.
 */
const getState = (repository: Repository): RepositoryState => {
  const referenceFormat = '--format=%(objectname) %(refname)'
  return {
    head: git(repository.workPath, 'rev-parse', 'HEAD'),
    branch: git(repository.workPath, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status: git(repository.workPath, 'status', '--porcelain'),
    references: git(repository.workPath, 'for-each-ref', referenceFormat),
    originReferences: git(repository.originPath, 'for-each-ref', referenceFormat),
    manifest: readFileSync(path.join(repository.workPath, 'package.json'), 'utf8'),
    lockfile: readFileSync(path.join(repository.workPath, 'package-lock.json'), 'utf8'),
    changelog: readFileSync(path.join(repository.workPath, 'CHANGELOG.md'), 'utf8'),
  }
}

/**
 * Run a release on a scratch repository.
 *
 * @param repository - The scratch repository.
 * @param request - `major`, `minor`, `patch`, or an explicit version.
 * @param isDryRun - Whether to go through the steps without changing anything.
 * @param date - When the release is made.
 * @param environment - The environment variables the release runs with.
 *
 * @returns The released version.
 */
const releaseIn = (
  repository: Repository,
  request: string,
  isDryRun = false,
  date = RELEASE_DATE,
  environment: Record<string, string | undefined> = ENVIRONMENT
): string =>
  release({
    directoryPath: repository.workPath,
    environment,
    request,
    isDryRun,
    date,
    shouldStreamOutput: false,
    log: (message) => {
      repository.logs.push(message)
    },
  })

afterAll(() => {
  for (const temporaryDirectory of temporaryDirectories) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

describe('release', () => {
  it(
    'bumps the version, writes the changelog, commits, tags and pushes',
    () => {
      const repository = createRepository(
        `node --eval "process.exit(process.env.RELEASE_TEST_VARIABLE === 'set' ? 0 : 1)"`
      )
      const featureHash = commitFile(repository, 'feature.txt', 'feat(parser): add a thing')
      const fixHash = commitFile(repository, 'fix.txt', 'fix: correct a thing')
      commitFile(repository, 'docs.txt', 'docs: explain a thing')
      pushMain(repository)
      // The release commit skips the pre-commit hook (in this repository, the build).
      writeHook(repository.hooksPath, 'pre-commit', 'exit 1')
      // Only the release tag is pushed, even with a setting that pushes every reachable tag.
      git(repository.workPath, 'config', 'push.followTags', 'true')
      git(repository.workPath, 'tag', '--annotate', 'unrelated', '--message', 'Not a release')

      // The build only passes with a variable of the environment the release is given.
      const environment = { ...ENVIRONMENT, RELEASE_TEST_VARIABLE: 'set' }

      expect(releaseIn(repository, 'patch', false, RELEASE_DATE, environment)).toBe('1.2.4')
      expect(git(repository.originPath, 'tag', '--list')).toBe('v1.2.3\nv1.2.4')

      const state = getState(repository)

      expect(JSON.parse(state.manifest)).toHaveProperty('version', '1.2.4')
      expect(JSON.parse(state.lockfile)).toHaveProperty('version', '1.2.4')
      expect(JSON.parse(state.lockfile)).toHaveProperty(['packages', '', 'version'], '1.2.4')
      expect(state.changelog).toBe(
        [
          '# Changelog',
          `## [1.2.4](${REPOSITORY_URL}/compare/v1.2.3...v1.2.4) (2026-03-04)`,
          '### Bug Fixes',
          `- correct a thing ([${fixHash.slice(0, 7)}](${REPOSITORY_URL}/commit/${fixHash}))`,
          '### Features',
          `- **parser:** add a thing ([${featureHash.slice(0, 7)}](${REPOSITORY_URL}/commit/${featureHash}))`,
          `## [1.2.3](${REPOSITORY_URL}/compare/v1.2.2...v1.2.3) (2026-01-01)\n`,
        ].join('\n\n')
      )
      // One commit on top of the last one, holding exactly the three release files.
      expect(git(repository.workPath, 'log', '-1', '--format=%s')).toBe('🔖 release v1.2.4')
      expect(git(repository.workPath, 'show', '--name-only', '--format=', 'HEAD')).toBe(
        'CHANGELOG.md\npackage-lock.json\npackage.json'
      )
      expect(git(repository.workPath, 'rev-list', '--count', 'v1.2.3..HEAD')).toBe('4')
      expect(state.status).toBe('')
      // An annotated tag on the release commit.
      expect(git(repository.workPath, 'cat-file', '-t', 'refs/tags/v1.2.4')).toBe('tag')
      expect(
        git(repository.workPath, 'tag', '--list', '--format=%(contents:subject)', 'v1.2.4')
      ).toBe('Release 1.2.4')
      expect(git(repository.workPath, 'rev-parse', 'refs/tags/v1.2.4^{commit}')).toBe(state.head)
      // The branch and the tag are both on the remote.
      expect(git(repository.originPath, 'rev-parse', 'refs/heads/main')).toBe(state.head)
      expect(git(repository.originPath, 'rev-parse', 'refs/tags/v1.2.4^{commit}')).toBe(state.head)
      expect(repository.logs.at(-1)).toContain(
        `v1.2.4 is pushed. The release workflow now tests it, publishes it to npm and creates the GitHub release: ${REPOSITORY_URL}/actions/workflows/release.yml`
      )
    },
    COMMAND_TIMEOUT
  )

  it(
    'releases an explicit version, then another one on top of it',
    () => {
      const repository = createRepository()

      expect(releaseIn(repository, '2.0.0')).toBe('2.0.0')
      expect(releaseIn(repository, 'minor')).toBe('2.1.0')

      const state = getState(repository)

      // Neither release has commits to list: the release commit itself is not listed.
      expect(state.changelog).toBe(
        [
          '# Changelog',
          `## [2.1.0](${REPOSITORY_URL}/compare/v2.0.0...v2.1.0) (2026-03-04)`,
          `## [2.0.0](${REPOSITORY_URL}/compare/v1.2.3...v2.0.0) (2026-03-04)`,
          `## [1.2.3](${REPOSITORY_URL}/compare/v1.2.2...v1.2.3) (2026-01-01)\n`,
        ].join('\n\n')
      )
      expect(JSON.parse(state.manifest)).toHaveProperty('version', '2.1.0')
      expect(git(repository.originPath, 'rev-parse', 'refs/tags/v2.0.0^{commit}')).toBe(
        git(repository.workPath, 'rev-parse', 'HEAD~1')
      )
      expect(git(repository.originPath, 'rev-parse', 'refs/tags/v2.1.0^{commit}')).toBe(state.head)
    },
    COMMAND_TIMEOUT
  )

  it('changes nothing in a dry run, and reports every step', () => {
    const repository = createRepository()
    commitFile(repository, 'feature.txt', 'feat: add a thing')
    pushMain(repository)
    const stateBefore = getState(repository)

    expect(releaseIn(repository, 'patch', true)).toBe('1.2.4')
    expect(getState(repository)).toStrictEqual(stateBefore)

    const report = repository.logs.join('\n')

    expect(report).toContain('Releasing 1.2.3 → 1.2.4 (dry run: nothing is changed)')
    expect(report).not.toContain('A real release would stop here')
    for (const command of [
      'npm run build',
      'npm version 1.2.4 --no-git-tag-version',
      'npx --no-install prettier --write CHANGELOG.md',
      'git add CHANGELOG.md package.json package-lock.json',
      'git commit --no-verify --message "🔖 release v1.2.4"',
      'git tag --annotate v1.2.4 --message "Release 1.2.4"',
      'git push --atomic --no-follow-tags origin refs/heads/main refs/tags/v1.2.4',
    ]) {
      expect(report).toContain(`would run: ${command}`)
    }

    expect(report).toContain(
      `would add to CHANGELOG.md:\n\n## [1.2.4](${REPOSITORY_URL}/compare/v1.2.3...v1.2.4) (2026-03-04)\n\n### Features\n\n- add a thing`
    )
    expect(repository.logs.at(-1)).toBe(
      '✅ Dry run of v1.2.4 complete, nothing was changed. To release it: npm run release -- patch --confirm'
    )
  })

  it('does not write to the index in a dry run', () => {
    const repository = createRepository()
    const indexPath = path.join(repository.workPath, '.git', 'index')
    // A tracked file with a new modification time and the same content: `git status` would
    // normally take the occasion to refresh the index.
    utimesSync(path.join(repository.workPath, 'CHANGELOG.md'), new Date(), new Date(0))
    const indexBefore = readFileSync(indexPath)

    releaseIn(repository, 'patch', true)

    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true)
    expect(repository.logs.join('\n')).not.toContain('A real release would stop here')
  })

  it('reads the commits as they are, whatever `git log` is set to add to them', () => {
    const repository = createRepository()
    // Signed commits, and the setting that prints the signature of each one in `git log`.
    const keyPath = path.join(repository.originPath, '..', 'signing-key')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath])
    // The key is trusted for the identity of the scratch repository, so that git has a
    // signature line to print.
    writeFileSync(
      `${keyPath}.allowed`,
      `release-test@example.com ${readFileSync(`${keyPath}.pub`, 'utf8')}`
    )
    for (const [name, value] of [
      ['gpg.format', 'ssh'],
      ['user.signingKey', `${keyPath}.pub`],
      ['gpg.ssh.allowedSignersFile', `${keyPath}.allowed`],
      ['commit.gpgSign', 'true'],
      ['log.showSignature', 'true'],
    ]) {
      git(repository.workPath, 'config', name, value)
    }
    const fixHash = commitFile(repository, 'fix.txt', 'fix: correct a thing')
    pushMain(repository)

    releaseIn(repository, 'patch', true)

    expect(repository.logs.join('\n')).toContain(
      `### Bug Fixes\n\n- correct a thing ([${fixHash.slice(0, 7)}](${REPOSITORY_URL}/commit/${fixHash}))\n`
    )
  })

  it('is not misled by the variables git sets for the hook it may run in', () => {
    const repository = createRepository()
    const stateBefore = getState(repository)

    // What git gives a hook, such as the index of the commit being made for the pre-commit
    // hook of `git commit --all`. Each of these points to something that does not exist: any
    // of them reaching git would make it fail, or see every tracked file as deleted.
    const missingPath = path.join(repository.originPath, 'missing')

    for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE']) {
      repository.logs.length = 0
      releaseIn(repository, 'patch', true, RELEASE_DATE, { ...ENVIRONMENT, [name]: missingPath })

      expect(repository.logs.join('\n')).not.toContain('A real release would stop here')
    }

    expect(repository.logs.join('\n')).not.toContain('A real release would stop here')
    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('reports what would stop a real release in a dry run, without stopping', () => {
    const repository = createRepository()
    git(repository.workPath, 'checkout', '--quiet', '-b', 'feature')
    // The note is in the body of the commit, which is read from `git log` like its subject.
    commitFile(
      repository,
      'feature.txt',
      'feat: change a thing',
      'BREAKING CHANGE: call it\ndifferently'
    )
    writeFileSync(path.join(repository.workPath, 'untracked.txt'), '')
    const stateBefore = getState(repository)

    expect(releaseIn(repository, 'patch', true)).toBe('1.2.4')
    expect(getState(repository)).toStrictEqual(stateBefore)

    const report = repository.logs.join('\n')

    expect(report).toContain(
      [
        'A real release would stop here:',
        '   - the current branch is "feature", releases are made from "main"',
        '   - the working tree has uncommitted changes',
        '   - HEAD is not the tip of origin/main (pull or push first)',
      ].join('\n')
    )
    expect(report).toContain(
      '1 commit(s) since v1.2.3 are marked as breaking changes, but 1.2.4 is not a major version'
    )
    expect(report).toContain('### BREAKING CHANGES\n\n- call it differently')
  })

  it('warns about breaking changes unless a major version is released', () => {
    const repository = createRepository()
    commitFile(repository, 'feature.txt', 'feat!: change a thing')
    pushMain(repository)

    expect(releaseIn(repository, 'minor', true)).toBe('1.3.0')
    expect(repository.logs.join('\n')).toContain(
      'marked as breaking changes, but 1.3.0 is not a major version'
    )

    repository.logs.length = 0

    expect(releaseIn(repository, 'major', true)).toBe('2.0.0')
    expect(repository.logs.join('\n')).not.toContain('marked as breaking changes')
  })

  it('does not list merge commits, and is not confused by a branch named like the tag', () => {
    const repository = createRepository()
    git(repository.workPath, 'checkout', '--quiet', '-b', 'v1.2.4')
    commitFile(repository, 'feature.txt', 'feat: add a thing')
    git(repository.workPath, 'checkout', '--quiet', 'main')
    git(
      repository.workPath,
      'merge',
      '--quiet',
      '--no-ff',
      '--message',
      'feat: merge a branch',
      'v1.2.4'
    )
    pushMain(repository)

    expect(releaseIn(repository, 'patch', true)).toBe('1.2.4')

    const report = repository.logs.join('\n')

    expect(report).not.toContain('A real release would stop here')
    expect(report).toContain('### Features\n\n- add a thing')
    expect(report).not.toContain('merge a branch')
  })

  it('dates the changelog entry in UTC, wherever the release is made', () => {
    const repository = createRepository()

    // The first and the last half hour of March 4 in UTC: another day in most other time
    // zones. (On a machine set to UTC, as CI runners are, the local date is the same and this
    // test cannot tell the two apart.)
    for (const date of [new Date('2026-03-04T00:30:00Z'), new Date('2026-03-04T23:30:00Z')]) {
      repository.logs.length = 0
      releaseIn(repository, 'patch', true, date)

      expect(repository.logs.join('\n')).toContain('...v1.2.4) (2026-03-04)')
    }
  })

  it('refuses to release when the tag of the current version is not in the history of HEAD', () => {
    const repository = createRepository()
    // Version 1.2.3 was released from a branch that `main` does not contain.
    git(repository.workPath, 'checkout', '--quiet', '-b', 'hotfix')
    commitFile(repository, 'hotfix.txt', 'fix: correct a thing')
    git(repository.workPath, 'tag', '--force', '--annotate', 'v1.2.3', '--message', 'Release 1.2.3')
    git(repository.workPath, 'checkout', '--quiet', 'main')
    const stateBefore = getState(repository)

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the tag of the current version (v1.2.3) is not an ancestor of HEAD'
    )
    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('refuses to release when one of the release files is not tracked', () => {
    const repository = createRepository()
    git(repository.workPath, 'rm', '--quiet', '--cached', 'package-lock.json')
    git(repository.workPath, 'commit', '--quiet', '--message', 'chore: stop tracking the lockfile')
    pushMain(repository)
    const stateBefore = getState(repository)

    for (const isDryRun of [false, true]) {
      expect(() => releaseIn(repository, 'patch', isDryRun)).toThrow(
        'not tracked by git in this directory: package-lock.json'
      )
    }

    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('refuses to release from another branch', () => {
    const repository = createRepository()
    git(repository.workPath, 'checkout', '--quiet', '-b', 'feature')
    const stateBefore = getState(repository)

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the current branch is "feature", releases are made from "main"'
    )
    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('refuses to release with uncommitted changes, tracked or not', () => {
    const repository = createRepository()
    // Untracked files count even for someone whose `git status` does not show them.
    git(repository.workPath, 'config', 'status.showUntrackedFiles', 'no')
    writeFileSync(path.join(repository.workPath, 'untracked.txt'), '')

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the working tree has uncommitted changes'
    )

    unlinkSync(path.join(repository.workPath, 'untracked.txt'))
    writeFileSync(path.join(repository.workPath, 'CHANGELOG.md'), `${INITIAL_CHANGELOG}\nEdited.\n`)
    const stateBefore = getState(repository)

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the working tree has uncommitted changes'
    )
    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('refuses to release when HEAD is not the tip of the remote branch', () => {
    const repository = createRepository()
    commitFile(repository, 'feature.txt', 'feat: add a thing')
    const stateAhead = getState(repository)

    // Ahead of the remote.
    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - HEAD is not the tip of origin/main (pull or push first)'
    )
    expect(getState(repository)).toStrictEqual(stateAhead)

    // Behind the remote.
    pushMain(repository)
    git(repository.workPath, 'reset', '--quiet', '--hard', 'HEAD~1')
    const stateBehind = getState(repository)

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - HEAD is not the tip of origin/main (pull or push first)'
    )
    expect(getState(repository)).toStrictEqual(stateBehind)
  })

  it('refuses to release a version whose tag already exists, locally or on the remote', () => {
    const repository = createRepository()
    git(repository.workPath, 'tag', 'v1.2.4')
    git(repository.workPath, 'push', '--quiet', 'origin', 'v1.2.4')

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the tag v1.2.4 already exists locally\n   - the tag v1.2.4 already exists on "origin"'
    )

    git(repository.workPath, 'tag', '--delete', 'v1.2.4')
    const stateBefore = getState(repository)

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the tag v1.2.4 already exists on "origin"'
    )
    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('refuses to release when the remote cannot be read', () => {
    const repository = createRepository()
    git(repository.workPath, 'remote', 'set-url', 'origin', path.join(repository.workPath, 'gone'))
    const stateBefore = getState(repository)

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the remote "origin" could not be read (`git ls-remote '
    )
    expect(getState(repository)).toStrictEqual(stateBefore)

    git(repository.workPath, 'remote', 'remove', 'origin')

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the remote "origin" could not be read (`git remote get-url --push --all origin` failed: '
    )
  })

  it('refuses to release to a remote with several push URLs', () => {
    const repository = createRepository()
    const mirrorPath = path.join(repository.originPath, '..', 'mirror.git')
    git(repository.workPath, 'clone', '--quiet', '--bare', repository.originPath, mirrorPath)
    git(
      repository.workPath,
      'remote',
      'set-url',
      '--add',
      '--push',
      'origin',
      repository.originPath
    )
    git(repository.workPath, 'remote', 'set-url', '--add', '--push', 'origin', mirrorPath)
    const stateBefore = getState(repository)

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the remote "origin" has several push URLs, a release needs one'
    )
    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('checks the remote the release is pushed to, when it differs from the one fetched', () => {
    const repository = createRepository()
    // A second remote repository, which already has the tag, as the push URL of `origin`.
    const pushPath = path.join(repository.originPath, '..', 'push.git')
    git(repository.workPath, 'clone', '--quiet', '--bare', repository.originPath, pushPath)
    git(pushPath, 'tag', 'v1.2.4')
    git(repository.workPath, 'remote', 'set-url', '--push', 'origin', pushPath)
    const stateBefore = getState(repository)

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the tag v1.2.4 already exists on "origin"'
    )
    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('refuses to release when the tag of the current version is missing', () => {
    const repository = createRepository()
    git(repository.workPath, 'tag', '--delete', 'v1.2.3')

    for (const isDryRun of [false, true]) {
      expect(() => releaseIn(repository, 'patch', isDryRun)).toThrow(
        'the tag of the current version (v1.2.3) does not exist locally (try `git fetch --tags`)'
      )
    }

    // What is wrong with the checkout is reported first.
    git(repository.workPath, 'checkout', '--quiet', '-b', 'feature')

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the current branch is "feature", releases are made from "main"'
    )
  })

  it('refuses to release a version that already has a changelog entry', () => {
    const repository = createRepository()
    commitFile(repository, 'CHANGELOG.md', `# Changelog\n\n## [1.2.4](url) (date)\n`)
    pushMain(repository)
    const stateBefore = getState(repository)

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'CHANGELOG.md already has an entry for version 1.2.4'
    )
    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('refuses a version that is not higher, and a package.json it cannot use', () => {
    const repository = createRepository()

    expect(() => releaseIn(repository, '1.2.3')).toThrow('1.2.3 is not higher')

    writeFileSync(path.join(repository.workPath, 'package.json'), '{ "version": "1.2.3" }')

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'package.json must have a "version" and a "repository.url"'
    )
  })

  it(
    'stops when the build fails, before anything is changed',
    () => {
      const repository = createRepository('node --eval "process.exit(1)"')
      const stateBefore = getState(repository)

      expect(() => releaseIn(repository, 'patch')).toThrow('`npm run build` failed')
      expect(getState(repository)).toStrictEqual(stateBefore)
    },
    COMMAND_TIMEOUT
  )

  it(
    'stops when the build changes files, without committing them',
    () => {
      const repository = createRepository(
        `node --eval "require('fs').writeFileSync('built.txt', '')"`
      )
      const stateBefore = getState(repository)

      expect(() => releaseIn(repository, 'patch')).toThrow(
        '`npm run build` changed files, commit them first:\n?? built.txt'
      )
      expect(getState(repository)).toStrictEqual({ ...stateBefore, status: '?? built.txt' })
    },
    COMMAND_TIMEOUT
  )

  it(
    'restores the release files when a step fails before the commit',
    () => {
      const repository = createRepository()
      // With a configuration it cannot read, the `prettier` step (after the version bump and
      // the changelog entry are written) fails.
      commitFile(repository, '.prettierrc', '{ not a prettier configuration')
      pushMain(repository)
      const stateBefore = getState(repository)

      expect(() => releaseIn(repository, 'patch')).toThrow(
        /`npx --no-install prettier --write CHANGELOG\.md` failed[\s\S]*CHANGELOG\.md, package\.json, package-lock\.json were restored, nothing was committed\./
      )
      expect(getState(repository)).toStrictEqual(stateBefore)
    },
    COMMAND_TIMEOUT
  )

  it(
    'restores the release files, staged or not, when the commit fails',
    () => {
      const repository = createRepository()
      const stateBefore = getState(repository)
      // A hook that `--no-verify` does not skip, run once the three files are staged.
      writeHook(repository.hooksPath, 'prepare-commit-msg', 'exit 1')

      expect(() => releaseIn(repository, 'patch')).toThrow(
        /`git commit --no-verify --message "🔖 release v1\.2\.4"` failed[\s\S]*CHANGELOG\.md, package\.json, package-lock\.json were restored, nothing was committed\./
      )
      expect(getState(repository)).toStrictEqual(stateBefore)
    },
    COMMAND_TIMEOUT
  )

  it(
    'says how to retry or undo when the push is rejected, and both work',
    () => {
      const repository = createRepository()
      const stateBefore = getState(repository)
      // The remote refuses the tag only: the push being atomic, the branch must not go through
      // either.
      const rejectTags = 'case "$1" in refs/tags/*) exit 1 ;; esac'
      writeHook(path.join(repository.originPath, 'hooks'), 'update', rejectTags)

      expect(() => releaseIn(repository, 'patch')).toThrow(
        [
          '   The release commit exists locally. Check what reached "origin" with:',
          '     git ls-remote "$(git remote get-url --push origin)" refs/heads/main refs/tags/v1.2.4',
          '   To retry (create the tag first if `git tag --list v1.2.4` prints nothing):',
          '     git tag --annotate v1.2.4 --message "Release 1.2.4"',
          '     git push --atomic --no-follow-tags origin refs/heads/main refs/tags/v1.2.4',
          '   To undo, if nothing was pushed:',
          '     git tag --delete v1.2.4',
          '     git reset --hard HEAD~1',
          '   If the push was rejected because origin/main has new commits: undo, pull, and release again.',
        ].join('\n')
      )

      // Nothing reached the remote; the commit and the tag exist locally.
      const stateRejected = getState(repository)

      expect(stateRejected.originReferences).toBe(stateBefore.originReferences)
      expect(git(repository.workPath, 'log', '-1', '--format=%s')).toBe('🔖 release v1.2.4')
      expect(git(repository.workPath, 'rev-parse', 'refs/tags/v1.2.4^{commit}')).toBe(
        stateRejected.head
      )

      // Retry, once the remote accepts the tag.
      unlinkSync(path.join(repository.originPath, 'hooks', 'update'))
      git(
        repository.workPath,
        'push',
        '--quiet',
        '--atomic',
        'origin',
        'refs/heads/main',
        'refs/tags/v1.2.4'
      )

      expect(git(repository.originPath, 'rev-parse', 'refs/tags/v1.2.4^{commit}')).toBe(
        stateRejected.head
      )

      // Undo (on a second repository, where nothing was pushed).
      const otherRepository = createRepository()
      const otherStateBefore = getState(otherRepository)
      writeHook(path.join(otherRepository.originPath, 'hooks'), 'update', rejectTags)

      expect(() => releaseIn(otherRepository, 'patch')).toThrow('To undo, if nothing was pushed:')

      git(otherRepository.workPath, 'tag', '--delete', 'v1.2.4')
      git(otherRepository.workPath, 'reset', '--quiet', '--hard', 'HEAD~1')

      expect(getState(otherRepository)).toStrictEqual(otherStateBefore)
    },
    COMMAND_TIMEOUT
  )
})
