# Benchmarks

Performance benchmarks for `properties-file`, powered by [tinybench](https://github.com/tinylibs/tinybench).

## Quick Start

```bash
# Run benchmarks and print results
npm run benchmark

# Compare current code against the latest release tag
npm run benchmark:compare
```

## How It Works

### `npm run benchmark`

Runs all benchmark suites and prints a table of results (ops/sec, median latency, margin of error). Results are also written to `benchmarks/.results/results.json`.

### `npm run benchmark:compare`

Compares current code against the latest git release tag (e.g. `v3.7.0`):

1. Creates two **isolated copies** of the project in a temporary directory.
2. Replaces the baseline copy's `src/` with the tagged version via `git archive`.
3. Runs both copies **in parallel** so they share the same system conditions, reducing noise from external load.
4. Produces a comparison table in the terminal and a Markdown report at `benchmarks/.results/comparison.md`.

This design is **hardware-independent** — since both versions run on the same machine in the same session, absolute speed doesn't matter, only relative change. The benchmark can run on any machine (local dev, CI) and produce consistent comparisons.

## Benchmark Suites

| File                         | What it measures                                                               |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `properties.bench.ts`        | `Properties` constructor and `getProperties` across all payload types          |
| `properties-editor.bench.ts` | `PropertiesEditor` operations: insert, update, upsert, delete                  |
| `escape-unescape.bench.ts`   | `escapeKey`, `escapeValue`, and `unescapeContent` with ASCII and Unicode input |

## Payloads

Synthetic payloads (`payloads.ts`) generate 10,000+ entries each, targeting different parser code paths:

| Payload          | Parser path exercised                                               |
| ---------------- | ------------------------------------------------------------------- |
| Pure key/value   | Best-case fast path (no escapes, comments, or whitespace variation) |
| Comment-heavy    | Comment-skip logic (`#` and `!` lines)                              |
| Whitespace-heavy | Trimming, blank lines, whitespace separators                        |
| Unicode escapes  | `\uXXXX` decoding (regex-heavy, most expensive path)                |
| Multiline values | `\` line continuation handling                                      |
| Mixed/realistic  | Real `.properties` file repeated to scale (all features combined)   |

## Output Structure

All generated files are in `benchmarks/.results/` (git-ignored):

```
benchmarks/.results/
  results.json          # Latest standalone run
  baseline/results.json # Comparison: baseline (release tag)
  current/results.json  # Comparison: current code
  comparison.md         # Markdown comparison report
```
