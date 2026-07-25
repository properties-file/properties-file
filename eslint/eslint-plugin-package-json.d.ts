/**
 * Local type override for eslint-plugin-package-json.
 *
 * `eslint-plugin-package-json@1.6.0` bundles its type declarations with a full
 * inlined copy of the `@types/estree` node types as they existed at version
 * 1.0.8 (e.g. `Property.key: Expression | PrivateIdentifier`), while its
 * `PackageAST` interface extends `Program` from the *installed* `@types/estree`.
 * `@types/estree@1.0.9` (2026-05-06) narrowed `Property.key` to `Expression`,
 * so the inlined 1.0.8 shapes are no longer assignable to the installed 1.0.9
 * shapes, producing three TS2430 errors in the plugin's `.d.mts` under this
 * project's `strict`, no-`skipLibCheck` typecheck.
 *
 * The `paths` mapping in tsconfig.json redirects the `eslint-plugin-package-json`
 * import to this file, bypassing the broken upstream declarations. This file
 * exposes only the symbols that `eslint/config.ts` actually consumes
 * (the `configs.recommended` flat config and its `rules`).
 *
 * Upstream status (as of 2026-07-24): the plugin's repository pins
 * `@types/estree@1.0.8` in its devDependencies, which is why the inlined copy
 * is stale. Fix proposed upstream in
 * https://github.com/michaelfaith/eslint-plugin-package-json/pull/2034
 * (tracking issue: https://github.com/michaelfaith/eslint-plugin-package-json/issues/2033).
 *
 * Remove this override (and the `paths` entry in tsconfig.json) once the
 * plugin ships declarations compatible with `@types/estree@1.0.9`.
 */

declare module 'eslint-plugin-package-json' {
  import type { Linter } from 'eslint'

  export const configs: {
    recommended: Linter.Config & { rules: Linter.RulesRecord }
  }
}
