/**
 * Shared helpers for the downlevel rewrite catalog (see `catalog.ts`).
 *
 * These helpers implement the "simple expression" rule: a receiver or argument may only be an
 * identifier, `this`, or a dot-member chain of those, plus string/number literals for arguments.
 * That restriction only matters for rewrites that reference the same source expression more
 * than once in their generated output — duplicating a complex expression would evaluate a
 * potential side effect twice, or observe a value that changed between the two evaluations.
 *
 * Most catalog entries evaluate their receiver and every argument exactly once, in the original
 * order, so they accept arbitrary expressions and never call {@link isSimpleExpression} /
 * {@link isSimpleArgument} at all. The rule only gates the handful of rewrite forms that
 * genuinely duplicate an operand (e.g. inlining `s.slice(s.length - p.length) === p` for
 * `endsWith`, which uses `s` and `p` twice each) — those forms fall back to an emitted helper
 * function (see `emitted-helpers.ts`) instead of refusing when the operand isn't simple, so no
 * catalog entry actually refuses on shape grounds anymore.
 */
import { Node, SyntaxKind } from 'ts-morph'

import type { Type } from 'ts-morph'

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
 * Check whether an expression is side-effect-free: an identifier, `this`, or a dot-member
 * access chain rooted in one of those, with no calls or computed (`[]`) access along the way.
 *
 * Only used by rewrites that duplicate a receiver or argument in their generated output — see
 * the module documentation above for why non-duplicating rewrites don't need this at all.
 *
 * @param expression - The expression to check.
 *
 * @returns `true` if `expression` is safe to duplicate or relocate in generated code.
 */
export const isSimpleExpression = (expression: Node): boolean => {
  if (Node.isIdentifier(expression) || expression.getKind() === SyntaxKind.ThisKeyword) {
    return true
  }
  if (Node.isPropertyAccessExpression(expression)) {
    return isSimpleExpression(expression.getExpression())
  }
  return false
}

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
 * comparison-chain rewrite is allowed to duplicate the search argument against (the argument is
 * compared once per chain branch, so every element position must itself be safe to re-evaluate
 * for free, which a plain identifier/literal always is).
 *
 * @param element - The array literal element to check.
 *
 * @returns `true` if `element` is a plain identifier, string/numeric literal, or negative
 *   numeric literal.
 */
export const isSimpleArrayLiteralElement = (element: Node): boolean =>
  isSimpleArgument(element) ||
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
 * Check whether a type is a `string` type: the primitive `string` type, a string literal type,
 * or a union where every constituent is such.
 *
 * @param type - The type to check.
 *
 * @returns `true` if `type` is a string (or string literal) type.
 */
export const isStringLikeType = (type: Type): boolean => {
  if (type.isUnion()) {
    return type.getUnionTypes().every((constituent) => isStringLikeType(constituent))
  }
  return type.isString() || type.isStringLiteral()
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
 * Check whether a type is (or, for a union, includes a constituent that is) `number` or a
 * number literal type.
 *
 * @param type - The type to check.
 *
 * @returns `true` if `type` is or includes a `number` type.
 */
const isOrIncludesNumberType = (type: Type): boolean => {
  if (type.isUnion()) {
    return type.getUnionTypes().some((constituent) => isOrIncludesNumberType(constituent))
  }
  return type.isNumber() || type.isNumberLiteral()
}

/**
 * Check whether an array/tuple-like type's element type is or includes `number`. Used to refuse
 * downleveling `Array#includes` to `indexOf` for numeric arrays, since `NaN` is matched by
 * `includes` but never found by `indexOf`.
 *
 * @param type - An array, readonly array, or tuple type (as validated by
 *   {@link isArrayLikeType}).
 *
 * @returns `true` if any element position of `type` is or includes `number`.
 */
export const hasNumberElementType = (type: Type): boolean => {
  if (type.isUnion()) {
    return type.getUnionTypes().some((constituent) => hasNumberElementType(constituent))
  }
  if (type.isTuple()) {
    return type.getTupleElements().some((element) => isOrIncludesNumberType(element))
  }
  const elementType = type.getArrayElementType()
  return elementType !== undefined && isOrIncludesNumberType(elementType)
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
