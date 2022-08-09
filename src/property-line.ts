/**
 * Object representing a line from the content of .properties file.
 */
export class PropertyLine {
  /** The line content, minus the trailing \ that identifies that the line continues. */
  public content: string
  /** True if the line continues, otherwise false. */
  public continues = false
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
    this.content = line.trimStart()
    this.isMultiline = isMultiline

    if (this.content.length === 0) {
      // Line is blank.
      this.isBlank = true
    } else {
      if (!this.isMultiline) {
        // Line is a comment.
        this.isComment = !!/^[!#]/.test(this.content)
      }
      if (!this.isComment) {
        // Otherwise, check if the line continues on the next line.
        const backslashMatch = this.content.match(/(?<backslashes>\\+)$/)

        if (backslashMatch?.groups) {
          // If the number of backslashes is odd, the line continues, otherwise it doesn't.
          this.continues = !!(backslashMatch.groups.backslashes.length % 2)
          if (this.continues) {
            // Remove the trailing slash so that we can concatenate the line with the next one.
            this.content = this.content.slice(0, -1)
          }
        }
      }
    }
  }
}
