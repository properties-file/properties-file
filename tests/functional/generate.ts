/**
 * Golden-file generator for the functional behavioral test harness.
 *
 * Executes every scenario in `scenarios` (`scenarios.ts`) against the
 * TypeScript **source** via the shared `executeScenario()` (`execute-scenario.ts`)
 * and writes the results to `golden.json`.
 *
 * `golden.json` is then used by two other consumers:
 * - `functional.test.ts` — a normal Jest test that re-executes every scenario
 *   against the source and asserts it still matches `golden.json`, acting as
 *   an automatic staleness check inside `npm test`.
 * - `run-cjs.js` / `run-esm.mts` — dumb replay runners that execute the same
 *   scenarios against the compiled `dist/cjs` and `dist/esm` artifacts,
 *   verifying the build pipeline preserves source semantics.
 *
 * Every `expected` value is computed by calling the real source
 * implementation — nothing is hand-computed — so the golden file always
 * reflects actual current behavior.
 *
 * Usage:
 *   npx tsx tests/functional/generate.ts
 */
import fs from 'node:fs'
import path from 'node:path'

import { executeScenario } from './execute-scenario'
import { scenarios } from './scenarios'

import type { GoldenScenario } from './execute-scenario'

const goldenFilePath = path.join(import.meta.dirname, 'golden.json')

const golden: GoldenScenario[] = scenarios.map((scenario) => ({
  ...scenario,
  expected: executeScenario(scenario),
}))

// ASCII-armor the JSON: escape every non-ASCII character as a `\uXXXX` JSON escape (one per
// UTF-16 code unit, so astral characters become their surrogate pair). JSON escapes are decoded
// as code units by every JSON parser — including Node.js 0.4's, whose UTF-8 *file* decoder
// mangles raw supplementary-plane byte sequences — so this keeps the golden file byte-safe on
// every runtime the replay runners target.
const serializedGolden = `${JSON.stringify(golden, null, 2).replaceAll(
  /[\u{7F}-\u{10FFFF}]/gu,
  (character) =>
    character
      .split('')
      .map((codeUnit) => String.raw`\u${codeUnit.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('')
)}\n`

fs.writeFileSync(goldenFilePath, serializedGolden)
console.log(`Wrote ${golden.length} scenarios to ${goldenFilePath}`)
