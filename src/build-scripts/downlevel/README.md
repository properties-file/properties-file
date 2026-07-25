# Downlevel transform

A type-aware build step that lets shipped source code use modern JavaScript APIs while the
published artifacts stay ES5-compatible (down to Node.js 0.4). Source stays readable and
idiomatic; compatibility is produced mechanically at build time.

## The idea

Backward compatibility is handled by three cooperating mechanisms, each owning one layer:

1. **Syntax** — TypeScript (and esbuild/SWC) transpile modern syntax (arrow functions, classes,
   template literals, destructuring) to ES5 mechanically; nothing needs to be restricted at
   source level.
2. **Iteration** — SWC's `iterableIsArray` assumption lowers `for...of` and spread to plain
   index-based code with no `Symbol.iterator` dependency (see the SWC step in
   `src/build-scripts/build.ts`). Safe because the local `local/array-iteration-only` ESLint rule
   proves shipped code only iterates arrays: it type-checks every `for...of` target, every
   iterable spread (in calls, array literals, and `new` expressions — object spread is exempt,
   it lowers to property copying), and every array-destructuring `ArrayPattern` — covering
   variable declarations, `for...of` loop bindings, function parameters, and nested patterns —
   against an array/tuple type.
3. **Runtime APIs** — this directory. Methods like `String#includes` cannot be "transpiled":
   the method simply does not exist on an old runtime. Instead, each supported API is
   **rewritten** into an equivalent ES5 expression (e.g. `x.includes(y)` →
   `x.indexOf(y) !== -1`) before compilation, using the TypeScript type checker to know what is
   being rewritten (a `string` receiver, an array, a numeric element type, …).

Two verification layers make the guarantee provable rather than aspirational:

- **Artifact gate** — the build runs every es-x `restrict-to-es5` rule against the built output
  itself (see the "verify ES5 output" step in `src/build-scripts/build.ts`). This is the ONLY
  place ES5 compatibility is checked — deliberately not at source level, where covered APIs
  would need exception lists and generated code (emitted helpers, toolchain output) is
  invisible anyway. On the output the check is exceptionless: every covered API has already
  been rewritten away, so anything modern that remains is a build-pipeline bug. The only exempt
  region is SWC's own underscore-prefixed compatibility helpers, which reference modern globals
  deliberately behind feature-detection guards. Note the gate only understands ECMAScript —
  runtime-specific host APIs are kept out of shipped code by the `no-restricted-globals`
  runtime-agnostic ban in `eslint/config.ts` instead.
- **Behavioral proof** — the functional replay tests (`tests/functional/`) execute the built
  artifacts on Node.js 0.4 in CI.

## How it runs

`transform.ts` (invoked at the start of `npm run build`, before `tsc`) loads the repository's
sources through ts-morph with the root `tsconfig.json`, applies the rewrite catalog to a copy of
every file, and writes the result to a shadow tree at `./.transformed-src/`. The build then
compiles the shadow tree (`tsc -p tsconfig.build.json`, and esbuild bundles the main entry from
it) — the real `src/` is never modified. The shadow tree is deleted at the end of the build.

## Files

| File                 | Role                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `transform.ts`       | Orchestrator: shadow-tree copy, rewrite, self-verification.            |
| `catalog.ts`         | The rewrite catalog — one rule per supported API shape.                |
| `helpers.ts`         | Shared predicates (type checks, the simple-expression rule, refusals). |
| `emitted-helpers.ts` | Helper functions emitted into the shadow tree for non-inline rewrites. |

## The safety model

Two principles keep the transform small and provably correct:

- **Evaluation-order preservation.** A rewrite that references each operand exactly once, in the
  original order (e.g. `includes` → `indexOf`), accepts arbitrary expressions — nothing about
  the operands needs to be validated, because nothing is duplicated or reordered.
- **The simple-expression rule.** A rewrite whose inline output would reference an operand twice
  (e.g. `endsWith` → `s.slice(s.length - p.length) === p` uses both operands twice) only inlines
  when the operands are side-effect-free (identifiers, `this`, dot-chains, literals). Otherwise
  it emits a small typed **helper function** into the file (see `emitted-helpers.ts`) and calls
  it — full support, single evaluation, no silent behavior change.

Every emitted helper implements the exact ECMAScript semantics of the method it replaces —
including argument clamping and `NaN` handling — and is tested for **runtime equivalence**
against the native method across edge-input matrices (see the "runtime equivalence" tests in
`tests/downlevel-transform.test.ts`). The same equivalence discipline applies to **inline**
rewrite shapes (e.g. the `indexOf(...) !== -1` form): the catalog-rewritten expression text is
compiled and executed directly (never hand-re-implemented in the test), and checked against the
native method across the same kind of edge-input matrix — see "Runtime equivalence for INLINE
rewrite shapes" in the same test file. This is not a redundant duplicate of the helper tests: a
`split`/`join` fast path once looked correct by inspection but diverged from native `replaceAll`
for an empty search value, a case only an equivalence test (not a read of the code) would catch.

The transform refuses (fails the build with a `file:line` diagnostic) only for constructs whose
semantics do not exist in ES5 at all, or that would always throw natively: an `Array#entries()`
iterator that escapes a `for...of`; a `for...of .entries()` binding where the index position
isn't a plain identifier (a rest element or default value there is meaningless — `entries()`
always yields exactly one index and one value per iteration); `replaceAll` with a RegExp search
value that lacks the `g` flag (native `replaceAll` always throws `TypeError` for this, so failing
the build is strictly better than shipping a call that always throws). Refusal messages state the
semantic reason.

## Supported APIs

| API                                           | Rewrite                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `String#includes` / `Array#includes`          | `indexOf(...) !== -1`; literal-array receivers become a `===`           |
|                                               | comparison chain; numeric arrays use a NaN-safe helper.                 |
| `String#startsWith` (with/without pos)        | `lastIndexOf(p, 0) === 0`; position form uses a helper.                 |
| `String#endsWith` (with/without pos)          | Slice comparison; non-simple operands / position use a helper.          |
| `Object.hasOwn`                               | `Object.prototype.hasOwnProperty.call(...)`.                            |
| `Array#toSorted` / `Array#toReversed`         | `slice().sort(...)` / `slice().reverse()`.                              |
| `String#replaceAll` (global RegExp literal)   | `.replace(...)` directly (`replace`/`replaceAll` share the algorithm    |
|                                               | for a global RegExp); a literal missing the `g` flag is a build error.  |
| `String#replaceAll` (non-literal RegExp)      | Helper: checks `.global` at run time, then `.replace(...)`.             |
| `String#replaceAll` (string search, function) | Helper implementing the native per-match replacer contract.             |
| `String#replaceAll` (string search, string)   | `split(a).join(b)` only for a non-empty literal search and a `$`-free   |
|                                               | literal replacement (the only case a plain split/join is exact —        |
|                                               | `replaceAll` still applies GetSubstitution, and an empty search inserts |
|                                               | at every boundary position); helper otherwise.                          |
| `Number.parseInt` / `Number.parseFloat`       | Global `parseInt` / `parseFloat`.                                       |
| `` String.raw`...` ``                         | Constant-folded literal; substitutions become concatenation.            |
| `Array#entries` (in `for...of`)               | Index loop; non-simple receivers are hoisted to a local; the value      |
|                                               | position may itself be a nested destructuring pattern.                  |
| `String#at` / `Array#at`                      | Direct indexing for integer literals; helper for anything else.         |
| `Number.isNaN`                                | `(x !== x)` for a simple number-typed operand; helper otherwise.        |
| `Number.isFinite`                             | Global `isFinite(x)` for a number-typed operand; helper otherwise.      |
| `Number.isInteger` / `Number.isSafeInteger`   | Helper (always — no allocation-free inline ES5 form).                   |
| `Number.EPSILON` / `MAX_SAFE_INTEGER` /       | Constant-folded numeric literal (`MIN_SAFE_INTEGER` is parenthesized).  |
| `MIN_SAFE_INTEGER`                            |                                                                         |
| `Array#find` / `findIndex` / `findLast` /     | Helper (always): forward/backward loop, `predicate.call(thisArg, ...)`. |
| `findLastIndex`                               |                                                                         |
| `String#repeat`                               | Helper with exact `RangeError` semantics for negative/infinite counts.  |
| `String#padStart` / `padEnd`                  | Helper with exact fill/truncation semantics.                            |
| `Object.values` / `Object.entries`            | Helper: `Object.keys` loop (same own-enumerable-key order).             |
| `Array#toSpliced`                             | Helper: `slice()` copy, then `.splice(...)` the copy.                   |

## Adding a catalog entry

The catalog, the ESLint configuration, and the tests must stay consistent. The checklist:

1. **Rule** — add the rewrite to `catalog.ts` (and register it in `CATALOG_RULES`). Decide which
   safety class it is in: operands-used-once (accept anything) or operand-duplicating (inline
   for simple operands, emitted helper otherwise — add the helper to `emitted-helpers.ts`).
2. **Tests** — in `tests/downlevel-transform.test.ts`: positive rewrite cases (exact expected
   output), a helper-fallback case if applicable, and a **runtime-equivalence test for every
   rewrite shape the entry introduces — inline or emitted helper alike** — against the native
   method it replaces, covering the ECMAScript edge cases (negative/oversized positions, empty
   strings, `NaN`, etc.). For an emitted helper, compile `HELPER_SOURCE[name]` and execute it
   (see `compileHelper`); for an inline shape, extract and execute the exact rewritten expression
   text from a `rewrite()`-transformed source file (see `compileRewrittenExpression` /
   `extractRewrittenExpression`) — never hand-re-implement the rewrite's logic in the test, since
   that can reproduce (and hide) the same bug the rewrite itself has. This is not optional for
   "obviously correct" inline shapes: the `replaceAll` split/join fast path looked correct by
   inspection twice (missing first the `$`-substitution case, then the empty-search case) before
   equivalence testing caught both.
3. **ESLint** — usually nothing: ES5 compatibility is checked on the built output (the artifact
   gate), not at source level, and the lazy policy (see the `UNICORN_MODERN_API_RULES` doc in
   `eslint/config.ts`) keeps uncovered-API rules active — covering the API simply makes their
   suggestions buildable. If the rule was previously parked in `UNICORN_MODERN_API_RULES` (a
   documented decision), remove its entry only if the catalog now covers the rule's entire
   suggestion surface.
4. **Source** — modernize call sites the newly-enabled rules flag.
5. **Verification** — `npm run build` must stay green end to end, and for call sites that
   existed before in hand-written ES5 form, the rebuilt `dist/` files should be byte-identical
   to their previous build (the modern source form must round-trip to exactly the code that was
   there before). The Node.js 0.4 compat test (`npm run test-node-compat`) is the behavioral
   backstop.

## Troubleshooting

- **Build fails with a "cannot downlevel this usage" error** — a source file uses a supported
  API in one of the few genuinely unsupported (non-ES5-expressible) forms. The message includes
  the location, the offending code, and the fix.
- **Build fails with "catalog rule … still matched after the rewrite pass"** — an internal bug
  in a catalog rule (its matcher and its rewrite disagree about what it handles); fix the rule,
  not the source.
- **A functional replay test fails but Jest passes** — see `tests/functional/README.md`; if the
  failing module uses a catalog API, suspect the rewrite first and compare the module's built
  output against the equivalent hand-written form.
