/**
 * The downlevel rewrite catalog.
 *
 * Each entry recognizes one modern-JS API shape and rewrites it to an ES5-safe equivalent
 * before the shadow-tree copy is compiled (see `transform.ts`). This lets shipped source use
 * the modern form (enforced by ESLint — see `eslint/config.ts`) while the published artifacts
 * stay ES5/Node 0.4 compatible.
 *
 * Most entries evaluate their receiver and every argument exactly once, in the original order,
 * so they accept arbitrary expressions (calls, arithmetic, whatever) — only the value's *type*
 * is validated. A handful of forms would need to evaluate an operand twice to stay
 * allocation-free (e.g. inlining `s.slice(s.length - p.length) === p` for a non-literal
 * `endsWith`); those keep an allocation-free inline fast path for simple (duplication-safe)
 * operands, and fall back to a small emitted helper function (`emitted-helpers.ts`) for
 * everything else, rather than refusing. See `helpers.ts` for the "simple expression" rule
 * these fast paths rely on.
 *
 * Every remaining refusal exists because the construct genuinely has no ES5 equivalent, or would
 * always throw natively, rather than because the transform doesn't know how to rewrite it: a
 * `.entries()` result stored as an iterator instead of consumed immediately by a `for...of`; a
 * `for...of .entries()` index binding that isn't a plain identifier (a rest element or default
 * value there is meaningless, since `entries()` always yields exactly one index and one value
 * per iteration); and `replaceAll` with a RegExp search *literal* missing the `g` flag (native
 * `replaceAll` always throws `TypeError` for this, so failing the build is strictly better than
 * shipping a call that always throws). See `CATALOG_RULE_ARRAY_ENTRIES_FOR_OF` and
 * `CATALOG_RULE_REPLACE_ALL` for the specific reasons.
 */
import { Node, SyntaxKind } from 'ts-morph'

import {
  emitRequestedHelpers,
  pickFreshIdentifierName as pickFreshName,
  requestHelper,
} from './emitted-helpers'
import {
  capitalizeFirstLetter,
  escapeForSingleQuotedLiteral,
  getIntegerLiteral,
  isArrayLikeType,
  isGlobalConstructorReference,
  isIndexOfSafeReceiverType,
  isIndexOfSafeType,
  isNaNLiteralElement,
  isNumberLikeType,
  isRegExpLikeType,
  isSimpleArgument,
  isSimpleArrayLiteralElement,
  isSimpleExpression,
  isStringLikeType,
  refuse,
  refuseSpreadArguments,
} from './helpers'

import type { DownlevelHelperName } from './emitted-helpers'
import type { Expression, SourceFile, VariableDeclarationList } from 'ts-morph'

/**
 * A single downlevel catalog entry.
 */
export type CatalogRule = {
  /** Short identifier used in diagnostics (e.g. the entry's catalog number and API name). */
  readonly id: string
  /**
   * Find the next unhandled match of this rule's pattern in `sourceFile` and rewrite it in
   * place. Re-scans the AST from scratch on every call, so it stays correct across rewrites
   * made by this rule or any other.
   *
   * @param sourceFile - The source file to scan and rewrite.
   *
   * @returns `true` if a match was found and rewritten (the caller should call again to look
   *   for further matches), or `false` if no match remains.
   *
   * @throws DownlevelRefusalError if a match is found but has no ES5-safe rewrite at all.
   */
  readonly rewriteNext: (sourceFile: SourceFile) => boolean
}

// ---------------------------------------------------------------------------
// #1 — `x.includes(y)` / `x.includes(y, from)`
// ---------------------------------------------------------------------------

const CATALOG_RULE_INCLUDES: CatalogRule = {
  id: '#1 String/Array#includes',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'includes') {
        continue
      }
      const receiver = callee.getExpression()
      const receiverType = receiver.getType()
      const isArray = isArrayLikeType(receiverType)
      if (!isArray && !isStringLikeType(receiverType)) {
        continue
      }

      const arguments_ = call.getArguments()
      const argumentsText = arguments_.map((argument) => argument.getText()).join(', ')

      if (!isArray) {
        // String#includes never duplicates its receiver or arguments — arbitrary shapes OK.
        call.replaceWithText(`(${receiver.getText()}.indexOf(${argumentsText}) !== -1)`)
        return true
      }

      // Array#includes on a literal array: rewrite to a comparison chain instead of `.indexOf()`
      // so the array literal is never (re-)materialized at all.
      if (Node.isArrayLiteralExpression(receiver)) {
        const elements = receiver.getElements()
        const isChainEligible =
          arguments_.length === 1 &&
          isSimpleArgument(arguments_[0]) &&
          elements.every((element) => isSimpleArrayLiteralElement(element))
        if (isChainEligible) {
          const argumentText = arguments_[0].getText()
          const branches = elements.map((element) =>
            // `NaN === NaN` is always `false`; a self-inequality test is the only way to test
            // "is this the search value?" for a `NaN` element (mirrors `includes`'
            // SameValueZero). Matches both the bare `NaN` and `Number.NaN` spellings — see
            // isNaNLiteralElement.
            isNaNLiteralElement(element)
              ? `${argumentText} !== ${argumentText}`
              : `${argumentText} === ${element.getText()}`
          )
          call.replaceWithText(`(${branches.join(' || ')})`)
          return true
        }
      }

      // Any other array receiver: `.indexOf()` is safe only when the element type AND the
      // search argument's type provably exclude the two divergence values — `NaN` (found by
      // `includes`, never by `indexOf`) and `undefined` (read from holes by `includes`, skipped
      // by `indexOf`). Generic, `any`, and `unknown` types are not provable, so they take the
      // exact helper below.
      if (
        isIndexOfSafeReceiverType(receiverType) &&
        (arguments_.length === 0 || isIndexOfSafeType(arguments_[0].getType()))
      ) {
        call.replaceWithText(`(${receiver.getText()}.indexOf(${argumentsText}) !== -1)`)
        return true
      }

      // Not provably indexOf-safe, and not eligible for the comparison chain above: the exact
      // helper — receiver and arguments are each passed through once, so arbitrary shapes OK.
      requestHelper(sourceFile, 'downlevelIncludesNaNSafe')
      call.replaceWithText(`downlevelIncludesNaNSafe(${receiver.getText()}, ${argumentsText})`)
      return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// #2 — `s.startsWith(p)` / `s.startsWith(p, position)`
// ---------------------------------------------------------------------------

const CATALOG_RULE_STARTS_WITH: CatalogRule = {
  id: '#2 String#startsWith',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'startsWith') {
        continue
      }
      const receiver = callee.getExpression()
      if (!isStringLikeType(receiver.getType())) {
        continue
      }
      // The two rewrite forms below dispatch on the syntactic argument count, which a spread
      // argument would silently defeat (one spread node can carry a runtime position).
      refuseSpreadArguments(call)

      const arguments_ = call.getArguments()
      if (arguments_.length === 2) {
        // `position` forces the helper regardless of operand shape: any shape is OK there since
        // the helper only evaluates each argument once.
        requestHelper(sourceFile, 'downlevelStartsWithAt')
        call.replaceWithText(
          `downlevelStartsWithAt(${receiver.getText()}, ${arguments_[0].getText()}, ${arguments_[1].getText()})`
        )
        return true
      }

      // No position argument: the receiver and pattern are each evaluated once — arbitrary
      // shapes OK.
      call.replaceWithText(
        `(${receiver.getText()}.lastIndexOf(${arguments_[0].getText()}, 0) === 0)`
      )
      return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// #3 — `s.endsWith(p)` / `s.endsWith(p, endPosition)`
// ---------------------------------------------------------------------------

const CATALOG_RULE_ENDS_WITH: CatalogRule = {
  id: '#3 String#endsWith',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'endsWith') {
        continue
      }
      const receiver = callee.getExpression()
      if (!isStringLikeType(receiver.getType())) {
        continue
      }
      // The rewrite forms below dispatch on the syntactic argument count, which a spread
      // argument would silently defeat (one spread node can carry a runtime endPosition).
      refuseSpreadArguments(call)

      const arguments_ = call.getArguments()
      const pattern = arguments_[0]

      if (arguments_.length === 2) {
        requestHelper(sourceFile, 'downlevelEndsWithAt')
        call.replaceWithText(
          `downlevelEndsWithAt(${receiver.getText()}, ${pattern.getText()}, ${arguments_[1].getText()})`
        )
        return true
      }

      if (isSimpleExpression(receiver) && isSimpleArgument(pattern)) {
        // Allocation-free inline fast path: `s` and `p` are each duplicated (used twice), which
        // the simple-expression rule allows.
        const receiverText = receiver.getText()
        const patternText = pattern.getText()
        call.replaceWithText(
          `(${receiverText}.slice(${receiverText}.length - ${patternText}.length) === ${patternText})`
        )
        return true
      }

      requestHelper(sourceFile, 'downlevelEndsWith')
      call.replaceWithText(`downlevelEndsWith(${receiver.getText()}, ${pattern.getText()})`)
      return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// #4 — `Object.hasOwn(o, k)` → `Object.prototype.hasOwnProperty.call(o, k)`
// ---------------------------------------------------------------------------

const CATALOG_RULE_HAS_OWN: CatalogRule = {
  id: '#4 Object.hasOwn',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'hasOwn') {
        continue
      }
      const receiver = callee.getExpression()
      if (!isGlobalConstructorReference(receiver, 'Object', 'ObjectConstructor')) {
        continue
      }
      // The positional destructuring below assumes two syntactic arguments; a spread argument
      // would leave `key` with no node at all.
      refuseSpreadArguments(call)

      // `object` and `key` are each evaluated once — arbitrary shapes OK.
      const [object, key] = call.getArguments()
      call.replaceWithText(
        `Object.prototype.hasOwnProperty.call(${object.getText()}, ${key.getText()})`
      )
      return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// #5 — `arr.toSorted(cmp?)` → `arr.slice().sort(cmp?)`; `arr.toReversed()` → `arr.slice().reverse()`
// ---------------------------------------------------------------------------

/**
 * Build a catalog rule that rewrites `receiver.<catalogMethodName>(...)` to
 * `receiver.slice().<targetMethodName>(...)` for array receivers, forwarding arguments as-is.
 * The receiver is evaluated once (via `.slice()`) and every argument once — arbitrary shapes OK.
 *
 * @param id - The rule's diagnostic id.
 * @param catalogMethodName - The modern method name to match (e.g. `'toSorted'`).
 * @param targetMethodName - The ES5-safe method to call on the `.slice()` copy (e.g. `'sort'`).
 *
 * @returns The constructed {@link CatalogRule}.
 */
const createArraySliceThenMethodRule = (
  id: string,
  catalogMethodName: string,
  targetMethodName: string
): CatalogRule => ({
  id,
  rewriteNext: (sourceFile): boolean => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== catalogMethodName) {
        continue
      }
      const receiver = callee.getExpression()
      if (!isArrayLikeType(receiver.getType())) {
        continue
      }

      const argumentsText = call
        .getArguments()
        .map((argument) => argument.getText())
        .join(', ')
      call.replaceWithText(`${receiver.getText()}.slice().${targetMethodName}(${argumentsText})`)
      return true
    }
    return false
  },
})

const CATALOG_RULE_TO_SORTED = createArraySliceThenMethodRule(
  '#5 Array#toSorted',
  'toSorted',
  'sort'
)
const CATALOG_RULE_TO_REVERSED = createArraySliceThenMethodRule(
  '#5 Array#toReversed',
  'toReversed',
  'reverse'
)

// ---------------------------------------------------------------------------
// #6 — `s.replaceAll(...)` — full coverage: regex-literal, RegExp-typed, string-search
// ---------------------------------------------------------------------------

/**
 * Check whether `node` is a string literal or no-substitution template literal whose *value*
 * (not source text) contains no `$` character — the replacement shape half of the split/join
 * fast path's eligibility (see {@link isNonEmptyStringLiteral} for the other half). `replaceAll`
 * applies GetSubstitution to its replacement string even for a plain string search (the `$$`,
 * `$&`, and backtick/quote-boundary patterns are still live), which `split`/`join` cannot
 * reproduce; a literal with no `$` at all has nothing for GetSubstitution to do, so the two are
 * equivalent only in that case.
 *
 * @param node - The replacement-argument expression to check.
 *
 * @returns `true` if `node` is a literal proven to contain no `$`.
 */
const isDollarFreeLiteral = (node: Node): boolean =>
  (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) &&
  !node.getLiteralValue().includes('$')

/**
 * Check whether `node` is a string literal or no-substitution template literal whose *value* is
 * non-empty — the search-argument half of the split/join fast path's eligibility. An empty
 * search value is the other way (besides `$`-substitutions — see {@link isDollarFreeLiteral})
 * `replaceAll` and `split`/`join` diverge: `replaceAll` inserts the replacement at every
 * position, including before the first and after the last character
 * (`''.replaceAll('', 'X')` is `'X'`), while `''.split('').join('X')` is `''` — splitting on an
 * empty separator does not produce the boundary positions `replaceAll` does. Since a non-literal
 * search value's emptiness can't be known at build time, only a literal proven non-empty is
 * eligible.
 *
 * @param node - The search-argument expression to check.
 *
 * @returns `true` if `node` is a literal proven to be non-empty.
 */
const isNonEmptyStringLiteral = (node: Node): boolean =>
  (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) &&
  node.getLiteralValue().length > 0

const CATALOG_RULE_REPLACE_ALL: CatalogRule = {
  id: '#6 String#replaceAll',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'replaceAll') {
        continue
      }
      const receiver = callee.getExpression()
      if (!isStringLikeType(receiver.getType())) {
        continue
      }

      // The positional destructuring below assumes two syntactic arguments; a spread argument
      // would leave `replaceValue` with no node at all.
      refuseSpreadArguments(call)

      // `receiver`, `searchValue`, and `replaceValue` are each evaluated once — arbitrary shapes
      // OK throughout; only the argument *types* (and, for the split/join fast path, the
      // replacement's literal *value*) need checking.
      const [searchValue, replaceValue] = call.getArguments()
      const receiverText = receiver.getText()
      const searchText = searchValue.getText()
      const replaceText = replaceValue.getText()

      if (Node.isRegularExpressionLiteral(searchValue)) {
        // A regex *literal*'s flags are known at build time, so the `g`-flag check native
        // `replaceAll` does at run time can happen here instead — `replace()` and `replaceAll()`
        // share the exact same substitution algorithm for a global RegExp, so this is a direct,
        // helper-free rewrite (arbitrary replacement — string or function — OK).
        const flags = searchText.slice(searchText.lastIndexOf('/') + 1)
        if (!flags.includes('g')) {
          return refuse(
            call,
            'a RegExp search value without the `g` flag throws a TypeError at runtime — native ' +
              '`replaceAll` requires a global RegExp, so this call would always fail',
            'add the `g` flag to the regular expression'
          )
        }
        call.replaceWithText(`${receiverText}.replace(${searchText}, ${replaceText})`)
        return true
      }

      if (isRegExpLikeType(searchValue.getType())) {
        // A non-literal RegExp's flags aren't statically knowable, so the `g`-flag check has to
        // happen at run time instead — see the helper.
        requestHelper(sourceFile, 'downlevelReplaceAllRegExp')
        call.replaceWithText(
          `downlevelReplaceAllRegExp(${receiverText}, ${searchText}, ${replaceText})`
        )
        return true
      }

      if (!isStringLikeType(searchValue.getType())) {
        // Unreachable for type-checked source (replaceAll's search parameter is `string |
        // RegExp`), but refuse rather than silently leave an ES2021 API call in shipped code.
        return refuse(
          call,
          "the search value's type could not be determined to be exactly `string` or " +
            '`RegExp`, so no downlevel rewrite could be selected',
          'give the search value an explicit `string` or `RegExp` type'
        )
      }

      if (!isStringLikeType(replaceValue.getType())) {
        // Function replacer, string search: the replacer is called with (matched, position,
        // fullString) — see the helper.
        requestHelper(sourceFile, 'downlevelReplaceAllStringFunction')
        call.replaceWithText(
          `downlevelReplaceAllStringFunction(${receiverText}, ${searchText}, ${replaceText})`
        )
        return true
      }

      if (isNonEmptyStringLiteral(searchValue) && isDollarFreeLiteral(replaceValue)) {
        call.replaceWithText(`${receiverText}.split(${searchText}).join(${replaceText})`)
        return true
      }

      // Search not provably non-empty, or replacement not provably `$`-free: GetSubstitution or
      // the empty-search boundary-insertion behavior may be live — see the helper (and its doc
      // comment for the `'a-b'.replaceAll('-', '$&$&')` example).
      requestHelper(sourceFile, 'downlevelReplaceAllString')
      call.replaceWithText(
        `downlevelReplaceAllString(${receiverText}, ${searchText}, ${replaceText})`
      )
      return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// #7 — `Number.parseInt(...)` → `parseInt(...)`; `Number.parseFloat(...)` → `parseFloat(...)`
// ---------------------------------------------------------------------------

/**
 * Build a catalog rule that rewrites `Number.<methodName>(...)` to the equivalent global
 * function call, forwarding arguments unchanged — arbitrary shapes OK (never duplicated).
 *
 * @param id - The rule's diagnostic id.
 * @param methodName - The `Number` static method name to match (e.g. `'parseInt'`).
 *
 * @returns The constructed {@link CatalogRule}.
 */
const createNumberStaticMethodRule = (id: string, methodName: string): CatalogRule => ({
  id,
  rewriteNext: (sourceFile): boolean => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== methodName) {
        continue
      }
      const receiver = callee.getExpression()
      if (!isGlobalConstructorReference(receiver, 'Number', 'NumberConstructor')) {
        continue
      }

      const argumentsText = call
        .getArguments()
        .map((argument) => argument.getText())
        .join(', ')
      call.replaceWithText(`${methodName}(${argumentsText})`)
      return true
    }
    return false
  },
})

const CATALOG_RULE_PARSE_INT = createNumberStaticMethodRule('#7 Number.parseInt', 'parseInt')
const CATALOG_RULE_PARSE_FLOAT = createNumberStaticMethodRule('#7 Number.parseFloat', 'parseFloat')

// ---------------------------------------------------------------------------
// #8 — `` String.raw`...` `` (with or without substitutions) → constant-folded expression
// ---------------------------------------------------------------------------

/**
 * Normalize line terminators in a template's raw source text the way the spec's template raw
 * value (TRV) does: `\r\n` and a lone `\r` both become `\n`. Without this, a folded
 * `String.raw` literal would embed the file's on-disk line endings — producing different
 * shipped output from a CRLF (Windows) working tree than from an LF one, where native
 * `String.raw` yields `\n` on both.
 *
 * @param rawText - The raw source text between a template's backticks/braces.
 *
 * @returns The text with spec-normalized line terminators.
 */
const normalizeTemplateRawText = (rawText: string): string => rawText.replaceAll(/\r\n?/g, '\n')

const CATALOG_RULE_STRING_RAW: CatalogRule = {
  id: '#8 String.raw',
  rewriteNext: (sourceFile) => {
    for (const taggedTemplate of sourceFile.getDescendantsOfKind(
      SyntaxKind.TaggedTemplateExpression
    )) {
      const tag = taggedTemplate.getTag()
      if (!Node.isPropertyAccessExpression(tag) || tag.getName() !== 'raw') {
        continue
      }
      if (!isGlobalConstructorReference(tag.getExpression(), 'String', 'StringConstructor')) {
        continue
      }

      const template = taggedTemplate.getTemplate()

      if (Node.isNoSubstitutionTemplateLiteral(template)) {
        // The raw text is the exact source text between the backticks (unlike
        // `getLiteralValue()`, which returns the *cooked*, escape-interpreted value), with the
        // spec's line-terminator normalization applied (see normalizeTemplateRawText).
        const rawText = normalizeTemplateRawText(template.getText().slice(1, -1))
        taggedTemplate.replaceWithText(`'${escapeForSingleQuotedLiteral(rawText)}'`)
        return true
      }

      // Template with substitutions: fold to a parenthesized concatenation of literal segments
      // (raw, un-interpreted — same as above) and parenthesized substitution expressions, each
      // evaluated exactly once, in their original left-to-right order (matching a tagged
      // template's own evaluation order) — arbitrary substitution expressions OK.
      const headRawText = normalizeTemplateRawText(template.getHead().getText().slice(1, -2))
      const parts = [`'${escapeForSingleQuotedLiteral(headRawText)}'`]
      for (const span of template.getTemplateSpans()) {
        parts.push(`(${span.getExpression().getText()})`)
        const literal = span.getLiteral()
        const literalRawText = normalizeTemplateRawText(
          Node.isTemplateTail(literal)
            ? literal.getText().slice(1, -1)
            : literal.getText().slice(1, -2)
        )
        parts.push(`'${escapeForSingleQuotedLiteral(literalRawText)}'`)
      }
      taggedTemplate.replaceWithText(`(${parts.join(' + ')})`)
      return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// #9 — `for (... of expr.entries())` → index loop
// ---------------------------------------------------------------------------

/** The recognized `for (... of expr.entries())` variable-binding shapes. */
type EntriesForOfBindingShape =
  | {
      readonly kind: 'pair'
      readonly indexName: string
      /**
       * The value binding's exact source text — a plain identifier (e.g. `value`) or an
       * arbitrarily nested destructuring pattern (e.g. `[a, b]`, `{ x, y }`), copied verbatim
       * into the rewritten `<declarationKind> <valueBindingText> = ...` declaration. Only the
       * pair's second *element itself* is restricted (no rest, no default — see
       * {@link getEntriesForOfBindingShape}); whatever is nested inside it is never inspected.
       */
      readonly valueBindingText: string
      /** A plain identifier to derive a related hoisted-receiver name from, if one exists. */
      readonly nameSeed: string
      /** The original declaration keyword (`const`/`let`/`var`), reused for the bindings. */
      readonly declarationKind: string
    }
  | {
      readonly kind: 'tuple'
      readonly entryName: string
      /** The original declaration keyword (`const`/`let`/`var`), reused for the binding. */
      readonly declarationKind: string
    }

/**
 * Recognize the variable-binding shape of a `for (... of expr.entries())` initializer: either a
 * `[index, value]` destructuring — where `index` is a plain identifier and `value` is a plain
 * identifier or an arbitrarily nested pattern — or a single plain identifier bound to the whole
 * `[index, value]` pair. Any declaration kind (`const`/`let`/`var`) is accepted and reused for
 * the rewritten per-iteration bindings, so mutating a `let` binding stays local to that
 * iteration exactly as it does with native `for...of` (the loop's own counter is a separate,
 * fresh name the body cannot reach).
 *
 * @param initializer - The for...of statement's initializer.
 *
 * @returns The recognized {@link EntriesForOfBindingShape}, or `undefined` if `initializer`
 *   doesn't match either supported shape (e.g. a rest element or default value on the index or
 *   value slot itself, or a non-declaration assignment target).
 */
const getEntriesForOfBindingShape = (
  initializer: VariableDeclarationList | Expression
): EntriesForOfBindingShape | undefined => {
  if (!Node.isVariableDeclarationList(initializer)) {
    return undefined
  }
  const declarations = initializer.getDeclarations()
  if (declarations.length !== 1) {
    return undefined
  }
  const declarationKind = initializer.getDeclarationKind()
  const nameNode = declarations[0].getNameNode()

  if (Node.isIdentifier(nameNode)) {
    return { kind: 'tuple', entryName: nameNode.getText(), declarationKind }
  }

  if (!Node.isArrayBindingPattern(nameNode)) {
    return undefined
  }
  const elements = nameNode.getElements()
  if (elements.length !== 2) {
    return undefined
  }
  const [indexElement, valueElement] = elements
  if (
    !Node.isBindingElement(indexElement) ||
    !Node.isBindingElement(valueElement) ||
    !Node.isIdentifier(indexElement.getNameNode()) ||
    indexElement.getDotDotDotToken() ||
    valueElement.getDotDotDotToken() ||
    indexElement.getInitializer() ||
    valueElement.getInitializer()
  ) {
    return undefined
  }
  const valueNameNode = valueElement.getNameNode()
  return {
    kind: 'pair',
    indexName: indexElement.getNameNode().getText(),
    valueBindingText: valueNameNode.getText(),
    nameSeed: Node.isIdentifier(valueNameNode) ? valueNameNode.getText() : 'receiver',
    declarationKind,
  }
}

/** How to reference a `.entries()` receiver inside the rewritten loop, from {@link planEntriesReceiver}. */
type EntriesReceiverPlan = {
  /** The fresh name that references the receiver everywhere in the rewritten loop. */
  readonly text: string
  /** The `const <name> = <expr>` declaration that captures the receiver, emitted first. */
  readonly hoistDeclaration: string
}

/**
 * Plan how to reference a `.entries()` receiver inside the rewritten loop. The receiver is
 * always captured into a fresh `const` — even when it is a plain identifier — for two reasons:
 * it matches `Array#entries()`'s own once-only evaluation of its receiver at the start of
 * iteration, and the rewritten value-binding line lives inside the loop body's block right next
 * to the user's own statements, where a user declaration shadowing (or TDZ-ing) the original
 * receiver identifier must not affect the read. A fresh, whole-file-collision-checked name (see
 * {@link pickFreshName}) cannot be shadowed by any existing code.
 *
 * @param sourceFile - The source file being rewritten (used to pick a collision-free name).
 * @param receiver - The `.entries()` receiver expression.
 * @param nameSeed - The loop's own binding name (the pair's value name, or the whole-tuple
 *   entry name), used to derive a readable, related hoisted name.
 *
 * @returns The {@link EntriesReceiverPlan} to use when building the loop's replacement text.
 */
const planEntriesReceiver = (
  sourceFile: SourceFile,
  receiver: Node,
  nameSeed: string
): EntriesReceiverPlan => {
  const name = pickFreshName(sourceFile, `downlevel${capitalizeFirstLetter(nameSeed)}`)
  return { text: name, hoistDeclaration: `const ${name} = ${receiver.getText()}` }
}

const CATALOG_RULE_ARRAY_ENTRIES_FOR_OF: CatalogRule = {
  id: '#9 Array#entries (for...of)',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'entries') {
        continue
      }
      const receiver = callee.getExpression()
      if (!isArrayLikeType(receiver.getType())) {
        continue
      }

      // From here this is a catalog target: `expr.entries()` on an array. A `.entries()` result
      // is a genuine ES2015 iterator object with no ES5 equivalent, so the only rewrite that can
      // ever work is one that consumes it immediately, in place, via `for...of` — never one that
      // stores or otherwise passes around the iterator itself.
      const forOf = call.getParentIfKind(SyntaxKind.ForOfStatement)
      if (forOf?.getExpression() !== call) {
        return refuse(
          call,
          'a `.entries()` result is an ES2015 iterator object, which has no ES5 equivalent — ' +
            'only `for (... of expr.entries())`, which consumes it immediately without ever ' +
            'holding onto the iterator itself, can be downleveled',
          'iterate immediately with for...of instead of storing the iterator'
        )
      }

      const bindingShape = getEntriesForOfBindingShape(forOf.getInitializer())
      if (!bindingShape) {
        return refuse(
          forOf,
          'neither position of a `[index, value]` binding may have a rest element or default ' +
            'value, and the index position must be a plain identifier — `entries()` always ' +
            'yields exactly one index and one value per iteration, so there is nothing for a ' +
            'rest element to collect and no way for either position to be absent',
          'bind a plain `[index, value]` pair (the value position may itself destructure)'
        )
      }

      // The rewrite wraps the loop in a block (so the whole replacement stays a single
      // statement, valid in any statement position — e.g. a braceless `if` body). A label
      // cannot survive that wrapping: `continue <label>` must target a loop, not a block.
      if (Node.isLabeledStatement(forOf.getParent())) {
        return refuse(
          forOf,
          'a labeled `for...of` over `.entries()` cannot be rewritten — the rewrite wraps the ' +
            'loop in a block scope, and `continue`/`break` with a label cannot target a label ' +
            'that sits on a block',
          'restructure the loop so the label is not needed'
        )
      }

      // The body is copied verbatim — a block body keeps everything between its braces,
      // including comments (which also preserves any `@ts-expect-error` suppressions into the
      // shadow tree).
      const body = forOf.getStatement()
      const bodyText = Node.isBlock(body) ? body.getText().slice(1, -1) : body.getText()

      const nameSeed = bindingShape.kind === 'pair' ? bindingShape.nameSeed : bindingShape.entryName
      const { text: receiverText, hoistDeclaration } = planEntriesReceiver(
        sourceFile,
        receiver,
        nameSeed
      )
      // The loop's own counter is a fresh name derived from the receiver name (the strict
      // suffix guarantees the two can never collide, even before either is inserted into the
      // file): user code can neither read nor write it, so assigning to the user's own
      // per-iteration bindings below cannot change the iteration — exactly native `for...of`
      // semantics.
      const counterName = pickFreshName(sourceFile, `${receiverText}Index`)
      const loopHead =
        `for (let ${counterName} = 0; ` +
        `${counterName} < ${receiverText}.length; ${counterName}++)`

      if (bindingShape.kind === 'pair') {
        const { indexName, valueBindingText, declarationKind } = bindingShape
        forOf.replaceWithText(
          `{\n${hoistDeclaration}\n${loopHead} {\n` +
            `${declarationKind} ${indexName} = ${counterName}\n` +
            `${declarationKind} ${valueBindingText} = ${receiverText}[${counterName}]\n` +
            `${bodyText}\n}\n}`
        )
        return true
      }

      // Whole-tuple form (`for (const entry of expr.entries())`): the body observes a single
      // `[index, value]` pair per iteration — matching native `entries()`, this allocates one
      // fresh 2-element array per iteration (unavoidable: the body may hold onto it).
      forOf.replaceWithText(
        `{\n${hoistDeclaration}\n${loopHead} {\n` +
          `${bindingShape.declarationKind} ${bindingShape.entryName} = ` +
          `[${counterName}, ${receiverText}[${counterName}]]\n` +
          `${bodyText}\n}\n}`
      )
      return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// #10 — `x.at(N)` — literal index → direct/length-relative indexing; otherwise the helper
// ---------------------------------------------------------------------------

const CATALOG_RULE_AT: CatalogRule = {
  id: '#10 String/Array#at',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'at') {
        continue
      }
      const receiver = callee.getExpression()
      const receiverType = receiver.getType()
      if (!isStringLikeType(receiverType) && !isArrayLikeType(receiverType)) {
        continue
      }

      const [argument] = call.getArguments()
      const integerLiteral = getIntegerLiteral(argument)

      if (integerLiteral && !integerLiteral.isNegative) {
        // Non-negative literal index: `x[N]` never duplicates the receiver — arbitrary shapes OK.
        call.replaceWithText(`${receiver.getText()}[${integerLiteral.value}]`)
        return true
      }

      if (integerLiteral && isSimpleExpression(receiver)) {
        // Negative literal index with a simple receiver: allocation-free inline fast path
        // (kept byte-identical) — `x` is duplicated (`.length` and the index), which the
        // simple-expression rule allows.
        const receiverText = receiver.getText()
        call.replaceWithText(`${receiverText}[${receiverText}.length - ${integerLiteral.value}]`)
        return true
      }

      // Non-literal index, or a negative literal index with a non-simple receiver: the helper —
      // receiver and index are each passed through once, so arbitrary shapes OK.
      requestHelper(sourceFile, 'downlevelAt')
      call.replaceWithText(`downlevelAt(${receiver.getText()}, ${argument.getText()})`)
      return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// #11 — Number statics: `Number.isNaN`/`isFinite`/`isInteger`/`isSafeInteger`, and the
// `EPSILON`/`MAX_SAFE_INTEGER`/`MIN_SAFE_INTEGER` constant folds
// ---------------------------------------------------------------------------

const CATALOG_RULE_NUMBER_IS_NAN: CatalogRule = {
  id: '#11 Number.isNaN',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'isNaN') {
        continue
      }
      const receiver = callee.getExpression()
      if (!isGlobalConstructorReference(receiver, 'Number', 'NumberConstructor')) {
        continue
      }

      const [argument] = call.getArguments()
      if (isNumberLikeType(argument.getType()) && isSimpleExpression(argument)) {
        // Inline fast path: `x` is duplicated (`x !== x`), which the simple-expression rule
        // allows. Only valid when `x` is statically known to be a `number` — `Number.isNaN`,
        // unlike the global `isNaN`, never coerces a non-number argument first.
        const argumentText = argument.getText()
        call.replaceWithText(`(${argumentText} !== ${argumentText})`)
        return true
      }

      requestHelper(sourceFile, 'downlevelNumberIsNaN')
      call.replaceWithText(`downlevelNumberIsNaN(${argument.getText()})`)
      return true
    }
    return false
  },
}

const CATALOG_RULE_NUMBER_IS_FINITE: CatalogRule = {
  id: '#11 Number.isFinite',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'isFinite') {
        continue
      }
      const receiver = callee.getExpression()
      if (!isGlobalConstructorReference(receiver, 'Number', 'NumberConstructor')) {
        continue
      }

      const [argument] = call.getArguments()
      if (isNumberLikeType(argument.getType())) {
        // `argument` is evaluated once — arbitrary shapes OK. Only valid when statically known
        // to be a `number` — the global `isFinite`, unlike `Number.isFinite`, coerces first.
        call.replaceWithText(`isFinite(${argument.getText()})`)
        return true
      }

      requestHelper(sourceFile, 'downlevelNumberIsFinite')
      call.replaceWithText(`downlevelNumberIsFinite(${argument.getText()})`)
      return true
    }
    return false
  },
}

/**
 * Build a catalog rule that rewrites `Number.<methodName>(x)` to a call to the given emitted
 * helper. Always uses the helper — neither `Number.isInteger` nor `Number.isSafeInteger` has an
 * allocation-free inline ES5 form — so `x` is always forwarded as-is (evaluated once: arbitrary
 * shapes OK).
 *
 * @param id - The rule's diagnostic id.
 * @param methodName - The `Number` static method name to match (e.g. `'isInteger'`).
 * @param helperName - The emitted helper to call.
 *
 * @returns The constructed {@link CatalogRule}.
 */
const createNumberHelperOnlyRule = (
  id: string,
  methodName: string,
  helperName: DownlevelHelperName
): CatalogRule => ({
  id,
  rewriteNext: (sourceFile): boolean => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== methodName) {
        continue
      }
      const receiver = callee.getExpression()
      if (!isGlobalConstructorReference(receiver, 'Number', 'NumberConstructor')) {
        continue
      }

      const [argument] = call.getArguments()
      requestHelper(sourceFile, helperName)
      call.replaceWithText(`${helperName}(${argument.getText()})`)
      return true
    }
    return false
  },
})

const CATALOG_RULE_NUMBER_IS_INTEGER = createNumberHelperOnlyRule(
  '#11 Number.isInteger',
  'isInteger',
  'downlevelNumberIsInteger'
)
const CATALOG_RULE_NUMBER_IS_SAFE_INTEGER = createNumberHelperOnlyRule(
  '#11 Number.isSafeInteger',
  'isSafeInteger',
  'downlevelNumberIsSafeInteger'
)

/**
 * Constant-fold replacements for `Number.<name>` property accesses, keyed by property name.
 * `MIN_SAFE_INTEGER` is parenthesized because its fold is a unary-minus expression, and the
 * property access it replaces could be the receiver of a further member access (e.g.
 * `Number.MIN_SAFE_INTEGER.toString()`) — without parens, `-9007199254740991.toString()` would
 * parse as `-(9007199254740991.toString())`, not `(-9007199254740991).toString()`.
 */
const NUMBER_CONSTANT_FOLDS = new Map<string, string>([
  ['EPSILON', '2.220446049250313e-16'],
  ['MAX_SAFE_INTEGER', '9007199254740991'],
  ['MIN_SAFE_INTEGER', '(-9007199254740991)'],
])

const CATALOG_RULE_NUMBER_CONSTANTS: CatalogRule = {
  id: '#11 Number constants',
  rewriteNext: (sourceFile) => {
    for (const propertyAccess of sourceFile.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression
    )) {
      const replacement = NUMBER_CONSTANT_FOLDS.get(propertyAccess.getName())
      if (replacement === undefined) {
        continue
      }
      const receiver = propertyAccess.getExpression()
      if (!isGlobalConstructorReference(receiver, 'Number', 'NumberConstructor')) {
        continue
      }

      propertyAccess.replaceWithText(replacement)
      return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// #12 — `Array#find` / `findIndex` / `findLast` / `findLastIndex`
// ---------------------------------------------------------------------------

/**
 * Build a catalog rule that rewrites `receiver.<methodName>(predicate, thisArg?)` to a call to
 * the given emitted helper, for array receivers. Always uses the helper — none of the find
 * family has an allocation-free inline ES5 form — so `receiver` and every argument are always
 * forwarded as-is (each evaluated once: arbitrary shapes OK).
 *
 * @param id - The rule's diagnostic id.
 * @param methodName - The find-family method name to match (e.g. `'findLast'`).
 * @param helperName - The emitted helper to call.
 *
 * @returns The constructed {@link CatalogRule}.
 */
const createArrayFindRule = (
  id: string,
  methodName: string,
  helperName: DownlevelHelperName
): CatalogRule => ({
  id,
  rewriteNext: (sourceFile): boolean => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== methodName) {
        continue
      }
      const receiver = callee.getExpression()
      if (!isArrayLikeType(receiver.getType())) {
        continue
      }

      requestHelper(sourceFile, helperName)
      const argumentsText = call
        .getArguments()
        .map((argument) => argument.getText())
        .join(', ')
      call.replaceWithText(`${helperName}(${receiver.getText()}, ${argumentsText})`)
      return true
    }
    return false
  },
})

const CATALOG_RULE_FIND = createArrayFindRule('#12 Array#find', 'find', 'downlevelArrayFind')
const CATALOG_RULE_FIND_INDEX = createArrayFindRule(
  '#12 Array#findIndex',
  'findIndex',
  'downlevelArrayFindIndex'
)
const CATALOG_RULE_FIND_LAST = createArrayFindRule(
  '#12 Array#findLast',
  'findLast',
  'downlevelArrayFindLast'
)
const CATALOG_RULE_FIND_LAST_INDEX = createArrayFindRule(
  '#12 Array#findLastIndex',
  'findLastIndex',
  'downlevelArrayFindLastIndex'
)

// ---------------------------------------------------------------------------
// #13 — `String#repeat(n)`
// ---------------------------------------------------------------------------

const CATALOG_RULE_STRING_REPEAT: CatalogRule = {
  id: '#13 String#repeat',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'repeat') {
        continue
      }
      const receiver = callee.getExpression()
      if (!isStringLikeType(receiver.getType())) {
        continue
      }

      // `receiver` and `count` are each evaluated once — arbitrary shapes OK.
      requestHelper(sourceFile, 'downlevelStringRepeat')
      const [count] = call.getArguments()
      call.replaceWithText(`downlevelStringRepeat(${receiver.getText()}, ${count.getText()})`)
      return true
    }
    return false
  },
}

// ---------------------------------------------------------------------------
// #14 — `String#padStart(len, pad?)` / `String#padEnd(len, pad?)`
// ---------------------------------------------------------------------------

/**
 * Build a catalog rule that rewrites `receiver.<methodName>(...)` to a call to the given emitted
 * helper, for string receivers. Always uses the helper — neither `padStart` nor `padEnd` has an
 * allocation-free inline ES5 form — so `receiver` and every argument are always forwarded as-is
 * (each evaluated once: arbitrary shapes OK).
 *
 * @param id - The rule's diagnostic id.
 * @param methodName - The method name to match (`'padStart'` or `'padEnd'`).
 * @param helperName - The emitted helper to call.
 *
 * @returns The constructed {@link CatalogRule}.
 */
const createStringPadRule = (
  id: string,
  methodName: string,
  helperName: DownlevelHelperName
): CatalogRule => ({
  id,
  rewriteNext: (sourceFile): boolean => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== methodName) {
        continue
      }
      const receiver = callee.getExpression()
      if (!isStringLikeType(receiver.getType())) {
        continue
      }

      requestHelper(sourceFile, helperName)
      const argumentsText = call
        .getArguments()
        .map((argument) => argument.getText())
        .join(', ')
      call.replaceWithText(`${helperName}(${receiver.getText()}, ${argumentsText})`)
      return true
    }
    return false
  },
})

const CATALOG_RULE_PAD_START = createStringPadRule(
  '#14 String#padStart',
  'padStart',
  'downlevelStringPadStart'
)
const CATALOG_RULE_PAD_END = createStringPadRule(
  '#14 String#padEnd',
  'padEnd',
  'downlevelStringPadEnd'
)

// ---------------------------------------------------------------------------
// #15 — `Object.values(o)` / `Object.entries(o)`
// ---------------------------------------------------------------------------

/**
 * Build a catalog rule that rewrites `Object.<methodName>(o)` to a call to the given emitted
 * helper. Always uses the helper — neither `Object.values` nor `Object.entries` has an
 * allocation-free inline ES5 form — so `o` is always forwarded as-is (evaluated once: arbitrary
 * shapes OK).
 *
 * @param id - The rule's diagnostic id.
 * @param methodName - The `Object` static method name to match (`'values'` or `'entries'`).
 * @param helperName - The emitted helper to call.
 *
 * @returns The constructed {@link CatalogRule}.
 */
const createObjectStaticRule = (
  id: string,
  methodName: string,
  helperName: DownlevelHelperName
): CatalogRule => ({
  id,
  rewriteNext: (sourceFile): boolean => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== methodName) {
        continue
      }
      const receiver = callee.getExpression()
      if (!isGlobalConstructorReference(receiver, 'Object', 'ObjectConstructor')) {
        continue
      }

      requestHelper(sourceFile, helperName)
      const [object] = call.getArguments()
      call.replaceWithText(`${helperName}(${object.getText()})`)
      return true
    }
    return false
  },
})

const CATALOG_RULE_OBJECT_VALUES = createObjectStaticRule(
  '#15 Object.values',
  'values',
  'downlevelObjectValues'
)
const CATALOG_RULE_OBJECT_ENTRIES = createObjectStaticRule(
  '#15 Object.entries',
  'entries',
  'downlevelObjectEntries'
)

// ---------------------------------------------------------------------------
// #16 — `Array#toSpliced(...)`
// ---------------------------------------------------------------------------

const CATALOG_RULE_TO_SPLICED: CatalogRule = {
  id: '#16 Array#toSpliced',
  rewriteNext: (sourceFile) => {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'toSpliced') {
        continue
      }
      const receiver = callee.getExpression()
      if (!isArrayLikeType(receiver.getType())) {
        continue
      }

      // `receiver` and every argument are each evaluated once — arbitrary shapes OK.
      requestHelper(sourceFile, 'downlevelArrayToSpliced')
      const argumentsText = call
        .getArguments()
        .map((argument) => argument.getText())
        .join(', ')
      call.replaceWithText(`downlevelArrayToSpliced(${receiver.getText()}, ${argumentsText})`)
      return true
    }
    return false
  },
}

/** Every downlevel catalog rule, in the order documented in the feature spec (#1 through #16). */
export const CATALOG_RULES: readonly CatalogRule[] = [
  CATALOG_RULE_INCLUDES,
  CATALOG_RULE_STARTS_WITH,
  CATALOG_RULE_ENDS_WITH,
  CATALOG_RULE_HAS_OWN,
  CATALOG_RULE_TO_SORTED,
  CATALOG_RULE_TO_REVERSED,
  CATALOG_RULE_REPLACE_ALL,
  CATALOG_RULE_PARSE_INT,
  CATALOG_RULE_PARSE_FLOAT,
  CATALOG_RULE_STRING_RAW,
  CATALOG_RULE_ARRAY_ENTRIES_FOR_OF,
  CATALOG_RULE_AT,
  CATALOG_RULE_NUMBER_IS_NAN,
  CATALOG_RULE_NUMBER_IS_FINITE,
  CATALOG_RULE_NUMBER_IS_INTEGER,
  CATALOG_RULE_NUMBER_IS_SAFE_INTEGER,
  CATALOG_RULE_NUMBER_CONSTANTS,
  CATALOG_RULE_FIND,
  CATALOG_RULE_FIND_INDEX,
  CATALOG_RULE_FIND_LAST,
  CATALOG_RULE_FIND_LAST_INDEX,
  CATALOG_RULE_STRING_REPEAT,
  CATALOG_RULE_PAD_START,
  CATALOG_RULE_PAD_END,
  CATALOG_RULE_OBJECT_VALUES,
  CATALOG_RULE_OBJECT_ENTRIES,
  CATALOG_RULE_TO_SPLICED,
]

/**
 * Apply every {@link CATALOG_RULES} entry to `sourceFile`, in order, rewriting each rule's
 * matches to a fixed point (i.e. until it reports no more matches) before moving to the next
 * rule, then emit any helper functions the rewrites requested (see `emitted-helpers.ts`).
 *
 * @param sourceFile - The source file to rewrite in place.
 *
 * @throws DownlevelRefusalError if any match has no ES5-safe rewrite at all.
 */
export const applyCatalogToSourceFile = (sourceFile: SourceFile): void => {
  const originalText = sourceFile.getFullText()
  for (const rule of CATALOG_RULES) {
    while (rule.rewriteNext(sourceFile)) {
      // Keep re-scanning this rule until it reports no further matches.
    }
  }
  emitRequestedHelpers(sourceFile, originalText)
}

/**
 * Verify that `sourceFile` has zero remaining catalog-API usages after
 * {@link applyCatalogToSourceFile} has run. Re-runs every rule's own matcher (the same one used
 * to drive rewriting) one more time — if any of them still finds (and rewrites) a match, the
 * first pass did not reach a fixed point, which is an internal bug in the transform.
 *
 * @param sourceFile - The already-transformed source file to verify.
 *
 * @throws Error if a rule still finds a match.
 */
export const verifyNoRemainingCatalogUsage = (sourceFile: SourceFile): void => {
  for (const rule of CATALOG_RULES) {
    if (rule.rewriteNext(sourceFile)) {
      throw new Error(
        `Internal downlevel transform error: catalog rule "${rule.id}" still matched after the ` +
          `rewrite pass completed in ${sourceFile.getFilePath()}. The fixed-point loop did not ` +
          'converge — this is a bug in the downlevel transform, not in the source file.'
      )
    }
  }
}
