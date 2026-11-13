/**
 * Unit tests for the legacy subpath resolution stub generator
 * (`src/build-scripts/generate-subpath-stubs.ts`).
 *
 * The generator deletes and writes directories at the package root, so every test runs it on a
 * scratch package in its own temporary directory: a `package.json` with `exports` and `files`,
 * plus the `dist/` files the `exports` targets point to. `src/build-scripts/**` is excluded from
 * coverage, so these tests are the only thing exercising the generator's error branches.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { generateSubpathStubs } from '../src/build-scripts/generate-subpath-stubs'

/** The `dist/` files a standard `exports` entry for a subpath points to. */
type EntryFiles = {
  /** The ESM declarations. */
  importTypes: string
  /** The ESM JavaScript. */
  importDefault: string
  /** The CommonJS declarations. */
  requireTypes: string
  /** The CommonJS JavaScript. */
  requireDefault: string
}

/**
 * Build the standard `{ import, require } × { types, default }` `exports` entry for a subpath
 * whose build output lives under `dist/{esm,cjs}/<outputPath>`.
 *
 * @param outputPath - The output path without extension (e.g. `editor/index`).
 *
 * @returns The entry's four `dist/` targets.
 */
const getEntryFiles = (outputPath: string): EntryFiles => ({
  importTypes: `./dist/esm/${outputPath}.d.ts`,
  importDefault: `./dist/esm/${outputPath}.js`,
  requireTypes: `./dist/cjs/${outputPath}.d.ts`,
  requireDefault: `./dist/cjs/${outputPath}.js`,
})

/**
 * Turn the targets of an entry into its `exports` value.
 *
 * @param entryFiles - The entry's four `dist/` targets.
 *
 * @returns The `exports` value for the entry.
 */
const toExportsEntry = (entryFiles: EntryFiles): Record<string, unknown> => ({
  import: { types: entryFiles.importTypes, default: entryFiles.importDefault },
  require: { types: entryFiles.requireTypes, default: entryFiles.requireDefault },
})

/** The stub the generator writes for the top-level `./editor` subpath of the scratch package. */
const EDITOR_STUB = {
  main: '../dist/cjs/editor/index.js',
  module: '../dist/esm/editor/index.js',
  types: '../dist/cjs/editor/index.d.ts',
}

/** The stub the generator writes for the nested `./bundler/webpack` subpath. */
const WEBPACK_STUB = {
  main: '../../dist/cjs/bundler/webpack.js',
  module: '../../dist/esm/bundler/webpack.js',
  types: '../../dist/cjs/bundler/webpack.d.ts',
}

/** Every scratch package created by the tests, removed in `afterAll`. */
const temporaryDirectories: string[] = []

/**
 * (Re)write the `package.json` of a scratch package.
 *
 * @param packageJsonPath - The path to the `package.json`.
 * @param exportsMap - The subpath → conditions map to write as `exports`.
 * @param files - The directories to write as `files` (what would be published).
 */
const writePackageJson = (
  packageJsonPath: string,
  exportsMap: Record<string, unknown>,
  files: string[]
): void => {
  writeFileSync(
    packageJsonPath,
    JSON.stringify({ name: 'scratch', exports: exportsMap, files }, undefined, 2)
  )
}

/**
 * Create a scratch package and write its `package.json`.
 *
 * @param exportsMap - The subpath → conditions map to write as `exports`.
 * @param files - The directories to write as `files` (what would be published).
 * @param outputFiles - The (empty) `dist/` files to create, package-root-relative (e.g.
 * `./dist/x.js`).
 *
 * @returns The path to the scratch package's `package.json`.
 */
const createPackage = (
  exportsMap: Record<string, unknown>,
  files: string[],
  outputFiles: string[]
): string => {
  const packageRootPath = mkdtempSync(path.join(tmpdir(), 'subpath-stubs-'))
  temporaryDirectories.push(packageRootPath)
  for (const outputFile of outputFiles) {
    const outputFilePath = path.join(packageRootPath, outputFile)
    mkdirSync(path.dirname(outputFilePath), { recursive: true })
    writeFileSync(outputFilePath, '')
  }
  const packageJsonPath = path.join(packageRootPath, 'package.json')
  writePackageJson(packageJsonPath, exportsMap, files)
  return packageJsonPath
}

/**
 * Create a scratch package exporting one top-level subpath (`./editor`) and one nested one
 * (`./bundler/webpack`), with every `dist/` file their targets point to.
 *
 * @returns The path to the scratch package's `package.json`.
 */
const createStandardPackage = (): string => {
  const editorFiles = getEntryFiles('editor/index')
  const webpackFiles = getEntryFiles('bundler/webpack')
  return createPackage(
    {
      '.': toExportsEntry(getEntryFiles('index')),
      './editor': toExportsEntry(editorFiles),
      './bundler/webpack': toExportsEntry(webpackFiles),
    },
    ['dist', 'editor', 'bundler'],
    [...Object.values(editorFiles), ...Object.values(webpackFiles)]
  )
}

/**
 * Create a scratch package exporting only `./editor`, with an arbitrary `exports` entry for
 * it. The standard `dist/` files exist, so only the entry's shape can make the generator fail.
 *
 * @param editorEntry - The `exports` value for `./editor`.
 *
 * @returns The path to the scratch package's `package.json`.
 */
const createEditorPackage = (editorEntry: unknown): string =>
  createPackage(
    { './editor': editorEntry },
    ['dist', 'editor'],
    Object.values(getEntryFiles('editor/index'))
  )

/**
 * Read a generated stub.
 *
 * @param packageJsonPath - The scratch package's `package.json`.
 * @param stubDirectory - The stub directory, relative to the package root.
 *
 * @returns The parsed stub `package.json`.
 */
const readStub = (packageJsonPath: string, stubDirectory: string): unknown => {
  const stubFilePath = path.join(path.dirname(packageJsonPath), stubDirectory, 'package.json')
  return JSON.parse(readFileSync(stubFilePath, 'utf8'))
}

/**
 * Generate the standard stubs, plant a foreign entry under `editor/`, and check that
 * regeneration refuses with every existing file still in place — including the `bundler/`
 * tree, which is deletable on its own but must survive the refusal.
 *
 * @param plant - Creates the foreign entry, given the `editor/` stub directory.
 * @param plantedPath - The planted entry's path, relative to `editor/`.
 */
const expectRefusal = (plant: (editorPath: string) => void, plantedPath: string): void => {
  const packageJsonPath = createStandardPackage()
  const packageRootPath = path.dirname(packageJsonPath)
  generateSubpathStubs(packageJsonPath)
  const editorPath = path.join(packageRootPath, 'editor')
  plant(editorPath)

  expect(() => {
    generateSubpathStubs(packageJsonPath)
  }).toThrow(`🚨 ${editorPath} contains files other than generated stubs, refusing to replace it`)
  expect(existsSync(path.join(editorPath, plantedPath))).toBe(true)
  expect(readStub(packageJsonPath, 'editor')).toStrictEqual(EDITOR_STUB)
  expect(readStub(packageJsonPath, 'bundler/webpack')).toStrictEqual(WEBPACK_STUB)
}

describe('legacy subpath resolution stubs (generate-subpath-stubs)', () => {
  beforeAll(() => {
    // The generator narrates every removal and write; keep the test output readable.
    jest.spyOn(console, 'log').mockReturnValue()
  })

  afterAll(() => {
    jest.restoreAllMocks()
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('writes a stub per subpath with paths relative to its own directory, skipping the root entry', () => {
    const packageJsonPath = createStandardPackage()
    const packageRootPath = path.dirname(packageJsonPath)
    generateSubpathStubs(packageJsonPath)

    expect(readStub(packageJsonPath, 'editor')).toStrictEqual(EDITOR_STUB)
    expect(readStub(packageJsonPath, 'bundler/webpack')).toStrictEqual(WEBPACK_STUB)
    // Only the subpath stubs: no stub for "." (served by the root package.json) and nothing
    // at the intermediate `bundler/` level.
    expect(existsSync(path.join(packageRootPath, 'bundler', 'package.json'))).toBe(false)
  })

  it('replaces previous stubs on regeneration and clears a stale nested stub', () => {
    const packageJsonPath = createStandardPackage()
    const packageRootPath = path.dirname(packageJsonPath)
    const rollupFiles = getEntryFiles('bundler/rollup')
    for (const outputFile of Object.values(rollupFiles)) {
      writeFileSync(path.join(packageRootPath, outputFile), '')
    }
    const editorFiles = getEntryFiles('editor/index')
    writePackageJson(
      packageJsonPath,
      {
        './editor': toExportsEntry(editorFiles),
        './bundler/webpack': toExportsEntry(getEntryFiles('bundler/webpack')),
        './bundler/rollup': toExportsEntry(rollupFiles),
      },
      ['dist', 'editor', 'bundler']
    )
    generateSubpathStubs(packageJsonPath)
    expect(existsSync(path.join(packageRootPath, 'bundler', 'rollup', 'package.json'))).toBe(true)

    // Drop `./bundler/rollup` and move the editor's CommonJS build: the rollup stub must go
    // (its top-level directory `bundler/` is still exported, so it is cleared and rewritten)
    // and the editor stub must carry the new target.
    const movedEditorFiles = { ...editorFiles, requireDefault: './dist/cjs/editor/main.js' }
    writeFileSync(path.join(packageRootPath, movedEditorFiles.requireDefault), '')
    writePackageJson(
      packageJsonPath,
      {
        './editor': toExportsEntry(movedEditorFiles),
        './bundler/webpack': toExportsEntry(getEntryFiles('bundler/webpack')),
      },
      ['dist', 'editor', 'bundler']
    )
    generateSubpathStubs(packageJsonPath)

    expect(existsSync(path.join(packageRootPath, 'bundler', 'rollup'))).toBe(false)
    expect(readStub(packageJsonPath, 'bundler/webpack')).toStrictEqual(WEBPACK_STUB)
    expect(readStub(packageJsonPath, 'editor')).toStrictEqual({
      ...EDITOR_STUB,
      main: '../dist/cjs/editor/main.js',
    })
  })

  describe('refuses to replace a stub directory it did not generate, deleting nothing', () => {
    it('a file not named package.json', () => {
      expectRefusal((editorPath) => {
        writeFileSync(path.join(editorPath, 'notes.md'), '')
      }, 'notes.md')
    })

    it('a nested package.json that is a real manifest, not a stub', () => {
      expectRefusal((editorPath) => {
        mkdirSync(path.join(editorPath, 'fixtures'))
        writeFileSync(
          path.join(editorPath, 'fixtures', 'package.json'),
          JSON.stringify({ name: 'fixture', main: 'index.js' })
        )
      }, 'fixtures/package.json')
    })

    it('a package.json with the stub keys plus another one', () => {
      expectRefusal((editorPath) => {
        mkdirSync(path.join(editorPath, 'extra'))
        writeFileSync(
          path.join(editorPath, 'extra', 'package.json'),
          JSON.stringify({ ...EDITOR_STUB, name: 'extra' })
        )
      }, 'extra/package.json')
    })

    it('a package.json with the stub keys but a non-string value', () => {
      expectRefusal((editorPath) => {
        mkdirSync(path.join(editorPath, 'typed'))
        writeFileSync(
          path.join(editorPath, 'typed', 'package.json'),
          JSON.stringify({ ...EDITOR_STUB, types: false })
        )
      }, 'typed/package.json')
    })

    it('a package.json that is valid JSON but not an object', () => {
      expectRefusal((editorPath) => {
        mkdirSync(path.join(editorPath, 'array'))
        writeFileSync(path.join(editorPath, 'array', 'package.json'), '[]')
      }, 'array/package.json')
    })

    it('a package.json that is not valid JSON', () => {
      expectRefusal((editorPath) => {
        mkdirSync(path.join(editorPath, 'broken'))
        writeFileSync(path.join(editorPath, 'broken', 'package.json'), '{ "main": ')
      }, 'broken/package.json')
    })

    it('a symbolic link named package.json, even to a stub-shaped file', () => {
      expectRefusal((editorPath) => {
        mkdirSync(path.join(editorPath, 'linked'))
        symlinkSync(
          path.join(editorPath, 'package.json'),
          path.join(editorPath, 'linked', 'package.json')
        )
      }, 'linked/package.json')
    })
  })

  it('rejects a "files" list that does not match the stub directories', () => {
    const packageJsonPath = createStandardPackage()
    writePackageJson(
      packageJsonPath,
      { './editor': toExportsEntry(getEntryFiles('editor/index')) },
      ['dist', 'editor', 'bundler']
    )
    expect(() => {
      generateSubpathStubs(packageJsonPath)
    }).toThrow(
      `🚨 ${packageJsonPath} "files" must list exactly ["dist","editor"] (the build output plus ` +
        `one legacy resolution stub directory per top-level exports subpath), but lists ` +
        `["bundler","dist","editor"]`
    )
  })

  it('rejects an exports key outside the subpath pattern', () => {
    for (const subpath of ['./Editor', './editor/', './editor/*', './a/../b', './v2']) {
      const packageJsonPath = createPackage(
        { [subpath]: toExportsEntry(getEntryFiles('editor/index')) },
        ['dist'],
        []
      )
      expect(() => {
        generateSubpathStubs(packageJsonPath)
      }).toThrow(`🚨 Unsupported exports key for a legacy resolution stub: "${subpath}"`)
    }
  })

  describe('rejects an exports entry of any other shape than { import, require } × { types, default }', () => {
    const editorFiles = getEntryFiles('editor/index')
    const importCondition = { types: editorFiles.importTypes, default: editorFiles.importDefault }
    const requireCondition = {
      types: editorFiles.requireTypes,
      default: editorFiles.requireDefault,
    }

    it.each([
      ['a string', './dist/cjs/editor/index.js'],
      ['an array', [importCondition]],
    ])('an entry that is %s', (_description, entry) => {
      expect(() => {
        generateSubpathStubs(createEditorPackage(entry))
      }).toThrow(
        '🚨 exports["./editor"] must be { "import": { … }, "require": { … } } for a legacy ' +
          'resolution stub'
      )
    })

    it.each(['node', 'browser', 'default'])(
      'an extra "%s" condition next to import/require',
      (key) => {
        expect(() => {
          generateSubpathStubs(
            createEditorPackage({
              import: importCondition,
              require: requireCondition,
              [key]: editorFiles.requireDefault,
            })
          )
        }).toThrow(
          `🚨 exports["./editor"] has an unexpected key "${key}": a legacy resolution stub can ` +
            'only be derived from "import" and "require"'
        )
      }
    )

    it('an extra key next to types/default', () => {
      expect(() => {
        generateSubpathStubs(
          createEditorPackage({
            import: importCondition,
            require: { ...requireCondition, node: editorFiles.requireDefault },
          })
        )
      }).toThrow(
        '🚨 exports["./editor"].require has an unexpected key "node": a legacy resolution stub ' +
          'can only be derived from "types" and "default"'
      )
    })

    it.each([
      ['missing', { import: importCondition }],
      ['a string', { import: importCondition, require: editorFiles.requireDefault }],
    ])('a require condition that is %s', (_description, entry) => {
      expect(() => {
        generateSubpathStubs(createEditorPackage(entry))
      }).toThrow('🚨 exports["./editor"].require must be { "types": string, "default": string }')
    })

    it.each([
      ['missing types', { default: editorFiles.importDefault }],
      ['a non-string default', { types: editorFiles.importTypes, default: 1 }],
    ])('an import condition with %s', (_description, condition) => {
      expect(() => {
        generateSubpathStubs(createEditorPackage({ import: condition, require: requireCondition }))
      }).toThrow('🚨 exports["./editor"].import must be { "types": string, "default": string }')
    })

    it.each(['../outside.js', './dist/../outside.js', 'dist/cjs/editor/index.js'])(
      'a target outside ./dist/: %s',
      (target) => {
        expect(() => {
          generateSubpathStubs(
            createEditorPackage({
              import: importCondition,
              require: { types: editorFiles.requireTypes, default: target },
            })
          )
        }).toThrow(`🚨 exports["./editor"].require target "${target}" must point inside "./dist/"`)
      }
    )
  })

  describe('rejects a stub pointing to a missing file, before deleting or writing anything', () => {
    /** Each stub field, the `exports` target it is derived from, and its stub-relative path. */
    const missingTargets: [string, keyof EntryFiles, string][] = [
      ['main', 'requireDefault', '../dist/cjs/editor/index.js'],
      ['module', 'importDefault', '../dist/esm/editor/index.js'],
      ['types', 'requireTypes', '../dist/cjs/editor/index.d.ts'],
    ]

    it.each(missingTargets)('a missing "%s" target', (field, missingFile, relativePath) => {
      const packageJsonPath = createStandardPackage()
      const packageRootPath = path.dirname(packageJsonPath)
      generateSubpathStubs(packageJsonPath)
      rmSync(path.join(packageRootPath, getEntryFiles('editor/index')[missingFile]))

      expect(() => {
        generateSubpathStubs(packageJsonPath)
      }).toThrow(
        `🚨 Legacy resolution stub editor/package.json: "${field}" (${relativePath}) is not a ` +
          `file: ${path.join(packageRootPath, 'editor', relativePath)}`
      )
      // The previous stubs are still in place: the check runs before anything is deleted.
      expect(readStub(packageJsonPath, 'editor')).toStrictEqual(EDITOR_STUB)
    })

    it('a target that is a directory, not a file', () => {
      const editorFiles = getEntryFiles('editor/index')
      const packageJsonPath = createPackage(
        { './editor': toExportsEntry({ ...editorFiles, requireDefault: './dist/cjs/editor' }) },
        ['dist', 'editor'],
        Object.values(editorFiles)
      )
      const packageRootPath = path.dirname(packageJsonPath)
      expect(() => {
        generateSubpathStubs(packageJsonPath)
      }).toThrow(
        '🚨 Legacy resolution stub editor/package.json: "main" (../dist/cjs/editor) is not a ' +
          `file: ${path.join(packageRootPath, 'dist', 'cjs', 'editor')}`
      )
      expect(existsSync(path.join(packageRootPath, 'editor'))).toBe(false)
    })
  })
})
