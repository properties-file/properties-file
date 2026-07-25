/**
 * Typed error handling without `try`/`catch`.
 *
 * `catch` bindings are always `unknown` (anything can be thrown), which forces every call site
 * into ad-hoc `instanceof Error` narrowing, and `try` blocks trap their variables in a nested
 * scope. This module replaces that pattern: {@link noThrow} runs an action and returns either
 * its result or a {@link NormalizedError} — a guaranteed `Error` with a string stack and the
 * original thrown value preserved — so callers branch on {@link isNormalizedError} with full
 * type safety and no nesting.
 *
 * `try`/`catch` is banned repo-wide in favor of this module (see the `no-restricted-syntax`
 * rule in eslint/config.ts); this file itself hosts the only `try`/`catch` statements and is
 * exempted. The module is internal tooling (tests, performance and build scripts) — it must
 * never be imported from shipped code under src/, where it would add bundle bytes.
 *
 * @see https://dev.to/nbouvrette/handling-errors-in-typescript-the-right-way-5aej
 */

/**
 * An `Error` subclass wrapping whatever value was thrown, guaranteeing a string message, a
 * string stack, and access to the original thrown value.
 */
export class NormalizedError extends Error {
  /** The stack trace of the error (guaranteed a string, unlike `Error`'s optional stack). */
  stack: string
  /** The originally thrown value, preserved for callers that need to inspect it. */
  originalValue: unknown

  /**
   * Create a normalized error from a guaranteed `Error`.
   *
   * @param error - The error whose message and stack seed the normalized error.
   * @param originalValue - The originally thrown value, when it was not `error` itself.
   */
  constructor(error: Error, originalValue?: unknown) {
    super(error.message)
    this.stack = error.stack ?? this.message
    this.originalValue = originalValue ?? error
  }
}

/**
 * Check whether a value is shaped like an `Error`. Structural (not `instanceof`) on purpose:
 * errors thrown in another realm (e.g. a `node:vm` context) fail `instanceof Error` here even
 * though they are genuine errors.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value has string `message` and `stack` properties.
 */
export const isError = (value: unknown): value is Error =>
  typeof value === 'object' &&
  value !== null &&
  'message' in value &&
  typeof value.message === 'string' &&
  'stack' in value &&
  typeof value.stack === 'string'

/**
 * Check whether a value is a {@link NormalizedError} — the "did it throw?" branch after a
 * {@link noThrow} call. Uses `instanceof` (not a structural check) because every
 * `NormalizedError` is created in this realm by this module, and a structural check could
 * false-positive on error-shaped domain data.
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value is a {@link NormalizedError}.
 */
export const isNormalizedError = (value: unknown): value is NormalizedError =>
  value instanceof NormalizedError

/**
 * Check whether a value is a thenable with a `catch` method (a promise).
 *
 * @param value - The value to check.
 *
 * @returns `true` if the value looks like a promise.
 */
const isPromise = (value: unknown): value is Promise<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  'then' in value &&
  typeof value.then === 'function' &&
  'catch' in value &&
  typeof value.catch === 'function'

/**
 * Describe a non-error thrown value for a {@link NormalizedError} message: objects are JSON
 * serialized, primitives are converted to their string form.
 *
 * @param value - The thrown value to describe.
 *
 * @returns A human-readable description of the value.
 */
const describeThrownValue = (value: unknown): string => {
  // Positive narrowing per primitive type: `unknown` is not narrowed by the *negation* of a
  // `typeof value === 'object'` check, so a single object/primitive branch would leave `value`
  // as `unknown` in the primitive branch.
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value === 'symbol') {
    return value.toString()
  }
  if (value === undefined) {
    return 'undefined'
  }
  return JSON.stringify(value)
}

/**
 * Convert any thrown value into a {@link NormalizedError}: real errors are wrapped as-is,
 * non-error values (strings, objects, ...) are stringified into the message and preserved in
 * `originalValue`.
 *
 * @param value - The thrown value to normalize.
 *
 * @returns A {@link NormalizedError} representing the thrown value.
 */
export const toNormalizedError = (value: unknown): NormalizedError => {
  if (isNormalizedError(value)) {
    return value
  }
  if (isError(value)) {
    return new NormalizedError(value)
  }
  try {
    return new NormalizedError(
      new Error(`Unexpected value thrown: ${describeThrownValue(value)}`),
      value
    )
  } catch {
    // JSON.stringify can itself throw (circular references, throwing toJSON).
    return new NormalizedError(
      new Error('Unexpected value thrown: non-stringifiable object'),
      value
    )
  }
}

/**
 * Run an action and return its result, or a {@link NormalizedError} if it threw. For an async
 * action, the returned promise resolves to the result or to a {@link NormalizedError} — it
 * never rejects. Branch on the outcome with {@link isNormalizedError}.
 *
 * @param action - The (sync or async) action to run.
 *
 * @returns The action's result, or a {@link NormalizedError} when it threw.
 */
export function noThrow<Result>(action: () => Promise<Result>): Promise<Result | NormalizedError>
export function noThrow<Result>(action: () => Result): Result | NormalizedError
// Overload signatures require `function` declarations — an arrow implementation cannot be
// assigned to the narrower overload pair without a type assertion.
export function noThrow(action: () => unknown): unknown {
  try {
    const result = action()
    if (isPromise(result)) {
      return result.catch((error: unknown) => toNormalizedError(error))
    }
    return result
  } catch (error) {
    return toNormalizedError(error)
  }
}
