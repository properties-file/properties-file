# Migration Guides

Each migration guide covers upgrading from the immediately preceding major version. If you are skipping multiple major versions, apply the guides in order.

| From | To  | Guide            | Summary                                                                                         |
| ---- | --- | ---------------- | ----------------------------------------------------------------------------------------------- |
| v1   | v2  | [v2.md](./v2.md) | Complete rewrite — `parse`/`stringify` replaced with Java-spec-compliant APIs                   |
| v2   | v3  | [v3.md](./v3.md) | New `PropertiesEditor` class, `getProperties` replaces `propertiesToJson`, content-only input   |
| v3   | v4  | [v4.md](./v4.md) | Webpack loader path changed to `properties-file/bundler/webpack`                                |
| v4   | v5  | [v5.md](./v5.md) | Lossless `Properties` data model, `Properties` moves to `/parser`, `PropertiesEditor` rewritten |
