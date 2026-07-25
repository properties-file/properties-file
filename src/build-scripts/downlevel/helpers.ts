/**
 * Shared helpers for the downlevel rewrite catalog (see `catalog.ts`).
 *
 * These helpers implement the "simple expression" rule: a receiver or argument may only be an
 * identifier or `this`, plus string/number literals for arguments. That restriction only
 * matters for rewrites that reference the same source expression more than once in their
 * generated output — duplicating a complex expression would evaluate a potential side effect
 * twice, or observe a value that changed between the two evaluations.
 *
 * Most catalog entries evaluate their receiver and every argument exactly once, in the original
 * order, so they accept arbitrary expressions and never call {@link isSimpleExpression} /
 * {@link isSimpleArgument} at all. The rule only gates the handful of rewrite forms that
 * genuinely duplicate an operand (e.g. inlining `s.slice(s.length - p.length) === p` for
 * `endsWith`, which uses `s` and `p` twice each) — those forms fall back to an emitted helper
 * function (see `emitted-helpers.ts`) instead of refusing when the operand isn't simple, so no
 * catalog entry actually refuses on shape grounds anymore.
 */
import { Node, SyntaxKind, ts } from 'ts-morph'

import type { CallExpression, Type } from 'ts-morph'

/**
 * Thrown when the catalog finds shipped-code usage of a downlevel-catalog API that it cannot
 * safely rewrite. The message already includes the file:line location, the offending source
 * text, and a suggested fix, per the downlevel transform's error-reporting contract.
 */
export class DownlevelRefusalError extends Error {}

/**
 * Refuse to rewrite a matched catalog-API usage, throwing a {@link DownlevelRefusalError} with
 * the file:line location, the offending source text, and a suggested fix.
 *
 * @param node - The offending AST node (typically the call expression or statement).
 * @param reason - A short explanation of why the usage could not be rewritten.
 * @param fix - The suggested fix shown to the developer. Defaults to extracting the offending
 *   expression into a local `const`, which is the fix for most simple-expression violations.
 *
 * @throws DownlevelRefusalError always.
 */
export const refuse = (
  node: Node,
  reason: string,
  fix = 'extract the expression into a local const'
): never => {
  const filePath = node.getSourceFile().getFilePath()
  const line = node.getStartLineNumber()
  throw new DownlevelRefusalError(
    `${filePath}:${line}: cannot downlevel this usage — ${reason}\n\n` +
      `    ${node.getText()}\n\n` +
      `Fix: ${fix}.`
  )
}

/**
 * Check whether an expression is safe to duplicate or relocate in generated code: a plain
 * identifier or `this`, whose evaluation is guaranteed effect-free and idempotent.
 *
 * Property-access chains (`o.x.y`) are deliberately NOT accepted even though they read as
 * plain data: any link of a member chain may be an accessor property (or a Proxy trap), so a
 * duplicating rewrite would change how many times the getter runs — and a getter returning
 * changing values would make the duplicated reads disagree with each other, diverging from the
 * single-read native semantics. Such operands take a rewrite's helper fallback instead, which
 * evaluates them exactly once.
 *
 * Only used by rewrites that duplicate a receiver or argument in their generated output — see
 * the module documentation above for why non-duplicating rewrites don't need this at all.
 *
 * @param expression - The expression to check.
 *
 * @returns `true` if `expression` is safe to duplicate or relocate in generated code.
 */
export const isSimpleExpression = (expression: Node): boolean =>
  Node.isIdentifier(expression) || expression.getKind() === SyntaxKind.ThisKeyword

/**
 * Check whether an expression is a {@link isSimpleExpression} expression, or a string/numeric
 * literal — the set of argument shapes safe to duplicate in a rewrite's generated output.
 *
 * Only used by rewrites that duplicate a receiver or argument — see the module documentation
 * above.
 *
 * @param expression - The expression to check.
 *
 * @returns `true` if `expression` is safe to duplicate as a catalog rewrite argument.
 */
export const isSimpleArgument = (expression: Node): boolean =>
  isSimpleExpression(expression) ||
  Node.isStringLiteral(expression) ||
  Node.isNumericLiteral(expression)

/**
 * Check whether an array literal element is a plain identifier, string/numeric literal, or
 * negative numeric literal — the element shapes the literal-array `.includes()`
 * comparison-chain rewrite accepts. The chain (`x === a || x === b`) short-circuits, so
 * elements move from the array literal's guaranteed left-to-right, always-evaluated
 * construction to conditionally-evaluated comparison operands: an element with observable
 * evaluation effects could run conditionally or not at all. Restricting elements to
 * identifiers/literals (whose evaluation is effect-free) makes that difference unobservable.
 *
 * @param element - The array literal element to check.
 *
 * @returns `true` if `element` is a plain identifier, string/numeric literal, or negative
 *   numeric literal.
 */
export const isSimpleArrayLiteralElement = (element: Node): boolean =>
  isSimpleArgument(element) ||
  isNaNLiteralElement(element) ||
  (Node.isPrefixUnaryExpression(element) &&
    element.getOperatorToken() === SyntaxKind.MinusToken &&
    Node.isNumericLiteral(element.getOperand()))

/**
 * Capitalize the first character of a name (e.g. `'value'` → `'Value'`), for building a
 * `downlevel`-prefixed identifier out of an existing binding name (see the `.entries()`
 * for...of rewrite in `catalog.ts`, which hoists a `downlevel<Name>` local when the iterated
 * expression can't be evaluated inline).
 *
 * @param name - The name to capitalize.
 *
 * @returns `name` with its first character upper-cased.
 */
export const capitalizeFirstLetter = (name: string): string =>
  name.length === 0 ? name : name.charAt(0).toUpperCase() + name.slice(1)

/**
 * Check whether an expression is exactly a reference to a global constructor value (e.g. the
 * global `Object`, `Number`, or `String`) — an identifier with the expected name whose type is
 * the expected built-in constructor type. Guards against a local variable or namespace member
 * that happens to share the name shadowing the real global.
 *
 * @param expression - The expression to check.
 * @param identifierName - The expected identifier name (e.g. `'Object'`).
 * @param constructorTypeName - The expected type text of the global constructor (e.g.
 *   `'ObjectConstructor'`).
 *
 * @returns `true` if `expression` is exactly a reference to the named global constructor.
 */
export const isGlobalConstructorReference = (
  expression: Node,
  identifierName: string,
  constructorTypeName: string
): boolean =>
  Node.isIdentifier(expression) &&
  expression.getText() === identifierName &&
  expression.getType().getText() === constructorTypeName

/**
 * Check whether a type is guaranteed to be a string primitive at runtime: the primitive
 * `string` type, a string literal type, a template-literal type such as `id-${string}`, a
 * string-mapping type (`Uppercase<...>`), a type parameter whose constraint is string-like
 * (string primitives have no subclasses, so — unlike arrays — every instantiation behaves
 * identically), an intersection with a string-like member (a branded string is a string at
 * runtime), or a union where every constituent is such.
 *
 * @param type - The type to check.
 *
 * @returns `true` if every runtime value of `type` is a string primitive.
 */
export const isStringLikeType = (type: Type): boolean => {
  if (type.isUnion()) {
    return type.getUnionTypes().every((constituent) => isStringLikeType(constituent))
  }
  if (type.isIntersection()) {
    return type.getIntersectionTypes().some((constituent) => isStringLikeType(constituent))
  }
  if (type.isTypeParameter()) {
    const constraint = type.getConstraint()
    return constraint !== undefined && isStringLikeType(constraint)
  }
  const flags = type.getFlags()
  return (
    type.isString() ||
    type.isStringLiteral() ||
    (flags & ts.TypeFlags.TemplateLiteral) !== 0 ||
    (flags & ts.TypeFlags.StringMapping) !== 0
  )
}

/**
 * Check whether a type is a `number` type: the primitive `number` type, a number literal type,
 * or a union where every constituent is such.
 *
 * @param type - The type to check.
 *
 * @returns `true` if `type` is a number (or number literal) type.
 */
export const isNumberLikeType = (type: Type): boolean => {
  if (type.isUnion()) {
    return type.getUnionTypes().every((constituent) => isNumberLikeType(constituent))
  }
  return type.isNumber() || type.isNumberLiteral()
}

/**
 * Check whether a type is exactly `RegExp`, or a union where every constituent is.
 *
 * @param type - The type to check.
 *
 * @returns `true` if `type` is a `RegExp` type.
 */
export const isRegExpLikeType = (type: Type): boolean => {
  if (type.isUnion()) {
    return type.getUnionTypes().every((constituent) => isRegExpLikeType(constituent))
  }
  return type.getSymbol()?.getName() === 'RegExp'
}

/**
 * Check whether a type is an array, readonly array, or tuple type, or a union where every
 * constituent is such.
 *
 * @param type - The type to check.
 *
 * @returns `true` if `type` is safe to treat as an array for catalog rewrite purposes.
 */
export const isArrayLikeType = (type: Type): boolean => {
  if (type.isUnion()) {
    return type.getUnionTypes().every((constituent) => isArrayLikeType(constituent))
  }
  return type.isArray() || type.isReadonlyArray() || type.isTuple()
}

/**
 * Check whether a type provably rules out both values on which an `indexOf`-based `includes`
 * rewrite diverges from native `Array#includes`: `NaN` (found by `includes`' SameValueZero,
 * never by `indexOf`'s strict equality) and `undefined` (read from array holes by `includes`,
 * skipped over by `indexOf`). Anything not statically decidable — `any`, `unknown`, type
 * parameters (whose instantiations are unknowable), enums, and unresolved type operators — is
 * treated as unsafe, routing the rewrite to the exact `downlevelIncludesNaNSafe` helper.
 *
 * Intersections require every constituent safe: a branded number (`number & { brand }`) is a
 * number — and possibly `NaN` — at runtime.
 *
 * @param type - The element or search-argument type to check.
 *
 * @returns `true` if no runtime value of `type` can be `NaN` or `undefined`.
 */
export const isIndexOfSafeType = (type: Type): boolean => {
  if (type.isUnion()) {
    return type.getUnionTypes().every((constituent) => isIndexOfSafeType(constituent))
  }
  if (type.isIntersection()) {
    return type.getIntersectionTypes().every((constituent) => isIndexOfSafeType(constituent))
  }
  const unsafeFlags =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Number |
    ts.TypeFlags.NumberLiteral |
    ts.TypeFlags.Enum |
    ts.TypeFlags.EnumLiteral |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.TypeParameter |
    ts.TypeFlags.Index |
    ts.TypeFlags.IndexedAccess |
    ts.TypeFlags.Conditional
  return (type.getFlags() & unsafeFlags) === 0
}

/**
 * Check whether every element position of an array/tuple-like receiver type is
 * {@link isIndexOfSafeType} — the receiver-side half of the `.indexOf()` fast-path condition
 * for the `Array#includes` rewrite.
 *
 * @param type - An array, readonly array, or tuple type (as validated by
 *   {@link isArrayLikeType}).
 *
 * @returns `true` if no element of `type` can be `NaN` or `undefined`.
 */
export const isIndexOfSafeReceiverType = (type: Type): boolean => {
  if (type.isUnion()) {
    return type.getUnionTypes().every((constituent) => isIndexOfSafeReceiverType(constituent))
  }
  if (type.isTuple()) {
    return type.getTupleElements().every((element) => isIndexOfSafeType(element))
  }
  const elementType = type.getArrayElementType()
  return elementType !== undefined && isIndexOfSafeType(elementType)
}

/**
 * Check whether an array literal element is a literal spelling of `NaN`: the bare global `NaN`
 * identifier or `Number.NaN` (verified to reference the real global `Number`, not a shadowing
 * local). The comparison-chain `.includes()` rewrite must emit a self-inequality branch for
 * these — a strict-equality branch against `NaN` would be constantly `false`. The `Number.NaN`
 * spelling matters in practice because `unicorn/prefer-number-properties` autofixes the bare
 * form to it, making it the spelling that actually survives in lint-clean shipped code.
 *
 * @param element - The array literal element to check.
 *
 * @returns `true` if `element` denotes the `NaN` value.
 */
export const isNaNLiteralElement = (element: Node): boolean =>
  (Node.isIdentifier(element) && element.getText() === 'NaN') ||
  (Node.isPropertyAccessExpression(element) &&
    element.getName() === 'NaN' &&
    isGlobalConstructorReference(element.getExpression(), 'Number', 'NumberConstructor'))

/**
 * Refuse the rewrite when any call argument is a spread (`...args`): every catalog rewrite
 * reasons about arguments positionally — arity dispatch, per-argument forwarding — and a
 * spread collapses an unknown number of runtime arguments into one syntactic node, so e.g. an
 * arity-2 dispatch would silently drop the spread's second element.
 *
 * @param call - The matched call expression to validate.
 */
export const refuseSpreadArguments = (call: CallExpression): void => {
  for (const argument of call.getArguments()) {
    if (Node.isSpreadElement(argument)) {
      refuse(
        argument,
        "a spread argument defeats the rewrite's positional argument handling",
        'spell the arguments out positionally'
      )
    }
  }
}

/** An integer literal argument, as matched by {@link getIntegerLiteral}. */
export type IntegerLiteral = {
  /** Whether the literal was written with a unary minus (e.g. `-1`). */
  readonly isNegative: boolean
  /** The literal's non-negative magnitude (e.g. `1` for both `1` and `-1`). */
  readonly value: number
}

/**
 * Match an expression as an integer literal, optionally negative (e.g. `4` or `-4`, but not
 * `4.5`, `-4.5`, or a non-literal expression).
 *
 * @param expression - The expression to check.
 *
 * @returns The matched {@link IntegerLiteral}, or `undefined` if `expression` is not an integer
 *   literal.
 */
export const getIntegerLiteral = (expression: Node): IntegerLiteral | undefined => {
  if (Node.isNumericLiteral(expression)) {
    const value = expression.getLiteralValue()
    return Number.isSafeInteger(value) ? { isNegative: false, value } : undefined
  }
  if (
    Node.isPrefixUnaryExpression(expression) &&
    expression.getOperatorToken() === SyntaxKind.MinusToken
  ) {
    const operand = expression.getOperand()
    if (Node.isNumericLiteral(operand)) {
      const value = operand.getLiteralValue()
      // `-0` behaves as index 0 in `.at()` (ToIntegerOrInfinity(-0) is +0), not "from the end".
      return Number.isSafeInteger(value) ? { isNegative: value !== 0, value } : undefined
    }
  }
  return undefined
}

/**
 * Escape a raw string value for embedding in a single-quoted JS string literal, producing a
 * literal whose runtime value equals `value` exactly.
 *
 * @param value - The raw string value to escape.
 *
 * @returns The escaped literal body, without surrounding quotes.
 */
export const escapeForSingleQuotedLiteral = (value: string): string =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", String.raw`\'`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\r', String.raw`\r`)
