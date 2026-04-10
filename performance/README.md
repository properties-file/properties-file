# Performance

Performance benchmarks and bundle size analysis for `properties-file`, powered by [tinybench](https://github.com/tinylibs/tinybench).

## Quick Start

```bash
# Compare benchmarks against the latest published version
npm run build
npm run benchmark

# Compare bundle sizes against the latest published version
npm run size

# Compare against a saved snapshot
npm run benchmark -- --snapshot my-snapshot
npm run size -- --snapshot my-snapshot

# Compare against a specific published version
npm run benchmark -- --version 3.7.0
npm run size -- --version 3.7.0

# Average benchmark results over multiple runs (reduces noise)
npm run benchmark -- --runs 3

# Save a snapshot for later comparison
npm run build
npm run snapshot -- save my-snapshot "Description of this version"

# Restore a snapshot
npm run snapshot -- restore my-snapshot

# Clean all caches and results
npm run performance-clean
```

## Commands

### `npm run benchmark`

Compares runtime performance of the current compiled code (`dist/`) against a baseline. The default baseline is the latest published npm version. Published packages are downloaded and cached automatically.

```bash
npm run benchmark                                    # vs latest published version
npm run benchmark -- --version 3.7.0                 # vs specific published version
npm run benchmark -- --snapshot before-optimization   # vs saved snapshot
npm run benchmark -- --runs 3                        # average over multiple runs
npm run benchmark -- --snapshot my-snapshot --runs 5  # snapshot + multiple runs
npm run benchmark -- --strict                        # exit code 1 on regressions
```

Both current and baseline benchmarks run **in parallel** so they share the same system conditions (CPU load, thermal state), ensuring a fair comparison.

The `--runs` option repeats the full parallel cycle N times and averages the results, reducing noise for detecting small changes.

Results are saved to `performance/benchmarks/.results/` as JSON and Markdown.

**Prerequisite:** `dist/` must exist. Run `npm run build` first.

### `npm run size`

Compares bundle sizes of the current compiled code against a baseline. Measures tree-shaken, minified, and gzipped size for each entry point using esbuild. Also updates the README badge with the current `getProperties` size.

```bash
npm run size                                 # vs latest published version
npm run size -- --version 3.7.0              # vs specific published version
npm run size -- --snapshot my-snapshot        # vs saved snapshot
npm run size -- --strict                     # exit code 1 if any entry grows >10%
```

Size measurements are deterministic, so `--runs` is not needed.

Entry points measured:

| Entry point               | What it represents                                    |
| ------------------------- | ----------------------------------------------------- |
| `getProperties`           | Most common use case: convert `.properties` to object |
| `Properties`              | Class-based parsing with metadata access              |
| `PropertiesEditor`        | Full editor (insert, update, delete)                  |
| `escapeKey + escapeValue` | Escape utilities only                                 |
| `All exports (*)`         | Everything imported (worst case)                      |

Results are saved to `performance/size/.results/` as JSON and Markdown.

**Prerequisite:** `dist/` must exist. Run `npm run build` first.

### `npm run snapshot`

Saves and restores complete project states for iterative optimization. Each snapshot captures everything that can affect compiled output.

#### `save <name> <description>`

Saves the current `src/`, `dist/`, `package.json`, `package-lock.json`, and `tsconfig.json` as a named snapshot.

```bash
npm run build
npm run snapshot -- save before-rewrite "Baseline before parser rewrite"
```

**Prerequisite:** `dist/` must exist. Run `npm run build` first.

#### `list`

Lists all saved snapshots with their date, commit, branch, and description.

```bash
npm run snapshot -- list
```

#### `restore <name>`

Replaces the project's `src/`, `dist/`, `package.json`, `package-lock.json`, and `tsconfig.json` with the copies from the snapshot. This is a **destructive operation** — includes a dirty-working-tree guard that checks for uncommitted changes in `src/` and `dist/` before proceeding.

```bash
npm run snapshot -- restore before-rewrite
```

> **Tip:** After restoring, your working tree will show changes in `git diff`. Use `git checkout -- src/ dist/` to get back to your current git state, or restore a different snapshot.

#### `delete <name>`

Deletes a saved snapshot and all its stored files.

```bash
npm run snapshot -- delete before-rewrite
```

### `npm run performance-clean`

Removes all caches and results. Does **not** delete snapshots.

```bash
npm run performance-clean
```

Deletes:

- `performance/published-packages/.cache/` — downloaded npm packages
- `performance/benchmarks/.results/` — benchmark results
- `performance/size/.results/` — size results

## Pre-release Gate

Before a release, both tools should run with `--strict` to catch regressions:

```bash
npm run build
npm run benchmark -- --strict   # fails if any benchmark regresses >20%
npm run size -- --strict        # fails if any entry point grows >10%
```

This can be added to `release-it`'s `before:init` hook.

## Typical Workflows

### Iterative optimization

```bash
# 1. Build and save starting point
npm run build
npm run snapshot -- save before-change "Starting point"

# 2. Make changes, rebuild, compare against starting point
npm run build
npm run benchmark -- --snapshot before-change
npm run size -- --snapshot before-change

# 3. Happy? Save this approach
npm run snapshot -- save after-change "Optimized parser"

# 4. Want to try something else? Restore starting point
npm run snapshot -- restore before-change

# 5. Make different changes, rebuild, compare against the other approach
npm run build
npm run benchmark -- --snapshot after-change
npm run size -- --snapshot after-change
```

### PR validation

```bash
npm run build
npm run benchmark
npm run size
```

### Comparing against an older release

```bash
npm run build
npm run benchmark -- --version 3.7.0
npm run size -- --version 3.7.0
```

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
| Unicode escapes  | `\uXXXX` decoding (most expensive path)                             |
| Multiline values | `\` line continuation handling                                      |
| Mixed/realistic  | Real `.properties` file repeated to scale (all features combined)   |

## Directory Structure

```
performance/
  published-packages/
    manage.ts                       # Fetch + cache published npm versions
    .cache/                         # Cached packages (git-ignored)
  snapshots/
    manage.ts                       # Snapshot CRUD (save, list, restore, delete)
    .snapshots/                     # Saved snapshots (git-ignored)
      <name>/
        src/                        # Source code
        dist/                       # Compiled output
        package.json                # Dependencies
        package-lock.json           # Exact dependency tree
        tsconfig.json               # Compiler settings
        metadata.json               # Git commit, branch, date, description
  benchmarks/
    compare.ts                      # Compare benchmarks: current vs baseline
    payloads.ts                     # Synthetic test data generators
    suites/                         # Benchmark suite files
    .results/                       # Generated results (git-ignored)
  size/
    compare.ts                      # Compare bundle sizes: current vs baseline
    .results/                       # Generated results (git-ignored)
  utilities.ts                      # Shared: baseline resolution, comparison formatting
  README.md
  tsconfig.json
```
