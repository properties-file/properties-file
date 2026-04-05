const CH_TAB = 9 // \t
const CH_LF = 10 // \n
const CH_FF = 12 // \f
const CH_CR = 13 // \r
const CH_SPACE = 32 // ' '
const CH_BANG = 33 // !
const CH_HASH = 35 // #
const CH_BACKSLASH = 92 // \\

/**
 * Object representing a line from the content of .properties file.
 */
export class PropertyLine {
  /** The line content, minus the trailing `\` that identifies that the line is continuing. */
  public content: string
  /** True if the line is continuing to the next line, otherwise false. */
  public isContinuing = false
  /** True if the line is blank, otherwise false. */
  public isBlank = false
  /** True if the line is a comment, otherwise false. */
  public isComment = false
  /** Is the line object a continuation from a previous line? */
  public isMultiline: boolean

  /**
   * Create a new line object.
   *
   * @param line - The raw content of a line.
   * @param isMultiline - Is the line spreading on multiple lines?
   */
  constructor(line: string, isMultiline: boolean) {
    // Strip leading whitespace using charCodeAt instead of regex.
    let start = 0
    const length = line.length
    while (start < length) {
      const charCode = line.charCodeAt(start)
      if (
        charCode !== CH_SPACE &&
        charCode !== CH_TAB &&
        charCode !== CH_LF &&
        charCode !== CH_FF &&
        charCode !== CH_CR
      ) {
        break
      }
      start++
    }
    this.content = start > 0 ? line.slice(start) : line
    this.isMultiline = isMultiline

    if (this.content.length === 0) {
      // Line is blank.
      this.isBlank = true
    } else {
      if (!this.isMultiline) {
        // Line is a comment.
        const firstCharCode = this.content.charCodeAt(0)
        this.isComment = firstCharCode === CH_BANG || firstCharCode === CH_HASH
      }
      if (!this.isComment) {
        // Count trailing backslashes to determine if line continues.
        let trailingBackslashCount = 0
        for (let index = this.content.length - 1; index >= 0; index--) {
          if (this.content.charCodeAt(index) === CH_BACKSLASH) {
            trailingBackslashCount++
          } else {
            break
          }
        }

        if (trailingBackslashCount > 0 && trailingBackslashCount % 2 === 1) {
          this.isContinuing = true
          // Remove the trailing slash so that we can concatenate the line with the next one.
          this.content = this.content.slice(0, -1)
        }
      }
    }
  }
}
