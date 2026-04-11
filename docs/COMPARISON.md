# Comparison with Other `.properties` Packages

> **Last updated:** April 11, 2026. Download counts, compliance scores, and performance numbers may have changed since this was written. Feel free to [open an issue](https://github.com/properties-file/properties-file/issues) if you notice something outdated.

There are many `.properties` file packages on npm. This document compares the most popular ones to help you choose the right tool for your needs.

## Overview

| Package                                                              | Weekly Downloads | Last Updated | Java Compliance | TypeScript | Deps  | min+gzip   | Browser        | Node       |
| -------------------------------------------------------------------- | ---------------: | :----------- | :-------------- | :--------- | :---- | :--------- | :------------- | :--------- |
| [properties-reader](https://www.npmjs.com/package/properties-reader) |        3,063,130 | Jan 2026     | Basic (45%)     | Yes (v3+)  | 2     | 7.2 kB     | No             | >=18       |
| [java-properties](https://www.npmjs.com/package/java-properties)     |        2,790,666 | Jul 2019     | Partial (64%)   | Yes        | 0     | 1.3 kB     | No             | >=0.6      |
| **[properties-file](https://www.npmjs.com/package/properties-file)** |      **718,105** | **Mar 2026** | **Full (100%)** | **Yes**    | **0** | **1.1 kB** | **Yes (ES5+)** | **>=0.10** |
| [properties](https://www.npmjs.com/package/properties)               |          677,733 | Feb 2014     | Mostly (91%)    | No         | 0     | 3.6 kB     | Partial        | >=0.10     |
| [properties-parser](https://www.npmjs.com/package/properties-parser) |          110,318 | May 2023     | Full (100%)     | No         | 0     | 2.1 kB     | No             | >=0.3      |

> Download counts as of April 2026.

> **Note on `properties-reader`:** `properties-reader` works for basic `key=value` files with `#` comments — which covers many simple use cases. However, it is designed as an INI-style config parser and does not implement the Java `.properties` specification. `:` separators, whitespace separators, escape sequences, multiline continuations, and escaped characters in keys will not be handled correctly.

## Java Spec Compliance

We tested each library against 22 test cases that cover the [Java Properties specification](https://docs.oracle.com/javase/9/docs/api/java/util/Properties.html), including all separator types, escape sequences, multiline handling, comments, and edge cases.

| Package             |            Score | Notes                                                                                                   |
| ------------------- | ---------------: | ------------------------------------------------------------------------------------------------------- |
| **properties-file** | **22/22 (100%)** | Full compliance with Java output                                                                        |
| properties-parser   |     22/22 (100%) | Full compliance                                                                                         |
| properties          |      20/22 (91%) | Returns `null` instead of `""` for empty values                                                         |
| java-properties     |      14/22 (64%) | Fails on space separators, escaped keys, duplicate handling, crashes on some escape sequences           |
| properties-reader   |      10/22 (45%) | No `:` or space separators, no escape handling, no multiline, no empty keys, strips trailing whitespace |

### Specific failures

<details>
<summary><b>java-properties</b> (14/22)</summary>

- Space separator (`key value`) — key not found
- Escaped `=`, `:`, space in keys — key not found
- Non-escape backslash (`ran\dom` → `random`) — crashes with JSON parse error
- Even trailing backslashes (`value\\`) — crashes
- Trailing whitespace in values — stripped instead of preserved
- Duplicate keys — returns array instead of last-wins

</details>

<details>
<summary><b>properties</b> (20/22)</summary>

- Empty value (`key =`) — returns `null` instead of `""`
- Key-only (`key`) — returns `null` instead of `""`

</details>

<details>
<summary><b>properties-reader</b> (10/22)</summary>

- `:` separator (`key:value`) — treated as part of the key
- Space separator (`key value`) — treated as part of the key
- `\uXXXX` unicode escape — not decoded, returned as literal
- Escaped chars in keys (`\=`, `\:`, `\ `) — not recognized
- Non-escape backslash (`ran\dom` → `random`) — backslash kept as literal
- Multiline value continuation — not supported, trailing `\` kept as literal
- Multiline key — not supported
- Even trailing backslashes (`value\\`) — doubled instead of unescaped
- Empty key with `=` separator — not recognized
- Trailing whitespace in values — stripped

</details>

## Performance

Benchmark parsing 10,000 key-value entries (593 KB of `.properties` content), 50 iterations, median time:

| Package                               |     Median |      Throughput |           Relative |
| ------------------------------------- | ---------: | --------------: | -----------------: |
| **properties-file** (`Properties`)    | **1.7 ms** | **580 ops/sec** | **1.0x (fastest)** |
| **properties-file** (`getProperties`) | **3.0 ms** | **331 ops/sec** |           **1.8x** |
| java-properties                       |     6.1 ms |     165 ops/sec |        3.6x slower |
| properties-parser                     |    11.6 ms |      86 ops/sec |        6.8x slower |
| properties                            |    11.7 ms |      86 ops/sec |        6.9x slower |

> `properties-reader` was excluded from the benchmark because it requires file I/O and is not a Java-compliant parser.

> `properties-file` offers two parsing paths: `getProperties()` for simple key-value extraction, and `Properties` for the full lossless data model. Both are significantly faster than alternatives.

## Feature Comparison

| Feature                                         | properties-file | properties-reader | java-properties | properties | properties-parser |
| ----------------------------------------------- | :-------------: | :---------------: | :-------------: | :--------: | :---------------: |
| **Parsing**                                     |                 |                   |                 |            |                   |
| `=` separator                                   |       Yes       |        Yes        |       Yes       |    Yes     |        Yes        |
| `:` separator                                   |       Yes       |        No         |       Yes       |    Yes     |        Yes        |
| Whitespace separator                            |       Yes       |        No         |       No        |    Yes     |        Yes        |
| `\n`, `\t`, `\r`, `\f` escapes                  |       Yes       |        No         |       Yes       |    Yes     |        Yes        |
| `\uXXXX` unicode escapes                        |       Yes       |        No         |       Yes       |    Yes     |        Yes        |
| Escaped chars in keys (`\=`, `\:`, `\ `)        |       Yes       |        No         |       No        |    Yes     |        Yes        |
| Multiline values (`\` continuation)             |       Yes       |        No         |       Yes       |    Yes     |        Yes        |
| Multiline keys                                  |       Yes       |        No         |       Yes       |    Yes     |        Yes        |
| Comment handling (`#` and `!`)                  |       Yes       |        Yes        |       Yes       |    Yes     |        Yes        |
| BOM handling                                    |       Yes       |        No         |       No        |     No     |        No         |
| **Data Model**                                  |                 |                   |                 |            |                   |
| Lossless round-trip                             |       Yes       |        No         |       No        |     No     |        No         |
| Comment preservation                            |       Yes       |        No         |       No        |     No     |      Partial      |
| Blank line preservation                         |       Yes       |        No         |       No        |     No     |        No         |
| Duplicate key tracking                          |       Yes       |        No         |      Array      |     No     |        No         |
| Separator detail (char + whitespace)            |       Yes       |        No         |       No        |     No     |        No         |
| Leading whitespace preservation                 |       Yes       |        No         |       No        |     No     |        No         |
| **Editing**                                     |                 |                   |                 |            |                   |
| Insert property                                 |       Yes       |        Yes        |       No        |     No     |        Yes        |
| Update property                                 |       Yes       |        Yes        |       No        |     No     |        Yes        |
| Delete property                                 |       Yes       |        No         |       No        |     No     |        Yes        |
| Delete all duplicates                           |       Yes       |        No         |       No        |     No     |        No         |
| Insert comment                                  |       Yes       |        No         |       No        |     No     |      Partial      |
| Insert blank line                               |       Yes       |        No         |       No        |     No     |        No         |
| **Output**                                      |                 |                   |                 |            |                   |
| Format (lossless)                               |       Yes       |        No         |       No        |     No     |        No         |
| Normalize (configurable)                        |       Yes       |        No         |       No        |     No     |        No         |
| Escape utilities                                |       Yes       |        No         |       No        |     No     |        No         |
| **Integration**                                 |                 |                   |                 |            |                   |
| TypeScript                                      |       Yes       |     Yes (v3+)     |       Yes       |     No     |        No         |
| Bundler plugins (Webpack, Rollup, esbuild, Bun) |       Yes       |        No         |       No        |     No     |        No         |
| Tree-shakable                                   |       Yes       |        N/A        |       N/A       |    N/A     |        N/A        |
| Zero dependencies                               |       Yes       |      No (2)       |       Yes       |    Yes     |        Yes        |
| Browser support                                 |   Yes (ES5+)    |        No         |       No        |  Partial   |        No         |
| Node.js minimum                                 |     >=0.10      |       >=18        |      >=0.6      |   >=0.10   |       >=0.3       |
| **Quality**                                     |                 |                   |                 |            |                   |
| Test coverage                                   |      100%       |      Unknown      |     Unknown     |  Unknown   |      Unknown      |
| Active maintenance                              |   Yes (2026)    |    Yes (2026)     |    No (2019)    | No (2014)  |  Minimal (2023)   |
| min+gzip (reading)                              |     1.1 kB      |      7.2 kB       |     1.3 kB      |   3.6 kB   |      2.1 kB       |

## When to use what

- **You need a simple key-value object** → `properties-file` (`getProperties`) — fastest, smallest, 100% compliant.
- **You need to inspect or transform the file** → `properties-file` (`Properties`) — lossless data model with normalization.
- **You need to edit and write back** → `properties-file` (`PropertiesEditor`) — full editing with format preservation.
- **You need INI-style config parsing** → `properties-reader` — not Java-compliant, but good for INI files with sections.
- **You're already using `java-properties`** → consider switching — it crashes on valid input, hasn't been updated since 2019, and is 3.6x slower.
- **You're already using `properties`** → consider switching — abandoned since 2014, returns `null` for empty values (spec violation).
