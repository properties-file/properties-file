import { Bench } from 'tinybench'

/** The module shape required by the escape/unescape benchmark suite. */
export type EscapeModule = {
  /** Escape a property key for writing to a `.properties` file. */
  escapeKey: (unescapedKey: string, escapeUnicode?: boolean) => string
  /** Escape a property value for writing to a `.properties` file. */
  escapeValue: (unescapedValue: string, escapeUnicode?: boolean) => string
}

/** The module shape required by the unescape benchmark suite. */
export type UnescapeModule = {
  /** Unescape content read from a `.properties` file. */
  unescapeContent: (content: string) => string
}

/** Plain ASCII string with no special characters. */
const PLAIN_ASCII = 'This is a simple plain ASCII string with no special characters at all'

/** String with CJK, accented, and Hangul characters. */
const UNICODE_HEAVY =
  '\u3053\u3093\u306B\u3061\u306F World \u00E9\u00E8\u00EA \u4E16\u754C \uD55C\uAD6D\uC5B4'

/** Pre-escaped Unicode sequences (as they would appear in a `.properties` file). */
const ESCAPED_UNICODE = String.raw`\u3053\u3093\u306b\u3061\u306f World \u00e9\u00e8\u00ea \u4e16\u754c \ud55c\uad6d\uc5b4`

/** Mix of standard escape sequences and Unicode escapes. */
const ESCAPED_MIXED = String.raw`Hello\nWorld\tTab\r\n\u0048\u0065\u006C\u006C\u006F`

/**
 * Benchmark escape and unescape functions with plain ASCII and Unicode-heavy input.
 *
 * Receives its dependencies via injection so that the same suite can be run against
 * different compiled builds (current vs baseline) without import-time coupling.
 *
 * @param escapeModule - The escape module (must provide `escapeKey` and `escapeValue`).
 * @param unescapeModule - The unescape module (must provide `unescapeContent`).
 *
 * @returns A tinybench `Bench` instance with completed results.
 */
export const runEscapeUnescapeBenchmarks = async (
  escapeModule: EscapeModule,
  unescapeModule: UnescapeModule
): Promise<Bench> => {
  const bench = new Bench({ warmupIterations: 10 })

  bench.add('escapeKey (plain ASCII)', () => {
    escapeModule.escapeKey(PLAIN_ASCII)
  })

  bench.add('escapeKey (Unicode)', () => {
    escapeModule.escapeKey(UNICODE_HEAVY, true)
  })

  bench.add('escapeValue (plain ASCII)', () => {
    escapeModule.escapeValue(PLAIN_ASCII)
  })

  bench.add('escapeValue (Unicode)', () => {
    escapeModule.escapeValue(UNICODE_HEAVY, true)
  })

  bench.add('unescapeContent (no escapes)', () => {
    unescapeModule.unescapeContent(PLAIN_ASCII)
  })

  bench.add('unescapeContent (Unicode escapes)', () => {
    unescapeModule.unescapeContent(ESCAPED_UNICODE)
  })

  bench.add('unescapeContent (mixed escapes)', () => {
    unescapeModule.unescapeContent(ESCAPED_MIXED)
  })

  await bench.run()
  return bench
}
