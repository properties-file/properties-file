/**
 * Functional behavioral test — runs inside the normal Jest suite (`npm test`).
 *
 * Re-executes every scenario in `scenarios` (`scenarios.ts`) against the
 * TypeScript **source** via the shared `executeScenario()`
 * (`execute-scenario.ts`) and asserts the result still matches the checked-in
 * `tests/functional/golden.json`. This is the automatic staleness check for
 * the golden file: if source behavior changes without regenerating
 * `golden.json` (`npm run functional-generate`), this test fails with a
 * message pointing the developer at that command.
 *
 * The compiled-artifact replay runners (`run-cjs.js` / `run-esm.mts`) read the
 * same `golden.json` and replay it against `dist/cjs` / `dist/esm` separately
 * — see `npm run test-functional`.
 */
import { readFileSync } from 'node:fs'

import { isNormalizedError, noThrow } from '../../utilities/no-throw'

import { executeScenario } from './execute-scenario'
import { scenarios } from './scenarios'

import type { GoldenScenario } from './execute-scenario'

const GOLDEN_FILE_PATH = 'tests/functional/golden.json'

/**
 * Structural type guard for a single golden.json entry — just enough to guard the
 * `JSON.parse()` unknown boundary. Deep per-kind field validation isn't necessary
 * since `golden.json` is a generated, trusted file produced by `generate.ts`.
 *
 * @param value - The value to check.
 *
 * @returns Whether `value` looks like a {@link GoldenScenario}.
 */
const isGoldenScenario = (value: unknown): value is GoldenScenario =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  'kind' in value &&
  typeof value.kind === 'string' &&
  'expected' in value

/**
 * Load and validate `golden.json` as an array of {@link GoldenScenario} entries.
 *
 * @param path - Path to the golden.json file (relative to the repository root).
 *
 * @returns The parsed and validated golden scenarios.
 *
 * @throws Error if the file does not contain a valid array of scenario entries.
 */
const loadGolden = (path: string): GoldenScenario[] => {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (Array.isArray(parsed) && parsed.every((entry) => isGoldenScenario(entry))) {
    return parsed
  }
  throw new Error(`Invalid golden.json at ${path}: expected an array of scenario entries.`)
}

const golden = loadGolden(GOLDEN_FILE_PATH)

const goldenById = new Map<string, GoldenScenario>(golden.map((entry) => [entry.id, entry]))

const STALENESS_HINT =
  'Behavior differs from tests/functional/golden.json. If this change is intentional, run `npm run functional-generate` and commit the updated golden.json.'

describe.each(scenarios)('$kind: $id', (scenario) => {
  it('matches the checked-in golden.json entry', () => {
    const goldenEntry = goldenById.get(scenario.id)
    if (!goldenEntry) {
      throw new Error(
        `${STALENESS_HINT}\n\nNo golden.json entry found for scenario "${scenario.id}".`
      )
    }

    const actual = executeScenario(scenario)

    const comparison = noThrow(() => expect(actual).toEqual(goldenEntry.expected))
    if (isNormalizedError(comparison)) {
      throw new Error(`${STALENESS_HINT}\n\n${comparison.message}`)
    }
  })
})

it('golden.json has no entries for scenarios that no longer exist', () => {
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.id))
  const orphanedIds = golden.map((entry) => entry.id).filter((id) => !scenarioIds.has(id))

  expect(orphanedIds).toEqual([])
})
