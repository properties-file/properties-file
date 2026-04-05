# Performance

Performance benchmarks and bundle size analysis for `properties-file`, powered by [tinybench](https://github.com/tinylibs/tinybench).

## Quick Start

```bash
# Run benchmarks and print results
npm run benchmark

# Compare current code against the latest release tag
npm run benchmark-compare

# Compare against a saved snapshot
npm run benchmark-compare -- --snapshot my-snapshot

# Run multiple iterations and average results to reduce noise
npm run benchmark-compare -- --runs 3
npm run benchmark-compare -- --snapshot my-snapshot --runs 3

# Save a snapshot (results + source + compiled code)
npm run snapshot -- save my-snapshot "Description of this version"

# Restore a snapshot's source and compiled code
npm run snapshot -- restore my-snapshot

# Measure bundle sizes (per entry point, tree-shaken + minified + gzipped)
npm run size

# Compare bundle sizes against the latest release tag
npm run size-compare
```

## Commands

### `npm run benchmark`

Runs all benchmark suites and prints a table of results (ops/sec, median latency, margin of error). Results are also written to `performance/benchmarks/.results/results.json`.

### `npm run benchmark-compare`

Compares current code against the latest git release tag (e.g. `v4.0.0`) or a saved snapshot:

1. Creates two **isolated copies** of the project in a temporary directory.
2. Replaces the baseline copy's `src/` with the tagged version (via `git archive`) or the snapshot's saved source.
3. Runs both copies **in parallel** so they share the same system conditions, reducing noise from external load.
4. Produces a comparison table in the terminal and a Markdown report at `performance/benchmarks/.results/comparison.md`.

This design is **hardware-independent** — since both versions run on the same machine in the same session, absolute speed doesn't matter, only relative change.

```bash
# Compare against the latest release tag
npm run benchmark-compare

# Compare against a saved snapshot
npm run benchmark-compare -- --snapshot my-snapshot

# Average over multiple runs to reduce noise further
npm run benchmark-compare -- --runs 3
npm run benchmark-compare -- --snapshot my-snapshot --runs 3
```

The `--runs` option repeats the full parallel benchmark cycle N times and averages the results. Each run creates fresh isolated copies and runs baseline + current in parallel, so system noise is both shared (within a run) and averaged out (across runs).

### `npm run snapshot`

Local snapshot system for fast iteration when experimenting with different optimization approaches. Each snapshot captures **benchmark results**, **source code** (`src/`), and **compiled output** (`dist/`).

Snapshots are pure CRUD — they don't run benchmarks. Run `npm run benchmark` first, then save.

#### `save <name> <description>`

Saves the latest benchmark results plus `src/` and `dist/` as a named snapshot.

```bash
npm run benchmark
npm run snapshot -- save before-rewrite "Baseline before parser rewrite"
```

#### `list`

Lists all saved snapshots with their date, commit, branch, and description.

```bash
npm run snapshot -- list
```

#### `restore <name>`

Replaces the project's `src/` and `dist/` directories with the copies from the snapshot. This is a **destructive operation** — it completely deletes the current `src/` and `dist/` and replaces them with the snapshot's versions.

This lets you instantly switch back to a previous approach without rebuilding, so you can re-run benchmarks or inspect the code exactly as it was when the snapshot was taken.

```bash
npm run snapshot -- restore before-rewrite
```

> **Tip:** After restoring, your working tree will show changes in `git diff`. You can use `git checkout -- src/ dist/` to get back to your current git state, or restore a different snapshot.

#### `delete <name>`

Deletes a saved snapshot and all its stored files.

```bash
npm run snapshot -- delete before-rewrite
```

### Typical Workflow

```bash
# 1. Run benchmarks and save baseline
npm run benchmark
npm run snapshot -- save approach-a "Current implementation"

# 2. Make changes, rebuild
npm run build

# 3. Run benchmarks and save the new approach
npm run benchmark
npm run snapshot -- save approach-b "New parser strategy"

# 4. Compare against approach-a
npm run benchmark-compare -- --snapshot approach-a

# 5. Want to go back to approach-a? Restore it instantly (no rebuild needed)
npm run snapshot -- restore approach-a

# 6. Run benchmarks to verify you're back to baseline numbers
npm run benchmark

# 7. Switch to approach-b again
npm run snapshot -- restore approach-b
```

### `npm run size` / `npm run size-compare`

Measures the tree-shaken, minified, and gzipped bundle size for each common import pattern using esbuild. This verifies that tree-shaking works correctly and that users who only need `getProperties` don't pay for the full `Properties` class chain.

`npm run size` measures the current build. `npm run size-compare` also builds the latest release tag and shows a side-by-side comparison, flagging any entry point that grew by more than 10%.

Entry points measured:

| Entry point               | What it represents                                    |
| ------------------------- | ----------------------------------------------------- |
| `getProperties`           | Most common use case: convert `.properties` to object |
| `Properties`              | Class-based parsing with metadata access              |
| `PropertiesEditor`        | Full editor (insert, update, delete)                  |
| `escapeKey + escapeValue` | Escape utilities only                                 |
| `All exports (*)`         | Everything imported (worst case)                      |

## Benchmark Suites

| File                                           | What it measures                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `benchmarks/suites/properties.bench.ts`        | `Properties` constructor and `getProperties` across all payload types          |
| `benchmarks/suites/properties-editor.bench.ts` | `PropertiesEditor` operations: insert, update, upsert, delete                  |
| `benchmarks/suites/escape-unescape.bench.ts`   | `escapeKey`, `escapeValue`, and `unescapeContent` with ASCII and Unicode input |

## Payloads

Synthetic payloads (`benchmarks/payloads.ts`) generate 10,000+ entries each, targeting different parser code paths:

| Payload          | Parser path exercised                                               |
| ---------------- | ------------------------------------------------------------------- |
| Pure key/value   | Best-case fast path (no escapes, comments, or whitespace variation) |
| Comment-heavy    | Comment-skip logic (`#` and `!` lines)                              |
| Whitespace-heavy | Trimming, blank lines, whitespace separators                        |
| Unicode escapes  | `\uXXXX` decoding (regex-heavy, most expensive path)                |
| Multiline values | `\` line continuation handling                                      |
| Mixed/realistic  | Real `.properties` file repeated to scale (all features combined)   |

## Directory Structure

```
performance/
  benchmarks/
    run.ts                          # Run all benchmark suites
    compare.ts                      # Compare against release tag or snapshot
    payloads.ts                     # Synthetic test data generators
    suites/                         # Benchmark suite files
    .results/                       # Generated results (git-ignored)
  size/
    measure.ts                      # Bundle size measurement and comparison
    .results/                       # Generated results (git-ignored)
  snapshots/
    manage.ts                       # Snapshot CRUD (save, list, restore, delete)
    .snapshots/                     # Saved snapshots (git-ignored)
      <name>/
        results.json                # Benchmark results at time of snapshot
        metadata.json               # Git commit, branch, date, description
        src/                        # Source code
        dist/                       # Compiled output
  shared/
    compare-utilities.ts            # Shared comparison formatting helpers
  README.md
  tsconfig.json
```
