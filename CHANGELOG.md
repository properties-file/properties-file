# Changelog

## [5.0.5](https://github.com/properties-file/properties-file/compare/v5.0.4...v5.0.5) (2026-05-19)

## [5.0.4](https://github.com/properties-file/properties-file/compare/v5.0.3...v5.0.4) (2026-04-12)

### Features

- `getProperties` bundle reduced to 970 B min+gzip (sub-1 kB).
- Verified compatibility back to Node.js 0.4.0 (2011) — the first stable release with ES5 support.

## [5.0.3](https://github.com/properties-file/properties-file/compare/v5.0.2...v5.0.3) (2026-04-11)

### Features

- `getProperties` bundle size reduced from 1.1 kB to 1014 B min+gzip (-7.7%) by simplifying the internal unescape logic and eliminating a redundant module.

## [5.0.2](https://github.com/properties-file/properties-file/compare/5.0.1...5.0.2) (2026-04-11)

### Features

- New `occurrence` option on `delete()` — set `{ occurrence: 'first' }` to delete the first occurrence of a duplicate key instead of the last. Enables cleaning up duplicates while keeping the effective value.

## [5.0.1](https://github.com/properties-file/properties-file/compare/5.0.0...5.0.1) (2026-04-11)

### Features

- `format({ deduplicateKeys: true })` now also removes leading comment and blank line nodes of removed duplicates, producing cleaner output. The previous behavior (preserving leading nodes) is available via the new `deduplicateKeysKeepLeadingNodes` option.
- Improved TSDoc on all option types (`NormalizeOptions`, `InsertOptions`, `UpdateOptions`, `UpsertOptions`, `DeleteOptions`) with detailed descriptions, default values, and edge case behavior — visible in IDE tooltips and autocomplete.

# [5.0.0](https://github.com/properties-file/properties-file/compare/4.0.0...5.0.0) (2026-04-11)

### Features

- **3–7x faster** than all competing `.properties` packages, with `getProperties()` at just 1.1 kB min+gzip (smallest in ecosystem). See [comparison](./docs/COMPARISON.md).
- **Lossless data model** — the `Properties` class now preserves every element in a `.properties` file (properties, comments, blank lines, leading whitespace, duplicate keys) as typed nodes. The original content can be reconstructed exactly via `format()`.
- **Output normalization** — `format()` accepts options to standardize separators, remove comments/blank lines, deduplicate keys, collapse multiline values, wrap at character widths, and escape Unicode.
- **Granular separator tracking** — each property stores `separatorLeading`, `separatorChar`, and `separatorTrailing` separately, enabling fine-grained formatting control.
- **New editor methods** — `deleteAll()` removes all occurrences of a duplicate key, `insertBlankLine()` inserts blank lines, and `insertComment()` supports multi-line comments with embedded blank lines.
- **Node.js 0.10+ compatibility** — compiled ES5 output verified on every Node.js version from 0.10 (2013) to latest via [Docker](./tests/node-compat/).
- **`PropertiesNodeType` constants** — type-safe constants for node type discrimination (`PROPERTY`, `COMMENT`, `BLANK`).

### BREAKING CHANGES

- `Properties` class moved from `properties-file` to `properties-file/parser`.
- `properties.collection` replaced by `properties.nodes` (ordered array of all elements).
- `Property` class replaced by `PropertyNode` plain type.
- `PropertyLine` class removed (logic absorbed into parser).
- `getKeyCollisions()` returns `{ nodes: PropertyNode[] }` instead of `{ startingLineNumbers: number[] }`.
- `PropertiesEditor.delete()` returns `PropertyNode | undefined` instead of `boolean`, and accepts `{ deleteLeadingNodes: false }` instead of a boolean second argument.
- `PropertiesEditor.deleteAll()` returns `PropertyNode[]` instead of `number`.

See the [migration guide](./docs/migration/v5.md) for step-by-step upgrade instructions.

# [4.0.0](https://github.com/properties-file/properties-file/compare/3.7.0...4.0.0) (2026-03-22)

### Features

- Add bundler integrations for Rollup/Vite, esbuild, and Bun ([bcae0c1](https://github.com/properties-file/properties-file/commit/bcae0c1003837d84a29fa463c62ba2a23db142f7)), closes [#200](https://github.com/properties-file/properties-file/issues/200)
- Add Bun loader ([2453af2](https://github.com/properties-file/properties-file/commit/2453af24257e6e534faf6492fa9a45984c25badb))

### BREAKING CHANGES

- The Webpack loader export path changed from `properties-file/webpack-loader` to `properties-file/bundler/webpack`. See [migration guide](./docs/migration/v4.md).

# [3.7.0](https://github.com/properties-file/properties-file/compare/3.6.5...3.7.0) (2026-03-15)

### Features

- Enforce ES5 runtime API compatibility and improve parsing performance ([7d51f8c](https://github.com/properties-file/properties-file/commit/7d51f8c0e37a100e315a07b654b49311063d9bc8))

## [3.6.2](https://github.com/properties-file/properties-file/compare/3.6.1...3.6.2) (2025-11-15)

### Bug Fixes

- Sync PropertiesEditor.toObject() after mutations ([#175](https://github.com/properties-file/properties-file/issues/175)) ([c81ec08](https://github.com/properties-file/properties-file/commit/c81ec08e294f4236acce4d803a842be25b63fc10))

## [3.6.1](https://github.com/properties-file/properties-file/compare/3.6.0...3.6.1) (2025-09-08)

### Bug Fixes

- **unescape:** Correct invalid `\u` escape detection so `\u00FC` decodes correctly (closes [#158](https://github.com/properties-file/properties-file/issues/158)) ([409e9ff](https://github.com/properties-file/properties-file/commit/409e9ff560cd7c542393dc346583925d9c638726))

# [3.6.0](https://github.com/properties-file/properties-file/compare/3.5.13...3.6.0) (2025-08-24)

### Features

- Small performance improvement ([2ba0950](https://github.com/properties-file/properties-file/commit/2ba0950628c15bb779141add66241d450b00fddd))

## [3.5.1 — 3.5.13](https://github.com/Avansai/properties-file/compare/3.5.1...3.5.13) (2024-03-14 — 2025-07-21)

Dependency updates and internal maintenance. No user-facing changes.

# [3.5.0](https://github.com/Avansai/properties-file/compare/3.4.1...3.5.0) (2024-03-05)

### Features

- TypeScript upgraded to latest version with ES5 compatibility fixes.

## [3.4.1](https://github.com/Avansai/properties-file/compare/3.4.0...3.4.1) (2024-03-03)

### Bug Fixes

- Correct ESM paths for dual CJS/ESM compatibility ([98f53c8](https://github.com/Avansai/properties-file/commit/98f53c8d5f37f2c6a16a3f8e814a993d387c75d6))

# [3.4.0](https://github.com/Avansai/properties-file/compare/3.3.19...3.4.0) (2024-02-28)

### Features

- **cjs/esm:** Add dual CJS/ESM compatibility ([f60af94](https://github.com/Avansai/properties-file/commit/f60af942c5c16d1b03b1094e237f8eecc399e17d))

## [3.3.4 — 3.3.19](https://github.com/Avansai/properties-file/compare/3.3.4...3.3.19) (2023-10-21 — 2024-02-11)

Dependency updates and internal maintenance. No user-facing changes.

## [3.3.3](https://github.com/Avansai/properties-file/compare/3.3.2...3.3.3) (2023-10-11)

### Bug Fixes

- Improve `PropertiesEditor.insert()` performance ([#17](https://github.com/Avansai/properties-file/issues/17)) ([73531d5](https://github.com/Avansai/properties-file/commit/73531d53cbfd2b88979538343555fb65f15e314a))

## [3.3.2](https://github.com/Avansai/properties-file/compare/3.3.1...3.3.2) (2023-10-11)

### Bug Fixes

- Improve parsing performance ([#19](https://github.com/Avansai/properties-file/issues/19)) ([1b2ef59](https://github.com/Avansai/properties-file/commit/1b2ef595f3bd218968615a7febdf05d7aee82610))

## [3.3.1](https://github.com/Avansai/properties-file/compare/3.3.0...3.3.1) (2023-10-10)

### Bug Fixes

- Fix leading space behavior on values ([d7b2ee5](https://github.com/Avansai/properties-file/commit/d7b2ee5e45ee0b59b27a628dcadc9e2ea3539b57))

# [3.3.0](https://github.com/Avansai/properties-file/compare/3.2.25...3.3.0) (2023-10-10)

### Bug Fixes

- Performance optimization for `escapeContent` ([#18](https://github.com/Avansai/properties-file/issues/18)) ([7ea1b2b](https://github.com/Avansai/properties-file/commit/7ea1b2b1c53fe9f991473a8d655beafa15220cf9))

## [3.2.15 — 3.2.25](https://github.com/Avansai/properties-file/compare/3.2.15...3.2.25) (2023-08-10 — 2023-10-05)

Dependency updates. No user-facing changes.

## [3.2.14](https://github.com/Avansai/properties-file/compare/3.2.13...3.2.14) (2023-08-03)

### Bug Fixes

- Fix leading/trailing non-breaking spaces ([c782613](https://github.com/Avansai/properties-file/commit/c78261312500abc8d286a0205e4f4327c4075964))

## [3.2.2 — 3.2.13](https://github.com/Avansai/properties-file/compare/3.2.2...3.2.13) (2023-05-13 — 2023-07-20)

Dependency updates. No user-facing changes.

## [3.2.1](https://github.com/Avansai/properties-file/compare/3.2.0...3.2.1) (2023-05-06)

### Bug Fixes

- Remove corejs dependency ([b2c13cd](https://github.com/Avansai/properties-file/commit/b2c13cdd7b3677d5635e1848d39796736913014c))

# [3.2.0](https://github.com/Avansai/properties-file/compare/3.1.1...3.2.0) (2023-05-06)

### Features

- Add Babel to transpile and minify the build ([cfb0cb4](https://github.com/Avansai/properties-file/commit/cfb0cb464d9b48c145ec0837f0820e5f7e96e22e))

## [3.1.1](https://github.com/Avansai/properties-file/compare/3.1.0...3.1.1) (2023-04-30)

### Bug Fixes

- Buffer not found error ([26dde24](https://github.com/Avansai/properties-file/commit/26dde24cd78764110dede1bbed11620a97ba0157))

# [3.1.0](https://github.com/Avansai/properties-file/compare/3.0.0...3.1.0) (2023-04-25)

### Features

- Add `upsert` method ([8a356fc](https://github.com/Avansai/properties-file/commit/8a356fcbed5ff0cb8d48a8610f0391eaaa1bf7b3))

### BREAKING CHANGES

- Re-aligned method names to SQL conventions: `remove` renamed to `delete`, `edit` renamed to `update`.

# [3.0.0](https://github.com/Avansai/properties-file/compare/2.2.4...3.0.0) (2023-04-24)

### Features

- Add new editing capabilities ([3b07d98](https://github.com/Avansai/properties-file/commit/3b07d980beda337036f73aa96f283eaa72ce6cdc))

### BREAKING CHANGES

- See [migration guide](./docs/migration/v3.md) for details.

## [2.2.1 — 2.2.4](https://github.com/Avansai/properties-file/compare/2.2.1...2.2.4) (2023-03-25 — 2023-04-16)

Dependency updates. No user-facing changes.

# [2.2.0](https://github.com/Avansai/properties-file/compare/2.1.32...2.2.0) (2023-03-18)

### Features

- Add functions for property escaping ([95379d8](https://github.com/Avansai/properties-file/commit/95379d81cf0db14f49ff1fc869378ca8b64619b1))

## [2.0.2 — 2.1.32](https://github.com/Avansai/properties-file/compare/2.0.2...2.1.32) (2022-06-29 — 2022-10-27)

Dependency updates and README improvements. No user-facing changes.

## [2.0.1](https://github.com/properties-file/properties-file/releases/tag/2.0.1) (2022-06-11)

Initial release under new maintainer. Complete rewrite with Java Properties spec compliance. See [migration guide](./docs/migration/v2.md) for changes from v1.
