/**
 * Local ESLint rule: only allow iteration constructs over array (or tuple) types in shipped code.
 *
 * The build downlevels shipped code to ES5 with SWC's `iterableIsArray` assumption enabled
 * (see `src/build-scripts/build.ts`), which lowers `for...of` and spread to plain index-based
 * code with no `Symbol.iterator` dependency. That lowering is only correct when the iterated
 * value really is an array: under the assumption, iterating a string would produce UTF-16 code
 * units instead of code points, and iterating a `Map`/`Set`/generator would silently break.
 *
 * This rule makes the assumption provably safe: any `for...of`, iterable spread, or array
 * destructuring over a non-array type is a lint error in shipped code. Destructuring is checked
 * at every `ArrayPattern` via the pattern's own resolved type, which covers variable
 * declarations, `for...of` loop bindings, function parameters, and nested patterns alike. The
 * Node.js 0.4 functional replay test (`npm run test-node-compat`) is the behavioral backstop.
 *
 * Disabled for non-shipped files (tests, build scripts, performance), which run on modern
 * Node.js and never pass through the ES5 downlevel.
 *
 * Implementation note: the rule is written against eslint core types (not typescript-eslint's
 * `RuleModule`, which is not structurally assignable to core's plugin rule type). The type-aware
 * parser services provided at runtime by `@typescript-eslint/parser` are accessed through an
 * `unknown` boundary with a type guard, following the same pattern used elsewhere in this
 * repository for validating untyped data.
 */
import type { Rule } from 'eslint'
import type { Node as EstreeNode } from 'estree'
import type { Program, Type, TypeChecker } from 'typescript'

/**
 * The subset of `@typescript-eslint/parser`'s type-aware parser services used by this rule.
 * Available at runtime whenever typed linting (`parserOptions.project`) is configured.
 */
type TypeAwareParserServices = {
  program: Program
  getTypeAtLocation: (node: EstreeNode) => Type
}

/**
 * Check whether the parser services provide type information.
 *
 * @param services - The parser services exposed by the configured parser.
 *
 * @returns `true` if the services match the {@link TypeAwareParserServices} shape.
 */
const hasTypeInformation = (services: unknown): services is TypeAwareParserServices =>
  typeof services === 'object' &&
  services !== null &&
  'program' in services &&
  typeof services.program === 'object' &&
  services.program !== null &&
  'getTypeAtLocation' in services &&
  typeof services.getTypeAtLocation === 'function'

/**
 * Check whether a type is an array or tuple type (including readonly variants and unions
 * where every constituent is an array or tuple).
 *
 * @param checker - The TypeScript type checker.
 * @param type - The type to check.
 *
 * @returns `true` if the type is safe to iterate under the `iterableIsArray` assumption.
 */
const isArrayOrTupleType = (checker: TypeChecker, type: Type): boolean => {
  if (type.isUnion()) {
    return type.types.every((constituent) => isArrayOrTupleType(checker, constituent))
  }
  return checker.isArrayType(type) || checker.isTupleType(type)
}

export const arrayIterationOnlyRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Only allow `for...of`, iterable spread, and array destructuring over array types, ' +
        "so the ES5 downlevel's `iterableIsArray` assumption is provably safe.",
    },
    messages: {
      nonArrayIteration:
        'Only arrays may be iterated in shipped code: the ES5 downlevel assumes `for...of` ' +
        'targets are arrays (`iterableIsArray`), so iterating a {{typeName}} would break on ' +
        'pre-ES2015 runtimes or silently change semantics.',
      nonArraySpread:
        'Only arrays may be spread in shipped code: the ES5 downlevel assumes spread ' +
        'targets are arrays (`iterableIsArray`), so spreading a {{typeName}} would break on ' +
        'pre-ES2015 runtimes or silently change semantics.',
      nonArrayDestructuring:
        'Only arrays may be array-destructured in shipped code: the ES5 downlevel assumes ' +
        'destructured values are arrays (`iterableIsArray`), so destructuring a {{typeName}} ' +
        'would break on pre-ES2015 runtimes or silently change semantics.',
    },
    schema: [],
  },
  create: (context) => {
    const services: unknown = context.sourceCode.parserServices
    if (!hasTypeInformation(services)) {
      throw new Error(
        'The local/array-iteration-only rule requires typed linting (parserOptions.project).'
      )
    }
    const checker = services.program.getTypeChecker()

    /**
     * Report the given expression if its type is not an array or tuple type.
     *
     * @param expression - The expression whose type to validate.
     * @param messageId - The message to report on violation.
     */
    const checkExpression = (
      expression: EstreeNode,
      messageId: 'nonArrayIteration' | 'nonArraySpread' | 'nonArrayDestructuring'
    ): void => {
      const type = services.getTypeAtLocation(expression)
      if (!isArrayOrTupleType(checker, type)) {
        context.report({
          node: expression,
          messageId,
          data: { typeName: checker.typeToString(type) },
        })
      }
    }

    return {
      ForOfStatement: (node): void => {
        checkExpression(node.right, 'nonArrayIteration')
      },
      SpreadElement: (node): void => {
        // Object spread (`{ ...object }`) lowers to property copying, not iteration.
        if (node.parent.type !== 'ObjectExpression') {
          checkExpression(node.argument, 'nonArraySpread')
        }
      },
      ArrayPattern: (node): void => {
        // A pattern's own resolved type is the value being destructured into it, in every
        // context: the initializer's type in a declaration, the element type in a `for...of`
        // binding, the declared type of a function parameter, and the element type inside a
        // nested pattern. In a destructuring *assignment* (`[a] = expression`) the target is an
        // array literal in TypeScript's AST, so that form is checked via the assignment's
        // right-hand side below instead.
        if (node.parent.type !== 'AssignmentExpression') {
          checkExpression(node, 'nonArrayDestructuring')
        }
      },
      AssignmentExpression: (node): void => {
        if (node.left.type === 'ArrayPattern') {
          checkExpression(node.right, 'nonArrayDestructuring')
        }
      },
    }
  },
}
