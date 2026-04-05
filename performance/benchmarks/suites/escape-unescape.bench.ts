import { Bench } from 'tinybench'

import { escapeKey, escapeValue } from '../../../src/escape'
import { unescapeContent } from '../../../src/unescape'

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
 * @returns A tinybench `Bench` instance with completed results.
 */
export const runEscapeUnescapeBenchmarks = async (): Promise<Bench> => {
  const bench = new Bench({ warmupIterations: 10 })

  bench.add('escapeKey (plain ASCII)', () => {
    escapeKey(PLAIN_ASCII)
  })

  bench.add('escapeKey (Unicode)', () => {
    escapeKey(UNICODE_HEAVY, true)
  })

  bench.add('escapeValue (plain ASCII)', () => {
    escapeValue(PLAIN_ASCII)
  })

  bench.add('escapeValue (Unicode)', () => {
    escapeValue(UNICODE_HEAVY, true)
  })

  bench.add('unescapeContent (no escapes)', () => {
    unescapeContent(PLAIN_ASCII)
  })

  bench.add('unescapeContent (Unicode escapes)', () => {
    unescapeContent(ESCAPED_UNICODE)
  })

  bench.add('unescapeContent (mixed escapes)', () => {
    unescapeContent(ESCAPED_MIXED)
  })

  await bench.run()
  return bench
}
