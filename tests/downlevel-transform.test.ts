/**
 * Unit tests for the downlevel rewrite catalog (`src/build-scripts/downlevel/`).
 *
 * Every catalog entry gets at least one positive rewrite case (input → exact expected output).
 * Most entries have no refusal case at all — the catalog has full support for every recognized
 * API shape, falling back to an emitted helper function (see `emitted-helpers.ts`) rather than
 * refusing whenever a rewrite can't stay inline. The remaining genuine refusals (`replaceAll`
 * with a non-global RegExp literal, which would throw a `TypeError` at runtime; an `.entries()`
 * result used outside a `for...of`; and degenerate `.entries()` binding shapes) are tested,
 * asserted against the file:line diagnostic contract. A final test asserts non-catalog code
 * passes through byte-identical.
 *
 * Every test builds an isolated in-memory ts-morph project (`useInMemoryFileSystem: true`) so
 * cases can't interfere with each other or touch the real filesystem.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

import globals from 'globals'
import { Project, ScriptTarget } from 'ts-morph'
import { ScriptTarget as CompilerScriptTarget, transpileModule } from 'typescript'

import { applyCatalogToSourceFile, CATALOG_RULES } from '../src/build-scripts/downlevel/catalog'
import { HELPER_SOURCE } from '../src/build-scripts/downlevel/emitted-helpers'
import { DownlevelRefusalError } from '../src/build-scripts/downlevel/helpers'
import { isNormalizedError, noThrow } from '../utilities/no-throw'

import type { DownlevelHelperName } from '../src/build-scripts/downlevel/emitted-helpers'
import type { SourceFile } from 'ts-morph'

/**
 * Create an isolated in-memory source file and apply the downlevel catalog to it.
 *
 * @param text - The TypeScript source text to rewrite.
 *
 * @returns The rewritten source file (already mutated in place by
 *   {@link applyCatalogToSourceFile}).
 */
const rewrite = (text: string): SourceFile => {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.ES2023, strict: true },
  })
  const sourceFile = project.createSourceFile('input.ts', text)
  applyCatalogToSourceFile(sourceFile)
  return sourceFile
}

/**
 * Assert that rewriting `text` throws a {@link DownlevelRefusalError} whose message contains
 * every string in `expectedMessageParts`.
 *
 * @param text - The TypeScript source text expected to be refused.
 * @param expectedMessageParts - Substrings the thrown error message must contain.
 */
const expectRefusal = (text: string, expectedMessageParts: string[]): void => {
  const result = noThrow(() => rewrite(text))
  if (!isNormalizedError(result)) {
    throw new Error('Expected the rewrite to be refused, but it succeeded.')
  }
  expect(result.originalValue).toBeInstanceOf(DownlevelRefusalError)
  const message = result.message
  // Every refusal message carries the file:line diagnostic contract: location, offending code,
  // and a suggested fix.
  expect(message).toMatch(/input\.ts:\d+/)
  expect(message).toContain('Fix:')
  for (const part of expectedMessageParts) {
    expect(message).toContain(part)
  }
}

/**
 * Count non-overlapping occurrences of `substring` in `text`.
 *
 * @param text - The text to search.
 * @param substring - The substring to count.
 *
 * @returns The number of occurrences.
 */
const countOccurrences = (text: string, substring: string): number =>
  text.split(substring).length - 1

describe('downlevel catalog #1 - String/Array#includes', () => {
  it('rewrites a string receiver to indexOf', () => {
    const sourceFile = rewrite("declare const s: string\ns.includes('a')\n")
    expect(sourceFile.getFullText()).toBe("declare const s: string\n(s.indexOf('a') !== -1)\n")
  })

  it('rewrites a string receiver with a complex (non-simple) argument — arbitrary shapes OK', () => {
    const sourceFile = rewrite(
      'declare function getValue(): string\ndeclare const s: string\n' +
        'const matched = s.includes(getValue())\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare function getValue(): string\ndeclare const s: string\n' +
        'const matched = (s.indexOf(getValue()) !== -1)\n'
    )
  })

  it('rewrites an array receiver with a fromIndex argument to indexOf', () => {
    const sourceFile = rewrite("declare const arr: string[]\narr.includes('a', 1)\n")
    expect(sourceFile.getFullText()).toBe(
      "declare const arr: string[]\n(arr.indexOf('a', 1) !== -1)\n"
    )
  })

  it('rewrites a complex (non-simple) non-numeric array receiver to indexOf', () => {
    const sourceFile = rewrite(
      "declare function getArray(): string[]\nconst matched = getArray().includes('a')\n"
    )
    expect(sourceFile.getFullText()).toBe(
      "declare function getArray(): string[]\nconst matched = (getArray().indexOf('a') !== -1)\n"
    )
  })

  it('parenthesizes the rewrite so outer operators keep their original precedence', () => {
    const sourceFile = rewrite("declare const s: string\n!s.includes('a')\n")
    expect(sourceFile.getFullText()).toBe("declare const s: string\n!(s.indexOf('a') !== -1)\n")
  })

  it('leaves a same-named method on an unrelated receiver type untouched', () => {
    const sourceFile = rewrite(
      "declare const custom: { includes: (x: string) => boolean }\ncustom.includes('a')\n"
    )
    expect(sourceFile.getFullText()).toBe(
      "declare const custom: { includes: (x: string) => boolean }\ncustom.includes('a')\n"
    )
  })

  it('rewrites a literal-array receiver with a simple argument to a comparison chain', () => {
    const sourceFile = rewrite(
      "declare const x: string\nconst matched = ['a', 'b', 'c'].includes(x)\n"
    )
    expect(sourceFile.getFullText()).toBe(
      "declare const x: string\nconst matched = (x === 'a' || x === 'b' || x === 'c')\n"
    )
  })

  it('rewrites a literal `NaN` chain element to a self-inequality check', () => {
    const sourceFile = rewrite('declare const x: number\nconst matched = [1, NaN, 3].includes(x)\n')
    expect(sourceFile.getFullText()).toBe(
      'declare const x: number\nconst matched = (x === 1 || x !== x || x === 3)\n'
    )
  })

  it('falls back to the NaN-safe helper for a literal array with a complex argument', () => {
    const sourceFile = rewrite(
      'declare function getValue(): number\nconst matched = [1, 2, 3].includes(getValue())\n'
    )
    const text = sourceFile.getFullText()
    expect(text).toContain(
      'const downlevelIncludesNaNSafe = <T>(arr: readonly T[], v: T, from?: number): boolean => {'
    )
    expect(text).toContain('const matched = downlevelIncludesNaNSafe([1, 2, 3], getValue())')
  })

  it('falls back to the NaN-safe helper for a non-literal numeric-element array receiver', () => {
    const sourceFile = rewrite(
      'declare function getArray(): number[]\nconst matched = getArray().includes(1)\n'
    )
    const text = sourceFile.getFullText()
    expect(text).toContain('const downlevelIncludesNaNSafe')
    expect(text).toContain('const matched = downlevelIncludesNaNSafe(getArray(), 1)')
  })

  it('rewrites a literal `Number.NaN` chain element to a self-inequality check', () => {
    const sourceFile = rewrite(
      'declare const x: number\nconst matched = [1, Number.NaN, 3].includes(x)\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare const x: number\nconst matched = (x === 1 || x !== x || x === 3)\n'
    )
  })

  it('routes a generic-element receiver to the exact helper (NaN is not statically excludable)', () => {
    const sourceFile = rewrite('const has = <T>(arr: T[], v: T): boolean => arr.includes(v)\n')
    expect(sourceFile.getFullText()).toContain('downlevelIncludesNaNSafe(arr, v)')
  })

  it('routes an unknown-element receiver to the exact helper', () => {
    const sourceFile = rewrite(
      'declare const arr: unknown[]\ndeclare const v: unknown\nconst has = arr.includes(v)\n'
    )
    expect(sourceFile.getFullText()).toContain('downlevelIncludesNaNSafe(arr, v)')
  })

  it('routes an element type including undefined to the exact helper (array holes read as undefined)', () => {
    const sourceFile = rewrite(
      'declare const arr: (string | undefined)[]\nconst has = arr.includes(undefined)\n'
    )
    expect(sourceFile.getFullText()).toContain('downlevelIncludesNaNSafe(arr, undefined)')
  })

  it('rewrites includes on a template-literal-typed receiver (a string primitive at runtime)', () => {
    const sourceFile = rewrite('declare const s: `id-${string}`\ns.includes("x")\n')
    expect(sourceFile.getFullText()).toBe(
      'declare const s: `id-${string}`\n(s.indexOf("x") !== -1)\n'
    )
  })
})

describe('downlevel catalog #2 - String#startsWith', () => {
  it('rewrites to lastIndexOf(pattern, 0) === 0', () => {
    const sourceFile = rewrite("declare const s: string\ns.startsWith('a')\n")
    expect(sourceFile.getFullText()).toBe(
      "declare const s: string\n(s.lastIndexOf('a', 0) === 0)\n"
    )
  })

  it('falls back to the position-aware helper for a position argument (arbitrary shapes OK)', () => {
    const sourceFile = rewrite("declare const s: string\nconst matched = s.startsWith('a', 2)\n")
    const text = sourceFile.getFullText()
    expect(text).toContain(
      'const downlevelStartsWithAt = (s: string, p: string, position: number | undefined): boolean => {'
    )
    expect(text).toContain("const matched = downlevelStartsWithAt(s, 'a', 2)")
  })

  it('rewrites startsWith on a string-constrained generic receiver', () => {
    const sourceFile = rewrite('const f = <T extends string>(s: T): boolean => s.startsWith("a")\n')
    expect(sourceFile.getFullText()).toBe(
      'const f = <T extends string>(s: T): boolean => (s.lastIndexOf("a", 0) === 0)\n'
    )
  })

  it('refuses a spread argument (the arity dispatch cannot see a runtime position)', () => {
    expectRefusal(
      'declare const s: string\ndeclare const args: [string, number]\nconst matched = s.startsWith(...args)\n',
      [
        "a spread argument defeats the rewrite's positional argument handling",
        'spell the arguments out positionally',
      ]
    )
  })
})

describe('downlevel catalog #3 - String#endsWith', () => {
  it('rewrites to a slice/length comparison for simple operands', () => {
    const sourceFile = rewrite("declare const s: string\ns.endsWith('a')\n")
    expect(sourceFile.getFullText()).toBe(
      "declare const s: string\n(s.slice(s.length - 'a'.length) === 'a')\n"
    )
  })

  it('falls back to the endsWith helper for a complex (non-simple) receiver', () => {
    const sourceFile = rewrite(
      "declare function getS(): string\nconst matched = getS().endsWith('x')\n"
    )
    const text = sourceFile.getFullText()
    expect(text).toContain(
      'const downlevelEndsWith = (s: string, p: string): boolean => s.slice(s.length - p.length) === p'
    )
    expect(text).toContain("const matched = downlevelEndsWith(getS(), 'x')")
  })

  it('falls back to the position-aware helper for a position argument (arbitrary shapes OK)', () => {
    const sourceFile = rewrite("declare const s: string\nconst matched = s.endsWith('x', 5)\n")
    const text = sourceFile.getFullText()
    expect(text).toContain(
      'const downlevelEndsWithAt = (s: string, p: string, end: number): boolean => {'
    )
    expect(text).toContain("const matched = downlevelEndsWithAt(s, 'x', 5)")
  })

  it('emits a requested helper only once per file, even when used by two call sites', () => {
    const sourceFile = rewrite(
      'declare function getS1(): string\ndeclare function getS2(): string\n' +
        "const a = getS1().endsWith('x')\nconst b = getS2().endsWith('y')\n"
    )
    const text = sourceFile.getFullText()
    expect(countOccurrences(text, 'const downlevelEndsWith = (s: string, p: string)')).toBe(1)
    expect(text).toContain("const a = downlevelEndsWith(getS1(), 'x')")
    expect(text).toContain("const b = downlevelEndsWith(getS2(), 'y')")
  })
})

describe('downlevel catalog #4 - Object.hasOwn', () => {
  it('rewrites to Object.prototype.hasOwnProperty.call', () => {
    const sourceFile = rewrite("declare const o: object\nObject.hasOwn(o, 'a')\n")
    expect(sourceFile.getFullText()).toBe(
      "declare const o: object\nObject.prototype.hasOwnProperty.call(o, 'a')\n"
    )
  })

  it('rewrites with complex (non-simple) arguments — arbitrary shapes OK', () => {
    const sourceFile = rewrite(
      'declare function getObj(): object\ndeclare function getKey(): string\n' +
        'const has = Object.hasOwn(getObj(), getKey())\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare function getObj(): object\ndeclare function getKey(): string\n' +
        'const has = Object.prototype.hasOwnProperty.call(getObj(), getKey())\n'
    )
  })

  it('refuses a spread argument (positional destructuring would see no key node)', () => {
    expectRefusal('declare const args: [object, string]\nconst has = Object.hasOwn(...args)\n', [
      "a spread argument defeats the rewrite's positional argument handling",
      'spell the arguments out positionally',
    ])
  })
})

describe('downlevel catalog #5 - Array#toSorted / Array#toReversed', () => {
  it('rewrites toSorted to slice().sort()', () => {
    const sourceFile = rewrite('declare const arr: number[]\narr.toSorted()\n')
    expect(sourceFile.getFullText()).toBe('declare const arr: number[]\narr.slice().sort()\n')
  })

  it('rewrites toReversed to slice().reverse()', () => {
    const sourceFile = rewrite('declare const arr: number[]\narr.toReversed()\n')
    expect(sourceFile.getFullText()).toBe('declare const arr: number[]\narr.slice().reverse()\n')
  })

  it('forwards a simple comparator argument to toSorted', () => {
    const sourceFile = rewrite(
      'declare const arr: number[]\ndeclare const compare: (a: number, b: number) => number\narr.toSorted(compare)\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare const arr: number[]\ndeclare const compare: (a: number, b: number) => number\narr.slice().sort(compare)\n'
    )
  })

  it('rewrites a complex (non-simple) receiver — arbitrary shapes OK', () => {
    const sourceFile = rewrite(
      'declare function getArray(): number[]\nconst sorted = getArray().toSorted()\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare function getArray(): number[]\nconst sorted = getArray().slice().sort()\n'
    )
  })
})

describe('downlevel catalog #6 - String#replaceAll', () => {
  it('rewrites to split(a).join(b) for a non-empty literal search and a $-free literal replacement', () => {
    const sourceFile = rewrite("declare const s: string\ns.replaceAll('a', 'b')\n")
    expect(sourceFile.getFullText()).toBe("declare const s: string\ns.split('a').join('b')\n")
  })

  it('refuses a spread argument (positional destructuring would see no replacement node)', () => {
    expectRefusal(
      'declare const s: string\ndeclare const args: [string, string]\nconst out = s.replaceAll(...args)\n',
      [
        "a spread argument defeats the rewrite's positional argument handling",
        'spell the arguments out positionally',
      ]
    )
  })

  // See the "(full coverage)" describe block below for the RegExp and function-replacer cases.
})

describe('downlevel catalog #7 - Number.parseInt / Number.parseFloat', () => {
  it('rewrites Number.parseInt to the global parseInt', () => {
    const sourceFile = rewrite("Number.parseInt('5', 10)\n")
    expect(sourceFile.getFullText()).toBe("parseInt('5', 10)\n")
  })

  it('rewrites Number.parseFloat to the global parseFloat', () => {
    const sourceFile = rewrite("Number.parseFloat('5.5')\n")
    expect(sourceFile.getFullText()).toBe("parseFloat('5.5')\n")
  })

  // No refusal case: argument shapes for this entry "pass through unchanged" (never duplicated
  // in the output, so there is nothing unsafe to refuse). The only failure mode is not matching
  // at all, exercised below: a receiver that merely shares the `Number` name (shadowing the
  // global) is left untouched rather than rewritten, since it was never really calling the
  // ES2015 API.
  it('leaves a shadowed local "Number" untouched', () => {
    // `export {}` forces module scope so the local declaration actually shadows the ambient
    // global `Number` instead of conflicting with it in global-script scope.
    const sourceFile = rewrite(
      "export {}\ndeclare const Number: { parseInt: (value: string) => number }\nNumber.parseInt('5')\n"
    )
    expect(sourceFile.getFullText()).toBe(
      "export {}\ndeclare const Number: { parseInt: (value: string) => number }\nNumber.parseInt('5')\n"
    )
  })
})

describe('downlevel catalog #8 - String.raw', () => {
  it('constant-folds a substitution-free template to a plain string literal', () => {
    const sourceFile = rewrite('const value = String.raw`a\\nb`\n')
    expect(sourceFile.getFullText()).toBe("const value = 'a\\\\nb'\n")
  })

  it('escapes backslashes and single quotes in the folded literal', () => {
    const sourceFile = rewrite("const value = String.raw`\\'`\n")
    expect(sourceFile.getFullText()).toBe("const value = '\\\\\\''\n")
  })

  it('folds a template with one substitution to a parenthesized concatenation', () => {
    const sourceFile = rewrite('declare const x: string\nconst value = String.raw`a\\n${x}b`\n')
    expect(sourceFile.getFullText()).toBe(
      "declare const x: string\nconst value = ('a\\\\n' + (x) + 'b')\n"
    )
  })

  it('folds a template with multiple substitutions, each evaluated once in order', () => {
    const sourceFile = rewrite(
      'declare const x: string\ndeclare const y: string\n' +
        'const value = String.raw`a${x}mid\\t${y}z`\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare const x: string\ndeclare const y: string\n' +
        "const value = ('a' + (x) + 'mid\\\\t' + (y) + 'z')\n"
    )
  })

  it('normalizes CRLF and lone CR line terminators to LF, matching the spec template raw value', () => {
    // A CRLF working tree (Windows checkout) must fold the same bytes as an LF one: native
    // String.raw normalizes \r\n and \r to \n when building the raw strings.
    const crlfSource = rewrite('const value = String.raw`a\r\nb`\n')
    expect(crlfSource.getFullText()).toContain(String.raw`'a\nb'`)
    const crSource = rewrite('const value = String.raw`a\rb`\n')
    expect(crSource.getFullText()).toContain(String.raw`'a\nb'`)
  })
})

describe('downlevel catalog #9 - Array#entries (for...of)', () => {
  it('rewrites the [index, value] destructured form to a block-wrapped index loop', () => {
    const sourceFile = rewrite(
      'declare const arr: string[]\nfor (const [index, value] of arr.entries()) {\n  console.log(index, value)\n}\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare const arr: string[]\n{\nconst downlevelValue = arr\n' +
        'for (let downlevelValueIndex = 0; downlevelValueIndex < downlevelValue.length; downlevelValueIndex++) {\n' +
        'const index = downlevelValueIndex\n' +
        'const value = downlevelValue[downlevelValueIndex]\n' +
        '\n  console.log(index, value)\n\n}\n}\n'
    )
  })

  it('preserves the declaration kind, keeping a `let` binding assignable without affecting iteration', () => {
    const sourceFile = rewrite(
      'declare const arr: string[]\nfor (let [index, value] of arr.entries()) {\n  console.log(index, value)\n}\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare const arr: string[]\n{\nconst downlevelValue = arr\n' +
        'for (let downlevelValueIndex = 0; downlevelValueIndex < downlevelValue.length; downlevelValueIndex++) {\n' +
        'let index = downlevelValueIndex\n' +
        'let value = downlevelValue[downlevelValueIndex]\n' +
        '\n  console.log(index, value)\n\n}\n}\n'
    )
  })

  it('hoists a complex (non-simple) receiver in the [index, value] form', () => {
    const sourceFile = rewrite(
      'declare function getArr(): string[]\nfor (const [index, value] of getArr().entries()) {\n  console.log(index, value)\n}\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare function getArr(): string[]\n{\nconst downlevelValue = getArr()\n' +
        'for (let downlevelValueIndex = 0; downlevelValueIndex < downlevelValue.length; downlevelValueIndex++) {\n' +
        'const index = downlevelValueIndex\n' +
        'const value = downlevelValue[downlevelValueIndex]\n' +
        '\n  console.log(index, value)\n\n}\n}\n'
    )
  })

  it('rewrites the whole-tuple form to an index loop building [index, value] per iteration', () => {
    const sourceFile = rewrite(
      'declare const arr: string[]\nfor (const entry of arr.entries()) {\n  console.log(entry)\n}\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare const arr: string[]\n{\nconst downlevelEntry = arr\n' +
        'for (let downlevelEntryIndex = 0; downlevelEntryIndex < downlevelEntry.length; downlevelEntryIndex++) {\n' +
        'const entry = [downlevelEntryIndex, downlevelEntry[downlevelEntryIndex]]\n' +
        '\n  console.log(entry)\n\n}\n}\n'
    )
  })

  it('hoists a complex (non-simple) receiver in the whole-tuple form', () => {
    const sourceFile = rewrite(
      'declare function getArr(): string[]\nfor (const entry of getArr().entries()) {\n  console.log(entry)\n}\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare function getArr(): string[]\n{\nconst downlevelEntry = getArr()\n' +
        'for (let downlevelEntryIndex = 0; downlevelEntryIndex < downlevelEntry.length; downlevelEntryIndex++) {\n' +
        'const entry = [downlevelEntryIndex, downlevelEntry[downlevelEntryIndex]]\n' +
        '\n  console.log(entry)\n\n}\n}\n'
    )
  })

  it('refuses a .entries() result stored/used outside a for...of', () => {
    expectRefusal('declare const arr: string[]\nconst it = arr.entries()\n', [
      'ES2015 iterator object, which has no ES5 equivalent',
      'iterate immediately with for...of instead of storing the iterator',
    ])
  })

  it('rewrites a nested value-destructuring pattern (index must stay a plain identifier)', () => {
    const sourceFile = rewrite(
      'declare const arr: [string, string][]\nfor (const [i, [a, b]] of arr.entries()) {\n  console.log(i, a, b)\n}\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare const arr: [string, string][]\n{\nconst downlevelReceiver = arr\n' +
        'for (let downlevelReceiverIndex = 0; downlevelReceiverIndex < downlevelReceiver.length; downlevelReceiverIndex++) {\n' +
        'const i = downlevelReceiverIndex\n' +
        'const [a, b] = downlevelReceiver[downlevelReceiverIndex]\n' +
        '\n  console.log(i, a, b)\n\n}\n}\n'
    )
  })

  it('refuses a single-element destructuring (no plain-identifier index)', () => {
    expectRefusal(
      'declare const arr: string[]\nfor (const [index] of arr.entries()) {\n  console.log(index)\n}\n',
      [
        'neither position of a `[index, value]` binding may have a rest element or default value',
        'bind a plain `[index, value]` pair',
      ]
    )
  })

  it('refuses a rest element on the value position', () => {
    expectRefusal(
      'declare const arr: string[]\nfor (const [index, ...rest] of arr.entries()) {\n  console.log(index, rest)\n}\n',
      [
        'neither position of a `[index, value]` binding may have a rest element or default value',
        'bind a plain `[index, value]` pair',
      ]
    )
  })

  it('refuses a labeled loop (a label cannot survive the block wrapping)', () => {
    expectRefusal(
      'declare const arr: string[]\nouter: for (const [index, value] of arr.entries()) {\n' +
        '  if (index > 0) {\n    continue outer\n  }\n  console.log(value)\n}\n',
      ['labeled `for...of`', 'restructure the loop so the label is not needed']
    )
  })

  it('preserves body comments (including suppression directives) through the rewrite', () => {
    const sourceFile = rewrite(
      'declare const arr: string[]\nfor (const [index, value] of arr.entries()) {\n' +
        '  // keep: body comment must survive into the shadow tree\n  console.log(index, value)\n}\n'
    )
    expect(sourceFile.getFullText()).toContain('// keep: body comment must survive')
  })

  it('a mutated let index binding stays local to its iteration, matching native for...of', () => {
    const run = compileRewrittenFunction(
      'const run = (input: string[]): [number, string][] => {\n' +
        '  const out: [number, string][] = []\n' +
        '  for (let [index, value] of input.entries()) {\n' +
        '    index = index + 1\n' +
        '    out.push([index, value])\n' +
        '  }\n' +
        '  return out\n' +
        '}\n'
    )
    // Native for...of yields every element exactly once regardless of binding assignment.
    expect(run(['a', 'b', 'c'])).toStrictEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ])
  })

  it('a body binding shadowing the receiver identifier does not affect the iteration reads', () => {
    const run = compileRewrittenFunction(
      'const run = (input: string[]): string[] => {\n' +
        '  const out: string[] = []\n' +
        '  for (const [index, value] of input.entries()) {\n' +
        '    const input = `${index}`\n' +
        '    out.push(value + input)\n' +
        '  }\n' +
        '  return out\n' +
        '}\n'
    )
    expect(run(['a', 'b'])).toStrictEqual(['a0', 'b1'])
  })

  it('rewrites inside a braceless if body (the block replacement is a single statement)', () => {
    const run = compileRewrittenFunction(
      'const run = (input: string[]): string[] => {\n' +
        '  const out: string[] = []\n' +
        '  if (input.length > 0)\n' +
        '    for (const [index, value] of input.entries()) out.push(`${index}:${value}`)\n' +
        '  return out\n' +
        '}\n'
    )
    expect(run(['a', 'b'])).toStrictEqual(['0:a', '1:b'])
    expect(run([])).toStrictEqual([])
  })
})

describe('downlevel catalog #10 - String/Array#at', () => {
  it('rewrites a negative integer literal to length-relative indexing', () => {
    const sourceFile = rewrite('declare const arr: string[]\narr.at(-1)\n')
    expect(sourceFile.getFullText()).toBe('declare const arr: string[]\narr[arr.length - 1]\n')
  })

  it('rewrites a non-negative integer literal to direct indexing', () => {
    const sourceFile = rewrite('declare const s: string\ns.at(2)\n')
    expect(sourceFile.getFullText()).toBe('declare const s: string\ns[2]\n')
  })

  it('treats `-0` as index 0, not length-relative', () => {
    const sourceFile = rewrite('declare const arr: string[]\narr.at(-0)\n')
    expect(sourceFile.getFullText()).toBe('declare const arr: string[]\narr[0]\n')
  })

  it('rewrites a non-negative integer literal with a complex receiver — arbitrary shapes OK', () => {
    const sourceFile = rewrite(
      'declare function getArr(): string[]\nconst value = getArr().at(2)\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare function getArr(): string[]\nconst value = getArr()[2]\n'
    )
  })

  it('falls back to the helper for a non-literal index', () => {
    const sourceFile = rewrite(
      'declare const arr: string[]\ndeclare const n: number\nconst value = arr.at(n)\n'
    )
    const text = sourceFile.getFullText()
    expect(text).toContain('function downlevelAt(x: string, i: number): string | undefined')
    expect(text).toContain('const value = downlevelAt(arr, n)')
  })

  it('falls back to the helper for a negative literal index with a complex receiver', () => {
    const sourceFile = rewrite(
      'declare function getArr(): string[]\nconst value = getArr().at(-1)\n'
    )
    const text = sourceFile.getFullText()
    expect(text).toContain('function downlevelAt')
    expect(text).toContain('const value = downlevelAt(getArr(), -1)')
  })
})

describe('downlevel catalog - non-catalog code', () => {
  it('passes through byte-identical', () => {
    const text =
      'export const add = (a: number, b: number): number => a + b\n' +
      "export const greeting = 'hello'\n" +
      'export const doubled = [1, 2, 3].map((value) => value * 2)\n'
    const sourceFile = rewrite(text)
    expect(sourceFile.getFullText()).toBe(text)
  })
})

/**
 * Compile an emitted helper's source text and evaluate it in an isolated `vm` context,
 * validating its shape with the provided type guard (the repository's `unknown`-then-narrow
 * pattern — emitted helper text is generated code, so its evaluated shape is validated rather
 * than assumed).
 *
 * @param name - The helper to compile.
 * @param isExpectedShape - Type guard validating the evaluated helper's function shape.
 *
 * @returns The compiled helper function.
 */
const compileHelper = <HelperFunction>(
  name: DownlevelHelperName,
  isExpectedShape: (value: unknown) => value is HelperFunction
): HelperFunction => {
  const transpiled = transpileModule(HELPER_SOURCE[name], {
    compilerOptions: { target: CompilerScriptTarget.ES2019 },
  }).outputText
  const evaluated: unknown = runInNewContext(`${transpiled}; ${name}`)
  if (!isExpectedShape(evaluated)) {
    throw new Error(`Compiled helper "${name}" did not evaluate to a function.`)
  }
  return evaluated
}

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters --
   The return-only type parameter is deliberate (see the doc comment below), so the rule's
   "used only once" heuristic is wrong for this specific function. */
/**
 * Build a type guard asserting that a value evaluated in the `vm` realm is a function with the
 * given signature. The runtime check can only verify "is a function"; the signature is declared
 * by the call site and trusted, which is exactly the contract {@link compileHelper} needs — the
 * equivalence tests then exercise that trusted signature against edge inputs.
 *
 * The return-only type parameter is what lets each call site state the expected signature
 * without a type assertion.
 *
 * @returns A type guard narrowing to the declared function signature.
 */
const functionGuard =
  <FunctionSignature>(): ((value: unknown) => value is FunctionSignature) =>
  (value: unknown): value is FunctionSignature =>
    typeof value === 'function'
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

const isStringPredicateHelper =
  functionGuard<(s: string, p: string, position: number | undefined) => boolean>()

const isPlainEndsWithHelper = functionGuard<(s: string, p: string) => boolean>()

const isAtHelper = functionGuard<(x: string | readonly unknown[], index: number) => unknown>()

const isIncludesHelper =
  functionGuard<
    (array: readonly (number | undefined)[], v: number | undefined, from?: number) => boolean
  >()

/**
 * Check whether a thrown value has a string `name` property (e.g. `'TypeError'`,
 * `'RangeError'`) — used instead of `instanceof` to check the *kind* of error a compiled helper
 * throws, since {@link compileHelper} executes helpers in a separate `vm` realm whose `Error`
 * subclasses are distinct constructor objects from this file's, making `instanceof` always
 * `false` across the boundary even for a same-named error type.
 *
 * @param value - The thrown value to check.
 *
 * @returns `true` if `value` has a string `name` property.
 */
const hasErrorName = (value: unknown): value is { name: string } =>
  typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'

const isReplaceAllStringHelper =
  functionGuard<(s: string, search: string, replacement: string) => string>()

const isReplaceAllStringFunctionHelper =
  functionGuard<
    (
      s: string,
      search: string,
      replacer: (matched: string, position: number, fullString: string) => unknown
    ) => string
  >()

const isReplaceAllRegExpHelper =
  functionGuard<(s: string, re: RegExp, replacement: unknown) => string>()

/**
 * A replacer function used only as a dynamic (non-literal) `replaceAll` argument in tests.
 *
 * @param matched - The matched substring.
 * @param position - The match's position in the full string.
 * @param fullString - The full string being searched.
 *
 * @returns A marker embedding all three replacer arguments, so tests can verify each was
 * forwarded correctly.
 */
const describeReplacer = (matched: string, position: number, fullString: string): string =>
  `<${matched}@${position}/${fullString.length}>`

/**
 * A replacer function used only as a dynamic (non-literal) `replaceAll` argument in tests.
 *
 * @param matched - The matched substring.
 *
 * @returns The matched substring in upper case.
 */
const upperCaseReplacer = (matched: string): string => matched.toUpperCase()

const isUnaryPredicateHelper = functionGuard<(v: unknown) => boolean>()

const isFindFamilyHelper =
  functionGuard<
    (
      array: readonly unknown[],
      predicate: (value: unknown, index: number, array: readonly unknown[]) => unknown,
      thisArgument?: unknown
    ) => unknown
  >()

/**
 * A find-family predicate used by value, never by reference, in the equivalence tests.
 *
 * @param value - The array element under test.
 *
 * @returns `true` if the element is a number greater than three.
 */
const isBiggerThanThree = (value: unknown): boolean => typeof value === 'number' && value > 3

/**
 * A find-family predicate used by value, never by reference, in the equivalence tests.
 *
 * @param value - The array element under test.
 *
 * @returns `true` if the element is a number greater than one hundred.
 */
const isBiggerThanOneHundred = (value: unknown): boolean => typeof value === 'number' && value > 100

/** The `this` shape bound to {@link isBiggerThanThisThreshold} via the helper's `thisArg`. */
type ThresholdHolder = {
  /** The exclusive lower bound the predicate compares elements against. */
  threshold: number
}

/**
 * A find-family predicate that reads its `thisArg` — exercising `this` outside a class is the
 * point of this predicate (it exists solely to verify the emitted find-family helpers forward
 * their optional `thisArg` the same way native `Array#find` does).
 *
 * @param this - The bound {@link ThresholdHolder}, forwarded by the helper under test.
 * @param value - The array element under test.
 *
 * @returns `true` if the element is a number greater than the bound `this.threshold`.
 */
function isBiggerThanThisThreshold(this: ThresholdHolder, value: unknown): boolean {
  return typeof value === 'number' && value > this.threshold
}

const isRepeatHelper = functionGuard<(s: string, count: number) => string>()

const isPadHelper = functionGuard<(s: string, targetLength: number, padString?: string) => string>()

const isObjectIterableHelper = functionGuard<(o: object) => unknown>()

const isToSplicedHelper =
  functionGuard<(array: readonly unknown[], ...rest: unknown[]) => unknown[]>()

describe('downlevel emitted helpers - standalone strict type-checking', () => {
  // The runtime-equivalence suites below transpile helpers with `transpileModule`, which never
  // type-checks. A helper only meets `tsc` when a src/ call site pulls it into the shadow tree,
  // so a helper defined ahead of any real usage could otherwise carry a type error undetected.
  it('every HELPER_SOURCE entry type-checks under the strict compiler settings', () => {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { target: ScriptTarget.ES2023, strict: true },
    })
    // One file holding every helper: helpers may reference each other, and the shadow tree
    // emits them into the same file scope as the rewritten code.
    const combinedSource = Object.values(HELPER_SOURCE).join('\n\n')
    const file = project.createSourceFile('helpers.ts', `export {}\n${combinedSource}\n`)
    const diagnostics = file.getPreEmitDiagnostics()
    expect(project.formatDiagnosticsWithColorAndContext(diagnostics)).toBe('')
  })
})

/**
 * Run a find-family implementation over an array whose predicate appends to that same array,
 * and report how the iteration behaved. Native find/findIndex capture the length before
 * iterating, so exactly the initial elements are visited — a per-iteration length re-read
 * would visit the appended elements too (and never terminate).
 *
 * @param find - The find-family implementation to exercise (native or an emitted helper).
 *
 * @returns The number of predicate calls, the array's final length, and the find result.
 */
const runGrowingArrayFind = (
  find: (array: number[], isMatch: (value: unknown) => boolean) => unknown
): { calls: number; length: number; result: unknown } => {
  const array = [1, 2, 3]
  let calls = 0
  const result = find(array, () => {
    calls++
    array.push(0)
    return false
  })
  return { calls, length: array.length, result }
}

describe('downlevel emitted helpers - runtime equivalence with the native methods', () => {
  const strings = ['', 'a', 'abc', 'aabc']
  const patterns = ['', 'a', 'ab', 'bc', 'abcd']
  // Includes the full ToIntegerOrInfinity surface: undefined, NaN, fractional, and negative
  // positions all normalize per spec, not just plain integers.
  const positions = [undefined, NaN, -5, -1.5, -1, -0.5, 0, 1, 1.5, 2, 2.9, 3, 10]

  it('downlevelStartsWithAt matches native String#startsWith for all position ranges', () => {
    const doesStartWithAt = compileHelper('downlevelStartsWithAt', isStringPredicateHelper)
    for (const s of strings) {
      for (const p of patterns) {
        for (const position of positions) {
          expect(doesStartWithAt(s, p, position)).toBe(s.startsWith(p, position))
        }
      }
    }
  })

  it('downlevelEndsWithAt matches native String#endsWith for all end-position ranges', () => {
    const doesEndWithAt = compileHelper('downlevelEndsWithAt', isStringPredicateHelper)
    for (const s of strings) {
      for (const p of patterns) {
        for (const end of positions) {
          expect(doesEndWithAt(s, p, end)).toBe(s.endsWith(p, end))
        }
      }
    }
  })

  it('downlevelEndsWith matches native String#endsWith', () => {
    const doesEndWith = compileHelper('downlevelEndsWith', isPlainEndsWithHelper)
    for (const s of strings) {
      for (const p of patterns) {
        expect(doesEndWith(s, p)).toBe(s.endsWith(p))
      }
    }
  })

  it('downlevelAt matches native at() semantics for integer indexes', () => {
    const helper = compileHelper('downlevelAt', isAtHelper)
    const array = ['x', 'y', 'z']
    const text = 'xyz'
    for (let index = -4; index <= 4; index++) {
      expect(helper(array, index)).toBe(array.at(index))
      expect(helper(text, index)).toBe(text.at(index))
    }
  })

  it('downlevelAt truncates fractional and NaN indexes per ToIntegerOrInfinity, matching native at()', () => {
    const helper = compileHelper('downlevelAt', isAtHelper)
    const array = ['x', 'y', 'z']
    const text = 'xyz'
    for (const index of [-3.5, -2.5, -1.5, -0.5, -0, 0.5, 1.5, 2.9, NaN, Infinity, -Infinity]) {
      expect(helper(array, index)).toBe(array.at(index))
      expect(helper(text, index)).toBe(text.at(index))
    }
  })

  it('downlevelIncludesNaNSafe matches native Array#includes, including NaN and negative from', () => {
    const doesInclude = compileHelper('downlevelIncludesNaNSafe', isIncludesHelper)
    const arrays = [[NaN, 1], [1, NaN, 3], [1, 2, 3], []]
    const searchValues = [NaN, 1, 4]
    // Includes fractional and NaN start indexes: both normalize per ToIntegerOrInfinity.
    const fromIndexes = [undefined, NaN, -10, -2, -1.5, -1, 0, 1, 1.5, 2, 5]
    for (const array of arrays) {
      for (const searchValue of searchValues) {
        for (const from of fromIndexes) {
          expect(doesInclude(array, searchValue, from)).toBe(array.includes(searchValue, from))
        }
      }
    }
  })

  it('downlevelIncludesNaNSafe reads array holes as undefined, matching native includes (indexOf skips them)', () => {
    const doesInclude = compileHelper('downlevelIncludesNaNSafe', isIncludesHelper)
    // Extending the length creates genuine holes (an array-literal elision or Array.from would
    // create dense undefined elements instead, which indexOf does NOT skip — no divergence).
    const sparse: (number | undefined)[] = [1]
    sparse.length = 3
    expect(doesInclude(sparse, undefined)).toBe(sparse.includes(undefined))
    expect(doesInclude(sparse, undefined)).toBe(true)
    expect(doesInclude(sparse, undefined, 1)).toBe(sparse.includes(undefined, 1))
    expect(doesInclude(sparse, 1)).toBe(sparse.includes(1))
  })

  // --- #0/#2 replaceAll helpers ------------------------------------------------------------

  it('downlevelReplaceAllString matches native replaceAll for a string search, including GetSubstitution patterns', () => {
    const helper = compileHelper('downlevelReplaceAllString', isReplaceAllStringHelper)
    const cases: [string, string, string][] = [
      ['a-b', '-', '$&$&'],
      ['a-b-c', '-', "[$`|$'$&]"],
      ['abc', '', 'X'],
      ['a1b', '1', '$1'],
      ['a1b', '1', '$<name>'],
      ['a$b', '$', 'Y'],
      ['abab', 'a', '$$'],
      ['', '', 'Z'],
      ['aa', 'a', '$99'],
      ['xx', 'x', ''],
      ['', 'a', 'x'],
      ['aaa', 'aa', 'b'],
    ]
    // Exercising dynamic GetSubstitution patterns against native replaceAll is the point of this
    // equivalence test.
    for (const [s, search, replacement] of cases) {
      // eslint-disable-next-line unicorn/no-unsafe-string-replacement
      expect(helper(s, search, replacement)).toBe(s.replaceAll(search, replacement))
    }
  })

  it('downlevelReplaceAllStringFunction matches native replaceAll with a function replacer', () => {
    const helper = compileHelper(
      'downlevelReplaceAllStringFunction',
      isReplaceAllStringFunctionHelper
    )
    const cases: [string, string][] = [
      ['a-b-c', '-'],
      ['abc', ''],
      ['aaa', 'a'],
    ]
    // Comparing the helper's replacer-calling convention against native replaceAll is the point
    // of this test.
    for (const [s, search] of cases) {
      // eslint-disable-next-line unicorn/no-unsafe-string-replacement
      expect(helper(s, search, describeReplacer)).toBe(s.replaceAll(search, describeReplacer))
    }
  })

  it('downlevelReplaceAllRegExp matches native replaceAll for a global RegExp (string and function forms)', () => {
    const helper = compileHelper('downlevelReplaceAllRegExp', isReplaceAllRegExpHelper)
    expect(helper('a-b-c', /-/g, 'X')).toBe('a-b-c'.replaceAll('-', 'X'))
    // Comparing the helper's regex-replacer forwarding against native replaceAll is the point of
    // this test; the native side uses an equivalent string search (`.` has no regex-special
    // meaning to escape here) to avoid re-triggering the catalog's own regex-preference rule.
    expect(helper('a.b.c', /\./g, upperCaseReplacer)).toBe(
      'a.b.c'.replaceAll('.', upperCaseReplacer) // eslint-disable-line unicorn/no-unsafe-string-replacement
    )
  })

  it('downlevelReplaceAllRegExp throws TypeError for a non-global RegExp, matching native replaceAll', () => {
    const helper = compileHelper('downlevelReplaceAllRegExp', isReplaceAllRegExpHelper)
    // The helper is compiled and executed in a separate `vm` realm (see `compileHelper`), so the
    // thrown error is an instance of *that* realm's `TypeError`, not this file's — compare by
    // `.name` rather than `instanceof`.
    const result = noThrow(() => helper('a-b', /-/, 'X'))
    if (!isNormalizedError(result) || !hasErrorName(result.originalValue)) {
      throw new Error(
        'Expected downlevelReplaceAllRegExp to throw an error-shaped value for a non-global RegExp.'
      )
    }
    expect(result.originalValue.name).toBe('TypeError')
  })

  // --- #11 Number statics --------------------------------------------------------------------

  it('downlevelNumberIsNaN matches native Number.isNaN for every value type', () => {
    const isNumberNaN = compileHelper('downlevelNumberIsNaN', isUnaryPredicateHelper)
    const values: unknown[] = [NaN, 0, -0, 1, Infinity, -Infinity, '5', 'NaN', null, undefined, {}]
    for (const value of values) {
      expect(isNumberNaN(value)).toBe(Number.isNaN(value))
    }
  })

  it('downlevelNumberIsFinite matches native Number.isFinite for every value type', () => {
    const isNumberFinite = compileHelper('downlevelNumberIsFinite', isUnaryPredicateHelper)
    const values: unknown[] = [NaN, 0, 1, Infinity, -Infinity, '5', null, undefined, {}]
    for (const value of values) {
      expect(isNumberFinite(value)).toBe(Number.isFinite(value))
    }
  })

  it('downlevelNumberIsInteger matches native Number.isInteger for every value type', () => {
    const isNumberInteger = compileHelper('downlevelNumberIsInteger', isUnaryPredicateHelper)
    const values: unknown[] = [
      NaN,
      Infinity,
      -Infinity,
      2.5,
      -0,
      0,
      1,
      9007199254740991,
      9007199254740992,
      '5',
      null,
      undefined,
      {},
    ]
    // Testing Number.isInteger specifically (not Number.isSafeInteger) is the point of this test.
    for (const value of values) {
      // eslint-disable-next-line unicorn/prefer-number-is-safe-integer
      expect(isNumberInteger(value)).toBe(Number.isInteger(value))
    }
  })

  it('downlevelNumberIsSafeInteger matches native Number.isSafeInteger for every value type', () => {
    const isNumberSafeInteger = compileHelper(
      'downlevelNumberIsSafeInteger',
      isUnaryPredicateHelper
    )
    const values: unknown[] = [
      NaN,
      Infinity,
      2.5,
      0,
      9007199254740991,
      9007199254740992,
      -9007199254740991,
      -9007199254740992,
      '5',
      null,
      {},
    ]
    for (const value of values) {
      expect(isNumberSafeInteger(value)).toBe(Number.isSafeInteger(value))
    }
  })

  // --- #12 Array find family -----------------------------------------------------------------

  it('downlevelArrayFind/findIndex/findLast/findLastIndex match native, including a thisArg and a no-match case', () => {
    const findHelper = compileHelper('downlevelArrayFind', isFindFamilyHelper)
    const findIndexHelper = compileHelper('downlevelArrayFindIndex', isFindFamilyHelper)
    const findLastHelper = compileHelper('downlevelArrayFindLast', isFindFamilyHelper)
    const findLastIndexHelper = compileHelper('downlevelArrayFindLastIndex', isFindFamilyHelper)

    const array = [1, 5, 3, 8, 2, 5]

    // Wrapped in inline arrows (rather than passed by reference) so native and the helper both
    // observe the exact same predicate identity per call, matching this repository's
    // no-array-callback-reference convention.
    expect(findHelper(array, isBiggerThanThree)).toBe(array.find((v) => isBiggerThanThree(v)))
    expect(findHelper(array, isBiggerThanOneHundred)).toBe(
      array.find((v) => isBiggerThanOneHundred(v))
    )
    expect(findIndexHelper(array, isBiggerThanThree)).toBe(
      array.findIndex((v) => isBiggerThanThree(v))
    )
    expect(findLastHelper(array, isBiggerThanThree)).toBe(
      array.findLast((v) => isBiggerThanThree(v))
    )
    expect(findLastIndexHelper(array, isBiggerThanThree)).toBe(
      array.findLastIndex((v) => isBiggerThanThree(v))
    )

    const thisArgument = { threshold: 4 }
    expect(findHelper(array, isBiggerThanThisThreshold, thisArgument)).toBe(
      // eslint-disable-next-line unicorn/no-array-method-this-argument, unicorn/no-array-callback-reference -- verifying the helper's thisArg forwarding against native Array#find's own thisArg support is the point of this comparison
      array.find(isBiggerThanThisThreshold, thisArgument)
    )
  })

  it('downlevelArrayFind/findIndex capture the length once — a self-growing predicate terminates like native', () => {
    const findHelper = compileHelper('downlevelArrayFind', isFindFamilyHelper)
    const findIndexHelper = compileHelper('downlevelArrayFindIndex', isFindFamilyHelper)

    expect(runGrowingArrayFind((array, isMatch) => findHelper(array, isMatch))).toStrictEqual(
      runGrowingArrayFind((array, isMatch) => array.find((v) => isMatch(v)))
    )
    expect(runGrowingArrayFind((array, isMatch) => findIndexHelper(array, isMatch))).toStrictEqual(
      runGrowingArrayFind((array, isMatch) => array.findIndex((v) => isMatch(v)))
    )
  })

  // --- #13/#14 String#repeat / padStart / padEnd ---------------------------------------------

  it('downlevelStringRepeat matches native String#repeat, including the RangeError cases', () => {
    const helper = compileHelper('downlevelStringRepeat', isRepeatHelper)
    const counts = [0, 1, 3, 2.9, NaN, -0.5, -0]
    for (const count of counts) {
      expect(helper('ab', count)).toBe('ab'.repeat(count))
    }
    for (const count of [-1, -Infinity, Infinity]) {
      expect(isNormalizedError(noThrow(() => 'ab'.repeat(count)))).toBe(true)

      const result = noThrow(() => helper('ab', count))
      if (!isNormalizedError(result) || !hasErrorName(result.originalValue)) {
        throw new Error(`Expected downlevelStringRepeat(${count}) to throw an error-shaped value.`)
      }
      expect(result.originalValue.name).toBe('RangeError')
    }
  })

  it('downlevelStringPadStart matches native String#padStart across fill/length combinations', () => {
    const helper = compileHelper('downlevelStringPadStart', isPadHelper)
    const cases: [string, number, string | undefined][] = [
      ['ab', 5, undefined],
      ['ab', 5, 'xyz'],
      ['ab', 1, 'x'],
      ['ab', 5, ''],
      ['ab', -1, 'x'],
      ['ab', 5, 'abc'],
    ]
    for (const [s, length, pad] of cases) {
      expect(helper(s, length, pad)).toBe(
        pad === undefined ? s.padStart(length) : s.padStart(length, pad)
      )
    }
  })

  it('downlevelStringPadEnd matches native String#padEnd across fill/length combinations', () => {
    const helper = compileHelper('downlevelStringPadEnd', isPadHelper)
    const cases: [string, number, string | undefined][] = [
      ['ab', 5, undefined],
      ['ab', 5, 'xyz'],
      ['ab', 1, 'x'],
      ['ab', 5, ''],
      ['ab', -1, 'x'],
      ['ab', 5, 'abc'],
    ]
    for (const [s, length, pad] of cases) {
      expect(helper(s, length, pad)).toBe(
        pad === undefined ? s.padEnd(length) : s.padEnd(length, pad)
      )
    }
  })

  // --- #15 Object.values / Object.entries ------------------------------------------------------

  it('downlevelObjectValues matches native Object.values, including an empty object', () => {
    const helper = compileHelper('downlevelObjectValues', isObjectIterableHelper)
    expect(helper({ a: 1, b: 2, c: 3 })).toStrictEqual(Object.values({ a: 1, b: 2, c: 3 }))
    expect(helper({})).toStrictEqual(Object.values({}))
  })

  it('downlevelObjectEntries matches native Object.entries, including an empty object', () => {
    const helper = compileHelper('downlevelObjectEntries', isObjectIterableHelper)
    expect(helper({ a: 1, b: 2, c: 3 })).toStrictEqual(Object.entries({ a: 1, b: 2, c: 3 }))
    expect(helper({})).toStrictEqual(Object.entries({}))
  })

  // --- #16 Array#toSpliced ---------------------------------------------------------------------

  it('downlevelArrayToSpliced matches native Array#toSpliced across start/deleteCount/insert combinations', () => {
    const helper = compileHelper('downlevelArrayToSpliced', isToSplicedHelper)
    const array = [1, 2, 3, 4]
    expect(helper(array, 1)).toStrictEqual(array.toSpliced(1))
    expect(helper(array, 1, 2, 9, 8)).toStrictEqual(array.toSpliced(1, 2, 9, 8))
    expect(helper(array, -2, 1)).toStrictEqual(array.toSpliced(-2, 1))
    expect(helper(array, 10, 5, 99)).toStrictEqual(array.toSpliced(10, 5, 99))
    // The original array must be left untouched (non-mutating, like native toSpliced).
    expect(array).toStrictEqual([1, 2, 3, 4])
  })

  it('downlevelArrayToSpliced distinguishes an omitted deleteCount from an explicit undefined', () => {
    const helper = compileHelper('downlevelArrayToSpliced', isToSplicedHelper)
    const array = [1, 2, 3, 4, 5]
    // Omitted: delete to the end. Explicit undefined: ToIntegerOrInfinity(undefined) is 0 —
    // delete nothing. Native distinguishes the two by argument count.
    expect(helper(array, 1)).toStrictEqual(array.toSpliced(1))
    expect(helper(array, 1, undefined)).toStrictEqual(array.toSpliced(1, undefined))
    expect(helper(array, 1, undefined)).toStrictEqual([1, 2, 3, 4, 5])
    // The with-items form is compared against a literal: TypeScript's 3-argument `toSpliced`
    // overload requires a `number` deleteCount, so the native call is not type-expressible
    // with an explicit `undefined` (at runtime it deletes nothing and inserts before index 1).
    expect(helper(array, 1, undefined, 9)).toStrictEqual([1, 9, 2, 3, 4, 5])
  })
})

// ---------------------------------------------------------------------------
// Runtime equivalence for INLINE rewrite shapes (not just emitted helpers)
// ---------------------------------------------------------------------------

/**
 * Extract the initializer text of `const result = ...` from an already-rewritten source
 * file — the exact rewritten expression the build would ship, used verbatim (not
 * re-implemented) as the equivalence-test subject.
 *
 * @param sourceFile - An already-rewritten source file (see {@link rewrite}).
 *
 * @returns The initializer's exact source text.
 */
const extractRewrittenExpression = (sourceFile: SourceFile): string =>
  sourceFile.getVariableDeclarationOrThrow('result').getInitializerOrThrow().getText()

const isCallable = functionGuard<(...arguments_: unknown[]) => unknown>()

/**
 * Compile a rewritten expression (see {@link extractRewrittenExpression}) into a callable
 * function over `parameterNames`, using the same transpile-then-vm-execute approach as
 * {@link compileHelper} — running the exact code the build would ship, rather than
 * re-implementing the rewrite by hand in the test (which could hide the same bug the rewrite
 * itself has — the class of failure the replaceAll `$`-substitution regression test guards
 * against).
 *
 * @param parameterNames - The rewritten expression's free variable names, in argument order.
 * @param expressionText - The rewritten expression's exact source text.
 *
 * @returns A callable function wrapping the expression.
 */
const compileRewrittenExpression = (
  parameterNames: string[],
  expressionText: string
): ((...arguments_: unknown[]) => unknown) => {
  const source = `const rewrittenFunction = (${parameterNames.join(', ')}) => (${expressionText})`
  const transpiled = transpileModule(source, {
    compilerOptions: { target: CompilerScriptTarget.ES2019 },
  }).outputText
  const evaluated: unknown = runInNewContext(`${transpiled}; rewrittenFunction`)
  if (!isCallable(evaluated)) {
    throw new Error('Compiled rewritten expression did not evaluate to a function.')
  }
  return evaluated
}

/**
 * Run a whole source snippet through the catalog, transpile it, and return the function bound
 * to `run` — the statement-level counterpart of {@link compileRewrittenExpression}, for
 * rewrites (like the `.entries()` for...of loop) that replace statements rather than
 * expressions. The snippet must declare `run` as a top-level `const`.
 *
 * @param sourceText - The TypeScript source to rewrite and compile.
 *
 * @returns The compiled function, running the exact rewritten code the build would ship.
 */
const compileRewrittenFunction = (sourceText: string): ((...arguments_: unknown[]) => unknown) => {
  const rewrittenText = rewrite(sourceText).getFullText()
  const transpiled = transpileModule(rewrittenText, {
    compilerOptions: { target: CompilerScriptTarget.ES2019 },
  }).outputText
  const evaluated: unknown = runInNewContext(`${transpiled}; run`)
  if (!isCallable(evaluated)) {
    throw new Error('Compiled snippet did not evaluate "run" to a function.')
  }
  return evaluated
}

describe('downlevel inline rewrites - runtime equivalence with the native methods', () => {
  it('#1 literal-array comparison chain matches native Array#includes, including a NaN element', () => {
    const sourceFile = rewrite('declare const x: number\nconst result = [1, NaN, 3].includes(x)\n')
    const rewritten = compileRewrittenExpression(['x'], extractRewrittenExpression(sourceFile))
    for (const x of [1, 2, 3, NaN, -1, 0]) {
      expect(rewritten(x)).toBe([1, NaN, 3].includes(x))
    }
  })

  it('#1 indexOf !== -1 matches native String#includes', () => {
    const sourceFile = rewrite(
      'declare const s: string\ndeclare const y: string\nconst result = s.includes(y)\n'
    )
    const rewritten = compileRewrittenExpression(['s', 'y'], extractRewrittenExpression(sourceFile))
    const strings = ['', 'a', 'abc', 'aabc']
    const patterns = ['', 'a', 'ab', 'bc', 'abcd']
    for (const s of strings) {
      for (const y of patterns) {
        expect(rewritten(s, y)).toBe(s.includes(y))
      }
    }
  })

  it('#2 lastIndexOf(p, 0) === 0 matches native String#startsWith', () => {
    const sourceFile = rewrite(
      'declare const s: string\ndeclare const p: string\nconst result = s.startsWith(p)\n'
    )
    const rewritten = compileRewrittenExpression(['s', 'p'], extractRewrittenExpression(sourceFile))
    const strings = ['', 'a', 'abc', 'aabc']
    const patterns = ['', 'a', 'ab', 'bc', 'abcd']
    for (const s of strings) {
      for (const p of patterns) {
        expect(rewritten(s, p)).toBe(s.startsWith(p))
      }
    }
  })

  it('#3 slice-compare matches native String#endsWith for simple operands', () => {
    const sourceFile = rewrite(
      'declare const s: string\ndeclare const p: string\nconst result = s.endsWith(p)\n'
    )
    const rewritten = compileRewrittenExpression(['s', 'p'], extractRewrittenExpression(sourceFile))
    const strings = ['', 'a', 'abc', 'aabc']
    const patterns = ['', 'a', 'ab', 'bc', 'abcd']
    for (const s of strings) {
      for (const p of patterns) {
        expect(rewritten(s, p)).toBe(s.endsWith(p))
      }
    }
  })

  it('#5 slice().sort() matches native Array#toSorted without mutating the receiver', () => {
    const sourceFile = rewrite('declare const arr: number[]\nconst result = arr.toSorted()\n')
    const rewritten = compileRewrittenExpression(['arr'], extractRewrittenExpression(sourceFile))
    const array = [3, 1, 2]
    // No comparator, matching the no-comparator rewrite form under test.
    // eslint-disable-next-line unicorn/require-array-sort-compare
    expect(rewritten(array)).toStrictEqual([3, 1, 2].toSorted())
    expect(array).toStrictEqual([3, 1, 2])
  })

  it('#5 slice().reverse() matches native Array#toReversed without mutating the receiver', () => {
    const sourceFile = rewrite('declare const arr: number[]\nconst result = arr.toReversed()\n')
    const rewritten = compileRewrittenExpression(['arr'], extractRewrittenExpression(sourceFile))
    const array = [3, 1, 2]
    expect(rewritten(array)).toStrictEqual([3, 1, 2].toReversed())
    expect(array).toStrictEqual([3, 1, 2])
  })

  it('#6 split(a).join(b) matches native String#replaceAll for a non-empty literal search and a $-free literal replacement', () => {
    const strings = ['', 'a-b', 'a-b-c', 'aaa']
    for (const search of ['-', 'a', 'aa']) {
      const sourceFile = rewrite(
        `declare const s: string\nconst result = s.replaceAll('${search}', 'X')\n`
      )
      const rewritten = compileRewrittenExpression(['s'], extractRewrittenExpression(sourceFile))
      for (const s of strings) {
        expect(rewritten(s)).toBe(s.replaceAll(search, 'X'))
      }
    }
  })

  it('#4 hasOwnProperty.call matches native Object.hasOwn', () => {
    const sourceFile = rewrite(
      'declare const o: object\ndeclare const k: string\nconst result = Object.hasOwn(o, k)\n'
    )
    const rewritten = compileRewrittenExpression(['o', 'k'], extractRewrittenExpression(sourceFile))
    expect(rewritten({ a: 1 }, 'a')).toBe(Object.hasOwn({ a: 1 }, 'a'))
    expect(rewritten({ a: 1 }, 'b')).toBe(Object.hasOwn({ a: 1 }, 'b'))
    expect(rewritten({}, 'toString')).toBe(Object.hasOwn({}, 'toString'))
  })

  it('#10 direct/length-relative indexing matches native Array#at for literal indexes', () => {
    const array = ['x', 'y', 'z']
    for (let index = -4; index <= 4; index++) {
      const sourceFile = rewrite(`declare const arr: string[]\nconst result = arr.at(${index})\n`)
      const rewritten = compileRewrittenExpression(['arr'], extractRewrittenExpression(sourceFile))
      expect(rewritten(array)).toBe(array.at(index))
    }
  })

  it('#10 direct/length-relative indexing matches native String#at for literal indexes', () => {
    const text = 'xyz'
    for (let index = -4; index <= 4; index++) {
      const sourceFile = rewrite(`declare const s: string\nconst result = s.at(${index})\n`)
      const rewritten = compileRewrittenExpression(['s'], extractRewrittenExpression(sourceFile))
      expect(rewritten(text)).toBe(text.at(index))
    }
  })

  it('#8 String.raw constant fold matches the native tagged-template value', () => {
    const sourceFile = rewrite('const result = String.raw`a\\nb\\\\c`\n')
    const rewritten = extractRewrittenExpression(sourceFile)
    const evaluated: unknown = runInNewContext(rewritten)
    expect(evaluated).toBe(String.raw`a\nb\\c`)
  })

  it('#11 (x !== x) matches native Number.isNaN for a number-typed simple operand', () => {
    const sourceFile = rewrite('declare const x: number\nconst result = Number.isNaN(x)\n')
    const rewritten = compileRewrittenExpression(['x'], extractRewrittenExpression(sourceFile))
    for (const x of [NaN, 0, 1, -1, Infinity, -Infinity]) {
      expect(rewritten(x)).toBe(Number.isNaN(x))
    }
  })

  it('#11 global isFinite(x) matches native Number.isFinite for a number-typed operand', () => {
    const sourceFile = rewrite('declare const x: number\nconst result = Number.isFinite(x)\n')
    const rewritten = compileRewrittenExpression(['x'], extractRewrittenExpression(sourceFile))
    for (const x of [NaN, 0, 1, -1, Infinity, -Infinity]) {
      expect(rewritten(x)).toBe(Number.isFinite(x))
    }
  })

  it('#11 constant folds match the native Number static values exactly', () => {
    const epsilon = rewrite('const result = Number.EPSILON\n')
    expect(runInNewContext(extractRewrittenExpression(epsilon))).toBe(Number.EPSILON)

    const maxSafe = rewrite('const result = Number.MAX_SAFE_INTEGER\n')
    expect(runInNewContext(extractRewrittenExpression(maxSafe))).toBe(Number.MAX_SAFE_INTEGER)

    const minSafe = rewrite('const result = Number.MIN_SAFE_INTEGER\n')
    expect(runInNewContext(extractRewrittenExpression(minSafe))).toBe(Number.MIN_SAFE_INTEGER)
  })
})

// ---------------------------------------------------------------------------
// #6 — replaceAll bug-fix regression + full coverage (exact-output cases)
// ---------------------------------------------------------------------------

describe('downlevel catalog #6 - String#replaceAll (full coverage)', () => {
  it('regression: a $-containing string replacement must not be routed through split/join', () => {
    const sourceFile = rewrite("declare const s: string\nconst v = s.replaceAll('-', '$&$&')\n")
    const text = sourceFile.getFullText()
    expect(text).not.toContain(".split('-').join('$&$&')")
    expect(text).toContain("downlevelReplaceAllString(s, '-', '$&$&')")
  })

  it('keeps the split/join fast path for a provably $-free literal replacement', () => {
    const sourceFile = rewrite("declare const s: string\nconst v = s.replaceAll('-', 'X')\n")
    expect(sourceFile.getFullText()).toBe(
      "declare const s: string\nconst v = s.split('-').join('X')\n"
    )
  })

  it('keeps the split/join fast path for a $-free no-substitution template replacement', () => {
    const sourceFile = rewrite("declare const s: string\nconst v = s.replaceAll('-', `X`)\n")
    expect(sourceFile.getFullText()).toBe(
      "declare const s: string\nconst v = s.split('-').join(`X`)\n"
    )
  })

  it('rewrites a global RegExp literal to .replace() directly (arbitrary replacement OK)', () => {
    const sourceFile = rewrite(
      "declare function getReplacement(): string\nconst v = 'a-b'.replaceAll(/-/g, getReplacement())\n"
    )
    expect(sourceFile.getFullText()).toBe(
      "declare function getReplacement(): string\nconst v = 'a-b'.replace(/-/g, getReplacement())\n"
    )
  })

  it('refuses a RegExp literal without the g flag — native replaceAll always throws for it', () => {
    expectRefusal("const v = 'a-b'.replaceAll(/-/, 'y')\n", [
      'without the `g` flag throws a TypeError at runtime',
      'add the `g` flag to the regular expression',
    ])
  })

  it('falls back to the RegExp helper for a non-literal RegExp search value', () => {
    const sourceFile = rewrite(
      "declare const s: string\ndeclare const re: RegExp\nconst v = s.replaceAll(re, 'y')\n"
    )
    const text = sourceFile.getFullText()
    expect(text).toContain('function downlevelReplaceAllRegExp(')
    expect(text).toContain("const v = downlevelReplaceAllRegExp(s, re, 'y')")
  })

  it('falls back to the string-function helper for a string search with a function replacer', () => {
    const sourceFile = rewrite(
      "declare const s: string\ndeclare const fn: (m: string, p: number, full: string) => string\nconst v = s.replaceAll('x', fn)\n"
    )
    const text = sourceFile.getFullText()
    expect(text).toContain('const downlevelReplaceAllStringFunction = (')
    expect(text).toContain("const v = downlevelReplaceAllStringFunction(s, 'x', fn)")
  })
})

// ---------------------------------------------------------------------------
// #11 — Number statics (exact-output cases)
// ---------------------------------------------------------------------------

describe('downlevel catalog #11 - Number statics', () => {
  it('rewrites Number.isNaN(x) to (x !== x) for a simple number-typed operand', () => {
    const sourceFile = rewrite('declare const x: number\nconst v = Number.isNaN(x)\n')
    expect(sourceFile.getFullText()).toBe('declare const x: number\nconst v = (x !== x)\n')
  })

  it('falls back to the helper for Number.isNaN on a non-number-typed operand', () => {
    const sourceFile = rewrite('declare const x: unknown\nconst v = Number.isNaN(x)\n')
    const text = sourceFile.getFullText()
    expect(text).toContain('const downlevelNumberIsNaN = (')
    expect(text).toContain('const v = downlevelNumberIsNaN(x)')
  })

  it('rewrites Number.isFinite(x) to global isFinite(x) for a number-typed operand, arbitrary shape', () => {
    const sourceFile = rewrite(
      'declare function getX(): number\nconst v = Number.isFinite(getX())\n'
    )
    expect(sourceFile.getFullText()).toBe(
      'declare function getX(): number\nconst v = isFinite(getX())\n'
    )
  })

  it('falls back to the helper for Number.isFinite on a non-number-typed operand', () => {
    const sourceFile = rewrite('declare const x: unknown\nconst v = Number.isFinite(x)\n')
    const text = sourceFile.getFullText()
    expect(text).toContain('const downlevelNumberIsFinite = (')
    expect(text).toContain('const v = downlevelNumberIsFinite(x)')
  })

  it('always uses the helper for Number.isInteger and Number.isSafeInteger', () => {
    const integerRewrite = rewrite('declare const x: number\nconst v = Number.isInteger(x)\n')
    expect(integerRewrite.getFullText()).toContain('const v = downlevelNumberIsInteger(x)')

    const safeIntegerRewrite = rewrite(
      'declare const x: number\nconst v = Number.isSafeInteger(x)\n'
    )
    expect(safeIntegerRewrite.getFullText()).toContain('const v = downlevelNumberIsSafeInteger(x)')
  })

  it('constant-folds Number.EPSILON / MAX_SAFE_INTEGER / MIN_SAFE_INTEGER', () => {
    expect(rewrite('const v = Number.EPSILON\n').getFullText()).toBe(
      'const v = 2.220446049250313e-16\n'
    )
    expect(rewrite('const v = Number.MAX_SAFE_INTEGER\n').getFullText()).toBe(
      'const v = 9007199254740991\n'
    )
    expect(rewrite('const v = Number.MIN_SAFE_INTEGER\n').getFullText()).toBe(
      'const v = (-9007199254740991)\n'
    )
  })

  it('parenthesizes the MIN_SAFE_INTEGER fold so a following member access still parses correctly', () => {
    const sourceFile = rewrite('const v = Number.MIN_SAFE_INTEGER.toString()\n')
    expect(sourceFile.getFullText()).toBe('const v = (-9007199254740991).toString()\n')
  })
})

// ---------------------------------------------------------------------------
// #12 — Array find family (exact-output cases)
// ---------------------------------------------------------------------------

describe('downlevel catalog #12 - Array#find family', () => {
  it('always uses a helper for find/findIndex/findLast/findLastIndex, arbitrary operands', () => {
    const cases: [string, string][] = [
      ['find', 'downlevelArrayFind'],
      ['findIndex', 'downlevelArrayFindIndex'],
      ['findLast', 'downlevelArrayFindLast'],
      ['findLastIndex', 'downlevelArrayFindLastIndex'],
    ]
    for (const [method, helperName] of cases) {
      const sourceFile = rewrite(
        `declare function getArr(): number[]\ndeclare function getPred(): (v: number) => boolean\nconst v = getArr().${method}(getPred())\n`
      )
      expect(sourceFile.getFullText()).toContain(`const v = ${helperName}(getArr(), getPred())`)
    }
  })

  it('forwards an optional thisArg argument', () => {
    const sourceFile = rewrite(
      'declare const arr: number[]\ndeclare const pred: (v: number) => boolean\ndeclare const thisArg: object\nconst v = arr.find(pred, thisArg)\n'
    )
    expect(sourceFile.getFullText()).toContain('const v = downlevelArrayFind(arr, pred, thisArg)')
  })
})

// ---------------------------------------------------------------------------
// #13/#14 — String#repeat / padStart / padEnd (exact-output cases)
// ---------------------------------------------------------------------------

describe('downlevel catalog #13/#14 - String#repeat / padStart / padEnd', () => {
  it('always uses a helper for repeat, padStart, and padEnd, arbitrary operands', () => {
    const repeat = rewrite(
      'declare const s: string\ndeclare const n: number\nconst v = s.repeat(n)\n'
    )
    expect(repeat.getFullText()).toContain('const v = downlevelStringRepeat(s, n)')

    const padStart = rewrite("declare const s: string\nconst v = s.padStart(5, 'x')\n")
    expect(padStart.getFullText()).toContain("const v = downlevelStringPadStart(s, 5, 'x')")

    const padEnd = rewrite('declare const s: string\nconst v = s.padEnd(5)\n')
    expect(padEnd.getFullText()).toContain('const v = downlevelStringPadEnd(s, 5)')
  })
})

// ---------------------------------------------------------------------------
// #15 — Object.values / Object.entries (exact-output cases)
// ---------------------------------------------------------------------------

describe('downlevel catalog #15 - Object.values / Object.entries', () => {
  it('always uses a helper for Object.values and Object.entries, arbitrary operand', () => {
    const values = rewrite('declare const o: Record<string, number>\nconst v = Object.values(o)\n')
    expect(values.getFullText()).toContain('const v = downlevelObjectValues(o)')

    const entries = rewrite(
      'declare const o: Record<string, number>\nconst v = Object.entries(o)\n'
    )
    expect(entries.getFullText()).toContain('const v = downlevelObjectEntries(o)')
  })
})

// ---------------------------------------------------------------------------
// #16 — Array#toSpliced (exact-output cases)
// ---------------------------------------------------------------------------

describe('downlevel catalog #16 - Array#toSpliced', () => {
  it('always uses a helper, forwarding every argument, arbitrary operands', () => {
    const sourceFile = rewrite('declare const arr: number[]\nconst v = arr.toSpliced(1, 2, 9)\n')
    expect(sourceFile.getFullText()).toContain('const v = downlevelArrayToSpliced(arr, 1, 2, 9)')
  })
})

// ---------------------------------------------------------------------------
// Coverage meta-guard: additions to the catalog must bring their tests along
// ---------------------------------------------------------------------------

describe('downlevel catalog - coverage meta-guard', () => {
  // The README's add-a-catalog-entry checklist ("rule + tests + lint must stay consistent") is
  // enforced here rather than trusted: a rule or helper added without tests fails this suite,
  // not a future code review.
  const ownSource = readFileSync(__filename, 'utf8')
  // Whitespace-normalized view, so formatting (a wrapped call, a re-indented title) never
  // defeats a match.
  const normalizedSource = ownSource.replaceAll(/\s+/g, '')

  it('every catalog rule family has a matching describe block in this file', () => {
    // A describe title may cover several families at once (e.g. "#13/#14"), so collect every
    // family number appearing in any "downlevel catalog ..." title.
    const coveredFamilies = new Set(
      ownSource
        .matchAll(/downlevel catalog ([^']*)/g)
        .flatMap((titleMatch) =>
          titleMatch[1].matchAll(/#(\d+)/g).map((numberMatch) => numberMatch[1])
        )
    )
    const missingFamilies = CATALOG_RULES.map((rule) => rule.id)
      .map((id) => /^#(?<familyNumber>\d+) /.exec(id)?.groups?.familyNumber)
      .filter((familyNumber): familyNumber is string => familyNumber !== undefined)
      .filter((familyNumber, index, families) => families.indexOf(familyNumber) === index)
      .filter((familyNumber) => !coveredFamilies.has(familyNumber))
    expect(missingFamilies).toStrictEqual([])
  })

  it('every emitted helper is exercised by at least one compileHelper equivalence test', () => {
    const unexercisedHelpers = Object.keys(HELPER_SOURCE).filter(
      (helperName) => !normalizedSource.includes(`compileHelper('${helperName}'`)
    )
    expect(unexercisedHelpers).toStrictEqual([])
  })
})

// ---------------------------------------------------------------------------
// The ES5 output gate itself (verify-es5-output.ts)
// ---------------------------------------------------------------------------

describe('ES5 output gate (verify-es5-output)', () => {
  const temporaryDirectories: string[] = []

  afterAll(() => {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  /** The outcome of one gate run, as observed from its subprocess. */
  type GateRun = {
    /** The `GATE_PASSED` / `GATE_FAILED: <message>` verdict line. */
    verdict: string
    /** The gate's per-violation report lines (`✖ <file>:<line>:<column> <message> (<rule>)`). */
    reportLines: string[]
  }

  /**
   * Run the gate over a probe directory that `populate` fills with the files to verify. The
   * gate runs in a `tsx` subprocess because `ESLint`'s flat-config machinery uses dynamic
   * `import()`, which Jest's module sandbox rejects. The subprocess's runner script is a `.mts`
   * file inside the probe directory, which the gate (verifying `.js` files only) never lints.
   *
   * @param populate - Creates the probe's files inside the (empty) directory it is given.
   * @param sourceType - How the gate parses the probe: `script` (the CJS build, the default) or
   *   `module` (the ESM build).
   *
   * @returns The subprocess's verdict line and the gate's per-violation report lines.
   */
  const runGate = (
    populate: (directory: string) => void,
    sourceType: 'module' | 'script' = 'script'
  ): GateRun => {
    const directory = mkdtempSync(path.join(tmpdir(), 'es5-gate-'))
    temporaryDirectories.push(directory)
    populate(directory)
    const runnerPath = path.join(directory, 'runner.mts')
    const verifierPath = path.resolve('src/build-scripts/verify-es5-output.ts')
    const noThrowPath = path.resolve('utilities/no-throw.ts')
    writeFileSync(
      runnerPath,
      `import { verifyEs5Output } from ${JSON.stringify(verifierPath)}\n` +
        `import { isNormalizedError, noThrow } from ${JSON.stringify(noThrowPath)}\n` +
        `const outcome = await noThrow(() => verifyEs5Output(${JSON.stringify(directory)}, ${JSON.stringify(sourceType)}))\n` +
        'console.log(isNormalizedError(outcome) ? `GATE_FAILED: ${outcome.message}` : `GATE_PASSED`)\n'
    )
    // The verdict is printed on stdout, the gate's report on stderr.
    const run = spawnSync('npx', ['tsx', runnerPath], { encoding: 'utf8' })
    return {
      verdict: run.stdout,
      reportLines: run.stderr.split('\n').filter((line) => line.trimStart().startsWith('✖ ')),
    }
  }

  /**
   * Run the gate over a single-file probe directory (`probe.js`) and return its verdict line.
   *
   * @param content - The JavaScript content of the probe file.
   * @param sourceType - How the gate parses the probe (see {@link runGate}).
   *
   * @returns The subprocess's `GATE_PASSED` / `GATE_FAILED: <message>` verdict line.
   */
  const gateVerdictFor = (content: string, sourceType: 'module' | 'script' = 'script'): string =>
    runGate((directory) => {
      writeFileSync(path.join(directory, 'probe.js'), content)
    }, sourceType).verdict

  /**
   * Run the gate over a single-file probe directory (`probe.js`) and return the line numbers of
   * its reported violations, one entry per violation (so a line reported twice appears twice).
   *
   * @param content - The JavaScript content of the probe file.
   * @param sourceType - How the gate parses the probe (see {@link runGate}).
   *
   * @returns The verdict line and the sorted line numbers of the reported violations.
   */
  const reportedLinesFor = (
    content: string,
    sourceType: 'module' | 'script' = 'script'
  ): { verdict: string; lineNumbers: number[] } => {
    const { verdict, reportLines } = runGate((directory) => {
      writeFileSync(path.join(directory, 'probe.js'), content)
    }, sourceType)
    const lineNumbers = reportLines.map((reportLine) =>
      Number(/probe\.js:(\d+):\d+ /.exec(reportLine)?.[1])
    )
    return { verdict, lineNumbers: lineNumbers.toSorted((left, right) => left - right) }
  }

  it('rejects a post-ES5 prototype-method call on a variable receiver (aggressive mode)', () => {
    // Without aggressive mode, es-x only fires on literal receivers — this variable-receiver
    // shape (the shape every real escape takes) would pass silently.
    const verdict = gateVerdictFor('var value = "abc"\nvar found = value.includes("a")\n')
    expect(verdict).toContain('GATE_FAILED')
    expect(verdict).toContain('post-ES5 construct')
  })

  it('accepts ES5 code, including static-namespace calls and array methods whose names collide with post-ES5 rules', () => {
    // `Object.keys` name-matches the ES2015 `Array#keys` rule and `.map`/`.filter` name-match
    // the ES2025 iterator-helper rules; all are legitimate ES5 here.
    const verdict = gateVerdictFor(
      'var keys = Object.keys({ a: 1 })\n' +
        'var mapped = keys.map(function (k) { return k })\n' +
        'var filtered = mapped.filter(function (k) { return k })\n'
    )
    expect(verdict).toContain('GATE_PASSED')
  })

  it.each(['script', 'module'] as const)(
    'accepts every ES5 static member of the ES5 global namespaces (%s)',
    (sourceType) => {
      // The gate filters no es-x finding after the fact, so this relies on es-x's type tracer
      // knowing each namespace's type: an aggressive-mode name match against a post-ES5
      // prototype rule (`Object.keys` vs `Array#keys`) would otherwise fail the build here.
      const es5StaticMembers: Record<string, string[]> = {
        Object: [
          'getPrototypeOf',
          'getOwnPropertyDescriptor',
          'getOwnPropertyNames',
          'create',
          'defineProperty',
          'defineProperties',
          'seal',
          'freeze',
          'preventExtensions',
          'isSealed',
          'isFrozen',
          'isExtensible',
          'keys',
        ],
        Array: ['isArray'],
        String: ['fromCharCode'],
        Date: ['parse', 'UTC', 'now'],
        JSON: ['parse', 'stringify'],
        Math: 'abs acos asin atan atan2 ceil cos exp floor log max min pow random round sin sqrt tan'.split(
          ' '
        ),
      }
      const lines = Object.entries(es5StaticMembers).flatMap(([namespace, members]) =>
        members.map((member) => `${namespace}.${member}(value)`)
      )
      const verdict = gateVerdictFor(
        `var value = {}\n${lines.join('\n')}\n` +
          // ES5 prototype methods borrowed through a global's `prototype` are ES5 as well.
          'Object.prototype.hasOwnProperty.call(value, "a")\n' +
          'Object.prototype.toString.call(value)\n' +
          'Array.prototype.slice.call([value])\n',
        sourceType
      )
      expect(verdict).toContain('GATE_PASSED')
    }
  )

  it('exempts an allowlisted SWC helper but rejects the same body under a rogue name (fail-closed)', () => {
    // The body is post-ES5 usage es-x reports. (A `typeof Symbol !== "undefined"` or
    // `if (Object.getOwnPropertySymbols)` guard would not change that: with the rules' default
    // options, es-x reports feature-detected usage too — which is why SWC's guarded helpers
    // need this exemption at all.)
    const unguardedBody = '  return Object.getOwnPropertySymbols(value)\n'
    const allowlisted = `function _instanceof(value) {\n${unguardedBody}}\n`
    expect(gateVerdictFor(allowlisted)).toContain('GATE_PASSED')

    const rogue = `function _rogue_helper(value) {\n${unguardedBody}}\n`
    const rogueVerdict = gateVerdictFor(rogue)
    expect(rogueVerdict).toContain('GATE_FAILED')
    expect(rogueVerdict).toContain('post-ES5 construct')
  })

  it('ignores eslint-disable comments surviving from the source (the gate cannot be switched off)', () => {
    // A file-level directive, a next-line directive naming the violated rule, and an inline
    // rule configuration: none may hide the post-ES5 call from the gate.
    for (const directive of [
      '/* eslint-disable */',
      '// eslint-disable-next-line es-x/no-array-prototype-includes',
      '/* eslint es-x/no-array-prototype-includes: "off" */',
    ]) {
      const verdict = gateVerdictFor(`${directive}\nvar found = [1].includes(1)\n`)
      expect(verdict).toContain('GATE_FAILED')
      expect(verdict).toContain('post-ES5 construct')
    }
  })

  it('rejects a file that does not parse, even when the parse error quotes an ignored-directive notice', () => {
    // A parse error leaves the whole file unchecked, and its message quotes the offending
    // token — here, the very text the ignored-directive filter looks for.
    const verdict = gateVerdictFor(
      'var value = 1 "\'noInlineConfig\' setting"\nvar found = [1].includes(1)\n'
    )
    expect(verdict).toContain('GATE_FAILED')
    expect(verdict).toContain('post-ES5 construct')
  })

  it('accepts ES5 code that carries eslint-disable comments for source-level rules', () => {
    // Directives naming core rules or other plugins' rules are leftovers of the source-level
    // lint; being ignored here must not turn them into violations.
    const verdict = gateVerdictFor(
      '// eslint-disable-next-line no-control-regex, unicorn/no-null -- reason\n' +
        'var controlCharacters = /[\\u0000-\\u001F]/\n'
    )
    expect(verdict).toContain('GATE_PASSED')
  })

  it('never skips genuine post-ES5 static APIs on ES5 global namespaces', () => {
    // A static member on an ES5 namespace is not ES5 by virtue of its namespace — an escaped
    // `Object.entries(...)` is a real ES2017 usage and must fail the gate.
    const verdict = gateVerdictFor('var entries = Object.entries({ a: 1 })\n')
    expect(verdict).toContain('GATE_FAILED')
    expect(verdict).toContain('post-ES5 construct')
  })

  it('never skips a post-ES5 prototype method spelled through a global (Array.prototype.includes)', () => {
    // The member expression's text starts with an ES5 global's name, but a
    // `Global.prototype.…` receiver is a genuine prototype-method usage, not a static call —
    // whether called directly or borrowed through `.call`.
    const lines = [
      'var found = Array.prototype.includes([1])',
      'var borrowed = Array.prototype.includes.call([1], 1)',
    ]
    const verdict = gateVerdictFor(`${lines.join('\n')}\n`)
    expect(verdict).toContain(`contains ${lines.length} post-ES5 construct(s)`)
  })

  it.each(['script', 'module'] as const)(
    'reports every post-ES5 global and static member exactly once (%s)',
    (sourceType) => {
      // es-x's global rules only see references that resolve to a declared global variable.
      // ESLint declares only the globals of the parsing `ecmaVersion` (5 for `script`, 2015 for
      // `module`), so without the gate declaring the newer ones, a bare `new Map()` in the CJS
      // build (or `globalThis` in either build) is an unresolved reference es-x never reports.
      // One construct per line: every line number must appear exactly once in the report, which
      // proves that every line is seen and that none is counted twice (a total alone could hide
      // one line reported twice and another not at all).
      const lines = [
        'var map = new Map()',
        'var set = new Set()',
        'var weakMap = new WeakMap()',
        'var symbol = Symbol("x")',
        'var promise = Promise.resolve()',
        'var proxy = new Proxy({}, {})',
        'var ownKeys = Reflect.ownKeys({})',
        'var bytes = new Uint8Array(2)',
        'var root = globalThis',
        'var big = BigInt(1)',
        'var weakRef = new WeakRef({})',
        // Post-ES5 globals that no `restrict-to-es5` es-x rule reports: no es-x rule exists
        // for the first two, and the rules for the next three exist only in es-x's esnext
        // configuration. Temporal is not listed in any ECMAScript edition of `globals` yet.
        'var buffer = new ArrayBuffer(8)',
        'var collator = new Intl.Collator()',
        'var stack = new DisposableStack()',
        'var asyncStack = new AsyncDisposableStack()',
        'var suppressed = new SuppressedError()',
        'var now = Temporal.Now',
        // The esnext prototype methods the gate enables individually (variable receivers).
        'var instant = value.toTemporalInstant()',
        'var chunks = value.chunks(2)',
        'var windows = value.windows(2)',
        // Post-ES5 static members of ES5 globals must stay reported alongside them.
        'var entries = Object.entries({})',
        'var array = Array.from([])',
        'var isNotANumber = Number.isNaN(1)',
        'var truncated = Math.trunc(1.5)',
      ]
      const { verdict, lineNumbers } = reportedLinesFor(`${lines.join('\n')}\n`, sourceType)
      expect(lineNumbers).toStrictEqual(lines.map((_line, index) => index + 1))
      expect(verdict).toContain(`contains ${lines.length} post-ES5 construct(s)`)
    }
  )

  it.each(['script', 'module'] as const)(
    'reports a reference to every non-ES5 ECMAScript built-in global exactly once (%s)',
    (sourceType) => {
      // Every global `globals` lists for some ECMAScript edition but not for ES5, plus Temporal
      // (see the gate's configuration), whether or not an es-x rule also reports it.
      const postEs5GlobalNames = [
        ...Object.keys(globals.builtin).filter((name) => !Object.hasOwn(globals.es5, name)),
        'Temporal',
      ]
      const lines = postEs5GlobalNames.map((name, index) => `var reference${index} = ${name}`)
      const { verdict, lineNumbers } = reportedLinesFor(`${lines.join('\n')}\n`, sourceType)
      expect(lineNumbers).toStrictEqual(lines.map((_line, index) => index + 1))
      expect(verdict).toContain(`contains ${lines.length} post-ES5 construct(s)`)
    }
  )

  it.each(['script', 'module'] as const)(
    'accepts a reference to every ES5 global (%s)',
    (sourceType) => {
      const lines = Object.keys(globals.es5).map((name, index) => `var reference${index} = ${name}`)
      expect(gateVerdictFor(`${lines.join('\n')}\n`, sourceType)).toContain('GATE_PASSED')
    }
  )

  it('counts a file ESLint does not lint (under node_modules) as a violation, without crashing', () => {
    // ESLint's default ignores (`node_modules/`, `.git/`) apply inside the verified directory:
    // such a file gets a single non-fatal "No matching configuration" message and no
    // `SourceCode`. It is listed after `a.js`, so a gate reusing the linter's last `SourceCode`
    // would resolve this file's line-0 message against `a.js` instead of reporting it.
    const { verdict, reportLines } = runGate((directory) => {
      writeFileSync(path.join(directory, 'a.js'), 'var value = 1\n')
      mkdirSync(path.join(directory, 'node_modules', 'dependency'), { recursive: true })
      writeFileSync(
        path.join(directory, 'node_modules', 'dependency', 'index.js'),
        'var map = new Map()\n'
      )
    })
    expect(verdict).toContain('contains 1 post-ES5 construct(s)')
    expect(reportLines).toHaveLength(1)
    expect(reportLines[0]).toContain(path.join('node_modules', 'dependency', 'index.js'))
  })

  it.each([
    ['a file', true],
    ['a directory', false],
  ])(
    'refuses a directory containing a symbolic link to %s (fail-closed)',
    (_kind, isFileTarget) => {
      // A symbolic link is neither a regular file nor a directory to `readdir`, so the code it
      // leads to would otherwise never be linted. The link target lives outside the probe.
      const outside = mkdtempSync(path.join(tmpdir(), 'es5-gate-outside-'))
      temporaryDirectories.push(outside)
      const targetPath = path.join(outside, isFileTarget ? 'target.js' : 'target')
      if (isFileTarget) {
        writeFileSync(targetPath, 'var map = new Map()\n')
      } else {
        mkdirSync(targetPath)
        writeFileSync(path.join(targetPath, 'index.js'), 'var map = new Map()\n')
      }
      const { verdict } = runGate((directory) => {
        writeFileSync(path.join(directory, 'a.js'), 'var value = 1\n')
        symlinkSync(targetPath, path.join(directory, 'linked.js'))
      })
      expect(verdict).toContain('GATE_FAILED')
      expect(verdict).toContain('linked.js')
    }
  )

  it.each([
    ['\\r', '\r'],
    ['\\r\\n', '\r\n'],
    ['\\u2028', '\u{2028}'],
    ['\\u2029', '\u{2029}'],
  ])(
    'locates findings exactly in a file whose line terminators are %s (helper exemption)',
    (_terminatorName, terminator) => {
      // ESLint counts every ECMAScript line terminator when numbering lines. A finding's
      // position must be resolved the same way, or a violation AFTER an allowlisted SWC helper
      // can resolve to a position INSIDE it and be exempted.
      const content = [
        'function _instanceof(value) {',
        '  return value',
        '}',
        'var found = [1].includes(1)',
        '',
      ].join(terminator)
      expect(gateVerdictFor(content)).toContain('contains 1 post-ES5 construct(s)')
    }
  )

  it('never exempts a parse error located inside an allowlisted SWC helper', () => {
    // A parse error leaves the WHOLE file unchecked (here, the `Map` after the helper too), so
    // its position — inside the helper's text — must not exempt it. Post-ES5 syntax is a
    // parse error in the CJS build (parsed as ES5).
    const verdict = gateVerdictFor(
      'function _instanceof(value) {\n  return () => value\n}\nvar map = new Map()\n'
    )
    expect(verdict).toContain('contains 1 post-ES5 construct(s)')
  })

  it('reports a post-ES5 prototype call chained onto an ES5 global call (Object.keys(o).includes(k))', () => {
    // The flagged member expression's text starts with an ES5 global's name, but its receiver
    // is the call's RESULT (an array, a string), not the global namespace itself.
    const lines = [
      'var hasKey = Object.keys({ a: 1 }).includes("a")',
      'var padded = String.fromCharCode(65).padStart(2)',
    ]
    const verdict = gateVerdictFor(`${lines.join('\n')}\n`)
    expect(verdict).toContain(`contains ${lines.length} post-ES5 construct(s)`)
  })
})
