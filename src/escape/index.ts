/**
 * Escape a property key.
 *
 * @param unescapedKey - A property key to be escaped.
 * @param escapeUnicode - Escape unicode characters into ISO-8859-1 compatible encoding?
 *
 * @returns The escaped key.
 */
export const escapeKey = (unescapedKey: string, escapeUnicode = false): string => {
  return escapeContent(unescapedKey, true, escapeUnicode)
}

/**
 * Escape property value.
 *
 * @param unescapedValue - Property value to be escaped.
 * @param escapeUnicode - Escape unicode characters into ISO-8859-1 compatible encoding?
 *
 * @returns The escaped value.
 */
export const escapeValue = (unescapedValue: string, escapeUnicode = false): string => {
  return escapeContent(unescapedValue, false, escapeUnicode)
}

/** Pre-compiled regex for escaping without unicode expansion. */
const REGEX_ESCAPE_NO_UNICODE = /[\s!#:=\\]/g

/** Pre-compiled regex for escaping with unicode expansion. */
// eslint-disable-next-line unicorn/prefer-unicode-code-point-escapes -- `\u{...}` in a regex requires the ES2015 `u` flag, which would survive into the ES5 output
const REGEX_ESCAPE_UNICODE = /[\s!#:=\\\u0000-\u001F\u007F-\uFFFF]/g

/**
 * Escape the content from either key or value of a property.
 *
 * @param unescapedContent - The content to escape.
 * @param escapeSpace - Escape spaces?
 * @param escapeUnicode - Escape unicode characters into ISO-8859-1 compatible encoding?
 *
 * @returns The escaped content.
 */
const escapeContent = (
  unescapedContent: string,
  escapeSpace: boolean,
  escapeUnicode: boolean
): string => {
  const regex = escapeUnicode ? REGEX_ESCAPE_UNICODE : REGEX_ESCAPE_NO_UNICODE
  regex.lastIndex = 0
  return unescapedContent.replace(regex, (character, position) => {
    switch (character) {
      case ' ': {
        // Only escape leading spaces or spaces in keys; in-value spaces stay literal.
        return escapeSpace || position === 0 ? String.raw`\ ` : ' '
      }
      case '\\': {
        // Backslash.
        return '\\\\'
      }
      case '\f': {
        // Formfeed.
        return String.raw`\f`
      }
      case '\n': {
        // Newline.
        return String.raw`\n`
      }
      case '\r': {
        // Carriage return.
        return String.raw`\r`
      }
      case '\t': {
        // Tab.
        return String.raw`\t`
      }
      case '=':
      case ':':
      case '#':
      case '!': {
        return `\\${character}`
      }
      default: {
        // Any character outside the printable ASCII range — emit as `\uXXXX`.
        const hex = character.charCodeAt(0).toString(16)
        return String.raw`\u` + ('0000' + hex).slice(-4)
      }
    }
  })
}
