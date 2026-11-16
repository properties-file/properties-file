/**
 * Tests for the release flow (`release/`).
 *
 * The pure logic (`release/changelog.ts`, the archive reading and comparison of
 * `release/package-diff.ts`) is tested directly. The release and its brief
 * (`release/release.ts`, `release/brief.ts`) run real `git` and `npm` commands, so each of
 * their tests works on a scratch repository in a temporary directory: a work tree with a
 * `package.json`, a `package-lock.json` and a `CHANGELOG.md`, and a bare repository next to it
 * standing in for the `origin` remote. Nothing here changes this repository or uses the
 * network. `release/` is outside of `src/`, so it is not part of the coverage threshold: these
 * tests are what exercises its error branches.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { brief } from '../release/brief'
import {
  assertChangelogEntryAdded,
  assertOlderEntriesKept,
  compareVersions,
  extractReleaseNotes,
  getRepositoryUrl,
  insertChangelogEntry,
  isReleaseVersion,
  normalizeReleaseNotes,
  readCodeBlockLines,
  renderChangelogEntry,
  resolveNextVersion,
} from '../release/changelog'
import {
  describeNotesProblems,
  findNotesProblems,
  getReleaseLevel,
  readNotesRules,
} from '../release/notes-rules'
import {
  comparePackageFiles,
  describePackageDifference,
  isSamePackage,
  readPackageArchive,
} from '../release/package-diff'
import { explainDryRun, parseReleaseArguments, release, USAGE } from '../release/release'

import type { BriefOptions } from '../release/brief'
import type { NotesContext, NotesRules } from '../release/notes-rules'
import type { PackageFiles } from '../release/package-diff'
import type { ReleaseOptions } from '../release/release'

/** The repository URL used by the changelog fixtures. */
const REPOSITORY_URL = 'https://github.com/scratch/scratch'

/** When the test releases are made, unless a test says otherwise: March 4, 2026 in UTC. */
const RELEASE_DATE = new Date('2026-03-04T12:00:00Z')

/** The release notes the test releases are given, unless a test says otherwise. */
const NOTES = '### Bug Fixes\n\n- Keep a `__proto__` key.\n'

/** The changelog a scratch repository starts with: the title and the entry of version 1.2.3. */
const INITIAL_CHANGELOG = `# Changelog

## [1.2.3](${REPOSITORY_URL}/compare/v1.2.2...v1.2.3) (2026-01-01)
`

/** The guidelines a scratch repository has, which its brief prints. */
const GUIDELINES = '# Release notes guidelines\n\nWrite for the users of the package.\n'

/** How long a test that runs real `npm` commands may take. */
const COMMAND_TIMEOUT = 60_000

/**
 * The temporary directory of these tests alone, removed in `afterAll`. Everything the tests
 * and the release code create goes there instead of the temporary directory of the system:
 * the tests can then check what a command leaves behind while something else on the machine
 * (another run of these tests, a real brief) uses that one, and leave nothing in it.
 */
const TEMPORARY_ROOT = mkdtempSync(path.join(tmpdir(), 'properties-file-release-tests-'))
jest.spyOn(os, 'tmpdir').mockReturnValue(TEMPORARY_ROOT)

/**
 * The environment of every command the tests run. Three things are taken out of this
 * process's own: every `GIT_*` variable (these tests run in the pre-commit hook of this
 * repository, for which git sets variables pointing at the index of the commit being made),
 * the options an outer `npm run` was given, which the release command reads
 * (`npm run --dry-run build`), and the git configuration of the machine (identity, signing,
 * hooks, push settings), so that only what a scratch repository sets itself plays a part.
 * The commands are also given the temporary directory of the tests.
 */
const ENVIRONMENT = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('GIT_') && !/^npm_config_(?:confirm|dry_?run)$/.test(name)
    )
  ),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  TMPDIR: TEMPORARY_ROOT,
}

/** The heading of the entry {@link renderEntry} renders. */
const ENTRY_HEADING = `## [1.2.4](${REPOSITORY_URL}/compare/v1.2.3...v1.2.4) (2026-03-04)`

/**
 * Render the changelog entry of version 1.2.4 for some release notes.
 *
 * @param notes - The release notes.
 *
 * @returns The rendered entry, ending with a line break.
 */
const renderEntry = (notes: string): string =>
  renderChangelogEntry({
    version: '1.2.4',
    previousVersion: '1.2.3',
    date: '2026-03-04',
    repositoryUrl: REPOSITORY_URL,
    notes,
  })

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

describe('release notes', () => {
  it('are written as they are, without blank lines around them', () => {
    expect(
      normalizeReleaseNotes('\n \t\r\n### Features\r\n\r\n- Add `a_b`, *really*.  \n  More.\n\n\n')
    ).toBe('### Features\n\n- Add `a_b`, *really*.  \n  More.')
  })

  it('have Unix line endings, whatever they were given with, and no byte order mark', () => {
    // A lone carriage return included: prettier would take one for the line ending of the
    // whole changelog.
    expect(
      normalizeReleaseNotes(`${String.fromCodePoint(0xfe_ff)}- One.\r- Two.\r\n- Three.\n`)
    ).toBe('- One.\n- Two.\n- Three.')
    // A heading hidden behind one is still refused.
    expect(() => normalizeReleaseNotes('- One.\r## [1.2.2](url) (date)\r- Two.')).toThrow(
      'the release notes have a line in the form of a changelog entry heading'
    )
  })

  it('may have headings and code that only look like parts of a changelog', () => {
    const notes = [
      '## What changed',
      '### [Renamed] options',
      '```properties\n# [1.2.3] is a comment\n## [section]\n```',
      '## [Unreleased]',
    ].join('\n\n')

    expect(normalizeReleaseNotes(notes)).toBe(notes)
  })

  it('cannot be empty', () => {
    for (const notes of ['', '\n', '  \r\n\t\n']) {
      expect(() => normalizeReleaseNotes(notes)).toThrow('the release notes are empty')
    }
  })

  it('cannot have a line in the form of an entry heading', () => {
    for (const heading of ['## [1.2.3](url) (date)', '# [9.0.0](url)', '## [1.2.0 — 1.2.2](url)']) {
      expect(() => normalizeReleaseNotes(`- An item.\n\n${heading}\n\n- Another.`)).toThrow(
        `the release notes have a line in the form of a changelog entry heading: ${heading}`
      )
    }
  })
})

describe('changelog entry', () => {
  it('is a heading with the compare link and the date, then the notes', () => {
    expect(renderEntry('\n### Bug Fixes\r\n\r\n- Keep a `__proto__` key.  \n\n')).toBe(
      `${ENTRY_HEADING}\n\n### Bug Fixes\n\n- Keep a \`__proto__\` key.\n`
    )
  })

  it('cannot be rendered without usable notes', () => {
    expect(() => renderEntry(' \n')).toThrow('the release notes are empty')
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
    for (const changelog of ['# Changelog\n', '# Changelog', '# Changelog\n\n\n']) {
      expect(insertChangelogEntry(changelog, '1.0.0', '## [1.0.0](url)\n')).toBe(
        '# Changelog\n\n## [1.0.0](url)\n'
      )
    }
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
      '## [Unreleased](url)',
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

  it('can be checked to have exactly one more entry, the one of the release', () => {
    const changelogWithEntry = insertChangelogEntry(INITIAL_CHANGELOG, '1.2.4', renderEntry(NOTES))

    expect(() => {
      assertChangelogEntryAdded(INITIAL_CHANGELOG, changelogWithEntry, '1.2.4')
    }).not.toThrow()
    // The entry cannot be read: every line ending became a lone carriage return.
    expect(() => {
      assertChangelogEntryAdded(
        INITIAL_CHANGELOG,
        changelogWithEntry.replaceAll('\n', '\r'),
        '1.2.4'
      )
    }).toThrow('CHANGELOG.md has no entry for version 1.2.4')
    // The entry is there, with another one that was not asked for.
    expect(() => {
      assertChangelogEntryAdded(
        INITIAL_CHANGELOG,
        changelogWithEntry.replace('- Keep', '## [1.2.2](url) (date)\n\n- Keep'),
        '1.2.4'
      )
    }).toThrow('CHANGELOG.md had 1 entries and now reads as having 3')
    // An entry was lost.
    expect(() => {
      assertChangelogEntryAdded(changelogWithEntry, changelogWithEntry, '1.2.4')
    }).toThrow('CHANGELOG.md had 2 entries and now reads as having 2')
  })

  it('does not mistake a version for another one that starts with it', () => {
    expect(insertChangelogEntry(INITIAL_CHANGELOG, '1.2', 'entry\n')).toContain('entry')
    expect(() => extractReleaseNotes(INITIAL_CHANGELOG, '1.2')).toThrow(
      'CHANGELOG.md has no entry for version 1.2'
    )
  })
})

describe('GitHub release notes', () => {
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
    expect(extractReleaseNotes(changelog.replaceAll('\n', '\r\n'), '1.2.4')).toBe(
      extractReleaseNotes(changelog, '1.2.4')
    )
  })

  it('cannot be read for a version without an entry', () => {
    expect(() => extractReleaseNotes(changelog, '1.2.5')).toThrow(
      'CHANGELOG.md has no entry for version 1.2.5'
    )
  })

  it('are the notes the entry was rendered from', () => {
    const changelogWithEntry = insertChangelogEntry(INITIAL_CHANGELOG, '1.2.4', renderEntry(NOTES))

    expect(extractReleaseNotes(changelogWithEntry, '1.2.4')).toBe(
      `${NOTES}\n**Full changelog**: [v1.2.3...v1.2.4](${REPOSITORY_URL}/compare/v1.2.3...v1.2.4)\n`
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

/**
 * Build one entry of a tar archive: its header block, then its content padded to whole blocks.
 *
 * @param entryPath - What goes in the name field of the header.
 * @param content - What the entry holds (the text of a file, the records of an extended header).
 * @param type - The type of the entry (`0` for a file, `5` for a directory, `x` for an
 *   extended header).
 * @param prefix - The prefix field of the entry, which comes before its name in its path.
 *
 * @returns The bytes of the entry.
 */
const toTarEntry = (entryPath: string, content: string, type = '0', prefix = ''): Buffer => {
  const header = Buffer.alloc(512)
  header.write(entryPath, 0, 100)
  header.write(Buffer.byteLength(content).toString(8).padStart(11, '0'), 124, 12)
  header.write(type, 156, 1)
  header.write(prefix, 345, 155)
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512)
  body.write(content)
  return Buffer.concat([header, body])
}

/**
 * Build a package archive from tar entries.
 *
 * @param entries - The entries, as {@link toTarEntry} builds them.
 *
 * @returns The compressed archive, ending with the two empty blocks that close a tar archive.
 */
const toArchive = (...entries: Buffer[]): Buffer =>
  gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))

/**
 * Build the files of a package.
 *
 * @param files - The content of each file, by its path.
 *
 * @returns The files, as a package archive is read into.
 */
const toPackageFiles = (files: Record<string, string>): PackageFiles =>
  new Map(Object.entries(files).map(([filePath, content]) => [filePath, Buffer.from(content)]))

/**
 * Read a package archive into something an assertion can show.
 *
 * @param archive - The compressed archive, as {@link toArchive} builds it.
 *
 * @returns The content of each file as text, by its path.
 */
const readArchive = (archive: Buffer): Record<string, string> =>
  Object.fromEntries(
    readPackageArchive(archive)
      .entries()
      .map(([filePath, content]) => [filePath, content.toString('utf8')])
  )

describe('package archive', () => {
  it('is read into its files, without the directory every path starts with', () => {
    const longContent = 'x'.repeat(600)

    const archive = toArchive(
      toTarEntry('package/package.json', '{}'),
      toTarEntry('package/dist/index.js', longContent),
      toTarEntry('package/empty.txt', ''),
      toTarEntry('package/README.md', 'Read me.')
    )

    expect(readArchive(archive)).toStrictEqual({
      'package.json': '{}',
      'dist/index.js': longContent,
      'empty.txt': '',
      'README.md': 'Read me.',
    })
  })

  it('takes the path of a file from its prefix or from an extended header when it has one', () => {
    const archive = toArchive(
      toTarEntry('index.js', 'a', '0', 'package/deep/directory'),
      toTarEntry('PaxHeader', '30 path=package/long/name.js\n12 size=1\n', 'x'),
      toTarEntry('package/truncated', 'b'),
      toTarEntry('package/next.js', 'c')
    )

    expect(readArchive(archive)).toStrictEqual({
      'deep/directory/index.js': 'a',
      'long/name.js': 'b',
      'next.js': 'c',
    })
  })

  it('only has files, in any form of the format', () => {
    const archive = toArchive(
      toTarEntry('package/dist/', '', '5'),
      toTarEntry('package/link', '', '2'),
      toTarEntry('package/old-style.js', 'd', '')
    )

    expect(readArchive(archive)).toStrictEqual({ 'old-style.js': 'd' })
  })
})

describe('package comparison', () => {
  const published = toPackageFiles({
    'package.json':
      '{"name":"scratch","version":"1.2.3","devDependencies":{"a":"1.0.0"},"main":"x.js"}',
    'dist/index.js': 'one',
    'dist/removed.js': 'gone',
    'README.md': 'same',
  })

  it('lists the files that were added, removed and changed, in order', () => {
    const difference = comparePackageFiles(
      published,
      toPackageFiles({
        'package.json':
          '{"name":"scratch","version":"1.2.4","devDependencies":{"a":"1.0.0"},"main":"x.js"}',
        'dist/index.js': 'two',
        'dist/z-added.js': 'new',
        'dist/a-added.js': 'new',
        'README.md': 'same',
      })
    )

    expect(difference).toStrictEqual({
      added: ['dist/a-added.js', 'dist/z-added.js'],
      removed: ['dist/removed.js'],
      changed: ['dist/index.js'],
      changedManifestFields: [],
    })
    expect(isSamePackage(difference)).toBe(false)
    expect(describePackageDifference(difference)).toStrictEqual([
      'changed  dist/index.js',
      'added    dist/a-added.js',
      'added    dist/z-added.js',
      'removed  dist/removed.js',
    ])
  })

  it('ignores what says nothing to those who install the package', () => {
    const current = new Map(published)
    // Another version, other development dependencies, scripts that do not run at install,
    // fields in another order and layout.
    current.set(
      'package.json',
      Buffer.from(
        '{\n  "scripts": { "build": "x", "prepare": "y" },\n  "main": "x.js",\n  "name": "scratch",\n  "version": "2.0.0",\n  "devDependencies": { "a": "2.0.0", "b": "1.0.0" }\n}\n'
      )
    )
    // Other line endings.
    const windowsPublished = new Map(published).set('README.md', Buffer.from('sa\r\nme\r\n'))
    current.set('README.md', Buffer.from('sa\nme\n'))
    const difference = comparePackageFiles(windowsPublished, current)

    expect(difference).toStrictEqual({
      added: [],
      removed: [],
      changed: [],
      changedManifestFields: [],
    })
    expect(isSamePackage(difference)).toBe(true)
    expect(describePackageDifference(difference)).toStrictEqual([])
  })

  it('counts any other change to package.json, and says which fields changed', () => {
    const cases: [string, string[]][] = [
      ['{"name":"scratch","main":"y.js"}', ['main']],
      ['{"name":"scratch","main":"x.js","dependencies":{"a":"1.0.0"}}', ['dependencies']],
      ['{"name":"scratch","main":"x.js","scripts":{"build":"x","postinstall":"y"}}', ['scripts']],
      ['{"name":"other","exports":{}}', ['exports', 'main', 'name']],
    ]

    for (const [manifest, fields] of cases) {
      const current = new Map(published)
      current.set('package.json', Buffer.from(manifest))
      const difference = comparePackageFiles(published, current)

      expect(difference.changed).toStrictEqual(['package.json'])
      expect(difference.changedManifestFields).toStrictEqual(fields)
      expect(describePackageDifference(difference)).toStrictEqual([
        `changed  package.json (${fields.join(', ')})`,
      ])
    }
  })

  it('counts a difference other than line endings, and any difference in a binary file', () => {
    for (const [publishedContent, currentContent] of [
      ['a\r\nb', 'a\nc'],
      ['a\rb', 'a\nb'],
      ['a\r\n\0b', 'a\n\0b'],
    ]) {
      const difference = comparePackageFiles(
        toPackageFiles({ 'file.bin': publishedContent }),
        toPackageFiles({ 'file.bin': currentContent })
      )

      expect(difference.changed).toStrictEqual(['file.bin'])
    }
  })
})

describe('release arguments', () => {
  it('are a dry run unless --confirm is given', () => {
    expect(parseReleaseArguments(['patch'], {})).toStrictEqual({
      command: 'release',
      request: 'patch',
      isDryRun: true,
    })
    expect(parseReleaseArguments(['--dry-run', '1.2.4'], {})).toStrictEqual({
      command: 'release',
      request: '1.2.4',
      isDryRun: true,
    })
    expect(parseReleaseArguments(['minor', '--confirm'], {})).toStrictEqual({
      command: 'release',
      request: 'minor',
      isDryRun: false,
    })
    expect(parseReleaseArguments(['--confirm', '1.2.4'], {})).toStrictEqual({
      command: 'release',
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
        command: 'release',
        request: 'patch',
        isDryRun: true,
      })
    }

    for (const environment of [{ npm_config_dry_run: '' }, { npm_config_dry_run: 'false' }]) {
      expect(parseReleaseArguments(['patch', '--confirm'], environment)).toStrictEqual({
        command: 'release',
        request: 'patch',
        isDryRun: false,
      })
    }
  })

  it('are explained when the dry run they give may not be meant', () => {
    // `npm run release patch --confirm`: npm keeps the option and sets this variable.
    expect(explainDryRun(['patch'], { npm_config_confirm: 'true' })).toBe(
      '⚠️  npm kept --confirm for itself: write it after the `--` that separates the arguments of the script from those of npm.'
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

  it('can ask for the brief, which takes no option', () => {
    expect(parseReleaseArguments(['brief'], { npm_config_dry_run: 'true' })).toStrictEqual({
      command: 'brief',
    })

    for (const option of ['--confirm', '--dry-run']) {
      expect(() => parseReleaseArguments(['brief', option], {})).toThrow(
        `"brief" takes no option\n${USAGE}`
      )
    }
  })

  it('cannot ask for a release and for a dry run at once', () => {
    expect(() => parseReleaseArguments(['patch', '--confirm', '--dry-run'], {})).toThrow(
      '--confirm and --dry-run cannot be used together'
    )
  })

  it('must have exactly one argument that is not an option', () => {
    for (const commandArguments of [[], ['--dry-run'], ['patch', 'minor'], ['brief', 'patch']]) {
      expect(() => parseReleaseArguments(commandArguments, {})).toThrow(
        `expected "brief" or exactly one version argument\n${USAGE}`
      )
    }
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
  /** The directory that holds the work tree, its remote and everything else of the test. */
  rootPath: string
  /** The work tree the release runs in. */
  workPath: string
  /** The bare repository the work tree knows as `origin`. */
  originPath: string
  /** Where the work tree looks for its git hooks (it has none unless a test writes one). */
  hooksPath: string
  /** Every line the releases and briefs run on this repository reported. */
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
 * Pack the package of a directory, as `npm pack` does.
 *
 * @param directoryPath - Where the `package.json` of the package is.
 * @param destinationPath - Where to write the archive.
 *
 * @returns The path of the archive.
 */
const packPackage = (directoryPath: string, destinationPath: string): string => {
  const archiveName = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--pack-destination', destinationPath],
    { cwd: directoryPath, env: ENVIRONMENT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
  return path.join(destinationPath, archiveName)
}

/**
 * Pack the package that stands in for the published version of the scratch package.
 *
 * @returns The path of its archive.
 */
const packPublishedPackage = (): string => {
  const rootPath = mkdtempSync(path.join(tmpdir(), 'properties-file-published-'))
  temporaryDirectories.push(rootPath)
  const packagePath = path.join(rootPath, 'package')
  mkdirSync(packagePath)
  writeFileSync(
    path.join(packagePath, 'package.json'),
    JSON.stringify({ name: 'scratch', version: '1.2.3' })
  )
  writeFileSync(path.join(packagePath, 'index.js'), 'module.exports = 1\n')
  return packPackage(packagePath, rootPath)
}

/**
 * The archive that stands in for version 1.2.3 of the scratch package on npm: a `package.json`
 * without scripts and the `index.js` every scratch repository starts with.
 */
const publishedPackagePath = packPublishedPackage()

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
 * @param buildScript - The `build` script of the scratch package, which a release runs
 *   (succeeds by default).
 * @param packageBuildScript - Its `build-artifacts` script, which a brief runs (succeeds by
 *   default).
 *
 * @returns The scratch repository.
 */
const createRepository = (
  buildScript = 'node --version',
  packageBuildScript = 'node --version'
): Repository => {
  const rootPath = mkdtempSync(path.join(tmpdir(), 'properties-file-release-'))
  temporaryDirectories.push(rootPath)
  const repository = {
    rootPath,
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
    scripts: {
      build: buildScript,
      'build-artifacts': packageBuildScript,
      // Packing the package to compare it does not run this script, which fails.
      prepack: 'exit 1',
    },
  }
  const lockfile = {
    name: 'scratch',
    version: '1.2.3',
    lockfileVersion: 2,
    requires: true,
    packages: { '': { name: 'scratch', version: '1.2.3' } },
  }
  mkdirSync(path.join(repository.workPath, 'docs'))
  for (const [fileName, content] of [
    ['.gitignore', 'node_modules\n'],
    ['package.json', `${JSON.stringify(manifest, undefined, 2)}\n`],
    ['package-lock.json', `${JSON.stringify(lockfile, undefined, 2)}\n`],
    ['CHANGELOG.md', INITIAL_CHANGELOG],
    ['index.js', 'module.exports = 1\n'],
    ['docs/release-notes-guidelines.md', GUIDELINES],
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
 * Run a release on a scratch repository: a real one of the given notes, compared with the
 * stand-in for the published package, unless the options say otherwise.
 *
 * @param repository - The scratch repository.
 * @param request - `major`, `minor`, `patch`, or an explicit version.
 * @param options - The options of the release to set differently.
 *
 * @returns The released version.
 */
const releaseIn = (
  repository: Repository,
  request: string,
  options: Partial<ReleaseOptions> = {}
): string =>
  release({
    directoryPath: repository.workPath,
    environment: ENVIRONMENT,
    request,
    isDryRun: false,
    notes: NOTES,
    date: RELEASE_DATE,
    shouldStreamOutput: false,
    publishedPackageSpec: publishedPackagePath,
    log: (message) => {
      repository.logs.push(message)
    },
    ...options,
  })

/**
 * Print the brief of a scratch repository, compared with the stand-in for the published
 * package unless the options say otherwise.
 *
 * @param repository - The scratch repository.
 * @param options - The options of the brief to set differently.
 *
 * @returns What the brief reported.
 */
const briefIn = (repository: Repository, options: Partial<BriefOptions> = {}): string => {
  repository.logs.length = 0
  brief({
    directoryPath: repository.workPath,
    environment: ENVIRONMENT,
    publishedPackageSpec: publishedPackagePath,
    log: (message) => {
      repository.logs.push(message)
    },
    ...options,
  })
  return repository.logs.join('\n')
}

afterAll(() => {
  jest.restoreAllMocks()
  for (const temporaryDirectory of [...temporaryDirectories, TEMPORARY_ROOT]) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

describe('release', () => {
  it(
    'bumps the version, writes the notes to the changelog, commits, tags and pushes',
    () => {
      const repository = createRepository(
        `node --eval "process.exit(process.env.RELEASE_TEST_VARIABLE === 'set' ? 0 : 1)"`
      )
      commitFile(repository, 'feature.txt', 'feat(parser): add a thing')
      pushMain(repository)
      // The release commit skips the pre-commit hook (in this repository, the build).
      writeHook(repository.hooksPath, 'pre-commit', 'exit 1')
      // Only the release tag is pushed, even with a setting that pushes every reachable tag.
      git(repository.workPath, 'config', 'push.followTags', 'true')
      // The branch is pushed to `main`, even with a setting that maps it to another name.
      git(repository.workPath, 'config', 'remote.origin.push', 'refs/heads/main:refs/heads/other')
      git(repository.workPath, 'tag', '--annotate', 'unrelated', '--message', 'Not a release')
      // The build only passes with a variable of the environment the release is given.
      const environment = { ...ENVIRONMENT, RELEASE_TEST_VARIABLE: 'set' }
      // The notes are given with a lone carriage return, which must not become the line
      // ending of the changelog.
      const notes = NOTES.replace('\n\n', '\r\r')
      const temporaryNamesBefore = readdirSync(tmpdir())

      expect(releaseIn(repository, 'patch', { environment, notes })).toBe('1.2.4')
      // The directory the two packages were packed in to be compared is gone.
      expect(
        readdirSync(tmpdir()).filter((name) => name.startsWith('release-package-'))
      ).toStrictEqual(temporaryNamesBefore.filter((name) => name.startsWith('release-package-')))
      expect(git(repository.originPath, 'tag', '--list')).toBe('v1.2.3\nv1.2.4')
      expect(git(repository.originPath, 'branch', '--format=%(refname)')).toBe('refs/heads/main')

      const state = getState(repository)

      expect(JSON.parse(state.manifest)).toHaveProperty('version', '1.2.4')
      expect(JSON.parse(state.lockfile)).toHaveProperty('version', '1.2.4')
      expect(JSON.parse(state.lockfile)).toHaveProperty(['packages', '', 'version'], '1.2.4')
      expect(state.changelog).toBe(
        [
          '# Changelog',
          `## [1.2.4](${REPOSITORY_URL}/compare/v1.2.3...v1.2.4) (2026-03-04)`,
          '### Bug Fixes',
          '- Keep a `__proto__` key.',
          `## [1.2.3](${REPOSITORY_URL}/compare/v1.2.2...v1.2.3) (2026-01-01)\n`,
        ].join('\n\n')
      )
      // One commit on top of the last one, holding exactly the three release files.
      expect(git(repository.workPath, 'log', '-1', '--format=%s')).toBe('🔖 release v1.2.4')
      expect(git(repository.workPath, 'show', '--name-only', '--format=', 'HEAD')).toBe(
        'CHANGELOG.md\npackage-lock.json\npackage.json'
      )
      expect(git(repository.workPath, 'rev-list', '--count', 'v1.2.3..HEAD')).toBe('2')
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
      // The last thing reported is what remains to be done, and by whom.
      expect(repository.logs.at(-1)).toBe(
        [
          '✅ v1.2.4 is pushed. It is not on npm yet. What happens next:',
          `   1. The release workflow tests the version, builds it and stages it on npm: ${REPOSITORY_URL}/actions/workflows/release.yml`,
          '   2. A maintainer approves the staged version with two-factor authentication: on npmjs.com (the Staged Packages tab), or with `npm stage approve <stage-id>`. The summary of the workflow run gives the id, and the shasum to check first. Tell them when the version is waiting.',
          '   3. scratch@1.2.4 is then public: `npm view scratch@1.2.4 version` prints the version once it is.',
        ].join('\n')
      )
    },
    COMMAND_TIMEOUT
  )

  it(
    'releases an explicit version, then another one on top of it',
    () => {
      const repository = createRepository()

      expect(releaseIn(repository, '2.0.0', { notes: '### BREAKING CHANGES\n\n- One.' })).toBe(
        '2.0.0'
      )
      expect(releaseIn(repository, 'minor', { notes: '### Features\n\n- Two.' })).toBe('2.1.0')

      const state = getState(repository)

      expect(state.changelog).toBe(
        [
          '# Changelog',
          `## [2.1.0](${REPOSITORY_URL}/compare/v2.0.0...v2.1.0) (2026-03-04)`,
          '### Features',
          '- Two.',
          `## [2.0.0](${REPOSITORY_URL}/compare/v1.2.3...v2.0.0) (2026-03-04)`,
          '### BREAKING CHANGES',
          '- One.',
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
    const stateBefore = getState(repository)

    expect(releaseIn(repository, 'patch', { isDryRun: true })).toBe('1.2.4')
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
      'git push --atomic --no-follow-tags origin refs/heads/main:refs/heads/main refs/tags/v1.2.4:refs/tags/v1.2.4',
    ]) {
      expect(report).toContain(`would run: ${command}`)
    }

    expect(report).toContain(
      `would compare the package with ${publishedPackagePath}, and stop if it is the same`
    )
    expect(report).toContain(
      `would add to CHANGELOG.md:\n\n## [1.2.4](${REPOSITORY_URL}/compare/v1.2.3...v1.2.4) (2026-03-04)\n\n### Bug Fixes\n\n- Keep a \`__proto__\` key.\n`
    )
    // The last thing reported is what to do before releasing for real.
    expect(repository.logs.at(-1)).toBe(
      [
        '✅ Dry run of v1.2.4 complete, nothing was changed.',
        '   Not checked by a dry run: that `npm run build` passes without changing a file, and that the package differs from the published one. The release checks both before it changes anything.',
        '   Next: check the notes above against docs/release-notes-guidelines.md (`npm run release -- brief` prints it with what changed), then show a maintainer the version and the notes, and wait for their go-ahead.',
        '   To release: the same command with --confirm after the version. The maintainer will then have to approve the version on npm.',
      ].join('\n')
    )
  })

  it('does not write to the index in a dry run', () => {
    const repository = createRepository()
    const indexPath = path.join(repository.workPath, '.git', 'index')
    // A tracked file with a new modification time and the same content: `git status` would
    // normally take the occasion to refresh the index.
    utimesSync(path.join(repository.workPath, 'CHANGELOG.md'), new Date(), new Date(0))
    const indexBefore = readFileSync(indexPath)

    releaseIn(repository, 'patch', { isDryRun: true })

    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true)
    expect(repository.logs.join('\n')).not.toContain('A real release would stop here')
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
      releaseIn(repository, 'patch', {
        isDryRun: true,
        environment: { ...ENVIRONMENT, [name]: missingPath },
      })

      expect(repository.logs.join('\n')).not.toContain('A real release would stop here')
    }

    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('reports what would stop a real release in a dry run, without stopping', () => {
    const repository = createRepository()
    git(repository.workPath, 'checkout', '--quiet', '-b', 'feature')
    commitFile(repository, 'feature.txt', 'feat: change a thing')
    writeFileSync(path.join(repository.workPath, 'untracked.txt'), '')
    const stateBefore = getState(repository)

    expect(releaseIn(repository, 'patch', { isDryRun: true })).toBe('1.2.4')
    expect(getState(repository)).toStrictEqual(stateBefore)
    expect(repository.logs.join('\n')).toContain(
      [
        'A real release would stop here:',
        '   - the current branch is "feature", releases are made from "main"',
        '   - the working tree has uncommitted changes',
        '   - HEAD is not the tip of origin/main (pull or push first)',
      ].join('\n')
    )
  })

  it('is not confused by a branch named like the tag of the release', () => {
    const repository = createRepository()
    git(repository.workPath, 'branch', 'v1.2.4')

    expect(releaseIn(repository, 'patch', { isDryRun: true })).toBe('1.2.4')
    expect(repository.logs.join('\n')).not.toContain('A real release would stop here')
  })

  it('dates the changelog entry in UTC, wherever the release is made', () => {
    const repository = createRepository()

    // The first and the last half hour of March 4 in UTC: another day in most other time
    // zones. (On a machine set to UTC, as CI runners are, the local date is the same and this
    // test cannot tell the two apart.)
    for (const date of [new Date('2026-03-04T00:30:00Z'), new Date('2026-03-04T23:30:00Z')]) {
      repository.logs.length = 0
      releaseIn(repository, 'patch', { isDryRun: true, date })

      expect(repository.logs.join('\n')).toContain('...v1.2.4) (2026-03-04)')
    }
  })

  it('refuses to release without release notes, or with notes that would break the changelog', () => {
    const repository = createRepository()
    const stateBefore = getState(repository)

    for (const isDryRun of [false, true]) {
      for (const notes of ['', ' \n\t\n']) {
        expect(() => releaseIn(repository, 'patch', { isDryRun, notes })).toThrow(
          `no release notes were given on the standard input\n${USAGE}`
        )
      }

      expect(() =>
        releaseIn(repository, 'patch', { isDryRun, notes: '## [1.2.2](url) (date)\n\n- Old.' })
      ).toThrow('the release notes have a line in the form of a changelog entry heading')
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
    const mirrorPath = path.join(repository.rootPath, 'mirror.git')
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
      /^🚨 cannot release:\n {3}- the remote "origin" has several push URLs, a release needs one$/
    )
    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('checks the remote the release is pushed to, when it differs from the one fetched', () => {
    const repository = createRepository()
    // A second remote repository, which already has the tag, as the push URL of `origin`.
    const pushPath = path.join(repository.rootPath, 'push.git')
    git(repository.workPath, 'clone', '--quiet', '--bare', repository.originPath, pushPath)
    git(pushPath, 'tag', 'v1.2.4')
    git(repository.workPath, 'remote', 'set-url', '--push', 'origin', pushPath)
    const stateBefore = getState(repository)

    expect(() => releaseIn(repository, 'patch')).toThrow(
      'cannot release:\n   - the tag v1.2.4 already exists on "origin"'
    )
    expect(getState(repository)).toStrictEqual(stateBefore)
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
      expect(() => releaseIn(repository, 'patch', { isDryRun })).toThrow(
        'not tracked by git in this directory: package-lock.json'
      )
    }

    expect(getState(repository)).toStrictEqual(stateBefore)
  })

  it('refuses to release when the tag of the current version is missing', () => {
    const repository = createRepository()
    git(repository.workPath, 'tag', '--delete', 'v1.2.3')

    for (const isDryRun of [false, true]) {
      expect(() => releaseIn(repository, 'patch', { isDryRun })).toThrow(
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
      'package.json must have a "name", a "version" and a "repository.url"'
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
        `node --eval "fs.writeFileSync('built.txt', ''); fs.appendFileSync('index.js', '//')"`
      )
      const stateBefore = getState(repository)

      expect(() => releaseIn(repository, 'patch')).toThrow(
        '`npm run build` changed files, commit them first:\n M index.js\n?? built.txt'
      )
      expect(getState(repository)).toStrictEqual({
        ...stateBefore,
        status: ' M index.js\n?? built.txt',
      })
    },
    COMMAND_TIMEOUT
  )

  it(
    'stops when the package is the same as the published one',
    () => {
      const repository = createRepository()
      // The published version is the package of the repository as it is now.
      const publishedPackageSpec = packPackage(repository.workPath, repository.rootPath)
      const stateBefore = getState(repository)

      expect(() => releaseIn(repository, 'patch', { publishedPackageSpec })).toThrow(
        `nothing to release: the files of the package are the same as in ${publishedPackageSpec}`
      )
      expect(getState(repository)).toStrictEqual(stateBefore)

      // A change to the development dependencies alone does not reach those who install it.
      const manifestPath = path.join(repository.workPath, 'package.json')
      writeFileSync(
        manifestPath,
        readFileSync(manifestPath, 'utf8').replace(
          '"scripts"',
          '"devDependencies": { "a": "1" },\n  "scripts"'
        )
      )
      git(repository.workPath, 'commit', '--quiet', '--all', '--message', 'build: add a tool')
      pushMain(repository)

      expect(() => releaseIn(repository, 'patch', { publishedPackageSpec })).toThrow(
        'nothing to release'
      )

      // A change to a file of the package does.
      commitFile(repository, 'index.js', 'module.exports = 2')
      pushMain(repository)

      expect(releaseIn(repository, 'patch', { publishedPackageSpec })).toBe('1.2.4')
    },
    COMMAND_TIMEOUT
  )

  it(
    'releases with a warning when the published package cannot be fetched',
    () => {
      const repository = createRepository()
      const publishedPackageSpec = path.join(repository.rootPath, 'missing.tgz')

      expect(releaseIn(repository, 'patch', { publishedPackageSpec })).toBe('1.2.4')
      expect(repository.logs.join('\n')).toContain(
        `The package could not be compared with ${publishedPackageSpec}, which could not be fetched (\`npm pack `
      )
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
          '     git push --atomic --no-follow-tags origin refs/heads/main:refs/heads/main refs/tags/v1.2.4:refs/tags/v1.2.4',
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

      // Retry with the command the error gives, once the remote accepts the tag.
      unlinkSync(path.join(repository.originPath, 'hooks', 'update'))
      git(
        repository.workPath,
        'push',
        '--quiet',
        '--atomic',
        '--no-follow-tags',
        'origin',
        'refs/heads/main:refs/heads/main',
        'refs/tags/v1.2.4:refs/tags/v1.2.4'
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

describe('release brief', () => {
  it(
    'lists the commits and the files that changed since the last release, then the guidelines',
    () => {
      const repository = createRepository()
      // Signed commits, and the settings that print the signature of each one in `git log`, in
      // another encoding than UTF-8: the commits are listed as they are all the same.
      const keyPath = path.join(repository.rootPath, 'signing-key')
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
        ['i18n.logOutputEncoding', 'ISO-8859-1'],
      ]) {
        git(repository.workPath, 'config', name, value)
      }
      mkdirSync(path.join(repository.workPath, 'src', 'build-scripts'), { recursive: true })
      const sourceHash = commitFile(repository, 'src/thing.js', 'docs: reword a thing é')
      const toolHash = commitFile(repository, 'src/build-scripts/tool.js', 'fix: build faster')
      const featureHash = commitFile(repository, 'feature.txt', 'feat: add a thing')
      // A merge commit, which is not listed: the commits it merges are.
      git(repository.workPath, 'checkout', '--quiet', '-b', 'fix')
      const fixHash = commitFile(repository, 'index.js', 'module.exports = 2')
      git(repository.workPath, 'checkout', '--quiet', 'main')
      git(repository.workPath, 'merge', '--quiet', '--no-ff', '--message', 'Merge the fix', 'fix')
      const stateBefore = getState(repository)

      const report = briefIn(repository)

      expect(report).toContain('# Release brief: scratch, currently at 1.2.3\n')
      // The commits that change the source of the package, whatever their type says, then
      // the others, among them the one that only changes a build script.
      expect(report).toContain(
        `\n## Commits since v1.2.3 that change the source of the package (1)\n\n- ${sourceHash.slice(0, 7)} docs: reword a thing é\n\nWhat they changed, all together: \`git diff v1.2.3 -- 'src' ':(exclude)src/build-scripts'\`.`
      )
      const otherCommits = report.slice(report.indexOf('\n## Other commits since v1.2.3 (3)\n'))

      expect(otherCommits).toContain(`\n- ${toolHash.slice(0, 7)} fix: build faster\n`)
      expect(otherCommits).toContain(`\n- ${featureHash.slice(0, 7)} feat: add a thing\n`)
      expect(otherCommits).toContain(`\n- ${fixHash.slice(0, 7)} module.exports = 2\n`)
      expect(otherCommits).not.toContain(sourceHash.slice(0, 7))
      expect(report).not.toContain('Merge the fix')
      // The files of the package, against the stand-in for the published one.
      expect(report).toContain(
        `\n## Files of the package that differ from ${publishedPackagePath}\n`
      )
      expect(report).toContain('\n- changed  index.js\n')
      expect(report).toContain('\n- changed  package.json (repository)\n')
      expect(report).toContain('\n- added    feature.txt\n')
      expect(report).not.toContain('node_modules')
      // Both packages are kept where the brief says, to look at a difference.
      const keptPath =
        /\nBoth packages are in (?<path>\S+) \(a temporary directory\)/.exec(report)?.groups
          ?.path ?? ''

      // It is in the temporary directory, which for these tests is their own.
      expect(path.dirname(keptPath)).toBe(TEMPORARY_ROOT)

      expect(report).toContain(
        `\`diff -u --strip-trailing-cr ${keptPath}/published/<file> ${keptPath}/current/<file>\``
      )
      expect(readFileSync(path.join(keptPath, 'published', 'index.js'), 'utf8')).toBe(
        'module.exports = 1\n'
      )
      expect(readFileSync(path.join(keptPath, 'current', 'index.js'), 'utf8')).toBe(
        'module.exports = 2'
      )
      // The guidelines come last.
      expect(
        report.endsWith(
          `\n## Guidelines (docs/release-notes-guidelines.md)\n\n${GUIDELINES.trimEnd()}`
        )
      ).toBe(true)
      expect(getState(repository)).toStrictEqual(stateBefore)
    },
    COMMAND_TIMEOUT
  )

  it(
    'says that there is nothing to release when the package is the published one',
    () => {
      const repository = createRepository()
      const publishedPackageSpec = packPackage(repository.workPath, repository.rootPath)
      const report = briefIn(repository, { publishedPackageSpec })

      expect(report).toContain(
        '\n## Commits since v1.2.3 that change the source of the package (0)\n\nNone.\n'
      )
      expect(report).toContain('\n## Other commits since v1.2.3 (0)\n\nNone.\n')
      expect(report).toContain(
        'None: the package is the same as the published one. There is nothing to release, and `npm run release` would refuse to.'
      )
      expect(report).not.toContain('- changed')
    },
    COMMAND_TIMEOUT
  )

  it(
    'warns about uncommitted changes, and works when npm was asked for a dry run',
    () => {
      const repository = createRepository()
      commitFile(repository, 'feature.txt', `feat: add${String.fromCodePoint(0x1b)}[31m a thing`)
      writeFileSync(path.join(repository.workPath, 'untracked.js'), '')
      // `npm run release brief --dry-run`: npm keeps the option, and passes it on to the
      // `npm pack` the brief runs, which must still write its archive.
      const report = briefIn(repository, {
        environment: { ...ENVIRONMENT, npm_config_dry_run: 'true' },
      })

      expect(report).toContain(
        'The working tree has uncommitted changes. The package below is built from the working tree, not from the last commit, and a release would refuse to start:\n?? untracked.js'
      )
      expect(report).toContain('\n- added    untracked.js\n')
      // The escape character of the subject is not printed.
      expect(report).toContain(' feat: add [31m a thing\n')
    },
    COMMAND_TIMEOUT
  )

  it(
    'says what it could not look at',
    () => {
      const repository = createRepository()
      git(repository.workPath, 'tag', '--delete', 'v1.2.3')
      const publishedPackageSpec = path.join(repository.rootPath, 'missing.tgz')
      const report = briefIn(repository, { publishedPackageSpec })

      expect(report).toContain(
        'The tag of the current version (v1.2.3) does not exist locally (try `git fetch --tags`), so the commits made since cannot be listed.'
      )
      expect(report).not.toContain('commits since')
      expect(report).toContain(
        `${publishedPackageSpec} could not be fetched, so the package was not compared with it (\`npm pack `
      )
      expect(report).toContain('## Guidelines (docs/release-notes-guidelines.md)')
    },
    COMMAND_TIMEOUT
  )

  it(
    'fails when the package cannot be built, or when there are no guidelines',
    () => {
      expect(() =>
        briefIn(createRepository('node --version', 'node --eval "process.exit(1)"'))
      ).toThrow('`npm run build-artifacts` failed')

      const repository = createRepository()
      unlinkSync(path.join(repository.workPath, 'docs', 'release-notes-guidelines.md'))

      expect(() => briefIn(repository)).toThrow('release-notes-guidelines.md')
    },
    COMMAND_TIMEOUT
  )
})

/**
 * Run the release command (`release/cli.ts`, what `npm run release` runs) in a scratch
 * repository.
 *
 * @param repository - The scratch repository.
 * @param commandArguments - What to pass to it (`patch`, `--confirm`, …).
 * @param input - What the command reads on its standard input (the release notes).
 * @param environment - Variables to add to the environment of the command.
 *
 * @returns The exit code of the command, and what it printed to each of its outputs.
 */
const runReleaseCommand = (
  repository: Repository,
  commandArguments: string[],
  input = '',
  environment: Record<string, string> = {}
): { status: number | null; output: string; errors: string } => {
  const result = spawnSync(
    path.resolve('node_modules/.bin/tsx'),
    [path.resolve('release/cli.ts'), ...commandArguments],
    { cwd: repository.workPath, env: { ...ENVIRONMENT, ...environment }, encoding: 'utf8', input }
  )
  return { status: result.status, output: result.stdout, errors: result.stderr }
}

describe('release command', () => {
  it(
    'reports a dry run of the notes it reads on its standard input, and succeeds',
    () => {
      const repository = createRepository()
      const stateBefore = getState(repository)
      const result = runReleaseCommand(repository, ['patch'], NOTES)

      expect(result.errors).toBe('')
      expect(result.status).toBe(0)
      expect(result.output).toMatch(
        /^📦 Releasing 1\.2\.3 → 1\.2\.4 \(dry run: nothing is changed\)\n[\s\S]+### Bug Fixes\n\n- Keep a `__proto__` key\.\n[\s\S]+To release: the same command with --confirm after the version\. The maintainer will then have to approve the version on npm\.\n$/
      )
      expect(getState(repository)).toStrictEqual(stateBefore)
    },
    COMMAND_TIMEOUT
  )

  it(
    'says so when npm kept --confirm for itself',
    () => {
      const repository = createRepository()
      const result = runReleaseCommand(repository, ['patch'], NOTES, { npm_config_confirm: 'true' })

      expect(result.status).toBe(0)
      expect(result.output).toMatch(
        /^⚠️ {2}npm kept --confirm for itself: write it after the `--` that separates the arguments of the script from those of npm\.\n📦 Releasing 1\.2\.3 → 1\.2\.4 \(dry run/
      )
    },
    COMMAND_TIMEOUT
  )

  it(
    'reports an error and fails',
    () => {
      const repository = createRepository()

      // No release notes.
      expect(runReleaseCommand(repository, ['patch'])).toStrictEqual({
        status: 1,
        output: '',
        errors: `🚨 no release notes were given on the standard input\n${USAGE}\n`,
      })
      // No argument.
      expect(runReleaseCommand(repository, [], NOTES)).toStrictEqual({
        status: 1,
        output: '',
        errors: `🚨 expected "brief" or exactly one version argument\n${USAGE}\n`,
      })
      // A version that cannot be released.
      expect(runReleaseCommand(repository, ['1.2.3', '--confirm'], NOTES)).toStrictEqual({
        status: 1,
        output: '',
        errors: '🚨 1.2.3 is not higher than the current version (1.2.3)\n',
      })
    },
    COMMAND_TIMEOUT
  )

  it(
    'gives up on release notes that never come, instead of waiting for them',
    async () => {
      const repository = createRepository()
      const start = performance.now()
      // The standard input is left open and nothing is ever written to it, as a tool that
      // runs commands may do.
      const child = spawn(
        path.resolve('node_modules/.bin/tsx'),
        [path.resolve('release/cli.ts'), 'patch'],
        { cwd: repository.workPath, env: ENVIRONMENT, stdio: ['pipe', 'ignore', 'pipe'] }
      )
      let errors = ''
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        errors += chunk
      })
      const status = await new Promise((resolve) => {
        child.on('close', resolve)
      })
      child.stdin.end()

      expect(status).toBe(1)
      expect(errors).toBe(`🚨 no release notes were given on the standard input\n${USAGE}\n`)
      // It waits three seconds for a first byte.
      expect(performance.now() - start).toBeGreaterThan(2500)
      expect(performance.now() - start).toBeLessThan(15_000)
    },
    COMMAND_TIMEOUT
  )

  it(
    'prints the brief',
    () => {
      const repository = createRepository()
      // A registry nothing answers at, so that the test does not depend on the real one: the
      // brief then says that it could not fetch the published package.
      const result = runReleaseCommand(repository, ['brief'], '', {
        npm_config_registry: 'http://127.0.0.1:9/',
        npm_config_fetch_retries: '0',
      })

      expect(result.errors).toBe('')
      expect(result.status).toBe(0)
      expect(result.output).toMatch(/^# Release brief: scratch, currently at 1\.2\.3\n/)
      expect(result.output).toContain(
        'scratch@1.2.3 could not be fetched, so the package was not compared with it'
      )
      expect(result.output.endsWith(`${GUIDELINES.trimEnd()}\n`)).toBe(true)
    },
    COMMAND_TIMEOUT
  )
})

/** Rules for the tests of the notes validator, close to those of this repository. */
const RULES: NotesRules = {
  sections: ['BREAKING CHANGES', 'Features', 'Bug Fixes'],
  breakingSection: 'BREAKING CHANGES',
  featureSection: 'Features',
  forbidden: [
    { pattern: 'full changelog', flags: 'gi', reason: 'No changelog link.' },
    { pattern: String.raw`#\d+`, reason: 'No issue number.' },
    { pattern: 'abc1234', flags: 'y', inCode: true, reason: 'No hash.' },
  ],
  example: '### Bug Fixes\n\n- What was wrong, and what happens now.\n',
  majorExample: '### BREAKING CHANGES\n\n- What breaks.\n',
}

/** A patch release, for the tests of the notes validator. */
const PATCH_RELEASE: NotesContext = { version: '1.2.4', level: 'patch' }

/** A minor release, for the tests of the notes validator. */
const MINOR_RELEASE: NotesContext = { version: '1.3.0', level: 'minor' }

/** A major release, for the tests of the notes validator. */
const MAJOR_RELEASE: NotesContext = { version: '2.0.0', level: 'major' }

/** The headings the rules of the tests allow, as the messages of the validator list them. */
const HEADING_LIST = '"### BREAKING CHANGES", "### Features", "### Bug Fixes"'

/** How the messages of the validator about a heading end. */
const ALLOWED_HEADINGS = `The only headings the notes can have are ${HEADING_LIST}`

/** What the validator says of a heading that is not one of the sections. */
const WRONG_HEADING = `${ALLOWED_HEADINGS}, written exactly so.`

/** What the validator adds for a heading that is close to the one of a section. */
const HEADING_HINT = ' This one is written "### Bug Fixes".'

/** What the validator says of the first line that comes before every heading. */
const BEFORE_SECTIONS = `The notes start with one of the headings ${HEADING_LIST}. This line, and any other before the first heading, is not in a section: put what it says under one, as a list item ("- …").`

/** What the validator says of a line that is neither an item nor the rest of one. */
const NOT_AN_ITEM =
  'Everything in a section is a list item: start the line with "- ", or indent it to continue the item above.'

/** What the validator says of an item that starts with another marker than `- `. */
const OTHER_MARKER =
  'An item starts with "- ": the other list markers ("*", "+", "1.") are not used.'

/** What the validator says of a line Markdown would not read as part of the list. */
const UNDERLINE = `Markdown reads this line as a rule, or as making a heading of the line above it. Neither is used in the notes: remove it. The only headings are ${HEADING_LIST}.`

/** What the validator says of a code block that is not part of an item. */
const CODE_OUTSIDE_ITEM =
  'A code block belongs to a list item: indent it, with what it contains, under the item it illustrates.'

/** What the validator says of a code block without its closing line. */
const CODE_NEVER_CLOSED =
  'This code block is never closed: end it with a line that has nothing but the marks that open it, indented like this one.'

/** What the validator says of a line of a code block that Markdown reads as outside of it. */
const CODE_ESCAPED =
  'This line is in a code block, but indented less than the line that opens the block: Markdown ends the block here. Indent every line of the block at least as much as that line.'

/** What the validator says of a section without an item. */
const NO_ITEM = 'This section has no item. Give it at least one ("- …"), or leave the section out.'

/**
 * Find the rules some notes do not follow, in a form that is short to compare.
 *
 * @param notes - The release notes.
 * @param context - The release the notes are for.
 * @param rules - The rules the notes have to follow.
 *
 * @returns One string for each problem: the number of its line (`notes` for the notes as a
 *   whole), then what is wrong.
 */
const problemsOf = (notes: string, context = PATCH_RELEASE, rules = RULES): string[] =>
  findNotesProblems(notes, rules, context).map(
    (problem) => `${String(problem.lineNumber ?? 'notes')}: ${problem.message}`
  )

describe('what release notes can do to the changelog', () => {
  it('finds code blocks line by line, closed only by a fence like the one that opens them', () => {
    expect(
      readCodeBlockLines([
        'text',
        '```js',
        '~~~',
        '``` not a closing fence',
        '````',
        '  ~~~~ properties',
        '  ```',
        '  ~~~',
        '  ~~~~~',
        'a line with ```inline``` code',
        '```',
        'never closed',
      ])
    ).toStrictEqual([
      'outside',
      'opening',
      'content',
      'content',
      'closing',
      'opening',
      'content',
      'content',
      'closing',
      'outside',
      'opening',
      'content',
    ])
    expect(readCodeBlockLines(['```a```', '```'])).toStrictEqual(['outside', 'opening'])
    // A line that is indented less than the block it is in is not in it for Markdown, when
    // the block is in a list item; a fence that is indented much more does not close it.
    expect(readCodeBlockLines(['  ```', 'less', '', '      ```', '  ```'])).toStrictEqual([
      'opening',
      'escaped',
      'content',
      'content',
      'closing',
    ])
    // A tab indents as far as the next multiple of four columns.
    expect(readCodeBlockLines([' \t```', '    code', '  less', '\t```'])).toStrictEqual([
      'opening',
      'content',
      'escaped',
      'closing',
    ])
    // Other kinds of space do not indent: such a line is text, not the start of a block.
    expect(readCodeBlockLines([`${String.fromCodePoint(0xa0)}\`\`\``, 'text'])).toStrictEqual([
      'outside',
      'outside',
    ])
  })

  it('refuses notes that leave a code block open: the older entries would be in it', () => {
    expect(() =>
      normalizeReleaseNotes('### Bug Fixes\n\n- A fix:\n\n  ```properties\n  key = value\n')
    ).toThrow(
      '🚨 the release notes have a code block that is never closed (line 5:   ```properties): the rest of the changelog would become part of it. End the block with a line that has nothing but the marks that open it (``` or ~~~), indented like it.'
    )
    expect(() => normalizeReleaseNotes('- A fix:\n\n~~~\ncode\n```')).toThrow(
      'never closed (line 3: ~~~)'
    )
    expect(normalizeReleaseNotes('- A fix:\n\n  ```\n  code\n  ```\n')).toBe(
      '- A fix:\n\n  ```\n  code\n  ```'
    )
  })

  it('refuses notes with a code block that Markdown would end before its closing line', () => {
    // A line of the code that is indented less than the block, such as the content of a
    // template literal.
    expect(() =>
      normalizeReleaseNotes('- A fix:\n\n  ```js\n  parse(`\nkey = value\n`)\n  ```')
    ).toThrow(
      '🚨 the release notes have a code block (line 3:   ```js) with a line that is indented less than it (line 5: key = value): Markdown ends the block at that line, and the rest of the changelog could become part of another one. Indent every line of the block at least as much as the line that opens it.'
    )
    // A closing line that is not indented like the opening one does not close the block.
    expect(() => normalizeReleaseNotes('- A fix:\n\n  ```js\n  const a = 1\n```')).toThrow(
      '🚨 the release notes have a code block (line 3:   ```js) that its last line does not close (line 5: ```): that line is indented less than the one that opens the block, so Markdown reads it as the start of another block, which the rest of the changelog would become part of. Indent it like the line that opens the block.'
    )
  })

  it('refuses notes that open a code block on the line of an item', () => {
    expect(() => normalizeReleaseNotes('- ```js\n  a()\n  ```')).toThrow(
      '🚨 the release notes open a code block on the line of a list item (line 1: - ```js). Put the line that opens the block on a line of its own, indented under the item, like the rest of the block.'
    )
    // Three backticks around a few words are inline code.
    expect(normalizeReleaseNotes('- ```a``` is kept.')).toBe('- ```a``` is kept.')
  })

  it('refuses notes with HTML, which could take in or hide the older entries', () => {
    const message =
      'Markdown copies it as it is, and a tag or a comment that is left open would take in the rest of the changelog. Put it in backticks if it is code (a type like `Promise<string>` is read as a tag), or write it in Markdown.'

    expect(() => normalizeReleaseNotes('- <!-- note to self\n\n- Faster.')).toThrow(
      `🚨 the release notes have HTML (line 1: - <!-- note to self): ${message}`
    )
    for (const notes of [
      'Fixed.\n\n<pre>',
      '- x\n\n<details>\n\n- y',
      '- Returns a Promise<string> now.',
      '- A line<br>and another.',
      // A line that only looks like the content of a code block: these spaces do not indent.
      `- x\n\n${String.fromCodePoint(0xa0)}\`\`\`\n<pre>\n${String.fromCodePoint(0xa0)}\`\`\``,
    ]) {
      expect(() => normalizeReleaseNotes(notes)).toThrow('🚨 the release notes have HTML (line ')
    }

    // HTML that is code, and a link between angle brackets.
    const notes =
      '- `<pre>` and `Promise<string>` are code, <https://example.com> is a link:\n\n  ```html\n  <!--\n  ```'

    expect(normalizeReleaseNotes(notes)).toBe(notes)
  })

  it('refuses an entry heading in the notes, however it is written', () => {
    for (const heading of [
      ' ## [9.9.9](https://x/compare/a...b)',
      '##\t[9.9.9](https://x/compare/a...b)',
      '[9.9.9](https://x/compare/a...b)\n---',
    ]) {
      expect(() => normalizeReleaseNotes(`- An item.\n\n${heading}\n\n- Another.`)).toThrow(
        `🚨 the release notes have a heading in the form of a changelog entry heading (line 3: ${heading.split('\n', 1)[0]})`
      )
    }
  })

  it('refuses notes that change how the older entries are read', () => {
    const olderEntry = `## [1.2.3](${REPOSITORY_URL}/compare/v1.2.2...v1.2.3) (2026-01-01)\n\n- Old [thing].\n`
    const previousChangelog = `# Changelog\n\n${olderEntry}`
    const message =
      '🚨 with these release notes, the older entries of CHANGELOG.md would not be read as they are now: the notes leave something open that takes them in, or change what they mean (a code block that is not closed, a list or a quote that goes on, a link definition). Check that every code block of the notes is closed and indented under its item, and that the notes end with a complete item.'

    expect(() => {
      assertOlderEntriesKept(
        previousChangelog,
        insertChangelogEntry(previousChangelog, '1.2.4', renderEntry(NOTES))
      )
    }).not.toThrow()
    // A changelog without an entry has nothing to keep.
    expect(() => {
      assertOlderEntriesKept('# Changelog\n', `# Changelog\n\n${renderEntry(NOTES)}`)
    }).not.toThrow()
    for (const notes of [
      // A block that is left open, which the other checks would refuse first.
      '- A fix:\n\n```\ncode',
      // A definition that makes a link of words of the older entries.
      '- A fix.\n\n[thing]: https://example.com',
    ]) {
      const entry = `${ENTRY_HEADING}\n\n${notes}\n`

      expect(() => {
        assertOlderEntriesKept(
          previousChangelog,
          insertChangelogEntry(previousChangelog, '1.2.4', entry)
        )
      }).toThrow(message)
    }
  })

  it('refuses a changelog whose older entries are not what they were', () => {
    const olderEntry = `## [1.2.3](${REPOSITORY_URL}/compare/v1.2.2...v1.2.3) (2026-01-01)\n\n- Old.\n`
    const previousChangelog = `# Changelog\n\n${olderEntry}`
    const changelog = `# Changelog\n\n${ENTRY_HEADING}\n\n- New.\n\n${olderEntry}`

    expect(() => {
      assertChangelogEntryAdded(previousChangelog, changelog, '1.2.4')
    }).not.toThrow()
    // What prettier does of a code block the notes left open: it closes it after everything.
    expect(() => {
      assertChangelogEntryAdded(previousChangelog, `${changelog}\n\`\`\`\n`, '1.2.4')
    }).toThrow(
      '🚨 CHANGELOG.md would not keep its older entries as they were, once formatted. Either the file was not formatted with prettier before the release, or the release notes leave something open that takes the older entries in (a code block, a list)'
    )
    expect(() => {
      assertChangelogEntryAdded(previousChangelog, changelog.replace('- Old.', '  - Old.'), '1.2.4')
    }).toThrow('would not keep its older entries as they were')
  })
})

describe('release notes rules', () => {
  it('accept notes in the expected form', () => {
    const notes = [
      '### Features',
      '',
      '- **Add a thing.** It does this.',
      '  A second line of the same item.',
      '',
      '  ```properties',
      '  # a comment that looks like a heading, and issue #12 in code',
      '  ```',
      '',
      '      # more code, indented under the item',
      '',
      '  - A nested item.',
      '',
      '### Bug Fixes ###',
      '',
      '- Fix `Properties#toObject` (the `#1` here is code, and so is ``#2 ` x``).',
      '- Another fix.',
      '-\tA fix whose item starts with a tab.',
      '- TODO comments are kept, and so are … marks.',
    ].join('\n')

    expect(problemsOf(notes, MINOR_RELEASE)).toStrictEqual([])
    expect(
      problemsOf(`### BREAKING CHANGES\n\n- It breaks.\n\n${notes}`, MAJOR_RELEASE)
    ).toStrictEqual([])
    // Spaces after the title do not make it another title.
    expect(problemsOf('### Bug Fixes  \n\n- An item.')).toStrictEqual([])
  })

  it('refuse a heading that is not exactly one of the sections, once', () => {
    for (const heading of ['### Fixes', '# Notes', '###']) {
      // The items under the heading are not reported for being under it.
      expect(findNotesProblems(`${heading}\n\n- One.\n- Two.`, RULES, PATCH_RELEASE)).toStrictEqual(
        [{ lineNumber: 1, line: heading, message: WRONG_HEADING }]
      )
    }
    // A heading that only differs from the one of a section by its marker, its case or what
    // it ends with is told which one it is.
    for (const heading of ['## Bug Fixes', '#### Bug Fixes', '### bug fixes', '### Bug Fixes:']) {
      expect(problemsOf(`${heading}\n\n- One.\n- Two.`)).toStrictEqual([
        `1: ${WRONG_HEADING}${HEADING_HINT}`,
      ])
    }

    expect(problemsOf('###Bug Fixes\n\n- One.\n- Two.')).toStrictEqual([
      `1: A heading needs a space after its "#" marks. ${ALLOWED_HEADINGS}.${HEADING_HINT}`,
    ])
    expect(problemsOf('### Bug Fixes\n\n- One.\n  # Two')).toStrictEqual([
      `4: Markdown reads this line as a heading, and a heading starts at the beginning of its line. ${ALLOWED_HEADINGS}.`,
    ])
    // A heading made by the line under it is reported once, for both lines.
    expect(problemsOf('Bug Fixes\n---------\n\n- One.\n\nOther\n=====\n\n- Two.')).toStrictEqual([
      `1: With the line under it, Markdown reads this line as a heading. A heading is written on one line, with "###" before its title. ${ALLOWED_HEADINGS}.${HEADING_HINT}`,
      `6: With the line under it, Markdown reads this line as a heading. A heading is written on one line, with "###" before its title. ${ALLOWED_HEADINGS}.`,
    ])
  })

  it('refuse sections that are out of order or repeated', () => {
    const message = `The sections go in this order: ${HEADING_LIST}.`

    expect(
      findNotesProblems('### Bug Fixes\n\n- One.\n\n### Features\n\n- Two.', RULES, MINOR_RELEASE)
    ).toStrictEqual([{ lineNumber: 5, line: '### Features', message }])
    expect(
      problemsOf('### Features\n\n- One.\n\n### Features\n\n- Two.', MINOR_RELEASE)
    ).toStrictEqual([
      '5: The notes already have this section, on line 1: put all its items under one heading.',
    ])
  })

  it('refuse text that is not in a section, once, and what is not a list item', () => {
    expect(
      problemsOf(
        [
          'Some fixes.',
          'More of them.',
          '',
          '### Bug Fixes',
          '',
          'A paragraph.',
          '',
          '- An item.',
          '1. Numbered.',
          '* A star.',
          '+ A plus.',
          '===',
          '---',
        ].join('\n')
      )
    ).toStrictEqual([
      `1: ${BEFORE_SECTIONS}`,
      `6: ${NOT_AN_ITEM}`,
      `9: ${OTHER_MARKER}`,
      `10: ${OTHER_MARKER}`,
      `11: ${OTHER_MARKER}`,
      `12: ${UNDERLINE}`,
      `13: ${UNDERLINE}`,
    ])
  })

  it('do not call a section empty when its items only have to be corrected', () => {
    expect(problemsOf('### Bug Fixes\n\n* One.\n* Two.')).toStrictEqual([
      `3: ${OTHER_MARKER}`,
      `4: ${OTHER_MARKER}`,
    ])
    expect(problemsOf('### Bug Fixes\n\n    - Indented.')).toStrictEqual([
      '3: This line is indented, but no item above it is there to continue. An item starts at the beginning of its line, with "- ".',
    ])
  })

  it('refuse a section without an item, and an item that says nothing of the release', () => {
    const placeholder = 'This item is a placeholder. Write what changed for the user, or remove it.'
    const empty = 'This item is empty. Write what changed for the user, or remove it.'
    const copied =
      'This item is the one of the example, which only shows the form. Write what changed for the user, or remove it.'

    expect(
      problemsOf(
        '### Features\n\n### Bug Fixes\n\n- …\n- TODO.\n- ...\n- \n-\n- TODO: describe the fix\n- **…**',
        MINOR_RELEASE
      )
    ).toStrictEqual([
      `1: ${NO_ITEM}`,
      `5: ${placeholder}`,
      `6: ${placeholder}`,
      `7: ${placeholder}`,
      `8: ${empty}`,
      `9: ${empty}`,
      `10: ${placeholder}`,
      `11: ${placeholder}`,
    ])
    // The last section can be the empty one.
    expect(problemsOf('### Features\n\n- One.\n\n### Bug Fixes\n', MINOR_RELEASE)).toStrictEqual([
      `5: ${NO_ITEM}`,
    ])
    // The examples of the rules show the form: their items are not notes.
    expect(RULES.example.startsWith('### Bug Fixes\n\n- What was wrong')).toBe(true)
    expect(problemsOf(RULES.example)).toStrictEqual([`3: ${copied}`])
    expect(problemsOf(RULES.majorExample ?? '', MAJOR_RELEASE)).toStrictEqual([`3: ${copied}`])
  })

  it('refuse a code block that is not part of an item, or that is not closed where it seems', () => {
    expect(problemsOf('### Bug Fixes\n\n- An item:\n\n```\ncode #12\n```')).toStrictEqual([
      `5: ${CODE_OUTSIDE_ITEM}`,
    ])
    expect(problemsOf('### Bug Fixes\n\n  ```\n  code\n  ```\n- An item.')).toStrictEqual([
      `3: ${CODE_OUTSIDE_ITEM}`,
    ])
    expect(problemsOf('```\ncode\n```\n\n### Bug Fixes\n\n- An item.')).toStrictEqual([
      `1: ${CODE_OUTSIDE_ITEM}`,
    ])
    // What follows a block that is never closed is code, and is not checked: the block is
    // what has to be corrected.
    expect(
      problemsOf('### Bug Fixes\n\n- An item:\n\n  ```\n  code\n\n### Other\n\n- Fix #12.')
    ).toStrictEqual([`5: ${CODE_NEVER_CLOSED}`])
    // A closing line that is not indented like the opening one does not close the block, and
    // a line of the code that is indented less than the block ends it for Markdown.
    expect(problemsOf('### Bug Fixes\n\n- An item:\n\n  ```js\n  const a = 1\n```')).toStrictEqual([
      `5: ${CODE_NEVER_CLOSED}`,
    ])
    expect(
      problemsOf('### Bug Fixes\n\n- An item:\n\n  ```js\n  parse(`\nkey = value\n`)\n  ```')
    ).toStrictEqual([`7: ${CODE_ESCAPED}`, `8: ${CODE_ESCAPED}`])
    // Another kind of fence, or a shorter one, does not close a block: what follows the
    // block is checked.
    expect(
      problemsOf(
        '### Bug Fixes\n\n- An item:\n\n  ````md\n  ```\n  ~~~\n  Fix #12\n  ````\n- Fix #13.'
      )
    ).toStrictEqual(['10: No issue number. Here: "#13".'])
    // Three backticks around a few words are inline code, not a block.
    expect(problemsOf('### Bug Fixes\n\n- An item\n  ```a #11``` and #12.')).toStrictEqual([
      '4: No issue number. Here: "#12".',
    ])
  })

  it('refuse what the repository forbids, on every line that has it, before anything else', () => {
    expect(
      problemsOf(
        [
          '### Bug Fixes',
          '',
          '- Fix #12, see the Full Changelog.',
          '- See the full changelog and `#13`.',
          '- In `abc1234`, and ``#14 ` x``.',
          'Full changelog: x',
        ].join('\n')
      )
    ).toStrictEqual([
      // With what was found on the line.
      '3: No changelog link. Here: "Full Changelog".',
      '3: No issue number. Here: "#12".',
      '4: No changelog link. Here: "full changelog".',
      // Only what the rules say so is looked for in inline code.
      '5: No hash. Here: "abc1234".',
      // What says that the line has to go comes before what says how to write it.
      '6: No changelog link. Here: "Full changelog".',
      `6: ${NOT_AN_ITEM}`,
    ])
  })

  it('tie the sections to the kind of release', () => {
    expect(problemsOf('### Features\n\n- One.', MAJOR_RELEASE)).toStrictEqual([
      'notes: 2.0.0 is a new major version: its notes need a "### BREAKING CHANGES" section saying what breaks.',
    ])
    for (const context of [PATCH_RELEASE, MINOR_RELEASE]) {
      expect(findNotesProblems('### BREAKING CHANGES\n\n- One.', RULES, context)).toStrictEqual([
        {
          lineNumber: 1,
          line: '### BREAKING CHANGES',
          message: `${context.version} is not a new major version, so its notes cannot have this section. A change that breaks existing code needs a major version.`,
        },
      ])
    }

    expect(problemsOf('### Features\n\n- One.')).toStrictEqual([
      '1: 1.2.4 is a patch version, so its notes cannot have this section. Something new for users needs a minor version.',
    ])
    expect(problemsOf('### Features\n\n- One.', MINOR_RELEASE)).toStrictEqual([])

    // Without a kind of release, and with rules that have no such sections, nothing is tied.
    const everySection = '### BREAKING CHANGES\n\n- One.\n\n### Features\n\n- Two.'
    const plainRules = { sections: RULES.sections, forbidden: [], example: RULES.example }

    expect(problemsOf(everySection, { version: '', level: undefined })).toStrictEqual([])
    expect(problemsOf(everySection, PATCH_RELEASE, plainRules)).toStrictEqual([])
    expect(problemsOf('### Features\n\n- One.', MAJOR_RELEASE, plainRules)).toStrictEqual([])
  })

  it('know the kind of a release from the version before it', () => {
    expect(getReleaseLevel('5.0.7', '6.0.0')).toBe('major')
    // A version given in full can change more than one number.
    expect(getReleaseLevel('5.0.7', '6.1.0')).toBe('major')
    expect(getReleaseLevel('5.0.7', '5.1.0')).toBe('minor')
    expect(getReleaseLevel('5.0.7', '5.1.2')).toBe('minor')
    expect(getReleaseLevel('5.1.9', '5.1.10')).toBe('patch')
    // Versions before 1.0.0 are read in the same way.
    expect(getReleaseLevel('0.5.0', '0.6.0')).toBe('minor')
  })

  it('are explained once for each line, with the reasons and notes in the expected form', () => {
    const notes = `Fixes.\n\n### Bug Fixes\n\nFull changelog: ${'x'.repeat(200)}`

    expect(
      describeNotesProblems(findNotesProblems(notes, RULES, PATCH_RELEASE), RULES, PATCH_RELEASE)
    ).toBe(
      [
        '🚨 the release notes do not follow the rules of release.config.json (2 places to correct):',
        '',
        '   1. line 1: Fixes.',
        `      ${BEFORE_SECTIONS}`,
        // A long line is not quoted whole.
        `   2. line 5: Full changelog: ${'x'.repeat(104)}…`,
        '      No changelog link. Here: "Full changelog".',
        `      ${NOT_AN_ITEM}`,
        '',
        '   Notes in the expected form:',
        '',
        '      ### Bug Fixes',
        '',
        '      - What was wrong, and what happens now.',
      ].join('\n')
    )
    // A major release is shown notes of a major release.
    expect(
      describeNotesProblems(
        findNotesProblems('### Features\n\n- One.', RULES, MAJOR_RELEASE),
        RULES,
        MAJOR_RELEASE
      )
    ).toBe(
      [
        '🚨 the release notes do not follow the rules of release.config.json (1 place to correct):',
        '',
        '   1. the notes as a whole',
        '      2.0.0 is a new major version: its notes need a "### BREAKING CHANGES" section saying what breaks.',
        '',
        '   Notes in the expected form:',
        '',
        '      ### BREAKING CHANGES',
        '',
        '      - What breaks.',
      ].join('\n')
    )
  })
})

/**
 * Create a directory with a `release.config.json`.
 *
 * @param config - What the file says: text to write as it is, anything else as JSON, or
 *   `undefined` for a directory without the file.
 *
 * @returns The path of the directory.
 */
const createConfiguredDirectory = (config: unknown): string => {
  const directoryPath = mkdtempSync(path.join(tmpdir(), 'properties-file-config-'))
  if (config !== undefined) {
    writeFileSync(
      path.join(directoryPath, 'release.config.json'),
      typeof config === 'string' ? config : JSON.stringify(config)
    )
  }
  return directoryPath
}

/**
 * Read the rules this repository gives to its own release notes.
 *
 * @returns What its `release.config.json` says of the notes.
 *
 * @throws If this repository has none, which the tests below do not expect.
 */
const readRepositoryRules = (): NotesRules => {
  const rules = readNotesRules('.')
  if (rules === undefined) {
    throw new Error('this repository is expected to have rules for its release notes')
  }
  return rules
}

/** Notes that follow the rules of {@link VALID_CONFIG_NOTES}. */
const VALID_CONFIG_EXAMPLE = '### A\n\n- x'

/** The least a `release.config.json` can say of the notes. */
const VALID_CONFIG_NOTES = { sections: ['A', 'B'], example: VALID_CONFIG_EXAMPLE }

/**
 * Give the error of a `release.config.json` whose example is not text.
 *
 * @param name - Which of the examples of the file is not.
 *
 * @returns What the error says.
 */
const exampleError = (name: string): string =>
  `🚨 release.config.json: "notes.${name}" must be release notes that follow the rules, as text: they are shown when notes do not follow them`

describe('release notes rules of a repository', () => {
  it('are read from its release.config.json', () => {
    expect(readNotesRules(createConfiguredDirectory({ notes: RULES }))).toStrictEqual(RULES)

    // A file some editors start with a mark that is not part of its text, and an example
    // with the line endings of Windows.
    const markedConfig = `${String.fromCodePoint(0xfe_ff)}${JSON.stringify({
      notes: { ...VALID_CONFIG_NOTES, example: '### A\r\n\r\n- x' },
    })}`

    expect(readNotesRules(createConfiguredDirectory(markedConfig))).toStrictEqual({
      sections: ['A', 'B'],
      breakingSection: undefined,
      featureSection: undefined,
      forbidden: [],
      example: VALID_CONFIG_EXAMPLE,
      majorExample: undefined,
    })
  })

  it('are none when the repository has no such file, or a file without notes', () => {
    expect(readNotesRules(createConfiguredDirectory(undefined))).toBeUndefined()
    expect(readNotesRules(createConfiguredDirectory({}))).toBeUndefined()
  })

  it('must have the expected form, and the error names what does not', () => {
    const sectionsError =
      '🚨 release.config.json: "notes.sections" must list the titles of the sections: at least one, all different, none empty, with spaces around it, or with a "#" at one end'
    const forbiddenError =
      '🚨 release.config.json: pattern 2 of "notes.forbidden" must be { "pattern", "reason", "flags"?, "inCode"? }, where the pattern and the reason are text that is not empty, the flags are text and inCode is true or false'
    const validPattern = { pattern: 'a', reason: 'b' }
    const cases: [config: unknown, error: string][] = [
      ['{ "notes": ', '🚨 release.config.json: the file is not valid JSON ('],
      [
        [VALID_CONFIG_NOTES],
        '🚨 release.config.json: the file must be a JSON object, with the rules under "notes"',
      ],
      ['null', '🚨 release.config.json: the file must be a JSON object'],
      // A misspelled key does not turn the rules off without a word.
      [
        { note: VALID_CONFIG_NOTES },
        '🚨 release.config.json: "note" is not a key of the file: the only one is "notes"',
      ],
      [{ notes: 'text' }, '🚨 release.config.json: "notes" must be an object'],
      [{ notes: [] }, '🚨 release.config.json: "notes" must be an object'],
      [
        { notes: { ...VALID_CONFIG_NOTES, forbiden: [] } },
        '🚨 release.config.json: "notes.forbiden" is not a key of the notes: these are "sections", "breakingSection", "featureSection", "forbidden", "example", "majorExample"',
      ],
      [{ notes: { example: VALID_CONFIG_EXAMPLE } }, sectionsError],
      ...[[], ['A', 1], ['A', 'A'], ['A '], [''], ['A #']].map((sections): [unknown, string] => [
        { notes: { ...VALID_CONFIG_NOTES, sections } },
        sectionsError,
      ]),
      [
        { notes: { ...VALID_CONFIG_NOTES, breakingSection: 'C' } },
        '🚨 release.config.json: "notes.breakingSection" is "C", which is not one of the titles of "notes.sections" ("A", "B")',
      ],
      [
        { notes: { ...VALID_CONFIG_NOTES, featureSection: 1 } },
        '🚨 release.config.json: "notes.featureSection" is 1, which is not one of the titles of "notes.sections" ("A", "B")',
      ],
      ...['x', null].map((forbidden): [unknown, string] => [
        { notes: { ...VALID_CONFIG_NOTES, forbidden } },
        '🚨 release.config.json: "notes.forbidden" must be a list of { "pattern", "reason", "flags"?, "inCode"? }',
      ]),
      ...[
        'x',
        { pattern: 'x' },
        { pattern: 'x', reason: 'y', flags: 1 },
        { pattern: 'x', reason: 'y', inCode: 'yes' },
        // A pattern that is empty would refuse every line, and a reason that is empty would
        // not say why.
        { pattern: '', reason: 'y' },
        { pattern: 'x', reason: ' ' },
      ].map((forbidden): [unknown, string] => [
        { notes: { ...VALID_CONFIG_NOTES, forbidden: [validPattern, forbidden] } },
        forbiddenError,
      ]),
      [
        {
          notes: {
            ...VALID_CONFIG_NOTES,
            forbidden: [validPattern, { pattern: 'x', reasn: 'y' }],
          },
        },
        '🚨 release.config.json: pattern 2 of "notes.forbidden" has a key that is not known, "reasn": the keys are "pattern", "reason", "flags", "inCode"',
      ],
      [
        { notes: { ...VALID_CONFIG_NOTES, forbidden: [{ pattern: '(', reason: 'y' }] } },
        '🚨 release.config.json: pattern 1 of "notes.forbidden" is not a regular expression: "(" (',
      ],
      [
        {
          notes: { ...VALID_CONFIG_NOTES, forbidden: [{ pattern: 'x', flags: 'q', reason: 'y' }] },
        },
        '🚨 release.config.json: pattern 1 of "notes.forbidden" is not a regular expression: "x" with the flags "q" (',
      ],
      [
        { notes: { sections: ['A'] } },
        '🚨 release.config.json: "notes.example" is missing: release notes that follow the rules, shown when notes do not',
      ],
      [{ notes: { ...VALID_CONFIG_NOTES, example: 1 } }, exampleError('example')],
      [{ notes: { ...VALID_CONFIG_NOTES, example: ' ' } }, exampleError('example')],
      [{ notes: { ...VALID_CONFIG_NOTES, majorExample: '' } }, exampleError('majorExample')],
      // An example is what is shown when notes are refused: it has to be notes that are not,
      // for every release it is shown for.
      [
        { notes: { ...VALID_CONFIG_NOTES, example: '- x' } },
        '🚨 release.config.json: "notes.example" does not follow the rules of the same file as the notes of a patch release, which it is shown for (line 1: - x): The notes start with one of the headings "### A", "### B"',
      ],
      [
        { notes: { ...VALID_CONFIG_NOTES, featureSection: 'A' } },
        '🚨 release.config.json: "notes.example" does not follow the rules of the same file as the notes of a patch release, which it is shown for (line 1: ### A): It is a patch version',
      ],
      [
        { notes: { ...VALID_CONFIG_NOTES, breakingSection: 'A' } },
        '🚨 release.config.json: "notes.majorExample" is missing: with a "breakingSection", the notes of a major release need an example of their own, which has that section',
      ],
      [
        { notes: { ...VALID_CONFIG_NOTES, breakingSection: 'A', majorExample: '### A\n\n- y' } },
        '🚨 release.config.json: "notes.example" does not follow the rules of the same file as the notes of a patch release, which it is shown for (line 1: ### A): It is not a new major version',
      ],
      [
        {
          notes: {
            ...VALID_CONFIG_NOTES,
            breakingSection: 'B',
            majorExample: VALID_CONFIG_EXAMPLE,
          },
        },
        '🚨 release.config.json: "notes.majorExample" does not follow the rules of the same file as the notes of a major release, which it is shown for: It is a new major version',
      ],
    ]

    for (const [config, error] of cases) {
      expect(() => readNotesRules(createConfiguredDirectory(config))).toThrow(error)
    }
  })

  it('are, for this repository, rules that its examples and its guidelines follow', () => {
    // Reading the rules checks both examples of the file against them.
    const rules = readRepositoryRules()

    expect(rules.majorExample).toContain(`### ${rules.breakingSection ?? ''}\n`)

    // The guidelines name the same headings, in the same order: a difference shows the
    // sections that are missing or out of place.
    const guidelines = readFileSync('docs/release-notes-guidelines.md', 'utf8')
    const namedSections = rules.sections.filter((section) =>
      guidelines.includes(`\`### ${section}\``)
    )

    // With the file to update, for whoever changes the sections of release.config.json.
    expect({ 'headings named in docs/release-notes-guidelines.md': namedSections }).toStrictEqual({
      'headings named in docs/release-notes-guidelines.md': rules.sections,
    })
    expect(
      namedSections.toSorted(
        (first, second) =>
          guidelines.indexOf(`\`### ${first}\``) - guidelines.indexOf(`\`### ${second}\``)
      )
    ).toStrictEqual(rules.sections)

    // Their example of notes follows the rules.
    const exampleOpening = '```markdown\n'
    const exampleStart = guidelines.indexOf(exampleOpening) + exampleOpening.length
    const guidelinesExample = guidelines.slice(
      exampleStart,
      guidelines.indexOf('\n```', exampleStart)
    )

    expect(guidelinesExample).toContain('### ')
    expect(findNotesProblems(guidelinesExample, rules, PATCH_RELEASE)).toStrictEqual([])

    // An item of the examples of the file is not notes, however it is wrapped.
    const exampleItem = rules.example.slice(
      rules.example.indexOf('- '),
      rules.example.indexOf('\n\n### Performance')
    )
    const unwrappedNotes = `### Bug Fixes\n\n${exampleItem.replaceAll(/\s+/g, ' ')}`
    const copyProblems = findNotesProblems(unwrappedNotes, rules, PATCH_RELEASE)

    expect(exampleItem).toContain('\n')
    expect(copyProblems.map((problem) => problem.message)).toStrictEqual([
      'This item is the one of the example, which only shows the form. Write what changed for the user, or remove it.',
    ])
  })

  it('forbid, for this repository, what points at its history and not what looks like it', () => {
    const rules = readRepositoryRules()
    const hash = 'This looks like a commit hash.'
    const number = 'This looks like a pull request or issue number.'
    const link = 'This links to the history of the repository'
    const changelog = 'Leave out any pointer to the full changelog'
    const mention = 'This reads as a mention of a GitHub user'
    const refused: [text: string, reason: string][] = [
      ['Fixed in 1025b79.', hash],
      ['Fixed in `1025b79`.', hash],
      ['Fixed in 1025b79a3c0d4e5f60718293a4b5c6d7e8f90123.', hash],
      ['Fixed #123.', number],
      ['Fixed (#5).', number],
      ['Fixes #5.', number],
      ['See owner/repo#12.', number],
      ['See GH-12 and more.', number],
      ['Reported in PR 34.', number],
      ['See issue 7.', number],
      ['See https://github.com/properties-file/properties-file/pull/245 for more.', link],
      ['See https://github.com/properties-file/properties-file/issues/9.', link],
      ['See the Full Changelog.', changelog],
      ['Thanks to @someone for the report.', mention],
    ]

    for (const [text, reason] of refused) {
      const problems = findNotesProblems(`### Bug Fixes\n\n- ${text}`, rules, PATCH_RELEASE)

      expect([
        text,
        ...problems.map((problem) => problem.message.slice(0, reason.length)),
      ]).toStrictEqual([text, reason])
    }

    const accepted = [
      'Now rank #1 in speed, and step #2 of 3 is gone.',
      'Line 42 of long files is read in C#12 projects.',
      'The colour `#aabbcc80` and the colour #abcdef1 are kept.',
      'An identifier like 123e4567-e89b-12d3-a456-426614174000 is kept.',
      'The entity &#39; is kept, and so is 0xdeadbeef1.',
      '`Properties#toObject` is smaller: 970 B → 954 B (min+gzip), since 5.0.8.',
      'See https://github.com/properties-file/properties-file#readme.',
      'The `@types/node` package and @types/node are not needed, write to someone@example.com.',
    ]

    for (const text of accepted) {
      expect([
        text,
        ...findNotesProblems(`### Bug Fixes\n\n- ${text}`, rules, PATCH_RELEASE),
      ]).toStrictEqual([text])
    }
  })

  it(
    'are checked by a release, dry run or not, before the checkout is looked at',
    () => {
      const repository = createRepository()
      writeFileSync(
        path.join(repository.workPath, 'release.config.json'),
        JSON.stringify({ notes: RULES })
      )
      git(repository.workPath, 'add', 'release.config.json')
      git(repository.workPath, 'commit', '--quiet', '--message', 'build: add rules for the notes')
      pushMain(repository)
      const stateBefore = getState(repository)

      for (const isDryRun of [false, true]) {
        expect(() =>
          releaseIn(repository, 'patch', { isDryRun, notes: '### Fixes\n\n- Fix #12.' })
        ).toThrow(
          [
            '🚨 the release notes do not follow the rules of release.config.json (2 places to correct):',
            '',
            '   1. line 1: ### Fixes',
            `      ${WRONG_HEADING}`,
            '   2. line 3: - Fix #12.',
            '      No issue number. Here: "#12".',
            '',
            '   Notes in the expected form:',
            '',
            '      ### Bug Fixes',
            '',
            '      - What was wrong, and what happens now.',
            '',
            '   What the notes should say is in docs/release-notes-guidelines.md.',
          ].join('\n')
        )
        // A major version needs to say what it breaks, and is shown how.
        expect(() => releaseIn(repository, 'major', { isDryRun })).toThrow(
          '      2.0.0 is a new major version: its notes need a "### BREAKING CHANGES" section saying what breaks.\n\n   Notes in the expected form:\n\n      ### BREAKING CHANGES\n'
        )
        // So does a version given in full that changes the major number with others.
        expect(() => releaseIn(repository, '2.1.0', { isDryRun })).toThrow(
          '2.1.0 is a new major version'
        )
        // Another version cannot break anything, and a patch cannot add anything.
        expect(() =>
          releaseIn(repository, 'minor', { isDryRun, notes: '### BREAKING CHANGES\n\n- One.' })
        ).toThrow('1.3.0 is not a new major version')
        expect(() =>
          releaseIn(repository, 'patch', { isDryRun, notes: '### Features\n\n- One.' })
        ).toThrow('1.2.4 is a patch version')
        // Whatever the rules, notes cannot have HTML, or leave a code block open.
        expect(() =>
          releaseIn(repository, 'patch', {
            isDryRun,
            notes: '### Bug Fixes\n\n- A line<br>and one.',
          })
        ).toThrow('🚨 the release notes have HTML (line 3: - A line<br>and one.)')
        expect(() =>
          releaseIn(repository, 'patch', { isDryRun, notes: '### Bug Fixes\n\n- One:\n\n  ```' })
        ).toThrow('a code block that is never closed (line 5:   ```)')
      }

      expect(getState(repository)).toStrictEqual(stateBefore)
      // Notes that follow the rules are released.
      expect(releaseIn(repository, 'patch')).toBe('1.2.4')
    },
    COMMAND_TIMEOUT
  )
})
