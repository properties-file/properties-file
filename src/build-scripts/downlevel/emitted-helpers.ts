/**
 * Emitted ES5-safe helper functions for downlevel catalog rewrites that would otherwise need to
 * duplicate a non-simple receiver or argument (see the "simple expression" rule in
 * `helpers.ts`). Rather than refuse those usages, the affected catalog rules in `catalog.ts`
 * request one of these helpers by name; each requested helper is written once, as a plain
 * top-level function declaration inserted immediately after the last import in the shadow-tree
 * copy of the file that used it (see `emitRequestedHelpers`).
 *
 * The generated declarations are ordinary modern TypeScript — they pass through the same
 * `tsc` → esbuild/SWC ES5 downlevel pipeline as every other shadow-tree file, so they don't need
 * to be hand-written in ES5 themselves.
 */
import type { SourceFile } from 'ts-morph'

/**
 * Every emittable downlevel helper name, in emission order. {@link emitRequestedHelpers} always
 * emits requested helpers in this order, so multi-helper output is deterministic regardless of
 * catalog rule application order.
 */
const HELPER_NAMES = [
  'downlevelEndsWith',
  'downlevelEndsWithAt',
  'downlevelStartsWithAt',
  'downlevelAt',
  'downlevelIncludesNaNSafe',
  'downlevelReplaceAllString',
  'downlevelReplaceAllStringFunction',
  'downlevelReplaceAllRegExp',
  'downlevelNumberIsNaN',
  'downlevelNumberIsFinite',
  'downlevelNumberIsInteger',
  'downlevelNumberIsSafeInteger',
  'downlevelArrayFind',
  'downlevelArrayFindIndex',
  'downlevelArrayFindLast',
  'downlevelArrayFindLastIndex',
  'downlevelStringRepeat',
  'downlevelStringPadStart',
  'downlevelStringPadEnd',
  'downlevelObjectValues',
  'downlevelObjectEntries',
  'downlevelArrayToSpliced',
] as const

/** The name of an emittable downlevel helper function. */
export type DownlevelHelperName = (typeof HELPER_NAMES)[number]

/**
 * Source text for each emittable helper, keyed by name. Exported so the unit tests can compile
 * and execute each helper against the native method it replaces (runtime-equivalence testing —
 * see `tests/downlevel-transform.test.ts`).
 */
export const HELPER_SOURCE: Record<DownlevelHelperName, string> = {
  downlevelEndsWith: `
/**
 * ES5-safe \`String#endsWith\` for a receiver or argument that cannot be duplicated inline
 * (see the endsWith downlevel rewrite in the shipped build).
 *
 * @param s - The string to test.
 * @param p - The suffix to test for.
 *
 * @returns \`true\` if \`s\` ends with \`p\`.
 */
const downlevelEndsWith = (s: string, p: string): boolean => s.slice(s.length - p.length) === p
`.trim(),
  downlevelEndsWithAt: `
/**
 * ES5-safe \`String#endsWith\` with an explicit \`endPosition\` argument (the position \`s\` is
 * treated as ending at, per \`String#endsWith\`'s second parameter).
 *
 * @param s - The string to test.
 * @param p - The suffix to test for.
 * @param end - The position \`s\` is treated as ending at.
 *
 * @returns \`true\` if the leading \`end\` characters of \`s\` end with \`p\`.
 */
const downlevelEndsWithAt = (s: string, p: string, end: number): boolean => {
  // A negative end position is clamped to 0, matching \`String#endsWith\` (which clamps the end
  // position into [0, length]; \`slice\` would instead count a negative position from the end).
  const truncated = s.slice(0, end < 0 ? 0 : end)
  return truncated.slice(truncated.length - p.length) === p
}
`.trim(),
  downlevelStartsWithAt: `
/**
 * ES5-safe \`String#startsWith\` with an explicit \`position\` argument (the index \`s\` is
 * searched from, per \`String#startsWith\`'s second parameter).
 *
 * @param s - The string to test.
 * @param p - The prefix to test for.
 * @param position - The position within \`s\` to begin searching from (\`undefined\` behaves as
 *   \`0\`, matching the native optional parameter).
 *
 * @returns \`true\` if \`s\`, starting at \`position\`, begins with \`p\`.
 */
const downlevelStartsWithAt = (s: string, p: string, position: number | undefined): boolean => {
  // ToIntegerOrInfinity on the position, matching \`String#startsWith\`: \`undefined\` and \`NaN\`
  // become \`0\`, negatives clamp to \`0\` (\`slice\` would instead count them from the end), and
  // fractions are truncated by \`slice\`'s own internal integer coercion. Computing the slice end
  // from an un-normalized position would poison it (\`NaN + p.length\` is \`NaN\`).
  const start = position === undefined || position !== position || position < 0 ? 0 : position
  return s.slice(start, start + p.length) === p
}
`.trim(),
  downlevelAt: `
/**
 * ES5-safe \`String#at\`/\`Array#at\` for an index that is not an integer literal, or a receiver
 * that cannot be duplicated inline (see the \`.at()\` downlevel rewrite in the shipped build).
 *
 * @param x - The string or array to index into.
 * @param i - The index; negative counts back from the end.
 *
 * @returns The element/character at index \`i\`, or \`undefined\` if out of range.
 */
function downlevelAt(x: string, i: number): string | undefined
function downlevelAt<T>(x: readonly T[], i: number): T | undefined
function downlevelAt<T>(x: string | readonly T[], i: number): T | string | undefined {
  // ToIntegerOrInfinity on the index, matching \`.at()\`: \`NaN\` becomes \`0\` and fractions
  // truncate toward zero (\`number\` admits both — \`arr.at(n / 2)\` type-checks). The
  // \`Math.ceil\`/\`Math.floor\` split is ES5's truncation (\`Math.trunc\` is ES2015).
  const n = i !== i ? 0 : i < 0 ? Math.ceil(i) : Math.floor(i)
  return n < 0 ? x[x.length + n] : x[n]
}
`.trim(),
  downlevelIncludesNaNSafe: `
/**
 * ES5-safe \`Array#includes\` for receivers or arguments the rewrite cannot prove immune to the
 * two \`indexOf\`/\`includes\` divergences (see the includes downlevel rewrite in the shipped
 * build): \`includes\` finds \`NaN\` via SameValueZero (\`indexOf\`'s strict equality never does),
 * and \`includes\` reads array holes as \`undefined\` (\`indexOf\` skips them).
 *
 * @param arr - The array to search.
 * @param v - The value to search for.
 * @param from - The index to start searching from (defaults to \`0\`).
 *
 * @returns \`true\` if \`arr\` includes \`v\`.
 */
const downlevelIncludesNaNSafe = <T>(arr: readonly T[], v: T, from?: number): boolean => {
  // ToIntegerOrInfinity on the start index, matching \`Array#includes\`: \`undefined\`/\`NaN\`
  // become \`0\`, fractions truncate toward zero (\`Math.trunc\` is ES2015, hence the
  // \`Math.ceil\`/\`Math.floor\` split), and negatives count back from the end, clamped to \`0\`.
  let start = from === undefined || from !== from ? 0 : from < 0 ? Math.ceil(from) : Math.floor(from)
  if (start < 0) {
    start = arr.length + start
    if (start < 0) {
      start = 0
    }
  }
  // Every index is read directly — never via \`indexOf\`, which would skip holes — and compared
  // with SameValueZero (strict equality, plus the mutual-NaN case it excludes).
  for (let index = start; index < arr.length; index++) {
    const element = arr[index]
    if (element === v || (element !== element && v !== v)) {
      return true
    }
  }
  return false
}
`.trim(),
  downlevelReplaceAllString: `
/**
 * Apply a \`String#replaceAll\`-style GetSubstitution replacement pattern for a single string
 * match: \`$$\` → a literal \`$\`, \`$&\` → the matched text, \` $\\\` \` → the text before the match,
 * \`$'\` → the text after the match. Numbered/named group patterns (\`$1\`, \`$<name>\`) have no
 * meaning for a string search (there are no capture groups) and pass through verbatim, matching
 * native \`replaceAll\` with a string search value.
 *
 * @param str - The full string being searched.
 * @param matched - The matched substring (the search value itself, for a string search).
 * @param position - The index within \`str\` where \`matched\` starts.
 * @param replacement - The raw replacement pattern to expand.
 *
 * @returns The expanded replacement text for this match.
 */
const downlevelApplyReplacementPattern = (
  str: string,
  matched: string,
  position: number,
  replacement: string
): string => {
  let result = ''
  let index = 0
  while (index < replacement.length) {
    const character = replacement.charAt(index)
    if (character === '$' && index + 1 < replacement.length) {
      const next = replacement.charAt(index + 1)
      if (next === '$') {
        result += '$'
        index += 2
        continue
      }
      if (next === '&') {
        result += matched
        index += 2
        continue
      }
      if (next === '\\\`') {
        result += str.slice(0, position)
        index += 2
        continue
      }
      if (next === "'") {
        result += str.slice(position + matched.length)
        index += 2
        continue
      }
    }
    result += character
    index++
  }
  return result
}

/**
 * ES5-safe \`String#replaceAll\` for a string search value and a replacement string that could
 * not be proven \`$\`-free (see the replaceAll downlevel rewrite in the shipped build) — a plain
 * \`split\`/\`join\` would skip the GetSubstitution step native \`replaceAll\` applies even for a
 * string search (e.g. \`'a-b'.replaceAll('-', '$&$&')\` is \`'a--b'\`, not \`'a$&$&b'\`).
 *
 * @param s - The string to search.
 * @param search - The (possibly empty) substring to replace every occurrence of.
 * @param replacement - The replacement pattern (may contain \`$$\`, \`$&\`, \` $\\\` \`, \`$'\`).
 *
 * @returns \`s\` with every occurrence of \`search\` replaced.
 */
const downlevelReplaceAllString = (s: string, search: string, replacement: string): string => {
  if (search === '') {
    // An empty search matches at every position, including before the first and after the last
    // character, advancing by one character each time — matching native \`replaceAll('', ...)\`.
    let result = downlevelApplyReplacementPattern(s, '', 0, replacement)
    for (let index = 0; index < s.length; index++) {
      result += s.charAt(index) + downlevelApplyReplacementPattern(s, '', index + 1, replacement)
    }
    return result
  }
  let result = ''
  let position = 0
  while (position <= s.length) {
    const matchIndex = s.indexOf(search, position)
    if (matchIndex === -1) {
      result += s.slice(position)
      break
    }
    result +=
      s.slice(position, matchIndex) +
      downlevelApplyReplacementPattern(s, search, matchIndex, replacement)
    position = matchIndex + search.length
  }
  return result
}
`.trim(),
  downlevelReplaceAllStringFunction: `
/**
 * ES5-safe \`String#replaceAll\` for a string search value and a function replacer (see the
 * replaceAll downlevel rewrite in the shipped build). The replacer is invoked once per match
 * with \`(matched, position, fullString)\`, matching native \`replaceAll\`'s replacer signature for
 * a string search (no capture groups, so no extra arguments between \`matched\` and \`position\`).
 *
 * @param s - The string to search.
 * @param search - The (possibly empty) substring to replace every occurrence of.
 * @param replacer - Called for each match; its return value is stringified and substituted.
 *
 * @returns \`s\` with every occurrence of \`search\` replaced by the replacer's result.
 */
const downlevelReplaceAllStringFunction = (
  s: string,
  search: string,
  replacer: (matched: string, position: number, fullString: string) => unknown
): string => {
  if (search === '') {
    let result = String(replacer('', 0, s))
    for (let index = 0; index < s.length; index++) {
      result += s.charAt(index) + String(replacer('', index + 1, s))
    }
    return result
  }
  let result = ''
  let position = 0
  while (position <= s.length) {
    const matchIndex = s.indexOf(search, position)
    if (matchIndex === -1) {
      result += s.slice(position)
      break
    }
    result += s.slice(position, matchIndex) + String(replacer(search, matchIndex, s))
    position = matchIndex + search.length
  }
  return result
}
`.trim(),
  downlevelReplaceAllRegExp: `
/**
 * ES5-safe \`String#replaceAll\` for a non-literal RegExp search value (see the replaceAll
 * downlevel rewrite in the shipped build — a RegExp *literal* is rewritten inline to
 * \`.replace()\` instead, since its \`g\` flag is checked at build time; a non-literal RegExp's
 * flags aren't statically knowable, so the check has to happen here, at run time, matching
 * native \`replaceAll\`'s own \`TypeError\`).
 *
 * @param s - The string to search.
 * @param re - The RegExp to search with; must have the \`g\` flag.
 * @param replacement - The replacement string or replacer function.
 *
 * @returns \`s\` with every match of \`re\` replaced.
 *
 * @throws TypeError if \`re\` does not have the \`g\` flag.
 */
function downlevelReplaceAllRegExp(s: string, re: RegExp, replacement: string): string
function downlevelReplaceAllRegExp(
  s: string,
  re: RegExp,
  replacement: (substring: string, ...args: unknown[]) => string
): string
function downlevelReplaceAllRegExp(
  s: string,
  re: RegExp,
  replacement: string | ((substring: string, ...args: unknown[]) => string)
): string {
  if (!re.global) {
    throw new TypeError('replaceAll must be called with a global RegExp')
  }
  // Both branches are runtime-identical; the \`typeof\` split exists purely for overload
  // resolution: \`String#replace\` has separate string-replacement and replacer-function
  // overloads, and the union-typed parameter satisfies neither without narrowing.
  if (typeof replacement === 'string') {
    return s.replace(re, replacement)
  }
  return s.replace(re, replacement)
}
`.trim(),
  downlevelNumberIsNaN: `
/**
 * ES5-safe \`Number.isNaN\` for a value that isn't statically known to be a \`number\`, or whose
 * receiver expression cannot be duplicated inline (see the \`Number.isNaN\` downlevel rewrite in
 * the shipped build). Unlike the global \`isNaN\`, this does not coerce non-number values first —
 * a non-number argument is always \`false\`, matching native \`Number.isNaN\`.
 *
 * @param v - The value to test.
 *
 * @returns \`true\` if \`v\` is the number value \`NaN\`.
 */
const downlevelNumberIsNaN = (v: unknown): boolean => typeof v === 'number' && v !== v
`.trim(),
  downlevelNumberIsFinite: `
/**
 * ES5-safe \`Number.isFinite\` for a value that isn't statically known to be a \`number\` (see the
 * \`Number.isFinite\` downlevel rewrite in the shipped build). Unlike the global \`isFinite\`, this
 * does not coerce non-number values first — a non-number argument is always \`false\`, matching
 * native \`Number.isFinite\`.
 *
 * @param v - The value to test.
 *
 * @returns \`true\` if \`v\` is a finite number.
 */
const downlevelNumberIsFinite = (v: unknown): boolean => typeof v === 'number' && isFinite(v)
`.trim(),
  downlevelNumberIsInteger: `
/**
 * ES5-safe \`Number.isInteger\` (see the \`Number.isInteger\` downlevel rewrite in the shipped
 * build).
 *
 * @param v - The value to test.
 *
 * @returns \`true\` if \`v\` is a finite number with no fractional part.
 */
const downlevelNumberIsInteger = (v: unknown): boolean =>
  typeof v === 'number' && isFinite(v) && Math.floor(v) === v
`.trim(),
  downlevelNumberIsSafeInteger: `
/**
 * ES5-safe \`Number.isSafeInteger\` (see the \`Number.isSafeInteger\` downlevel rewrite in the
 * shipped build). A "safe" integer is one exactly representable as an IEEE 754 double and whose
 * neighbors are too (magnitude at most \`Number.MAX_SAFE_INTEGER\`, \`2^53 - 1\`).
 *
 * @param v - The value to test.
 *
 * @returns \`true\` if \`v\` is a finite, integral, safe-magnitude number.
 */
const downlevelNumberIsSafeInteger = (v: unknown): boolean =>
  typeof v === 'number' && isFinite(v) && Math.floor(v) === v && Math.abs(v) <= 9007199254740991
`.trim(),
  downlevelArrayFind: `
/**
 * ES5-safe \`Array#find\` (see the \`.find()\` downlevel rewrite in the shipped build). Always
 * used regardless of operand shape — \`Array#find\` has no allocation-free inline ES5 form.
 *
 * @param arr - The array to search.
 * @param predicate - Called with \`(value, index, array)\` for each element, in order, until it
 *   returns a truthy value.
 * @param thisArg - Optional \`this\` value for \`predicate\`.
 *
 * @returns The first element for which \`predicate\` returns truthy, or \`undefined\`.
 */
const downlevelArrayFind = <T>(
  arr: readonly T[],
  predicate: (value: T, index: number, array: readonly T[]) => unknown,
  thisArg?: unknown
): T | undefined => {
  // \`Array#find\` captures the length once before iterating: a predicate that grows the array
  // must not extend the loop (and a re-read length would make a self-appending predicate loop
  // forever).
  const length = arr.length
  for (let index = 0; index < length; index++) {
    if (predicate.call(thisArg, arr[index], index, arr)) {
      return arr[index]
    }
  }
  return undefined
}
`.trim(),
  downlevelArrayFindIndex: `
/**
 * ES5-safe \`Array#findIndex\` (see the \`.findIndex()\` downlevel rewrite in the shipped build).
 * Always used regardless of operand shape — \`Array#findIndex\` has no allocation-free inline
 * ES5 form.
 *
 * @param arr - The array to search.
 * @param predicate - Called with \`(value, index, array)\` for each element, in order, until it
 *   returns a truthy value.
 * @param thisArg - Optional \`this\` value for \`predicate\`.
 *
 * @returns The index of the first element for which \`predicate\` returns truthy, or \`-1\`.
 */
const downlevelArrayFindIndex = <T>(
  arr: readonly T[],
  predicate: (value: T, index: number, array: readonly T[]) => unknown,
  thisArg?: unknown
): number => {
  // \`Array#findIndex\` captures the length once before iterating (see downlevelArrayFind).
  const length = arr.length
  for (let index = 0; index < length; index++) {
    if (predicate.call(thisArg, arr[index], index, arr)) {
      return index
    }
  }
  return -1
}
`.trim(),
  downlevelArrayFindLast: `
/**
 * ES5-safe \`Array#findLast\` (see the \`.findLast()\` downlevel rewrite in the shipped build).
 * Always used regardless of operand shape — \`Array#findLast\` has no allocation-free inline
 * ES5 form.
 *
 * @param arr - The array to search.
 * @param predicate - Called with \`(value, index, array)\` for each element, from the last to the
 *   first, until it returns a truthy value.
 * @param thisArg - Optional \`this\` value for \`predicate\`.
 *
 * @returns The last element (in index order) for which \`predicate\` returns truthy, or
 *   \`undefined\`.
 */
const downlevelArrayFindLast = <T>(
  arr: readonly T[],
  predicate: (value: T, index: number, array: readonly T[]) => unknown,
  thisArg?: unknown
): T | undefined => {
  for (let index = arr.length - 1; index >= 0; index--) {
    if (predicate.call(thisArg, arr[index], index, arr)) {
      return arr[index]
    }
  }
  return undefined
}
`.trim(),
  downlevelArrayFindLastIndex: `
/**
 * ES5-safe \`Array#findLastIndex\` (see the \`.findLastIndex()\` downlevel rewrite in the shipped
 * build). Always used regardless of operand shape — \`Array#findLastIndex\` has no
 * allocation-free inline ES5 form.
 *
 * @param arr - The array to search.
 * @param predicate - Called with \`(value, index, array)\` for each element, from the last to the
 *   first, until it returns a truthy value.
 * @param thisArg - Optional \`this\` value for \`predicate\`.
 *
 * @returns The index of the last element (in index order) for which \`predicate\` returns
 *   truthy, or \`-1\`.
 */
const downlevelArrayFindLastIndex = <T>(
  arr: readonly T[],
  predicate: (value: T, index: number, array: readonly T[]) => unknown,
  thisArg?: unknown
): number => {
  for (let index = arr.length - 1; index >= 0; index--) {
    if (predicate.call(thisArg, arr[index], index, arr)) {
      return index
    }
  }
  return -1
}
`.trim(),
  downlevelStringRepeat: `
/**
 * ES5-safe \`String#repeat\` (see the \`.repeat()\` downlevel rewrite in the shipped build).
 * Matches native \`repeat\`'s \`RangeError\` for a negative or infinite count exactly — it does
 * *not* silently clamp to an empty string.
 *
 * @param s - The string to repeat.
 * @param count - The number of times to repeat \`s\` (truncated toward zero if fractional).
 *
 * @returns \`s\` repeated \`count\` times.
 *
 * @throws RangeError if \`count\` is negative or \`Infinity\`.
 */
const downlevelStringRepeat = (s: string, count: number): string => {
  // Truncate toward zero without \`Math.trunc\`, which is itself ES2015.
  const times = count < 0 ? Math.ceil(count) : Math.floor(count)
  if (times < 0 || times === Number.POSITIVE_INFINITY) {
    throw new RangeError('Invalid count value: ' + count)
  }
  let result = ''
  let remaining = times
  while (remaining > 0) {
    result += s
    remaining--
  }
  return result
}
`.trim(),
  downlevelStringPadStart: `
/**
 * ES5-safe \`String#padStart\` (see the \`.padStart()\` downlevel rewrite in the shipped build).
 *
 * @param s - The string to pad.
 * @param targetLength - The length to pad \`s\` up to (no-op if \`s\` is already this long).
 * @param padString - The fill text (defaults to \`' '\`); an empty fill is a no-op, and the fill
 *   is truncated (never repeated with a partial final copy dropped) to fit exactly.
 *
 * @returns \`s\` padded at the start to \`targetLength\`.
 */
const downlevelStringPadStart = (s: string, targetLength: number, padString?: string): string => {
  const pad = padString === undefined ? ' ' : padString
  if (s.length >= targetLength || pad === '') {
    return s
  }
  const padLength = targetLength - s.length
  let filler = ''
  while (filler.length < padLength) {
    filler += pad
  }
  return filler.slice(0, padLength) + s
}
`.trim(),
  downlevelStringPadEnd: `
/**
 * ES5-safe \`String#padEnd\` (see the \`.padEnd()\` downlevel rewrite in the shipped build).
 *
 * @param s - The string to pad.
 * @param targetLength - The length to pad \`s\` up to (no-op if \`s\` is already this long).
 * @param padString - The fill text (defaults to \`' '\`); an empty fill is a no-op, and the fill
 *   is truncated (never repeated with a partial final copy dropped) to fit exactly.
 *
 * @returns \`s\` padded at the end to \`targetLength\`.
 */
const downlevelStringPadEnd = (s: string, targetLength: number, padString?: string): string => {
  const pad = padString === undefined ? ' ' : padString
  if (s.length >= targetLength || pad === '') {
    return s
  }
  const padLength = targetLength - s.length
  let filler = ''
  while (filler.length < padLength) {
    filler += pad
  }
  return s + filler.slice(0, padLength)
}
`.trim(),
  downlevelObjectValues: `
/**
 * ES5-safe \`Object.values\` (see the \`Object.values()\` downlevel rewrite in the shipped build).
 * Iterates \`Object.keys(o)\` (ES5) and reads each value — the same own-enumerable-string-key
 * order \`Object.values\` itself uses, since it is defined in terms of \`Object.keys\`.
 *
 * @param o - The object (or array-like) to read values from.
 *
 * @returns The own enumerable property values of \`o\`, in \`Object.keys\` order.
 */
const downlevelObjectValues = <T>(o: { [key: string]: T } | ArrayLike<T>): T[] => {
  const keys = Object.keys(o)
  const result: T[] = []
  for (let index = 0; index < keys.length; index++) {
    // The assertion unifies the union for string-key reads: \`Object.keys\` yields string keys
    // for both members, but \`ArrayLike\`'s index signature is numeric, so TypeScript cannot
    // index it with a string key. The union parameter cannot be simplified away — it mirrors
    // \`lib.es2017.object.d.ts\`'s own declared \`Object.values\` signature so rewritten call
    // sites infer exactly the type the native call would. No truthful type guard can replace
    // the assertion either: the asserted claim is not runtime-true for an \`ArrayLike\` (its
    // own enumerable \`length\`, when present, joins the values at runtime — an unsoundness
    // already present in the native lib typing this helper reproduces faithfully; see
    // https://github.com/microsoft/TypeScript/issues/38520). The
    // repository-wide type-assertion ban is deviated from knowingly, scoped to this single
    // property read, in generated code outside ESLint's reach.
    result.push((o as { [key: string]: T })[keys[index]])
  }
  return result
}
`.trim(),
  downlevelObjectEntries: `
/**
 * ES5-safe \`Object.entries\` (see the \`Object.entries()\` downlevel rewrite in the shipped
 * build). Iterates \`Object.keys(o)\` (ES5) and pairs each with its value — the same
 * own-enumerable-string-key order \`Object.entries\` itself uses, since it is defined in terms of
 * \`Object.keys\`.
 *
 * @param o - The object (or array-like) to read entries from.
 *
 * @returns The own enumerable \`[key, value]\` pairs of \`o\`, in \`Object.keys\` order.
 */
const downlevelObjectEntries = <T>(o: { [key: string]: T } | ArrayLike<T>): [string, T][] => {
  const keys = Object.keys(o)
  const result: [string, T][] = []
  for (let index = 0; index < keys.length; index++) {
    // Same knowingly-scoped type assertion as downlevelObjectValues: \`ArrayLike\`'s numeric
    // index signature cannot be read with the string keys \`Object.keys\` yields.
    result.push([keys[index], (o as { [key: string]: T })[keys[index]]])
  }
  return result
}
`.trim(),
  downlevelArrayToSpliced: `
/**
 * ES5-safe \`Array#toSpliced\` (see the \`.toSpliced()\` downlevel rewrite in the shipped build):
 * a non-mutating \`.splice()\` — copy first, then splice (and discard) the copy, forwarding every
 * argument unchanged (so \`Array#splice\`'s own negative/out-of-range \`start\` normalization
 * applies identically).
 *
 * @param arr - The array to copy and splice.
 * @param start - The index to start changing the array from (per \`Array#splice\`).
 * @param deleteCount - The number of elements to remove (per \`Array#splice\`); if omitted, every
 *   element from \`start\` to the end is removed.
 * @param items - Elements to insert starting at \`start\`.
 *
 * @returns A new array reflecting the splice, leaving \`arr\` untouched.
 */
// A function declaration (not an arrow) so \`arguments.length\` can distinguish an *omitted*
// deleteCount from an explicitly passed \`undefined\`: native \`toSpliced\` deletes to the end
// only when the argument is absent, while an explicit \`undefined\` coerces to \`0\` via
// ToIntegerOrInfinity (delete nothing). A parameter-value check alone cannot tell these apart.
function downlevelArrayToSpliced<T>(
  arr: readonly T[],
  start: number,
  deleteCount?: number,
  ...items: T[]
): T[] {
  const copy = arr.slice()
  if (arguments.length < 3) {
    copy.splice(start)
  } else {
    copy.splice(start, deleteCount === undefined ? 0 : deleteCount, ...items)
  }
  return copy
}
`.trim(),
}

/** Tracks, per shadow-tree source file, which helpers a catalog rewrite has requested. */
const requestedHelpersBySourceFile = new WeakMap<SourceFile, Set<DownlevelHelperName>>()

/** Tracks, per shadow-tree source file, whether {@link emitRequestedHelpers} already ran. */
const emittedSourceFiles = new WeakSet<SourceFile>()

/**
 * Request that a helper be available in `sourceFile`, to be written out once by a later call to
 * {@link emitRequestedHelpers}. Safe to call more than once for the same helper in the same
 * file (e.g. two `.at()` call sites both needing `downlevelAt`) — it is only emitted once.
 *
 * @param sourceFile - The shadow-tree source file that will use the helper.
 * @param name - The helper to request.
 */
export const requestHelper = (sourceFile: SourceFile, name: DownlevelHelperName): void => {
  const requested = requestedHelpersBySourceFile.get(sourceFile) ?? new Set<DownlevelHelperName>()
  requested.add(name)
  requestedHelpersBySourceFile.set(sourceFile, requested)
}

/**
 * Check whether `sourceFile`'s text already contains the given identifier name anywhere (a
 * plain substring scan — deliberately simple, per the downlevel transform's design: false
 * positives only make the transform pick a longer, still-safe name; false negatives are
 * structurally impossible since every real occurrence of an identifier includes its exact
 * spelling as a substring of the file text).
 *
 * @param sourceFile - The source file to scan.
 * @param name - The candidate identifier name.
 *
 * @returns `true` if `name` appears anywhere in `sourceFile`'s text.
 */
const hasIdentifierText = (sourceFile: SourceFile, name: string): boolean =>
  sourceFile.getFullText().includes(name)

/**
 * Pick an identifier name that does not collide with any existing text in `sourceFile`,
 * starting from `baseName` and appending an increasing numeric suffix (`baseName2`,
 * `baseName3`, ...) until a free one is found. Uses the same simple text-scan as
 * {@link hasIdentifierText} — see its documentation for why that is sufficient here.
 *
 * @param sourceFile - The source file the name must be unique within.
 * @param baseName - The preferred name.
 *
 * @returns `baseName`, or `baseName` suffixed with the smallest integer ≥ 2 that makes it unique.
 */
export const pickFreshIdentifierName = (sourceFile: SourceFile, baseName: string): string => {
  if (!hasIdentifierText(sourceFile, baseName)) {
    return baseName
  }
  for (let suffix = 2; ; suffix++) {
    const candidate = `${baseName}${suffix}`
    if (!hasIdentifierText(sourceFile, candidate)) {
      return candidate
    }
  }
}

/**
 * Insert the source text for every helper requested (via {@link requestHelper}) for
 * `sourceFile`, once, immediately after its last top-level import declaration (or at the very
 * top of the file if it has none). No-op if no helper was requested, or if this source file was
 * already processed. Called once per file, after the downlevel catalog has finished rewriting it
 * (see `catalog.ts`'s `applyCatalogToSourceFile`).
 *
 * @param sourceFile - The shadow-tree source file to insert requested helpers into.
 * @param originalText - `sourceFile`'s text as it was *before* any catalog rewrite touched it —
 *   used only for the collision check below. The catalog rewrites that request a helper always
 *   insert a call to it (e.g. `downlevelAt(...)`), so by the time this function runs the
 *   *current* file text legitimately already contains every requested helper's name; checking
 *   against the pre-rewrite snapshot instead is what makes the check meaningful.
 *
 * @throws Error if a requested helper's name collides with text that was already in the file
 *   before rewriting (should be unreachable in practice — `downlevel`-prefixed helper names are
 *   not realistic identifiers for hand-written source — but checked defensively rather than
 *   silently emitting a redeclaration).
 */
export const emitRequestedHelpers = (sourceFile: SourceFile, originalText: string): void => {
  if (emittedSourceFiles.has(sourceFile)) {
    return
  }
  emittedSourceFiles.add(sourceFile)

  const requested = requestedHelpersBySourceFile.get(sourceFile)
  if (!requested || requested.size === 0) {
    return
  }

  const names = HELPER_NAMES.filter((name) => requested.has(name))
  for (const name of names) {
    if (originalText.includes(name)) {
      throw new Error(
        `Internal downlevel transform error: helper name "${name}" collides with existing text ` +
          `in ${sourceFile.getFilePath()}.`
      )
    }
  }

  const importDeclarations = sourceFile.getImportDeclarations()
  const lastImportDeclaration = importDeclarations.at(-1)
  const insertIndex = lastImportDeclaration ? lastImportDeclaration.getChildIndex() + 1 : 0

  const helperText = names.map((name) => HELPER_SOURCE[name]).join('\n\n')
  sourceFile.insertStatements(insertIndex, `\n${helperText}\n`)
}
