# Functional (golden-file) tests

Behavioral tests that verify the **published artifacts** — not just the TypeScript source —
behave identically everywhere: from modern Node.js down to Node.js 0.4 (the oldest supported
runtime), across both the ESM and CJS builds.

The core idea: a single table of scenarios (inputs only) is executed against the TypeScript
source to produce `golden.json` (checked in), and then **replayed** against the compiled
`dist/` output on every supported runtime. If any layer of the build pipeline (TypeScript,
esbuild, SWC, the downlevel transform, terser) or any runtime changes observable behavior, a
replay diverges from the golden file and fails.

## Architecture

One scenario table, four consumers:

| File                  | Role                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| `scenarios.ts`        | The single source of scenario definitions (pure data, no assertions).   |
| `execute-scenario.ts` | The one place that knows how to run a scenario against the **source**.  |
| `generate.ts`         | Writes `golden.json` = every scenario + its result from the source.     |
| `functional.test.ts`  | Jest (runs in `npm test`): re-executes scenarios against the source and |
|                       | asserts they still match `golden.json` (the staleness check).           |
| `run-cjs.js`          | Dependency-free ES5 replay of `golden.json` against `dist/cjs`. Runs on |
|                       | modern Node.js in the build, and on Node.js 0.4 inside the Docker image |
|                       | built by `npm run test-node-compat`.                                    |
| `run-esm.mts`         | Modern TypeScript replay (via `tsx`) of `golden.json` against           |
|                       | `dist/esm`.                                                             |

The replay runners deliberately do **not** share runtime code with `execute-scenario.ts`: they
are dumb, independent interpreters of the same golden data, which is part of what is being
cross-checked (`run-esm.mts` imports harness _types_ only — erased at compile time).
`run-cjs.js` is additionally dependency-free ES5 so it can run unmodified on Node.js 0.4.

Wiring:

- `npm run functional-generate` — regenerate `golden.json` from the source.
- `npm run test-functional` — run both replay runners against `dist/` (part of `npm run build`,
  after the Jest suite).
- `npm run test-node-compat` — Docker image copies `golden.json` + `run-cjs.js` and replays the
  full scenario set on Node.js 0.4.
- `run-cjs.js [distRoot]` / `run-esm.mts [distRoot]` accept an optional dist root argument
  (defaults to the repository's `dist/cjs` / `dist/esm`; the Docker image passes `/dist/cjs`).

## Adding a scenario

1. Add an entry to the matching kind's list in `scenarios.ts` (`parse`, `format`, `editor`,
   `escape`, or `unescape`). The `ops`/`options` fields are typed against the real API, so
   TypeScript validates the scenario shape at compile time.
2. Scenarios must be deterministic and JSON-serializable: fixed string inputs, no randomness, no
   dates, no environment dependence.
3. Run `npm run functional-generate`, then **review the `golden.json` diff like code** — the
   expected values are computed from the current source, so the diff _is_ the behavioral
   contract you are committing to.
4. Commit `scenarios.ts` and `golden.json` together.

## Adding a scenario kind

Rare — only needed for a new API surface. A new kind must be added in four places:

1. The `Scenario` union and its type in `scenarios.ts`.
2. `executeScenario()` in `execute-scenario.ts`.
3. The per-kind interpreter in **both** `run-cjs.js` and `run-esm.mts`. `run-cjs.js` must stay
   strict ES5 (`var`, `function`, ES5 built-ins only — no arrow functions, template literals,
   `const`/`let`, destructuring, spread, or `for...of`), because it executes unmodified on
   Node.js 0.4.
4. Regenerate `golden.json`.

## Troubleshooting failures

Which layer fails tells you where the problem is:

- **`functional.test.ts` fails in Jest** — the _source's_ behavior no longer matches
  `golden.json`. If the change is intentional, run `npm run functional-generate` and commit the
  updated golden file (review the diff); if not, the change is a regression in the source.
- **Jest passes, but `run-cjs.js`/`run-esm.mts` fail** — the source behaves correctly but the
  _compiled artifact_ diverges: a build-pipeline bug (TypeScript emit, esbuild bundling, the
  downlevel transform in `src/build-scripts/downlevel/`, SWC ES5 downlevel, or minification).
  The failing scenario id names the API; inspect the corresponding module under `dist/`.
- **Both pass locally, but the Node.js 0.4 Docker job fails** — the artifact uses something that
  does not exist on the old runtime (a post-ES5 API or syntax reached the output). A scenario
  that throws (rather than mismatches) usually means exactly this; the error message names the
  missing global or method.
- **The "no orphaned golden entries" test fails** — a scenario was removed from `scenarios.ts`
  but its entry is still in `golden.json`: regenerate.
- **Merge conflicts in `golden.json`** — never resolve by hand-editing; take either side, then
  regenerate from the merged `scenarios.ts`.

## Invariants

- `golden.json` is generated — never hand-edit it. It is deliberately excluded from Prettier
  (see `.prettierignore`) so repeated generation stays byte-stable.
- `golden.json` is ASCII-armored: the generator escapes every non-ASCII character as `\uXXXX`
  JSON escapes (one per UTF-16 code unit). JSON escapes decode identically on every runtime,
  whereas raw supplementary-plane UTF-8 byte sequences are mangled by Node.js 0.4's file
  decoder — armoring is what lets astral-character scenarios run faithfully there.
- `run-cjs.js` is deliberately ES5 and excluded from ESLint (see the ignore list in
  `eslint/config.ts`).
- The local `package.json` (`{ "type": "commonjs" }`) exists so Node.js treats `run-cjs.js` as
  CommonJS despite the repository root's `"type": "module"`.
